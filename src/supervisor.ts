/**
 * FerryCat execution supervisor (Phase 3 Step 0).
 *
 * Owns the lifecycle of one automated `worker --exec / --exec-file` child process:
 *   - Heartbeat lease keep-alive bound to claim_token (CK-01 / CK-02 / CK-03)
 *   - Process-tree termination incl. grandchildren (CK-04 / CK-05)
 *   - Minimal environment allowlist for the child (CK-06)
 *   - Partial-output salvage before the execution window closes (CK-07)
 *
 * Deliberately introduces NO new contract states (CK-09): every outcome maps onto the
 * existing CLAIMED -> COMPLETED / FAILED / TIMED_OUT transitions exposed by the engine.
 * See docs/audits/2026-10-24-phase-3-multi-agent-consensus-audit_zh.md.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { expandTilde, type FerryCatEngine } from './engine.js';
import { FulfillContractSchema } from './schemas.js';

export interface ContractPayload {
  contract_id: string;
  requester_agent: string;
  target_agent: string;
  task_type: string;
  title: string;
  context_summary: string;
  workspace_root: string;
  pointers: unknown[];
  contract_schema: Record<string, unknown> | null;
  claimed_at: number;
  exec_ttl_sec: number;
  claim_token?: string;
}

export interface ExecSpec {
  execCmd?: string;
  execFile?: string;
  /** Explicit, user-consented env var names forwarded to the child despite the allowlist. */
  passEnv?: string[];
  /** Optional argv arguments forwarded directly to the executable (when using execFile). */
  args?: string[];
}

export interface SupervisorOptions {
  /** Override heartbeat tick cadence (tests). Default: min(60s, exec_ttl / 3). */
  heartbeatIntervalMs?: number;
  /**
   * Optional upper bound on child execution window TTL in seconds.
   * NOTE: The contract's own `exec_ttl_sec` remains the primary authoritative database window.
   */
  execTtlSec?: number;
  /** Grace period between SIGTERM and SIGKILL. Default: clamp(exec_ttl / 10, 200ms, 3s). */
  killGraceMs?: number;
  /** Max captured stdout bytes before the child is terminated. Default: 10MB. */
  maxBufferBytes?: number;
  /** Structured lifecycle events (heartbeat renewals, exhaustion, termination). */
  onEvent?: (event: Record<string, unknown>) => void;
}

export interface ExecutionResult {
  ok: boolean;
  status: string;
  fulfill_result?: unknown;
  error?: string;
  contract_status?: string;
  salvaged?: boolean;
}

// ---------------------------------------------------------------------------
// CK-06: Minimal child environment
// ---------------------------------------------------------------------------

/**
 * Variables the child genuinely needs to run and to locate the user's *file-based* login
 * state (~/.config, %APPDATA%). Token-bearing env vars are a different threat model from
 * user-authorized credential files and are stripped (see audit §1.4 "reverse trap").
 */
const WINDOWS_ENV_ALLOWLIST = new Set([
  'PATH',
  'PATHEXT',
  'SYSTEMROOT',
  'SYSTEMDRIVE',
  'WINDIR',
  'COMSPEC',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'USERNAME',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  'LANG',
  'AGENT_NAME',
]);

const POSIX_ENV_ALLOWLIST = new Set([
  'PATH',
  'HOME',
  'TMPDIR',
  'SHELL',
  'USER',
  'LOGNAME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'XDG_STATE_HOME',
  'XDG_RUNTIME_DIR',
  'AGENT_NAME',
]);

/** Defense in depth: even an allowlisted or FERRYCAT_* name is dropped if it looks secret. */
const SECRET_NAME_PATTERNS: RegExp[] = [
  /_TOKEN$/i,
  /_KEY$/i,
  /_SECRET$/i,
  /SECRET/i,
  /PASSWORD/i,
  /CREDENTIAL/i,
  /^AWS_/i,
  /^GITHUB_/i,
  /^GH_/i,
  /^NPM_/i,
  /^OPENAI_/i,
  /^ANTHROPIC_/i,
];

const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_().]*$/;

