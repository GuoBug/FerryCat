#!/usr/bin/env node
import { exec, execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ZodError } from 'zod';
import { expandTilde, FerryCatEngine } from './engine.js';
import {
  DispatchContractSchema,
  ExtendTtlSchema,
  FailContractSchema,
  FulfillContractSchema,
  InspectMeshStateSchema,
  PollNextTaskSchema,
  ReleaseContractSchema,
  VerifyContractSchema,
  WorkerCommandSchema,
} from './schemas.js';

function loadPackageVersion(): string {
  try {
    const pkgPath = fileURLToPath(new URL('../package.json', import.meta.url));
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { version?: string };
    return pkg.version ?? '0.3.0';
  } catch {
    return '0.3.0';
  }
}

const PKG_VERSION = loadPackageVersion();

const GLOBAL_HELP = `FerryCat CLI v${PKG_VERSION}
Contract-driven cross-host AI agent handoff & review bus over MCP and SQLite WAL.

Usage:
  ferrycat-cli <command> [options] [json_payload | -]

Commands:
  dispatch    Dispatch a new contract locking full-file SHA-256 pointers
  poll        Atomically claim the oldest SUBMITTED contract for an agent
  verify      Read-only pre-flight check of on-disk pointer files against baseline (ADR-0004)
  fulfill     Submit execution or review results (with 1-strike TOCTOU soft-failure buffer)
  release     Return a CLAIMED contract you hold back to the queue tail (max 3 releases)
  extend      Heartbeat renewal of execution window for a CLAIMED contract (max 5 extensions)
  fail        Explicitly mark a CLAIMED contract you hold as terminal FAILED with reason
  inspect     Query contracts (renders concise table by default; pass --json for raw JSON)
  worker      Run background watcher, single-shot claim, or automated script execution

Common Options:
  --agent <id>              Agent identity (overrides AGENT_NAME env var)
  --id <contract_id>        Target contract ID (for verify/fulfill/release/extend/fail/inspect)
  --file <path | ->         Read JSON payload from file path, or "-" for stdin pipe
  --help, -h                Show global help or subcommand help (e.g., ferrycat-cli worker --help)
  --version, -v             Print FerryCat version

Examples:
  # 1. Inspect pending or recent contracts for "workbuddy" as a table
  ferrycat-cli inspect --target workbuddy

  # 2. Dispatch a contract via stdin pipe (no temporary file needed)
  cat payload.json | ferrycat-cli dispatch --agent antigravity -

  # 3. Pre-flight verify pointer files before fulfilling (ADR-0004)
  ferrycat-cli verify --id fc_1792754417178_48cca09f --agent workbuddy

  # 4. Run worker in explicit mode (watch | claim | exec) with quote-free --exec-file
  ferrycat-cli worker --agent workbuddy --mode=exec --once --exec-file ./scripts/review.js`;

