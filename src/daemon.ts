/**
 * FerryCat Controlled Daemon (Phase 3 Step 1, ADR-0005 Hardened).
 *
 * Provides a production-grade, background-ready execution orchestrator:
 *   - Short-transaction CAS leases on `daemon_locks` table.
 *   - Cryptographically random per-process owner token (prevents split-brain on identical configs).
 *   - Automatic process tree termination on lease loss (CK-04/05).
 *   - Safe heartbeat intervals clamped to <= lease_ttl_sec / 2.
 *   - Robust heartbeat exception recovery.
 *   - Declarative handler execution with args and environment forwarding.
 *   - Graceful shutdown on SIGINT/SIGTERM.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { FerryCatEngine, expandTilde } from './engine.js';
import {
  FerryCatConfigFileSchema,
  type FerryCatConfigFile,
  type HandlerDefinition,
} from './schemas.js';
import { executeTaskAndFulfill, terminateActiveChildrenSync } from './supervisor.js';
import type { PollNextTaskResult } from './types.js';

export interface DaemonOptions {
  configPath?: string;
  dbPath?: string;
  journalPath?: string;
  targetAgent?: string;
  lockId?: string;
  leaseTtlSec?: number;
  heartbeatIntervalMs?: number;
  pollIntervalMs?: number;
  once?: boolean;
  notify?: boolean;
}

export type DaemonJournalEvent =
  | 'TASK_DISPATCHING'
  | 'CHILD_SPAWNED'
  | 'TASK_SETTLED'
  | 'CRASH_RECOVERED';

export type JournalRecoveryAction =
  | 'RELEASED_TO_QUEUE'
  | 'MARKED_FAILED_MAX_RELEASES'
  | 'MARKED_FAILED_MUTATION_UNSAFE'
  | 'MARKED_FAILED_MISSING_CLAIM_TOKEN'
  | 'QUARANTINED_ORPHAN_ALIVE'
  | 'ALREADY_SETTLED';

export interface DaemonJournalEntry {
  seq: number;
  timestamp: number;
  event: DaemonJournalEvent;
  daemon_owner_token: string;
  daemon_pid: number;
  /** R3: wall-clock start time of the writing daemon process, used to disambiguate PID reuse. */
  daemon_started_at?: number;
  lock_id: string;
  contract_id: string;
  target_agent: string;
  task_type?: string;
  claim_token?: string;
  exec_file?: string;
  child_pid?: number | null;
  child_started_at?: number;
  final_status?: string;
  previous_owner_token?: string;
  recovery_action?: JournalRecoveryAction;
}

export interface JournalRecoveryItem {
  contract_id: string;
  target_agent: string;
  claim_token?: string;
  previous_owner_token: string;
  previous_pid: number;
  child_pid?: number | null;
  action: JournalRecoveryAction;
}

const MAX_JOURNAL_LINES_BEFORE_COMPACT = 500;
const COMPACT_RETAIN_LINES = 100;

/**
 * Non-destructive OS liveness probe via `process.kill(pid, 0)`.
 * Never sends a termination signal (respecting CK-05 PID-reuse safety), only checks whether
 * the OS kernel still reports an active process for `pid`.
 */
export function isProcessAlive(pid?: number | null): boolean {
  if (!pid || typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'code' in err && (err as { code?: string }).code === 'EPERM') {
      return true;
    }
    return false;
  }
}