export function isSecretEnvName(name: string): boolean {
  return SECRET_NAME_PATTERNS.some((re) => re.test(name));
}

export function buildChildEnv(
  contract: ContractPayload,
  passEnv: string[] = [],
  parentEnv: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): { env: NodeJS.ProcessEnv; dropped: number } {
  const isWin = platform === 'win32';
  const allowlist = isWin ? WINDOWS_ENV_ALLOWLIST : POSIX_ENV_ALLOWLIST;
  const norm = (k: string) => (isWin ? k.toUpperCase() : k);
  const explicit = new Set(
    passEnv.map((n) => n.trim()).filter((n) => ENV_NAME_PATTERN.test(n)).map(norm)
  );

  const env: NodeJS.ProcessEnv = {};
  let dropped = 0;
  for (const [key, value] of Object.entries(parentEnv)) {
    if (value === undefined) continue;
    const k = norm(key);
    if (explicit.has(k)) {
      // Explicit --pass-env is user consent and intentionally overrides the secret filter.
      env[key] = value;
      continue;
    }
    const allowed = allowlist.has(k) || k.toUpperCase().startsWith('FERRYCAT_');
    if (allowed && !isSecretEnvName(key)) {
      env[key] = value;
    } else {
      dropped++;
    }
  }

  // Injected lease context always wins over anything inherited.
  env.FERRYCAT_CONTRACT_ID = contract.contract_id;
  env.FERRYCAT_TASK_TYPE = contract.task_type;
  env.FERRYCAT_WORKSPACE_ROOT = contract.workspace_root;
  env.FERRYCAT_TARGET_AGENT = contract.target_agent;
  env.FERRYCAT_CLAIM_TOKEN = contract.claim_token ?? '';
  return { env, dropped };
}

// ---------------------------------------------------------------------------
// CK-04 / CK-05: Process tree supervision
// ---------------------------------------------------------------------------

export interface SupervisedChild {
  child: ChildProcess;
  pid: number | undefined;
  startedAt: number;
  /** 'close' observed: every holder of the child's stdio pipes (incl. grandchildren) is gone. */
  closed: boolean;
  closedPromise: Promise<void>;
}

const activeChildren = new Set<SupervisedChild>();

function resolveExecTarget(spec: ExecSpec): { command: string; args: string[]; shell: boolean } {
  const extraArgs = spec.args ?? [];
  if (spec.execFile) {
    const script = path.resolve(expandTilde(spec.execFile));
    const ext = path.extname(script).toLowerCase();
    if (ext === '.js' || ext === '.mjs' || ext === '.cjs') {
      return { command: process.execPath, args: [script, ...extraArgs], shell: false };
    }
    if (ext === '.ts') {
      return { command: process.execPath, args: ['--import', 'tsx', script, ...extraArgs], shell: false };
    }
    if (ext === '.ps1') {
      return {
        command: 'powershell',
        args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, ...extraArgs],
        shell: false,
      };
    }
    if (ext === '.sh') {
      return { command: 'sh', args: [script, ...extraArgs], shell: false };
    }
    return { command: script, args: [...extraArgs], shell: false };
  }
  // --exec: explicit shell compatibility mode (FC-303), unchanged semantics.
  return { command: spec.execCmd!, args: [], shell: true };
}