const SUBCOMMAND_HELP: Record<string, string> = {
  dispatch: `Usage: ferrycat-cli dispatch [--agent <requester>] [--file <path|->] ['{...}']

Dispatches a new contract and computes full-file SHA-256 fingerprints for all pointer files.

Options:
  --agent <id>        Requester agent identifier (overrides requester_agent in payload)
  --file <path | ->   JSON payload file path, or "-" to read from stdin

Examples:
  ferrycat-cli dispatch --file dispatch.json
  cat dispatch.json | ferrycat-cli dispatch --agent antigravity -`,

  poll: `Usage: ferrycat-cli poll [--agent <worker_id>]

Atomically claims the oldest SUBMITTED contract assigned to this worker agent and verifies disk fingerprints.

Options:
  --agent <id>        Worker agent identifier (defaults to AGENT_NAME env var)

Examples:
  ferrycat-cli poll --agent workbuddy`,

  verify: `Usage: ferrycat-cli verify --id <contract_id> [--agent <worker_id>]

Read-only pre-flight check (ADR-0004): verifies whether on-disk pointer files still match the
contract's dispatched SHA-256 baseline without mutating any database state.

Options:
  --id <contract_id>  Contract ID to verify (required)
  --agent <id>        Optional caller agent identifier

Examples:
  ferrycat-cli verify --id fc_1792754417178_48cca09f --agent workbuddy`,

  fulfill: `Usage: ferrycat-cli fulfill [--id <contract_id>] [--agent <worker_id>] [--token <claim_token>] [--summary <text>] [--file <path|->] ['{...}']

Submits execution or review results for a CLAIMED contract. Enforces TOCTOU fingerprint verification
(with 1-strike soft-failure buffering per ADR-0004) and Ajv JSON Schema validation.

Options:
  --id <contract_id>    Contract ID to fulfill
  --agent <id>          Holder worker agent identifier
  --token <claim_token> Exclusive lease token returned by poll (or FERRYCAT_CLAIM_TOKEN env)
  --summary <text>      Result summary text (can be used directly when structured_output is not needed)
  --file <path | ->     JSON payload file path, or "-" to read from stdin

Examples:
  ferrycat-cli fulfill --id fc_123 --agent workbuddy --token <token> --summary "Audit passed cleanly."
  cat fulfill.json | ferrycat-cli fulfill --agent workbuddy -`,

  release: `Usage: ferrycat-cli release --id <contract_id> [--agent <worker_id>] [--token <claim_token>] [--reason <text>]

Hands a CLAIMED contract back to the queue tail as SUBMITTED with a fresh queue window.
Preserves contract-level retry_count; RESETS holder-level extend_count AND toctou_strike to 0.
This is holder-level quota isolation (ADR-0004 §4.3): the next holder must not inherit a strike
consumed by a previous holder. Max 3 releases.

Options:
  --id <contract_id>    CLAIMED contract ID to release (required)
  --agent <id>          Current holder agent identifier
  --token <claim_token> Exclusive lease token returned by poll (or FERRYCAT_CLAIM_TOKEN env)
  --reason <text>       Optional reason for releasing the contract

Examples:
  ferrycat-cli release --id fc_123 --agent workbuddy --token <token> --reason "wrong local branch"`,

  extend: `Usage: ferrycat-cli extend --id <contract_id> [--agent <worker_id>] [--token <claim_token>]

Heartbeat renewal: resets claimed_at to now, restarting the contract's exec_ttl_sec window.
Max 5 extensions per holder, bounded by created_at + 4 * queue_ttl_sec.

Options:
  --id <contract_id>    CLAIMED contract ID to renew (required)
  --agent <id>          Current holder agent identifier
  --token <claim_token> Exclusive lease token returned by poll (or FERRYCAT_CLAIM_TOKEN env)

Examples:
  ferrycat-cli extend --id fc_123 --agent workbuddy --token <token>`,

  fail: `Usage: ferrycat-cli fail --id <contract_id> [--agent <worker_id>] [--token <claim_token>] --reason <text>

Explicitly transitions a CLAIMED contract to terminal FAILED state with an error reason.

Options:
  --id <contract_id>    CLAIMED contract ID to fail (required)
  --agent <id>          Current holder agent identifier
  --token <claim_token> Exclusive lease token returned by poll (or FERRYCAT_CLAIM_TOKEN env)
  --reason <text>       Mandatory explanation of why the task cannot be completed

Examples:
  ferrycat-cli fail --id fc_123 --agent workbuddy --token <token> --reason "Missing compiler toolchain"`,

  inspect: `Usage: ferrycat-cli inspect [--id <contract_id>] [--target <agent>] [--status <status>] [--limit <n>] [--format <table|json>] [--json] [--table]

Read-only inspection of mesh contracts. Renders a concise table by default; pass --json for full JSON output.

Options:
  --id <contract_id>      Inspect a specific contract ID
  --target <agent>        Filter contracts assigned to target_agent
  --status <status>       SUBMITTED | CLAIMED | COMPLETED | POINTER_STALE | VALIDATION_FAILED | TIMED_OUT | FAILED | ACTIVE | ALL
  --limit <n>             Max records to return (1..100, default: 10)
  --format <table|json>   Output format (default: table)
  --json                  Shorthand for --format=json (full raw JSON payload)
  --table                 Shorthand for --format=table

Examples:
  ferrycat-cli inspect --target workbuddy --status ACTIVE
  ferrycat-cli inspect --id fc_123 --json`,

  worker: `Usage: ferrycat-cli worker [--agent <id>] [--mode <watch|claim|exec>] [--once] [--interval <ms>] [--exec <cmd>] [--exec-file <script>]

Runs the FerryCat CLI worker in watcher, single-claim, or automated execution mode.

Options:
  --agent <id>              Worker agent identifier (defaults to AGENT_NAME env var)
  --mode <watch|claim|exec> Explicit worker mode:
                              watch: persistent non-claiming notifier loop (default when no --once/--exec)
                              claim: single-shot claim and exit (equivalent to --once without --exec)
                              exec:  auto-claim and run --exec or --exec-file
  --once                    Run a single poll cycle and exit immediately
  --interval <ms>           Polling interval in milliseconds for persistent loop (>= 100, default: 1000)
  --exec-file <script>      Recommended: script file (.js/.mjs/.cjs/.ts/.ps1/.sh) executed directly via execFile without shell interpolation
  --exec <cmd>              Shell command to run on claim (UNSAFE: executes via system shell, contract JSON piped via stdin)

Examples:
  ferrycat-cli worker --agent workbuddy --mode=watch
  ferrycat-cli worker --agent workbuddy --mode=claim
  ferrycat-cli worker --agent workbuddy --mode=exec --once --exec-file ./worker-handler.js`,
};

function stripBom(content: string): string {
  return content.replace(/^\uFEFF/, '');
}