export function loadFerryCatConfig(customConfigPath?: string): {
  config: FerryCatConfigFile;
  resolvedPath: string | null;
} {
  const candidatePaths: string[] = [];

  if (customConfigPath) {
    candidatePaths.push(path.resolve(expandTilde(customConfigPath)));
  }
  if (process.env.FERRYCAT_CONFIG) {
    candidatePaths.push(path.resolve(expandTilde(process.env.FERRYCAT_CONFIG)));
  }
  candidatePaths.push(path.resolve(process.cwd(), 'ferrycat.config.json'));
  candidatePaths.push(path.join(os.homedir(), '.ferrycat', 'config.json'));

  for (const candidate of candidatePaths) {
    if (fs.existsSync(candidate)) {
      try {
        const raw = fs.readFileSync(candidate, 'utf8');
        const parsed = JSON.parse(raw);
        const validated = FerryCatConfigFileSchema.parse(parsed);
        return { config: validated, resolvedPath: candidate };
      } catch (err) {
        throw new Error(
          `Failed to parse FerryCat configuration file at '${candidate}': ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
    }
  }

  // Return empty valid default configuration if no file exists
  return {
    config: FerryCatConfigFileSchema.parse({}),
    resolvedPath: null,
  };
}

export type NotifyLevel = 'info' | 'warn' | 'error';

export interface NotifyOptions {
  level?: NotifyLevel;
  /** Stable machine-readable event name forwarded to the webhook payload. */
  event?: string;
  /** Explicit webhook endpoint; falls back to FERRYCAT_WEBHOOK_URL when omitted. */
  webhookUrl?: string;
  /** Set false to suppress the native OS toast (e.g. in CI or headless runs). */
  native?: boolean;
}

export interface WebhookPayload {
  event: string;
  title: string;
  message: string;
  timestamp: string;
  level: NotifyLevel;
}

const NOTIFY_WEBHOOK_TIMEOUT_MS = 3000;

/**
 * Process-level webhook endpoint registered by the active daemon instance. Call sites deep inside
 * signal handlers cannot reach `this`, so the resolved config value lives here instead of being
 * threaded through every notifyOperator() call.
 */
let activeWebhookUrl: string | undefined;

export function setNotifyWebhook(url: string | undefined): void {
  const trimmed = (url ?? '').trim();
  activeWebhookUrl = trimmed.length > 0 ? trimmed : undefined;
}

export function getNotifyWebhook(): string | undefined {
  return activeWebhookUrl;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Resolve the platform-native notification command (FC-403).
 * Windows uses a WinRT Toast driven by the PowerShell host's own AppId so no module install is
 * required; macOS uses `display notification`; Linux uses libnotify's `notify-send`.
 */
export function resolveNativeCommand(
  title: string,
  message: string,
  platform: NodeJS.Platform = process.platform
): { cmd: string; args: string[] } {
  if (platform === 'win32') {
    const toastXml =
      `<toast><visual><binding template="ToastText02">` +
      `<text id="1">${escapeXml(title)}</text><text id="2">${escapeXml(message)}</text>` +
      `</binding></visual></toast>`;
    // Reuse PowerShell's own registered AppId so the toast renders without an installed module.
    const appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe';
    const script = [
      "$ErrorActionPreference = 'Stop'",
      '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null',
      '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null',
      `$xml = New-Object Windows.Data.Xml.Dom.XmlDocument`,
      `$xml.LoadXml(@'`,
      toastXml,
      `'@)`,
      `$toast = New-Object Windows.UI.Notifications.ToastNotification $xml`,
      `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${appId}').Show($toast)`,
    ].join('\n');
    return {
      cmd: 'powershell',
      args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    };
  }

  if (platform === 'darwin') {
    return {
      cmd: 'osascript',
      args: [
        '-e',
        'on run argv',
        '-e',
        'display notification (item 2 of argv) with title (item 1 of argv)',
        '-e',
        'end run',
        '--',
        title,
        message,
      ],
    };
  }

  return { cmd: 'notify-send', args: ['--app-name=FerryCat', title, message] };
}

/**
 * Fire-and-forget native toast. Deliberately synchronous-returning: the child is spawned,
 * immediately unref'd, and every failure path (missing binary, EPERM, sandbox denial) is
 * swallowed. A notification must never block or crash the daemon event loop.
 */
function dispatchNativeNotification(title: string, message: string): void {
  try {
    const { cmd, args } = resolveNativeCommand(title, message);
    const child = spawn(cmd, args, { stdio: 'ignore', windowsHide: true, detached: true });
    // Without an 'error' listener, a missing binary surfaces as an uncaughtException and kills us.
    child.on('error', () => {});
    child.unref();
  } catch {
    // Silent by contract (FC-403 defense red line).
  }
}

/**
 * Deliver one webhook payload. Exported so tests can await the real HTTP round-trip; production
 * call sites use the fire-and-forget wrapper below.
 */
export async function dispatchWebhook(
  url: string,
  payload: WebhookPayload,
  timeoutMs: number = NOTIFY_WEBHOOK_TIMEOUT_MS
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (typeof timer.unref === 'function') timer.unref();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', connection: 'close' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    // Drain the body so the socket can be released even if the receiver wrote something.
    await res.text().catch(() => '');
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Derive a severity from the notice title so existing call sites gain levels without churn. */
function inferLevel(title: string): NotifyLevel {
  if (/error|fail|lost|exhausted|crash/i.test(title)) return 'error';
  if (/warn|unhandled|stale|timeout|retry/i.test(title)) return 'warn';
  return 'info';
}

/** Derive a stable SCREAMING_SNAKE event name (e.g. "Lease Lost" -> "LEASE_LOST"). */
function inferEvent(title: string): string {
  return title
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

export function notifyOperator(
  title: string,
  message: string,
  opts: NotifyOptions = {}
): void {
  const level: NotifyLevel = opts.level ?? inferLevel(title);
  const event = opts.event ?? inferEvent(title);
  const webhookUrl = (
    opts.webhookUrl ??
    activeWebhookUrl ??
    process.env.FERRYCAT_WEBHOOK_URL ??
    ''
  ).trim();

  try {
    const timestamp = new Date().toISOString();
    // Always emit structured line to stderr/stdout
    process.stderr.write(
      `[FerryCat Daemon Notice] ${timestamp} | ${level.toUpperCase()} | ${title}: ${message}\n`
    );
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'code' in err && (err as { code: string }).code === 'EPIPE') {
      // EPIPE indicates downstream logger closed its pipe early; safe to swallow silently
      return;
    }
  }

  // Native toast: skipped when explicitly disabled or when the caller is headless.
  if (opts.native !== false) {
    dispatchNativeNotification(title, message);
  }

  // Webhook: never awaited, never rejects into the caller.
  if (webhookUrl) {
    void dispatchWebhook(webhookUrl, {
      event,
      title,
      message,
      timestamp: new Date().toISOString(),
      level,
    });
  }
}

export class FerryCatDaemon {
  public readonly engine: FerryCatEngine;
  public readonly config: FerryCatConfigFile;
  public readonly configPath: string | null;
  public readonly journalPath: string;
  public readonly lockId: string;
  public readonly leaseTtlSec: number;
  public readonly heartbeatIntervalMs: number;
  public readonly pollIntervalMs: number;
  public readonly ownerToken: string;
  public readonly targetAgentFilter?: string;
  public readonly notifyEnabled: boolean;
  public readonly webhookUrl?: string;
  /** R3: wall-clock start of this daemon instance, journaled so a successor can disambiguate PID reuse. */
  public readonly daemonStartedAt: number = Math.floor(Date.now() - process.uptime() * 1000);
  public journalDegraded: boolean = false;
  public lastJournalError: string | null = null;

  private isRunning: boolean = false;
  private isLeader: boolean = false;
  private journalSeq: number = 0;
  private settledSinceLastCompact: number = 0;
  private journalDegradedReported: boolean = false;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private signalCleanupRegistered: boolean = false;
  private activeInFlightContract: { contract_id: string; target_agent: string; claim_token?: string } | null = null;

  constructor(options: DaemonOptions = {}) {
    const { config, resolvedPath } = loadFerryCatConfig(options.configPath);
    this.config = config;
    this.configPath = resolvedPath;

    this.engine = new FerryCatEngine({ dbPath: options.dbPath });

    this.lockId = options.lockId ?? config.daemon.lock_id ?? 'global';
    const safeLockSuffix =
      this.lockId === 'global'
        ? 'daemon-journal.jsonl'
        : `daemon-journal-${this.lockId.replace(/[^a-zA-Z0-9_-]/g, '_')}.jsonl`;

    const customJournal = options.journalPath ?? config.daemon.journal_path;
    this.journalPath = customJournal
      ? path.resolve(expandTilde(customJournal))
      : path.join(path.dirname(this.engine.dbPath), safeLockSuffix);

    // Backfill journalSeq from existing journal entries so seq stays strictly monotonic across restarts
    const existingEntries = this.readJournalEntries();
    for (const entry of existingEntries) {
      if (typeof entry.seq === 'number' && Number.isFinite(entry.seq) && entry.seq > this.journalSeq) {
        this.journalSeq = entry.seq;
      }
    }
    
    // Ensure lease TTL is at least 5 seconds
    const reqTtl = options.leaseTtlSec ?? config.daemon.lease_ttl_sec ?? 30;
    this.leaseTtlSec = Math.max(5, reqTtl);

    // Enforce heartbeat interval <= leaseTtl / 2 to prevent false expirations
    const reqHeartbeat = options.heartbeatIntervalMs ?? config.daemon.heartbeat_interval_ms ?? 5000;
    const maxHeartbeat = Math.floor((this.leaseTtlSec * 1000) / 2);
    this.heartbeatIntervalMs = Math.min(reqHeartbeat, maxHeartbeat);

    this.pollIntervalMs = options.pollIntervalMs ?? config.daemon.poll_interval_ms ?? 1000;

    // Critical Finding 1: Never accept a static shared owner_token across daemon processes.
    // Always generate a unique cryptographic token per runtime instance.
    this.ownerToken = `daemon-${process.pid}-${crypto.randomBytes(8).toString('hex')}`;

    this.targetAgentFilter = options.targetAgent;
    this.notifyEnabled = options.notify ?? config.daemon.notify ?? true;
    this.webhookUrl = config.daemon.webhook_url;

    // FC-403: expose the declarative webhook to notifyOperator() call sites when configured,
    // without wiping a previously registered endpoint when a secondary instance omits webhook_url.
    if (config.daemon.webhook_url !== undefined) {
      setNotifyWebhook(config.daemon.webhook_url);
    }
  }

  public registerSignalHandlers(): void {
    if (this.signalCleanupRegistered) return;
    this.signalCleanupRegistered = true;

    const cleanup = (sig: string) => {
      if (this.notifyEnabled) {
        notifyOperator('Shutdown', `Received ${sig}, terminating children and releasing lease...`, {
          webhookUrl: this.webhookUrl,
        });
      }
      this.stop();
      terminateActiveChildrenSync();
      this.engine.releaseDaemonLease({ lock_id: this.lockId, owner_token: this.ownerToken });
      this.engine.close();
      process.exit(0);
    };

    process.once('SIGINT', () => cleanup('SIGINT'));
    process.once('SIGTERM', () => cleanup('SIGTERM'));
  }

  public acquireLease(): boolean {
    const wasLeader = this.isLeader;
    try {
      const res = this.engine.acquireDaemonLease({
        lock_id: this.lockId,
        owner_token: this.ownerToken,
        ttl_sec: this.leaseTtlSec,
        metadata: {
          pid: process.pid,
          hostname: os.hostname(),
          platform: process.platform,
          config_path: this.configPath,
        },
      });

      if (res.ok) {
        this.isLeader = true;
        if (!wasLeader) {
          this.recoverFromJournal();
        }
        return true;
      }
      this.isLeader = false;
      return false;
    } catch (err) {
      this.isLeader = false;
      if (this.notifyEnabled) {
        notifyOperator('Lease Error', `Acquire lease error: ${err instanceof Error ? err.message : String(err)}`, {
          webhookUrl: this.webhookUrl,
        });
      }
      return false;
    }
  }

  /**
   * Synchronously appends a write-ahead record to `daemon-journal.jsonl` (Phase 3 Step 2).
   * Guaranteed to flush before child spawn and after task completion so sudden SIGKILL / power loss
   * leaves an auditable breadcrumb for the next daemon leader to self-heal.
   */
  public appendJournalEntry(
    partial: Omit<
      DaemonJournalEntry,
      'seq' | 'timestamp' | 'daemon_owner_token' | 'daemon_pid' | 'daemon_started_at' | 'lock_id'
    >
  ): DaemonJournalEntry {
    this.journalSeq += 1;
    const entry: DaemonJournalEntry = {
      seq: this.journalSeq,
      timestamp: Date.now(),
      daemon_owner_token: this.ownerToken,
      daemon_pid: process.pid,
      daemon_started_at: this.daemonStartedAt,
      lock_id: this.lockId,
      ...partial,
    };
    try {
      const dir = path.dirname(this.journalPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      let prefix = '';
      if (fs.existsSync(this.journalPath)) {
        const stat = fs.statSync(this.journalPath);
        if (stat.size > 0) {
          const fd = fs.openSync(this.journalPath, 'r');
          try {
            const lastByte = Buffer.alloc(1);
            fs.readSync(fd, lastByte, 0, 1, stat.size - 1);
            if (lastByte[0] !== 0x0a) {
              prefix = '\n';
            }
          } finally {
            fs.closeSync(fd);
          }
        }
      }
      fs.appendFileSync(this.journalPath, prefix + JSON.stringify(entry) + '\n', 'utf8');
      this.journalDegraded = false;
    } catch (err) {
      // Journal write is best-effort if disk is read-only; never crash the daemon loop,
      // but expose journalDegraded state and emit an operator warning on first transition.
      const wasDegraded = this.journalDegraded;
      this.journalDegraded = true;
      this.lastJournalError = err instanceof Error ? err.message : String(err);
      if (!wasDegraded && this.notifyEnabled) {
        notifyOperator(
          'Journal Degraded',
          `Failed to append write-ahead journal at '${this.journalPath}': ${this.lastJournalError}`,
          { level: 'warn', event: 'JOURNAL_DEGRADED', webhookUrl: this.webhookUrl }
        );
      }
    }
    return entry;
  }

  /**
   * Reads all valid JSONL records from this daemon's journal file, tolerating partial/corrupt tail lines.
   *
   * R6 (upgrade compatibility): before per-lock_id journal files existed, every daemon wrote into a
   * single shared `daemon-journal.jsonl`. When this instance is a non-`global` lock whose own file does
   * not exist yet, fall back to that legacy file and keep only the records belonging to this lock_id,
   * so in-flight contracts written by the previous version are still recovered instead of silently
   * stranded as CLAIMED until the TTL sweep kills them.
   */
  public readJournalEntries(): DaemonJournalEntry[] {
    let readPath = this.journalPath;
    let filterLockId: string | null = null;
    if (!fs.existsSync(readPath) && this.lockId !== 'global') {
      const legacyPath = path.join(path.dirname(this.journalPath), 'daemon-journal.jsonl');
      if (fs.existsSync(legacyPath)) {
        readPath = legacyPath;
        filterLockId = this.lockId;
      }
    }
    if (!fs.existsSync(readPath)) {
      return [];
    }
    try {
      const raw = fs.readFileSync(readPath, 'utf8');
      const lines = raw.split(/\r?\n/);
      const entries: DaemonJournalEntry[] = [];
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed) as DaemonJournalEntry;
          if (parsed && typeof parsed === 'object' && parsed.contract_id && parsed.event) {
            if (filterLockId && parsed.lock_id !== filterLockId) continue;
            entries.push(parsed);
          }
        } catch {
          // Tolerate truncated tail line from sudden power loss / crash
        }
      }
      return entries;
    } catch {
      return [];
    }
  }

  /**
   * Scans `daemon-journal.jsonl` upon acquiring leadership and heals any in-flight contracts
   * orphaned by a crashed predecessor daemon instance (Phase 3 Step 2, FC-404).
   *
   * Safety invariants:
   *  - CK-05 (PID reuse safety): never sends kill signals to bare numeric PIDs from old runs.
   *  - Liveness quarantine: probes `isProcessAlive(child_pid)` and `isProcessAlive(daemon_pid)`.
   *    If the predecessor daemon or orphaned child is still alive (e.g. GC pause / lease expiry),
   *    quarantines the contract as `FAILED` (`QUARANTINED_ORPHAN_ALIVE`) instead of re-queueing
   *    to prevent concurrent double-execution on the same workspace.
   *  - Mutation task protection: `implementation` and `test_generation` tasks interrupted mid-flight
   *    are never auto-requeued (`MARKED_FAILED_MUTATION_UNSAFE`) to protect working-tree integrity.
   *  - Read-only tasks (`code_review` / `architecture_audit`) whose predecessor & child are confirmed
   *    dead are released back to the `SUBMITTED` queue (or marked `FAILED` if `MAX_RELEASES` is reached).
   */
  public recoverFromJournal(): JournalRecoveryItem[] {
    const entries = this.readJournalEntries();
    if (entries.length === 0) return [];

    // Group flight state by (contract_id + claim_token) for this lockId
    const inFlightMap = new Map<
      string,
      {
        contract_id: string;
        target_agent: string;
        task_type?: string;
        claim_token?: string;
        exec_file?: string;
        daemon_owner_token: string;
        daemon_pid: number;
        child_pid?: number | null;
        child_started_at?: number;
        settled: boolean;
      }
    >();

    for (const entry of entries) {
      if (entry.lock_id && entry.lock_id !== this.lockId) continue;
      const key = `${entry.contract_id}::${entry.claim_token ?? ''}`;

      if (entry.event === 'TASK_DISPATCHING') {
        inFlightMap.set(key, {
          contract_id: entry.contract_id,
          target_agent: entry.target_agent,
          task_type: entry.task_type,
          claim_token: entry.claim_token,
          exec_file: entry.exec_file,
          daemon_owner_token: entry.daemon_owner_token,
          daemon_pid: entry.daemon_pid,
          settled: false,
        });
      } else if (entry.event === 'CHILD_SPAWNED') {
        const existing = inFlightMap.get(key);
        if (existing) {
          existing.child_pid = entry.child_pid;
          existing.child_started_at = entry.child_started_at;
        } else {
          inFlightMap.set(key, {
            contract_id: entry.contract_id,
            target_agent: entry.target_agent,
            claim_token: entry.claim_token,
            daemon_owner_token: entry.daemon_owner_token,
            daemon_pid: entry.daemon_pid,
            child_pid: entry.child_pid,
            child_started_at: entry.child_started_at,
            settled: false,
          });
        }
      } else if (entry.event === 'TASK_SETTLED' || entry.event === 'CRASH_RECOVERED') {
        const existing = inFlightMap.get(key);
        if (existing) {
          existing.settled = true;
        }
      }
    }

    const recovered: JournalRecoveryItem[] = [];

    for (const [, flight] of inFlightMap.entries()) {
      if (flight.settled) continue;
      if (flight.daemon_owner_token === this.ownerToken) continue;

      let action: JournalRecoveryAction = 'ALREADY_SETTLED';

      try {
        const snap = this.engine.getLeaseSnapshot(flight.contract_id);
        if (!snap || snap.status !== 'CLAIMED') {
          action = 'ALREADY_SETTLED';
        } else if (!flight.claim_token && snap.claim_token) {
          // Journal record lacked claim_token while DB row is protected by one: fail explicitly
          try {
            this.engine.recordSalvage({
              contract_id: flight.contract_id,
              agent_id: flight.target_agent,
              claim_token: snap.claim_token,
              salvage: {
                source: 'DAEMON_CRASH_JOURNAL_RECOVERY',
                quarantine_reason: 'MISSING_CLAIM_TOKEN',
                recovered_at: Date.now(),
                recovered_by_daemon: this.ownerToken,
                crashed_daemon_owner_token: flight.daemon_owner_token,
                crashed_daemon_pid: flight.daemon_pid,
                orphaned_child_pid: flight.child_pid ?? null,
              },
            });
          } catch {
            // best-effort salvage
          }
          this.engine.failContract({
            contract_id: flight.contract_id,
            agent_id: flight.target_agent,
            claim_token: snap.claim_token,
            reason: `DAEMON_CRASH_MISSING_CLAIM_TOKEN: journal entry from '${flight.daemon_owner_token}' lacked claim_token; marked FAILED to prevent stuck CLAIMED zombie.`,
          });
          action = 'MARKED_FAILED_MISSING_CLAIM_TOKEN';
        } else if (!flight.claim_token || !snap.claim_token || snap.claim_token === flight.claim_token) {
          const effectiveToken = flight.claim_token ?? snap.claim_token ?? undefined;
          const effectiveTaskType = flight.task_type ?? snap.task_type;
          const isMutationTask =
            effectiveTaskType === 'implementation' || effectiveTaskType === 'test_generation';

          const childAlive = Boolean(
            flight.child_pid && flight.child_pid !== process.pid && isProcessAlive(flight.child_pid)
          );
          const predecessorDaemonAlive = Boolean(
            flight.daemon_pid && flight.daemon_pid !== process.pid && isProcessAlive(flight.daemon_pid)
          );

          // 1. Record forensic crash salvage before taking recovery action
          try {
            this.engine.recordSalvage({
              contract_id: flight.contract_id,
              agent_id: flight.target_agent,
              claim_token: effectiveToken,
              salvage: {
                source: 'DAEMON_CRASH_JOURNAL_RECOVERY',
                recovered_at: Date.now(),
                recovered_by_daemon: this.ownerToken,
                crashed_daemon_owner_token: flight.daemon_owner_token,
                crashed_daemon_pid: flight.daemon_pid,
                predecessor_daemon_alive: predecessorDaemonAlive,
                orphaned_child_pid: flight.child_pid ?? null,
                orphaned_child_started_at: flight.child_started_at ?? null,
                orphaned_child_alive: childAlive,
                task_type: effectiveTaskType,
                exec_file: flight.exec_file ?? null,
              },
            });
          } catch {
            // best-effort salvage
          }

          if (childAlive) {
            // R4: only a live child can still be writing the workspace, so only that case is
            // quarantined. A live-but-stalled predecessor with no child (or an already-exited
            // child) is recoverable: it will notice its own lease loss and clean up.
            this.engine.failContract({
              contract_id: flight.contract_id,
              agent_id: flight.target_agent,
              claim_token: effectiveToken,
              reason: `DAEMON_CRASH_ORPHAN_STILL_ALIVE: orphaned child (pid=${flight.child_pid ?? 'none'}) from predecessor daemon (pid=${flight.daemon_pid}, alive=${predecessorDaemonAlive}) is still running; quarantined as FAILED to prevent concurrent double execution (CK-05).`,
            });
            action = 'QUARANTINED_ORPHAN_ALIVE';
            if (this.notifyEnabled) {
              notifyOperator(
                'Orphan Quarantined',
                `Quarantined contract ${flight.contract_id} as FAILED because orphaned child (pid=${flight.child_pid ?? 'none'}) is still alive.`,
                { level: 'error', event: 'ORPHAN_QUARANTINED', webhookUrl: this.webhookUrl }
              );
            }
          } else if (isMutationTask) {
            // Mutation task protection: never auto-requeue interrupted implementation/test_generation tasks
            this.engine.failContract({
              contract_id: flight.contract_id,
              agent_id: flight.target_agent,
              claim_token: effectiveToken,
              reason: `DAEMON_CRASH_MUTATION_ABORTED: mutation task (${effectiveTaskType}) interrupted by crash of '${flight.daemon_owner_token}'; auto-requeue disabled to protect workspace integrity.`,
            });
            action = 'MARKED_FAILED_MUTATION_UNSAFE';
            if (this.notifyEnabled) {
              notifyOperator(
                'Mutation Task Aborted',
                `Aborted interrupted mutation contract ${flight.contract_id} (${effectiveTaskType}) after daemon crash to protect workspace files.`,
                { level: 'error', event: 'MUTATION_CRASH_ABORTED', webhookUrl: this.webhookUrl }
              );
            }
          } else {
            // 2. Read-only task, no live child: release back to queue tail even if the predecessor
            //    daemon is still alive (PID reuse / GC stall) — it will self-release on lease loss,
            //    and re-queueing keeps the task instead of burning it as terminal FAILED.
            const relRes = this.engine.releaseContract({
              contract_id: flight.contract_id,
              agent_id: flight.target_agent,
              claim_token: effectiveToken,
              reason: `DAEMON_CRASH_RECOVERED: orphaned in-flight task from ${flight.daemon_owner_token} (pid=${flight.daemon_pid}) recovered via daemon-journal.jsonl`,
            });

            if (relRes.ok && relRes.status === 'SUBMITTED') {
              action = 'RELEASED_TO_QUEUE';
              if (this.notifyEnabled) {
                notifyOperator(
                  'Crash Recovered',
                  `Recovered orphaned contract ${flight.contract_id} from crashed daemon '${flight.daemon_owner_token}' and re-queued as SUBMITTED.`,
                  { level: 'warn', event: 'CRASH_RECOVERED', webhookUrl: this.webhookUrl }
                );
              }
            } else if (!relRes.ok && relRes.status === 'CLAIMED') {
              // Release cap (MAX_RELEASES = 3) reached: fail explicitly so it never hangs as a zombie
              this.engine.failContract({
                contract_id: flight.contract_id,
                agent_id: flight.target_agent,
                claim_token: effectiveToken,
                reason: `DAEMON_CRASH_RECOVERY_EXHAUSTED: contract exceeded max_releases (${relRes.max_releases}) after daemon crash (${flight.daemon_owner_token}).`,
              });
              action = 'MARKED_FAILED_MAX_RELEASES';
              if (this.notifyEnabled) {
                notifyOperator(
                  'Crash Recovery Exhausted',
                  `Orphaned contract ${flight.contract_id} exceeded max_releases after crash of '${flight.daemon_owner_token}' and was marked FAILED.`,
                  { level: 'error', event: 'CRASH_RECOVERY_EXHAUSTED', webhookUrl: this.webhookUrl }
                );
              }
            }
          }
        }
      } catch {
        action = 'ALREADY_SETTLED';
      }

      this.appendJournalEntry({
        event: 'CRASH_RECOVERED',
        contract_id: flight.contract_id,
        target_agent: flight.target_agent,
        claim_token: flight.claim_token,
        previous_owner_token: flight.daemon_owner_token,
        child_pid: flight.child_pid ?? null,
        recovery_action: action,
      });

      recovered.push({
        contract_id: flight.contract_id,
        target_agent: flight.target_agent,
        claim_token: flight.claim_token,
        previous_owner_token: flight.daemon_owner_token,
        previous_pid: flight.daemon_pid,
        child_pid: flight.child_pid ?? null,
        action,
      });
    }

    // Compact journal if all entries are now settled and file exceeds line threshold
    const totalEntriesAfter = entries.length + recovered.length;
    if (totalEntriesAfter > MAX_JOURNAL_LINES_BEFORE_COMPACT) {
      this.compactJournalIfSettled();
    }

    return recovered;
  }

  public compactJournalIfSettled(): boolean {
    if (!this.isLeader) return false;
    const entries = this.readJournalEntries();
    if (entries.length <= COMPACT_RETAIN_LINES) return false;

    const settledKeys = new Set<string>();
    for (const e of entries) {
      if (e.event === 'TASK_SETTLED' || e.event === 'CRASH_RECOVERED') {
        settledKeys.add(`${e.lock_id ?? ''}::${e.contract_id}::${e.claim_token ?? ''}`);
      }
    }
    for (const e of entries) {
      if (e.event === 'TASK_DISPATCHING' || e.event === 'CHILD_SPAWNED') {
        if (!settledKeys.has(`${e.lock_id ?? ''}::${e.contract_id}::${e.claim_token ?? ''}`)) {
          // Do not compact while any flight across any lock_id is still unsettled
          return false;
        }
      }
    }

    const tmpPath = `${this.journalPath}.tmp.${process.pid}.${Date.now()}`;
    try {
      const retained = entries.slice(-COMPACT_RETAIN_LINES);
      const content = retained.map((e) => JSON.stringify(e)).join('\n') + '\n';
      fs.writeFileSync(tmpPath, content, 'utf8');
      fs.renameSync(tmpPath, this.journalPath);
      this.settledSinceLastCompact = 0;
      return true;
    } catch {
      try {
        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
      } catch {
        // ignore cleanup failure
      }
      return false;
    }
  }

  /**
   * R7: operator-facing snapshot of the daemon's lease and journal health.
   * Exposes `journalDegraded` / `lastJournalError`, which were previously only internal fields
   * with no reader — a silently degraded write-ahead journal now shows up here and on stderr.
   */
  public getStatus(): {
    lock_id: string;
    is_leader: boolean;
    owner_token: string;
    daemon_pid: number;
    daemon_started_at: number;
    journal_path: string;
    journal_degraded: boolean;
    last_journal_error: string | null;
    journal_entries: number;
    lease: {
      owner_token: string;
      heartbeat_at: number;
      expires_at: number;
      metadata: unknown;
    } | null;
    lease_held_by_self: boolean;
  } {
    const lease = this.engine.inspectDaemonLease(this.lockId);
    let metadata: unknown = null;
    if (lease?.metadata_json) {
      try {
        metadata = JSON.parse(lease.metadata_json);
      } catch {
        metadata = lease.metadata_json;
      }
    }
    return {
      lock_id: this.lockId,
      is_leader: this.isLeader,
      owner_token: this.ownerToken,
      daemon_pid: process.pid,
      daemon_started_at: this.daemonStartedAt,
      journal_path: this.journalPath,
      journal_degraded: this.journalDegraded,
      last_journal_error: this.lastJournalError,
      journal_entries: this.readJournalEntries().length,
      lease: lease
        ? {
            owner_token: lease.owner_token,
            heartbeat_at: lease.heartbeat_at,
            expires_at: lease.expires_at,
            metadata,
          }
        : null,
      lease_held_by_self: Boolean(lease && lease.owner_token === this.ownerToken),
    };
  }

  public renewLease(): boolean {
    if (!this.isLeader) return false;
    try {
      const res = this.engine.renewDaemonLease({
        lock_id: this.lockId,
        owner_token: this.ownerToken,
        ttl_sec: this.leaseTtlSec,
      });

      if (!res.ok) {
        // Critical WorkBuddy P1 Fix: When lease is lost, don't kill active contract to FAILED.
        // First voluntarily release in-flight contract back to queue tail so new leader can claim it!
        this.isLeader = false;
        if (this.activeInFlightContract) {
          try {
            this.engine.releaseContract({
              contract_id: this.activeInFlightContract.contract_id,
              agent_id: this.activeInFlightContract.target_agent,
              claim_token: this.activeInFlightContract.claim_token,
              reason: 'DAEMON_LEASE_LOST',
            });
          } catch {
            // best-effort release
          }
          this.activeInFlightContract = null;
        }
        terminateActiveChildrenSync();
        if (this.notifyEnabled) {
          notifyOperator(
            'Lease Lost',
            `Failed to renew lease '${this.lockId}': ${res.message}. In-flight contract released and children terminated.`,
            { webhookUrl: this.webhookUrl }
          );
        }
        return false;
      }
      return true;
    } catch (err) {
      // WorkBuddy Finding: On SQLite/IO exception, demote to non-leader, backoff, and release in-flight contract
      this.isLeader = false;
      if (this.activeInFlightContract) {
        try {
          this.engine.releaseContract({
            contract_id: this.activeInFlightContract.contract_id,
            agent_id: this.activeInFlightContract.target_agent,
            claim_token: this.activeInFlightContract.claim_token,
            reason: 'DAEMON_HEARTBEAT_EXCEPTION',
          });
        } catch {
          // best-effort release
        }
        this.activeInFlightContract = null;
      }
      terminateActiveChildrenSync();
      if (this.notifyEnabled) {
        notifyOperator(
          'Lease Error',
          `Heartbeat exception: ${err instanceof Error ? err.message : String(err)}. Contract released and children terminated.`,
          { webhookUrl: this.webhookUrl }
        );
      }
      return false;
    }
  }

  public releaseLease(): void {
    if (this.isLeader) {
      try {
        this.engine.releaseDaemonLease({
          lock_id: this.lockId,
          owner_token: this.ownerToken,
        });
      } catch {
        // best-effort cleanup on shutdown
      }
      this.isLeader = false;
    }
  }

  public resolveHandler(targetAgent: string, taskType: string): HandlerDefinition | null {
    const agentConfig = this.config.agents[targetAgent];
    if (!agentConfig) return null;

    const typedTask = taskType as keyof typeof agentConfig.handlers;
    if (agentConfig.handlers && agentConfig.handlers[typedTask]) {
      return agentConfig.handlers[typedTask];
    }

    if (agentConfig.default_handler) {
      return agentConfig.default_handler;
    }

    return null;
  }

  /**
   * Process a single cycle: check lease, poll task, execute configured handler if matched.
   */
  public async pollAndDispatchOnce(): Promise<{
    processed: boolean;
    contract_id?: string;
    status?: string;
    reason?: string;
  }> {
    // R7: a silently degraded write-ahead journal means crash recovery is not actually armed.
    // Surface it once on stderr (and via getStatus()) instead of failing mute.
    if (this.journalDegraded && !this.journalDegradedReported) {
      this.journalDegradedReported = true;
      process.stderr.write(
        `[FerryCat Daemon] WARN write-ahead journal degraded at "${this.journalPath}": ${this.lastJournalError ?? 'unknown error'}. Crash recovery is not armed until writes succeed again.\n`
      );
    }
    if (!this.isLeader) {
      const acquired = this.acquireLease();
      if (!acquired) {
        return { processed: false, reason: 'LEASE_NOT_HELD' };
      }
    }

    // Determine target agent(s) to poll
    const targetAgentsToPoll = this.targetAgentFilter
      ? [this.targetAgentFilter]
      : Object.keys(this.config.agents);

    if (targetAgentsToPoll.length === 0) {
      // If no configured agents, poll without target agent filter
      return this.pollAgentQueue(undefined);
    }

    for (const agent of targetAgentsToPoll) {
      const res = await this.pollAgentQueue(agent);
      if (res.processed) {
        return res;
      }
    }

    return { processed: false, reason: 'NO_TASK_AVAILABLE' };
  }

  private async pollAgentQueue(agentId?: string): Promise<{
    processed: boolean;
    contract_id?: string;
    status?: string;
    reason?: string;
  }> {
    // Determine configured task types for this agent to avoid claiming unhandled tasks (WorkBuddy P1)
    let eligibleTaskTypes: Array<'code_review' | 'architecture_audit' | 'implementation' | 'test_generation'> | undefined;
    if (agentId && this.config.agents[agentId]) {
      const agentCfg = this.config.agents[agentId];
      if (!agentCfg.default_handler && agentCfg.handlers) {
        eligibleTaskTypes = Object.keys(agentCfg.handlers) as Array<
          'code_review' | 'architecture_audit' | 'implementation' | 'test_generation'
        >;
        if (eligibleTaskTypes.length === 0) {
          // If agent has no handlers and no default_handler, skip polling this agent completely
          return { processed: false, reason: 'NO_HANDLERS_CONFIGURED' };
        }
      }
    }

    const pollResult: PollNextTaskResult = await this.engine.pollNextTask({
      agent_id: agentId,
      task_types: eligibleTaskTypes,
    });

    if (!pollResult.has_task || !pollResult.contract || pollResult.status !== 'CLAIMED') {
      return { processed: false, reason: 'NO_TASK_AVAILABLE' };
    }

    const contract = pollResult.contract;
    const handler = this.resolveHandler(contract.target_agent, contract.task_type);

    if (!handler) {
      // Fallback: If somehow claimed without handler (e.g. default_handler was missing), release back to queue cleanly
      const warningMsg = `No handler configured in ferrycat.config.json for agent '${contract.target_agent}' task '${contract.task_type}'. Releasing contract back to queue.`;
      if (this.notifyEnabled) {
        notifyOperator('Unhandled Task', warningMsg);
      }
      this.engine.releaseContract({
        contract_id: contract.contract_id,
        agent_id: contract.target_agent,
        claim_token: contract.claim_token,
        reason: `NO_HANDLER_CONFIGURED: Task type '${contract.task_type}' not handled by this node.`,
      });
      return {
        processed: false,
        contract_id: contract.contract_id,
        reason: 'NO_HANDLER_CONFIGURED',
      };
    }

    if (this.notifyEnabled) {
      notifyOperator(
        'Task Claimed',
        `Agent '${contract.target_agent}' executing contract ${contract.contract_id} (${contract.task_type}: "${contract.title}") via ${handler.exec_file}`
      );
    }

    // Track active in-flight contract for graceful lease loss failover
    this.activeInFlightContract = {
      contract_id: contract.contract_id,
      target_agent: contract.target_agent,
      claim_token: contract.claim_token,
    };

    // Write-ahead journal before spawning child (Phase 3 Step 2)
    this.appendJournalEntry({
      event: 'TASK_DISPATCHING',
      contract_id: contract.contract_id,
      target_agent: contract.target_agent,
      task_type: contract.task_type,
      claim_token: contract.claim_token,
      exec_file: handler.exec_file,
    });

    let settledStatus = 'ABORTED';
    try {
      // Forward configured args and pass_env (contract's own exec_ttl_sec is authoritative)
      const execResult = await executeTaskAndFulfill(
        this.engine,
        contract,
        {
          execFile: handler.exec_file,
          passEnv: handler.pass_env,
          args: handler.args,
        },
        {
          onEvent: (ev) => {
            if (ev.event === 'CHILD_SPAWNED') {
              this.appendJournalEntry({
                event: 'CHILD_SPAWNED',
                contract_id: contract.contract_id,
                target_agent: contract.target_agent,
                claim_token: contract.claim_token,
                child_pid: (ev.pid as number | null) ?? null,
                child_started_at: (ev.started_at as number | undefined) ?? Date.now(),
              });
            }
          },
        }
      );
      settledStatus = execResult.status;

      if (this.notifyEnabled) {
        const finishLevel: NotifyLevel = execResult.ok
          ? 'info'
          : execResult.status === 'RETRY_NEEDED'
          ? 'warn'
          : 'error';
        notifyOperator(
          'Task Finished',
          `Contract ${contract.contract_id} concluded with status '${execResult.status}' (ok=${execResult.ok})`,
          {
            level: finishLevel,
            event: execResult.ok ? 'TASK_FINISHED' : 'TASK_FAILED',
            webhookUrl: this.webhookUrl,
          }
        );
      }

      return {
        processed: true,
        contract_id: contract.contract_id,
        status: execResult.status,
      };
    } finally {
      this.appendJournalEntry({
        event: 'TASK_SETTLED',
        contract_id: contract.contract_id,
        target_agent: contract.target_agent,
        claim_token: contract.claim_token,
        final_status: settledStatus,
      });
      this.activeInFlightContract = null;
      this.settledSinceLastCompact += 1;
      if (this.settledSinceLastCompact >= MAX_JOURNAL_LINES_BEFORE_COMPACT) {
        this.compactJournalIfSettled();
      }
    }
  }

  public async start(): Promise<void> {
    this.registerSignalHandlers();
    this.isRunning = true;

    // Heartbeat ticker loop for lease renewal
    this.heartbeatTimer = setInterval(() => {
      try {
        if (this.isRunning && this.isLeader) {
          this.renewLease();
        }
      } catch (err) {
        if (this.notifyEnabled) {
          notifyOperator('Heartbeat Ticker Error', err instanceof Error ? err.message : String(err), {
            webhookUrl: this.webhookUrl,
          });
        }
      }
    }, this.heartbeatIntervalMs);

    // Main polling loop
    const tick = async () => {
      if (!this.isRunning) return;
      try {
        await this.pollAndDispatchOnce();
      } catch (err) {
        if (this.notifyEnabled) {
          notifyOperator('Daemon Loop Error', err instanceof Error ? err.message : String(err), {
            webhookUrl: this.webhookUrl,
          });
        }
      }
      if (this.isRunning) {
        this.pollTimer = setTimeout(tick, this.pollIntervalMs);
      }
    };

    tick();
  }

  public stop(): void {
    this.isRunning = false;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    this.releaseLease();
  }
}