function waitWithTimeout(p: Promise<void>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    p.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

export function createSupervisedChild(child: ChildProcess): SupervisedChild {
  let resolveClosed!: () => void;
  const closedPromise = new Promise<void>((r) => (resolveClosed = r));
  const sup: SupervisedChild = {
    child,
    pid: child.pid,
    startedAt: Date.now(),
    closed: false,
    closedPromise,
  };
  child.once('close', () => {
    sup.closed = true;
    resolveClosed();
  });
  return sup;
}

/**
 * Terminate the child's whole process tree and wait until it is confirmed gone.
 *
 * PID-reuse safety (CK-05): we ONLY ever signal a tree that we explicitly spawned and still
 * supervise via its SupervisedChild handle. Bare numeric PID inputs are strictly forbidden
 * to eliminate inadvertent signaling of recycled OS PIDs.
 *   - POSIX: the child leads its own process group (detached: true). A PGID cannot be recycled
 *     while any member is alive, so kill(-pid) cannot hit an unrelated process group.
 *   - Windows: libuv holds the process handle until exit, so the PID cannot be recycled
 *     while the leader is alive. Once the leader exited, `taskkill /T` can no longer walk
 *     the tree; this is the documented non-equivalence vs. Job Objects (audit §1.3).
 */
export async function terminateProcessTree(
  sup: SupervisedChild,
  graceMs: number = 3000
): Promise<{ skipped?: 'ALREADY_EXITED' | 'NO_PID'; method?: string; confirmed: boolean }> {
  if (sup.closed) return { skipped: 'ALREADY_EXITED', confirmed: true };
  const pid = sup.pid;
  if (!pid) return { skipped: 'NO_PID', confirmed: sup.closed };

  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    const confirmed = await waitWithTimeout(sup.closedPromise, Math.max(2000, graceMs));
    return { method: 'taskkill /T /F', confirmed };
  }

  const signalGroup = (sig: NodeJS.Signals) => {
    try {
      process.kill(-pid, sig);
      return true;
    } catch {
      return false; // ESRCH: group already empty
    }
  };
  signalGroup('SIGTERM');
  if (await waitWithTimeout(sup.closedPromise, graceMs)) {
    return { method: 'SIGTERM(-pgid)', confirmed: true };
  }
  signalGroup('SIGKILL');
  const confirmed = await waitWithTimeout(sup.closedPromise, 2000);
  return { method: 'SIGTERM->SIGKILL(-pgid)', confirmed };
}

/**
 * Synchronous last-resort cleanup for a forced worker exit (second Ctrl+C). Because POSIX
 * children now run in their own process group, terminal SIGINT no longer reaches them, so
 * the worker must take them down explicitly instead of orphaning them.
 */
export function terminateActiveChildrenSync(): number {
  let count = 0;
  for (const sup of activeChildren) {
    if (sup.closed || !sup.pid) continue;
    count++;
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(sup.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } else {
      try {
        process.kill(-sup.pid, 'SIGKILL');
      } catch {
        // group already gone
      }
    }
  }
  return count;
}

// ---------------------------------------------------------------------------
// Execution with heartbeat lease (CK-01 / CK-02 / CK-03 / CK-07)
// ---------------------------------------------------------------------------

const SALVAGE_TAIL_CHARS = 256 * 1024;

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function stripBom(content: string): string {
  return content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
}

type AbortKind = 'WINDOW_EXHAUSTED' | 'LEASE_LOST' | 'MAX_BUFFER';