function parseJsonPayload(raw: string, sourceLabel: string): Record<string, unknown> {
  const cleaned = stripBom(raw).trim();
  if (!cleaned) {
    throw new Error(`Empty JSON payload from ${sourceLabel}.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    throw new Error(
      `Invalid JSON in ${sourceLabel}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Payload from ${sourceLabel} must be a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

function readStdinSync(): string {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch (err) {
    throw new Error(
      `Failed to read payload from stdin: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

async function readPipedStdinWithTimeout(timeoutMs: number = 60): Promise<string> {
  if (process.stdin.isTTY) {
    return '';
  }
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.stdin.removeListener('data', onData);
      process.stdin.removeListener('end', onEnd);
      process.stdin.removeListener('error', onError);
      process.stdin.pause();
      resolve(Buffer.concat(chunks).toString('utf8'));
    };

    const onData = (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    };
    const onEnd = () => finish();
    const onError = () => finish();

    const timer = setTimeout(() => {
      if (chunks.length === 0) {
        finish();
      }
    }, timeoutMs);

    process.stdin.on('data', onData);
    process.stdin.once('end', onEnd);
    process.stdin.once('error', onError);
    process.stdin.resume();
  });
}

function normalizeArgvTokens(tokens: string[]): string[] {
  const expanded: string[] = [];
  for (const token of tokens) {
    if (token.startsWith('--') && token.includes('=')) {
      const eqIdx = token.indexOf('=');
      expanded.push(token.slice(0, eqIdx), token.slice(eqIdx + 1));
    } else {
      expanded.push(token);
    }
  }
  return expanded;
}

function requireFlagValue(flag: string, value: string | undefined): string {
  if (value === undefined || (value.startsWith('--') && value !== '-')) {
    throw new Error(`Missing value for CLI flag "${flag}".`);
  }
  return value;
}

interface ParsedCliArgs {
  command: string;
  helpRequested: boolean;
  versionRequested: boolean;
  helpTopic?: string;
  format: 'table' | 'json';
  explicitFormat: boolean;
  hasExplicitPayloadSource: boolean;
  data: Record<string, unknown>;
}

function parseArgs(argv: string[]): ParsedCliArgs {
  const rawTokens = normalizeArgvTokens(argv.slice(2));

  if (rawTokens.includes('--version') || rawTokens.includes('-v') || rawTokens[0] === 'version') {
    return {
      command: 'version',
      helpRequested: false,
      versionRequested: true,
      format: 'table',
      explicitFormat: false,
      hasExplicitPayloadSource: false,
      data: {},
    };
  }

  if (rawTokens.length === 0 || rawTokens[0] === 'help') {
    const topic = rawTokens[0] === 'help' ? rawTokens[1] : undefined;
    return {
      command: 'help',
      helpRequested: true,
      versionRequested: false,
      helpTopic: topic,
      format: 'table',
      explicitFormat: false,
      hasExplicitPayloadSource: false,
      data: {},
    };
  }

  if (rawTokens.includes('--help') || rawTokens.includes('-h')) {
    const firstNonFlag = rawTokens.find((t) => !t.startsWith('-'));
    return {
      command: 'help',
      helpRequested: true,
      versionRequested: false,
      helpTopic: firstNonFlag,
      format: 'table',
      explicitFormat: false,
      hasExplicitPayloadSource: false,
      data: {},
    };
  }

  const command = rawTokens[0];
  const rest = rawTokens.slice(1);

  let filePayload: Record<string, unknown> = {};
  let positionalPayload: Record<string, unknown> = {};
  const flagOverrides: Record<string, unknown> = {};
  let format: 'table' | 'json' = 'table';
  let explicitFormat = false;
  let hasExplicitPayloadSource = false;

  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (token === '--file') {
      const filePath = requireFlagValue('--file', rest[++i]);
      hasExplicitPayloadSource = true;
      if (filePath === '-') {
        filePayload = parseJsonPayload(readStdinSync(), 'stdin (--file -)');
      } else {
        const resolved = path.resolve(expandTilde(filePath));
        if (!fs.existsSync(resolved)) {
          throw new Error(`Payload file not found: "${filePath}" (resolved: "${resolved}").`);
        }
        filePayload = parseJsonPayload(fs.readFileSync(resolved, 'utf8'), `--file "${filePath}"`);
      }
    } else if (token === '--agent') {
      const agentVal = requireFlagValue('--agent', rest[++i]);
      flagOverrides.agent_id = agentVal;
      if (command === 'dispatch') {
        flagOverrides.requester_agent = agentVal;
      }
    } else if (token === '--target') {
      flagOverrides.target_agent = requireFlagValue('--target', rest[++i]);
    } else if (token === '--id') {
      flagOverrides.contract_id = requireFlagValue('--id', rest[++i]);
    } else if (token === '--token' || token === '--claim-token') {
      flagOverrides.claim_token = requireFlagValue(token, rest[++i]);
    } else if (token === '--status') {
      flagOverrides.status = requireFlagValue('--status', rest[++i]);
    } else if (token === '--reason') {
      flagOverrides.reason = requireFlagValue('--reason', rest[++i]);
    } else if (token === '--summary') {
      flagOverrides.result_summary = requireFlagValue('--summary', rest[++i]);
    } else if (token === '--limit') {
      const rawLimit = requireFlagValue('--limit', rest[++i]);
      const num = Number(rawLimit);
      if (!Number.isInteger(num)) {
        throw new Error(`Invalid --limit "${rawLimit}": must be an integer.`);
      }
      flagOverrides.limit = num;
    } else if (token === '--once') {
      flagOverrides.once = true;
    } else if (token === '--interval') {
      const rawInterval = requireFlagValue('--interval', rest[++i]);
      const num = Number(rawInterval);
      if (!Number.isInteger(num) || num < 100) {
        throw new Error(`Invalid --interval "${rawInterval}": must be an integer >= 100.`);
      }
      flagOverrides.interval_ms = num;
    } else if (token === '--mode') {
      const modeVal = requireFlagValue('--mode', rest[++i]).trim();
      if (modeVal !== 'watch' && modeVal !== 'claim' && modeVal !== 'exec') {
        throw new Error(
          `Invalid --mode "${modeVal}": expected one of "watch", "claim", or "exec".`
        );
      }
      flagOverrides.mode = modeVal;
    } else if (token === '--exec') {
      const cmd = requireFlagValue('--exec', rest[++i]).trim();
      if (!cmd) {
        throw new Error('Invalid --exec value: command cannot be empty.');
      }
      flagOverrides.exec = cmd;
    } else if (token === '--exec-file') {
      const scriptPath = requireFlagValue('--exec-file', rest[++i]).trim();
      if (!scriptPath) {
        throw new Error('Invalid --exec-file value: script path cannot be empty.');
      }
      flagOverrides.exec_file = scriptPath;
    } else if (token === '--format') {
      const fmt = requireFlagValue('--format', rest[++i]).trim().toLowerCase();
      if (fmt !== 'table' && fmt !== 'json') {
        throw new Error(`Invalid --format "${fmt}": expected "table" or "json".`);
      }
      format = fmt;
      explicitFormat = true;
    } else if (token === '--json') {
      format = 'json';
      explicitFormat = true;
    } else if (token === '--table') {
      format = 'table';
      explicitFormat = true;
    } else if (token === '-') {
      hasExplicitPayloadSource = true;
      positionalPayload = parseJsonPayload(readStdinSync(), 'stdin (-)');
    } else if (!token.startsWith('-')) {
      const trimmed = stripBom(token).trim();
      if (trimmed.startsWith('{')) {
        hasExplicitPayloadSource = true;
        positionalPayload = parseJsonPayload(trimmed, 'positional JSON argument');
      } else {
        throw new Error(
          `Unknown positional argument "${token}". Expected a JSON object or "-". Run "ferrycat-cli --help" for usage.`
        );
      }
    } else {
      throw new Error(
        `Unknown CLI argument: "${token}". Run "ferrycat-cli ${command} --help" for supported options.`
      );
    }
  }

  // Merge in strict precedence order: --file < positional JSON < explicit CLI flags
  const data: Record<string, unknown> = {
    ...filePayload,
    ...positionalPayload,
    ...flagOverrides,
  };

  if (!data.claim_token && process.env.FERRYCAT_CLAIM_TOKEN) {
    const envToken = process.env.FERRYCAT_CLAIM_TOKEN.trim();
    if (envToken) {
      data.claim_token = envToken;
    }
  }

  return {
    command,
    helpRequested: false,
    versionRequested: false,
    format,
    explicitFormat,
    hasExplicitPayloadSource,
    data,
  };
}

function resolveWorkerIdentity(agentId?: string): string {
  const resolved = (agentId ?? process.env.AGENT_NAME ?? '').trim();
  if (!resolved) {
    throw new Error(
      'Worker identity is missing: please provide it via --agent <id> or set AGENT_NAME environment variable.'
    );
  }
  return resolved;
}

function interruptibleSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    let timer: NodeJS.Timeout;
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

interface ContractPayload {
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

interface ExecSpec {
  execCmd?: string;
  execFile?: string;
}

function spawnExecTarget(
  spec: ExecSpec,
  options: { env: NodeJS.ProcessEnv; timeout: number; maxBuffer: number },
  callback: (err: Error | null, stdout: string, stderr: string) => void
) {
  if (spec.execFile) {
    const resolvedScript = path.resolve(expandTilde(spec.execFile));
    const ext = path.extname(resolvedScript).toLowerCase();
    if (ext === '.js' || ext === '.mjs' || ext === '.cjs') {
      return execFile(process.execPath, [resolvedScript], options, callback);
    }
    if (ext === '.ts') {
      return execFile(process.execPath, ['--import', 'tsx', resolvedScript], options, callback);
    }
    if (ext === '.ps1') {
      return execFile(
        'powershell',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', resolvedScript],
        options,
        callback
      );
    }
    if (ext === '.sh') {
      return execFile('sh', [resolvedScript], options, callback);
    }
    return execFile(resolvedScript, [], options, callback);
  }
  return exec(spec.execCmd!, options, callback);
}

async function executeTaskAndFulfill(
  engine: FerryCatEngine,
  contract: ContractPayload,
  spec: ExecSpec
): Promise<{
  ok: boolean;
  status: string;
  fulfill_result?: unknown;
  error?: string;
  contract_status?: string;
}> {
  return new Promise((resolve) => {
    const childEnv = {
      ...process.env,
      FERRYCAT_CONTRACT_ID: contract.contract_id,
      FERRYCAT_TASK_TYPE: contract.task_type,
      FERRYCAT_WORKSPACE_ROOT: contract.workspace_root,
      FERRYCAT_TARGET_AGENT: contract.target_agent,
      FERRYCAT_CLAIM_TOKEN: contract.claim_token ?? '',
    };

    const timeoutMs = Math.max(10000, contract.exec_ttl_sec * 1000);
    const maxBuffer = 10 * 1024 * 1024;
    const label = spec.execFile ?? spec.execCmd ?? 'exec';

    const child = spawnExecTarget(
      spec,
      { env: childEnv, timeout: timeoutMs, maxBuffer },
      (err, stdout, stderr) => {
        if (err) {
          const execErr = err as Error & { code?: number | string; killed?: boolean };
          const execError = `External exec command failed with code ${execErr.code ?? 1}${execErr.killed ? ' (killed after exec timeout)' : ''}: ${stderr || execErr.message}`;
          let contractStatus: string | undefined;
          try {
            contractStatus = engine.failContract({
              contract_id: contract.contract_id,
              agent_id: contract.target_agent,
              claim_token: contract.claim_token,
              reason: execError.slice(0, 2000),
            }).status;
          } catch (failErr) {
            contractStatus = `UNCHANGED (${failErr instanceof Error ? failErr.message : String(failErr)})`;
          }
          return resolve({
            ok: false,
            status: 'EXEC_FAILED',
            error: execError,
            contract_status: contractStatus,
          });
        }

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

        const boundedSummary = (
          resultSummary || `Completed via automated worker exec: ${label}`
        ).slice(0, 20000);

        try {
          const validatedFulfillInput = FulfillContractSchema.parse({
            contract_id: contract.contract_id,
            agent_id: contract.target_agent,
            claim_token: contract.claim_token,
            result_summary: boundedSummary,
            structured_output: structuredOutput,
          });

          let fulfillRes = engine.fulfillContract(validatedFulfillInput);

          // If RETRY_NEEDED occurs in automated exec (schema retry vs TOCTOU strike 1):
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
              resolve({
                ok: false,
                status: 'TOCTOU_RESCUE_REQUIRED',
                fulfill_result: fulfillRes,
                error:
                  'Automated exec mutated pointer files. The contract stays CLAIMED with a renewed execution window. Restore the files (git stash / git checkout) and re-run, or deliver edits via structured_output.fixes instead of writing to the workspace.',
              });
              return;
            }

            const maxAttempts = (fulfillRes.max_retries ?? 2) + 1;
            for (let i = fulfillRes.retry_count ?? 1; i < maxAttempts; i++) {
              fulfillRes = engine.fulfillContract(validatedFulfillInput);
              if (fulfillRes.status !== 'RETRY_NEEDED') break;
            }
          }

          resolve({ ok: fulfillRes.ok, status: fulfillRes.status, fulfill_result: fulfillRes });
        } catch (fulfillErr) {
          const fulfillError =
            fulfillErr instanceof Error ? fulfillErr.message : String(fulfillErr);
          let contractStatus: string | undefined;
          try {
            contractStatus = engine.failContract({
              contract_id: contract.contract_id,
              agent_id: contract.target_agent,
              reason: `FULFILL_ERROR: ${fulfillError}`.slice(0, 2000),
            }).status;
          } catch {
            contractStatus = undefined;
          }
          resolve({
            ok: false,
            status: 'FULFILL_ERROR',
            error: fulfillError,
            contract_status: contractStatus,
          });
        }
      }
    );

    if (child.stdin) {
      child.stdin.on('error', () => {
        // Child process exited without consuming stdin, ignore EPIPE
      });
      child.stdin.write(JSON.stringify(contract));
      child.stdin.end();
    }
  });
}

async function runWorkerLoop(
  engine: FerryCatEngine,
  agentId: string | undefined,
  intervalMs: number,
  spec: ExecSpec
): Promise<void> {
  const resolvedAgent = resolveWorkerIdentity(agentId);
  const abortController = new AbortController();
  let running = true;
  let sigintCount = 0;
  let lastNotifiedIds = '';
  const hasExec = Boolean(spec.execCmd || spec.execFile);

  console.log(
    JSON.stringify({
      status: 'WORKER_STARTED',
      agent_id: resolvedAgent,
      interval_ms: intervalMs,
      mode: hasExec ? 'AUTO_EXEC_AND_FULFILL' : 'WATCHER_ONLY',
      exec_command: spec.execCmd ?? null,
      exec_file: spec.execFile ?? null,
      message: hasExec
        ? `FerryCat worker running in auto-claim & execute mode on agent "${resolvedAgent}"...`
        : `FerryCat worker running in watcher/notifier mode on agent "${resolvedAgent}" (will not claim without --exec / --exec-file)...`,
    })
  );

  const stopHandler = () => {
    sigintCount++;
    if (sigintCount >= 2) {
      console.error(
        JSON.stringify({
          status: 'WORKER_FORCE_EXIT',
          message: 'Second interrupt received, exiting immediately.',
        })
      );
      process.exit(130);
    }
    running = false;
    abortController.abort();
    console.log(
      JSON.stringify({
        status: 'WORKER_STOPPING',
        agent_id: resolvedAgent,
        message: 'Worker stopping gracefully on signal (send again to force)...',
      })
    );
  };

  process.on('SIGINT', stopHandler);
  process.on('SIGTERM', stopHandler);

  while (running) {
    try {
      if (hasExec) {
        const pollRes = engine.pollNextTask({ agent_id: resolvedAgent });
        if (pollRes.has_task && pollRes.contract) {
          console.log(
            JSON.stringify({
              event: 'TASK_CLAIMED',
              contract_id: pollRes.contract.contract_id,
              task_type: pollRes.contract.task_type,
              title: pollRes.contract.title,
            })
          );

          const execRes = await executeTaskAndFulfill(
            engine,
            pollRes.contract as unknown as ContractPayload,
            spec
          );
          console.log(
            JSON.stringify({
              event: 'TASK_EXECUTION_COMPLETED',
              contract_id: pollRes.contract.contract_id,
              status: execRes.status,
              ok: execRes.ok,
              error: execRes.error ?? null,
              contract_status: execRes.contract_status ?? execRes.status,
            })
          );
        }
      } else {
        // Watcher-only mode: query SQLite filtered by target_agent directly
        const state = engine.inspectMeshState({
          status: 'SUBMITTED',
          target_agent: resolvedAgent,
          limit: 100,
        });
        const pendingForAgent = state.contracts;
        const currentIds = pendingForAgent
          .map((c) => String(c.contract_id))
          .sort()
          .join(',');

        if (pendingForAgent.length > 0 && currentIds !== lastNotifiedIds) {
          lastNotifiedIds = currentIds;
          console.log(
            JSON.stringify({
              event: 'PENDING_TASKS_DETECTED',
              agent_id: resolvedAgent,
              pending_count: pendingForAgent.length,
              pending_contracts: pendingForAgent.map((c) => ({
                contract_id: c.contract_id,
                title: c.title,
                created_at: c.created_at,
              })),
              message:
                'Pending tasks detected. Run with --mode=exec (--exec / --exec-file) for automated processing or claim explicitly via poll.',
            })
          );
        } else if (pendingForAgent.length === 0) {
          lastNotifiedIds = '';
        }
      }
    } catch (err) {
      console.error(
        JSON.stringify({
          event: 'WORKER_CYCLE_ERROR',
          error: err instanceof Error ? err.message : String(err),
        })
      );
    }

    if (running) {
      await interruptibleSleep(intervalMs, abortController.signal);
    }
  }
}

function formatDurationSec(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const remSec = sec % 60;
  if (min < 60) return `${min}m${String(remSec).padStart(2, '0')}s`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return `${hr}h${String(remMin).padStart(2, '0')}m`;
}

function truncateCell(str: string, maxLen: number): string {
  const singleLine = str.replace(/\r?\n/g, ' ').trim();
  if (singleLine.length <= maxLen) return singleLine;
  return singleLine.slice(0, Math.max(1, maxLen - 3)) + '...';
}

function formatInspectTable(
  state: { total_returned: number; contracts: Array<Record<string, unknown>> },
  singleContractView: boolean
): string {
  if (state.contracts.length === 0) {
    return 'No matching contracts found. (Pass --json for raw JSON output)';
  }

  const nowMs = Date.now();
  const rows = state.contracts.map((c) => {
    const id = String(c.contract_id ?? '');
    const rawStatus = String(c.status ?? '');
    const status = c.is_logically_expired ? `${rawStatus}*` : rawStatus;
    const route = `${c.requester_agent ?? '?'}->${c.target_agent ?? '?'}`;
    const type = String(c.task_type ?? '');
    const createdAt = Number(c.created_at ?? nowMs);
    const completedAt = c.completed_at ? Number(c.completed_at) : null;
    const elapsedMs = completedAt ? completedAt - createdAt : nowMs - createdAt;
    const elapsed = formatDurationSec(elapsedMs);
    const title = truncateCell(String(c.title ?? ''), 42);
    return { id, status, route, type, elapsed, title };
  });

  const headers = {
    id: 'CONTRACT_ID',
    status: 'STATUS',
    route: 'ROUTE',
    type: 'TASK_TYPE',
    elapsed: 'ELAPSED',
    title: 'TITLE',
  };

  const widths = {
    id: Math.max(headers.id.length, ...rows.map((r) => r.id.length)),
    status: Math.max(headers.status.length, ...rows.map((r) => r.status.length)),
    route: Math.max(headers.route.length, ...rows.map((r) => r.route.length)),
    type: Math.max(headers.type.length, ...rows.map((r) => r.type.length)),
    elapsed: Math.max(headers.elapsed.length, ...rows.map((r) => r.elapsed.length)),
    title: Math.max(headers.title.length, ...rows.map((r) => r.title.length)),
  };

  const pad = (val: string, len: number) => val.padEnd(len, ' ');
  const headerLine = [
    pad(headers.id, widths.id),
    pad(headers.status, widths.status),
    pad(headers.route, widths.route),
    pad(headers.type, widths.type),
    pad(headers.elapsed, widths.elapsed),
    headers.title,
  ].join('  ');

  const divider = [
    '-'.repeat(widths.id),
    '-'.repeat(widths.status),
    '-'.repeat(widths.route),
    '-'.repeat(widths.type),
    '-'.repeat(widths.elapsed),
    '-'.repeat(widths.title),
  ].join('  ');

  const bodyLines = rows.map((r) =>
    [
      pad(r.id, widths.id),
      pad(r.status, widths.status),
      pad(r.route, widths.route),
      pad(r.type, widths.type),
      pad(r.elapsed, widths.elapsed),
      r.title,
    ].join('  ')
  );

  const lines = [
    `FerryCat Mesh Contracts (${state.total_returned} returned):`,
    headerLine,
    divider,
    ...bodyLines,
  ];

  if (singleContractView && state.contracts.length === 1) {
    const c = state.contracts[0];
    lines.push('');
    lines.push(
      `Counters : retry=${c.retry_count}/${c.max_retries}  extend=${c.extend_count}  release=${c.release_count}  toctou_strike=${c.toctou_strike ?? 0}`
    );
    if (c.error_reason) {
      lines.push(`Error    : ${c.error_reason}`);
    }
    if (c.result_summary) {
      lines.push(`Result   : ${truncateCell(String(c.result_summary), 200)}`);
    }
    if (c.salvaged_result) {
      lines.push(`Salvaged : Preserved in salvaged_result (pass --json to inspect full payload)`);
    }
  }

  lines.push(`\nTip: pass --json (or --format=json) for full raw JSON output.`);
  return lines.join('\n');
}

function formatCliError(err: unknown, command: string): string {
  if (err instanceof ZodError) {
    const issues = err.issues.map((issue) => {
      const pathStr = issue.path.length > 0 ? issue.path.join('.') : '(payload)';
      return `missing/invalid "${pathStr}" (${issue.message})`;
    });
    const cmdHint = command && SUBCOMMAND_HELP[command] ? `${command} --help` : '--help';
    return `Validation failed for "${command || 'cli'}": ${issues.join('; ')}. Run "ferrycat-cli ${cmdHint}" for usage.`;
  }
  return err instanceof Error ? err.message : String(err);
}

async function main(): Promise<void> {
  let parsed: ParsedCliArgs;
  try {
    parsed = parseArgs(process.argv);
  } catch (err) {
    console.error(
      JSON.stringify(
        { ok: false, error: formatCliError(err, process.argv[2] ?? '') },
        null,
        2
      )
    );
    process.exitCode = 1;
    return;
  }

  if (parsed.versionRequested) {
    console.log(PKG_VERSION);
    return;
  }

  if (parsed.helpRequested) {
    const topic = parsed.helpTopic?.toLowerCase();
    if (topic && SUBCOMMAND_HELP[topic]) {
      console.log(SUBCOMMAND_HELP[topic]);
    } else {
      console.log(GLOBAL_HELP);
    }
    return;
  }

  const { command, data } = parsed;
  let engine: FerryCatEngine | undefined;

  try {
    // Auto-detect piped stdin for payload-consuming commands when neither --file nor positional JSON was passed
    if (
      (command === 'dispatch' || command === 'fulfill') &&
      !parsed.hasExplicitPayloadSource &&
      !process.stdin.isTTY
    ) {
      const piped = await readPipedStdinWithTimeout(60);
      if (piped.trim().length > 0) {
        const stdinObj = parseJsonPayload(piped, 'piped stdin');
        // Explicit CLI flags in `data` take precedence over piped stdin fields
        for (const [k, v] of Object.entries(stdinObj)) {
          if (data[k] === undefined) {
            data[k] = v;
          }
        }
      }
    }

    let output: unknown;

    switch (command) {
      case 'dispatch': {
        if (!data.requester_agent && data.agent_id) {
          data.requester_agent = data.agent_id;
        }
        engine = new FerryCatEngine();
        output = engine.dispatchContract(DispatchContractSchema.parse(data));
        console.log(JSON.stringify(output, null, 2));
        break;
      }
      case 'poll': {
        engine = new FerryCatEngine();
        output = engine.pollNextTask(PollNextTaskSchema.parse(data));
        console.log(JSON.stringify(output, null, 2));
        break;
      }
      case 'verify': {
        engine = new FerryCatEngine();
        output = engine.verifyContract(VerifyContractSchema.parse(data));
        console.log(JSON.stringify(output, null, 2));
        break;
      }
      case 'fulfill': {
        engine = new FerryCatEngine();
        output = engine.fulfillContract(FulfillContractSchema.parse(data));
        console.log(JSON.stringify(output, null, 2));
        break;
      }
      case 'inspect': {
        engine = new FerryCatEngine();
        const state = engine.inspectMeshState(InspectMeshStateSchema.parse(data));
        if (parsed.format === 'json') {
          console.log(JSON.stringify(state, null, 2));
        } else {
          console.log(formatInspectTable(state, Boolean(data.contract_id)));
        }
        break;
      }
      case 'release': {
        engine = new FerryCatEngine();
        output = engine.releaseContract(ReleaseContractSchema.parse(data));
        console.log(JSON.stringify(output, null, 2));
        break;
      }
      case 'extend': {
        engine = new FerryCatEngine();
        output = engine.extendTtl(ExtendTtlSchema.parse(data));
        console.log(JSON.stringify(output, null, 2));
        break;
      }
      case 'fail': {
        engine = new FerryCatEngine();
        output = engine.failContract(FailContractSchema.parse(data));
        console.log(JSON.stringify(output, null, 2));
        break;
      }
      case 'worker': {
        const validated = WorkerCommandSchema.parse(data);
        const resolvedAgent = resolveWorkerIdentity(validated.agent_id);

        if (validated.exec && validated.exec_file) {
          throw new Error('Cannot specify both --exec and --exec-file; please choose one.');
        }

        if (validated.exec) {
          console.error(
            '[FerryCat Security Notice] --exec executes commands via system shell with shell interpolation. For safer execution, prefer --exec-file <script>.'
          );
        }

        if (validated.exec_file) {
          const resolvedScript = path.resolve(expandTilde(validated.exec_file));
          if (!fs.existsSync(resolvedScript)) {
            throw new Error(
              `Worker --exec-file script does not exist: "${validated.exec_file}" (resolved: "${resolvedScript}").`
            );
          }
        }

        const hasExec = Boolean(validated.exec || validated.exec_file);

        // Normalize explicit --mode with backward-compatible --once / --exec flags
        let effectiveOnce = Boolean(validated.once);
        if (validated.mode === 'watch') {
          if (hasExec) {
            throw new Error(
              'Worker --mode=watch cannot be combined with --exec or --exec-file (use --mode=exec instead).'
            );
          }
          if (validated.once) {
            throw new Error(
              'Worker --mode=watch is for persistent monitoring and cannot be combined with --once (use --mode=claim instead).'
            );
          }
          effectiveOnce = false;
        } else if (validated.mode === 'claim') {
          if (hasExec) {
            throw new Error(
              'Worker --mode=claim cannot be combined with --exec or --exec-file (use --mode=exec instead).'
            );
          }
          effectiveOnce = true;
        } else if (validated.mode === 'exec') {
          if (!hasExec) {
            throw new Error(
              'Worker --mode=exec requires either --exec <cmd> or --exec-file <script>.'
            );
          }
        }

        const execSpec: ExecSpec = {
          execCmd: validated.exec,
          execFile: validated.exec_file,
        };

        engine = new FerryCatEngine();

        if (effectiveOnce) {
          const pollRes = engine.pollNextTask({ agent_id: resolvedAgent });
          if (!pollRes.has_task || !pollRes.contract) {
            // Preserve engine's specific poll status/message/stale_error (fixes G8)
            output = {
              has_task: false,
              agent_id: resolvedAgent,
              ...(pollRes.status ? { status: pollRes.status } : {}),
              ...(pollRes.stale_error ? { stale_error: pollRes.stale_error } : {}),
              message: pollRes.message ?? `No pending contracts for agent "${resolvedAgent}".`,
            };
            console.log(JSON.stringify(output, null, 2));
          } else if (hasExec) {
            const execRes = await executeTaskAndFulfill(
              engine,
              pollRes.contract as unknown as ContractPayload,
              execSpec
            );
            output = {
              has_task: true,
              agent_id: resolvedAgent,
              contract_id: pollRes.contract.contract_id,
              execution: execRes,
            };
            console.log(JSON.stringify(output, null, 2));
          } else {
            output = {
              ...pollRes,
              mode: 'CLAIM_ONLY',
              notice:
                'Task claimed. Provide --exec <cmd> / --exec-file <script> to automatically execute and fulfill, or invoke fulfill subcommand.',
            };
            console.log(JSON.stringify(output, null, 2));
          }
        } else {
          await runWorkerLoop(
            engine,
            resolvedAgent,
            validated.interval_ms ?? 1000,
            execSpec
          );
        }
        break;
      }
      default:
        throw new Error(
          `Unknown subcommand "${command}". Supported commands: dispatch, poll, verify, fulfill, release, extend, fail, inspect, worker. Run "ferrycat-cli --help" for usage.`
        );
    }
  } catch (err) {
    console.error(
      JSON.stringify(
        { ok: false, error: formatCliError(err, command) },
        null,
        2
      )
    );
    process.exitCode = 1;
  } finally {
    engine?.close();
  }
}

main().catch((err) => {
  console.error('Fatal CLI Error:', err);
  process.exitCode = 1;
});