export async function executeTaskAndFulfill(
  engine: FerryCatEngine,
  contract: ContractPayload,
  spec: ExecSpec,
  opts: SupervisorOptions = {}
): Promise<ExecutionResult> {
  const emit = (event: Record<string, unknown>) => {
    try {
      opts.onEvent?.({ contract_id: contract.contract_id, ...event });
    } catch {
      // observability must never affect lifecycle correctness
    }
  };

  const effectiveTtlSec = opts.execTtlSec
    ? Math.min(contract.exec_ttl_sec, opts.execTtlSec)
    : contract.exec_ttl_sec;
  const ttlMs = effectiveTtlSec * 1000;
  const tickMs = opts.heartbeatIntervalMs ?? Math.max(100, Math.min(60000, Math.floor(ttlMs / 3)));
  const graceMs = opts.killGraceMs ?? clamp(Math.floor(ttlMs / 10), 200, 3000);
  // The guard fires early enough to terminate (grace) AND report failure before the window closes.
  const guardLeadMs = graceMs + clamp(Math.floor(ttlMs / 10), 200, 2000);
  const renewSlackMs = Math.min(1000, Math.floor(tickMs / 2));
  const maxBuffer = opts.maxBufferBytes ?? 10 * 1024 * 1024;
  const label = spec.execFile ?? spec.execCmd ?? 'exec';
  const token = contract.claim_token;

  const { env, dropped } = buildChildEnv(contract, spec.passEnv ?? []);
  emit({ event: 'ENV_SANITIZED', dropped_vars: dropped, passed_explicitly: spec.passEnv?.length ?? 0 });

  const target = resolveExecTarget(spec);
  let child: ChildProcess;
  try {
    child = spawn(target.command, target.args, {
      env,
      shell: target.shell,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true,
    });
  } catch (spawnErr) {
    return failAfterExit(
      `External exec command failed to start: ${spawnErr instanceof Error ? spawnErr.message : String(spawnErr)}`
    );
  }

  let resolveClosed!: () => void;
  const closedPromise = new Promise<void>((r) => (resolveClosed = r));
  const sup: SupervisedChild = {
    child,
    pid: child.pid,
    startedAt: Date.now(),
    closed: false,
    closedPromise,
  };
  activeChildren.add(sup);
  emit({ event: 'CHILD_SPAWNED', pid: sup.pid ?? null, started_at: sup.startedAt, tick_ms: tickMs });

  let stdout = '';
  let stderr = '';
  let stdoutBytes = 0;
  let abort: { kind: AbortKind; reason: string } | null = null;
  let salvaged = false;
  let windowEndsAt = (contract.claimed_at ?? Date.now()) + ttlMs;
  let budgetExhausted = false;
  let tickTimer: NodeJS.Timeout | undefined;
  let guardTimer: NodeJS.Timeout | undefined;

  const exitInfo = new Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: Error }>(
    (resolve) => {
      let settled = false;
      const settle = (v: { code: number | null; signal: NodeJS.Signals | null; error?: Error }) => {
        if (settled) return;
        settled = true;
        sup.closed = true;
        resolveClosed();
        resolve(v);
      };
      child.on('error', (error) => settle({ code: null, signal: null, error }));
      child.on('close', (code, signal) => settle({ code, signal }));
    }
  );

  const stopTimers = () => {
    if (tickTimer) clearInterval(tickTimer);
    if (guardTimer) clearTimeout(guardTimer);
    tickTimer = undefined;
    guardTimer = undefined;
  };

  const salvageNow = (source: string) => {
    if (!stdout && !stderr) return;
    try {
      const ok = engine.recordSalvage({
        contract_id: contract.contract_id,
        agent_id: contract.target_agent,
        claim_token: token,
        salvage: {
          source,
          captured_at: Date.now(),
          pid: sup.pid ?? null,
          started_at: sup.startedAt,
          stdout_bytes: stdoutBytes,
          truncated: stdout.length > SALVAGE_TAIL_CHARS,
          stdout_tail: stdout.slice(-SALVAGE_TAIL_CHARS),
          stderr_tail: stderr.slice(-16 * 1024),
        },
      });
      salvaged = salvaged || ok;
    } catch (err) {
      emit({ event: 'SALVAGE_FAILED', error: err instanceof Error ? err.message : String(err) });
    }
  };

  const triggerAbort = (kind: AbortKind, reason: string) => {
    if (abort) return;
    abort = { kind, reason };
    stopTimers();
    salvageNow(kind);
    emit({ event: 'CHILD_TERMINATING', kind, reason });
    void terminateProcessTree(sup, graceMs).then((r) => emit({ event: 'CHILD_TERMINATED', ...r }));
  };

  const armGuard = () => {
    if (guardTimer) clearTimeout(guardTimer);
    const delay = Math.max(0, windowEndsAt - guardLeadMs - Date.now());
    guardTimer = setTimeout(() => {
      triggerAbort(
        'WINDOW_EXHAUSTED',
        budgetExhausted
          ? 'EXEC_WINDOW_EXHAUSTED: heartbeat renewal budget exhausted (max extends or lifetime cap); child terminated before the window closed'
          : 'EXEC_WINDOW_EXHAUSTED: execution window about to close without a successful renewal; child terminated'
      );
    }, delay);
  };

  /** Re-read the row; returns true if we still hold the lease (and syncs the window). */
  const stillOwnsLease = (): boolean => {
    const snap = engine.getLeaseSnapshot(contract.contract_id);
    if (!snap || snap.status !== 'CLAIMED') return false;
    if (snap.claim_token && token && snap.claim_token !== token) return false;
    if (snap.claimed_at !== null) {
      const synced = snap.claimed_at + snap.exec_ttl_sec * 1000;
      if (synced !== windowEndsAt) {
        windowEndsAt = synced;
        armGuard();
      }
    }
    return true;
  };

  const tick = () => {
    if (abort) return;
    try {
      if (!stillOwnsLease()) {
        triggerAbort('LEASE_LOST', 'LEASE_LOST: contract is no longer CLAIMED under this claim_token');
        return;
      }
      if (budgetExhausted) return;
      // Lazy renewal: only spend one of the MAX_TTL_EXTENSIONS when the next tick would land
      // inside the guard lead. Renewing on every tick would burn the 5-extension budget in
      // under two windows (CK-01 acceptance: ttl=30s, tick=10s, 120s run must complete).
      const headroom = windowEndsAt - guardLeadMs - Date.now();
      if (headroom > tickMs + renewSlackMs) return;

      const res = engine.extendTtl({
        contract_id: contract.contract_id,
        agent_id: contract.target_agent,
        claim_token: token,
      });
      if (res.ok && res.expires_at) {
        windowEndsAt = res.expires_at;
        armGuard();
        emit({ event: 'HEARTBEAT_RENEWED', extend_count: res.extend_count, expires_at: res.expires_at });
      } else if (res.status === 'TIMED_OUT') {
        triggerAbort('LEASE_LOST', `LEASE_LOST: ${res.message}`);
      } else {
        // CK-02 reverse binding: ok:false while still CLAIMED (extend cap / lifetime cap).
        // Stop renewing; the guard (already armed for the current window) will terminate
        // the tree before the window closes instead of leaving an orphan behind.
        budgetExhausted = true;
        if (res.expires_at) windowEndsAt = res.expires_at;
        armGuard();
        emit({ event: 'HEARTBEAT_EXHAUSTED', message: res.message });
      }
    } catch (err) {
      // CK-03: optimistic-lock conflicts throw; never let a heartbeat kill the worker.
      const message = err instanceof Error ? err.message : String(err);
      emit({ event: 'HEARTBEAT_ERROR', error: message });
      try {
        if (!stillOwnsLease()) {
          triggerAbort('LEASE_LOST', `LEASE_LOST: ${message}`);
        }
      } catch (readErr) {
        emit({ event: 'HEARTBEAT_ERROR', error: readErr instanceof Error ? readErr.message : String(readErr) });
      }
    }
  };

  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    stdoutBytes += Buffer.byteLength(chunk, 'utf8');
    if (stdoutBytes > maxBuffer) {
      triggerAbort('MAX_BUFFER', `stdout exceeded maxBuffer (${maxBuffer} bytes)`);
      return;
    }
    stdout += chunk;
  });
  child.stderr?.on('data', (chunk: string) => {
    stderr = (stderr + chunk).slice(-64 * 1024);
  });

  if (child.stdin) {
    child.stdin.on('error', () => {
      // Child exited without consuming stdin, ignore EPIPE
    });
    child.stdin.write(JSON.stringify(contract));
    child.stdin.end();
  }

  armGuard();
  tickTimer = setInterval(tick, tickMs);

  const exit = await exitInfo;
  stopTimers();
  activeChildren.delete(sup);

  if (exit.error) {
    return failAfterExit(`External exec command failed with code ${(exit.error as NodeJS.ErrnoException).code ?? 1}: ${exit.error.message}`);
  }

  const abortState = abort as { kind: AbortKind; reason: string } | null;
  if (abortState?.kind === 'LEASE_LOST') {
    return { ok: false, status: 'LEASE_LOST', error: abortState.reason, salvaged };
  }
  if (abortState) {
    const res = failAfterExit(`${abortState.reason}${stderr ? ` | stderr: ${stderr.slice(-1000)}` : ''}`);
    res.status = abortState.kind === 'MAX_BUFFER' ? 'EXEC_FAILED' : 'EXEC_WINDOW_EXHAUSTED';
    res.salvaged = salvaged;
    return res;
  }

  if (exit.code !== 0) {
    salvageNow('NON_ZERO_EXIT');
    const exitDesc = exit.signal
      ? `terminated by signal ${exit.signal}`
      : `failed with code ${exit.code ?? 1}`;
    return failAfterExit(
      `External exec command ${exitDesc}: ${stderr || 'no stderr output'}`
    );
  }

  return fulfillFromStdout();

  // -------------------------------------------------------------------------

  function failAfterExit(reason: string): ExecutionResult {
    let contractStatus: string | undefined;
    try {
      contractStatus = engine.failContract({
        contract_id: contract.contract_id,
        agent_id: contract.target_agent,
        claim_token: token,
        reason: reason.slice(0, 2000),
      }).status;
    } catch (failErr) {
      contractStatus = `UNCHANGED (${failErr instanceof Error ? failErr.message : String(failErr)})`;
    }
    return { ok: false, status: 'EXEC_FAILED', error: reason, contract_status: contractStatus, salvaged };
  }

  function fulfillFromStdout(): ExecutionResult {
    let structuredOutput: Record<string, unknown> | undefined;
    let resultSummary = stripBom(stdout).trim();

    try {
      const parsed = JSON.parse(resultSummary);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        if (parsed.structured_output && typeof parsed.structured_output === 'object') {
          structuredOutput = parsed.structured_output as Record<string, unknown>;
        } else {
          structuredOutput = parsed as Record<string, unknown>;
        }
        if (parsed.result_summary && typeof parsed.result_summary === 'string') {
          resultSummary = parsed.result_summary;
        }
      }
    } catch {
      // Plain text stdout, fallback to result_summary
    }

    const boundedSummary = (resultSummary || `Completed via automated worker exec: ${label}`).slice(0, 20000);

    try {
      const validatedFulfillInput = FulfillContractSchema.parse({
        contract_id: contract.contract_id,
        agent_id: contract.target_agent,
        claim_token: token,
        result_summary: boundedSummary,
        structured_output: structuredOutput,
      });

      let fulfillRes = engine.fulfillContract(validatedFulfillInput);

      if (fulfillRes.status === 'RETRY_NEEDED') {
        // RETRY_NEEDED has two distinct causes with incompatible retry semantics:
        //   (a) schema validation failure -> retry_count increments, so retrying the
        //       same payload until the breaker trips is the intended behavior.
        //   (b) TOCTOU dirty pointers     -> retry_count does NOT move. The on-disk
        //       baseline cannot heal between two consecutive calls, so retrying only
        //       burns the single ADR-0004 strike and forces a terminal POINTER_STALE
        //       with nobody in the loop to restore the files. Never auto-retry it.
        const isToctouRejection =
          (fulfillRes.toctou_strike ?? 0) > 0 && (fulfillRes.retry_count ?? 0) === 0;
        if (isToctouRejection) {
          return {
            ok: false,
            status: 'TOCTOU_RESCUE_REQUIRED',
            fulfill_result: fulfillRes,
            error:
              'Automated exec mutated pointer files. The contract stays CLAIMED with a renewed execution window. Restore the files (git stash / git checkout) and re-run, or deliver edits via structured_output.fixes instead of writing to the workspace.',
          };
        }

        const maxAttempts = (fulfillRes.max_retries ?? 2) + 1;
        for (let i = fulfillRes.retry_count ?? 1; i < maxAttempts; i++) {
          fulfillRes = engine.fulfillContract(validatedFulfillInput);
          if (fulfillRes.status !== 'RETRY_NEEDED') break;
        }
      }

      return { ok: fulfillRes.ok, status: fulfillRes.status, fulfill_result: fulfillRes };
    } catch (fulfillErr) {
      const fulfillError = fulfillErr instanceof Error ? fulfillErr.message : String(fulfillErr);
      const res = failAfterExit(`FULFILL_ERROR: ${fulfillError}`);
      return { ...res, status: 'FULFILL_ERROR', error: fulfillError };
    }
  }
}
