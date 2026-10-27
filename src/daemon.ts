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
  targetAgent?: string;
  lockId?: string;
  leaseTtlSec?: number;
  heartbeatIntervalMs?: number;
  pollIntervalMs?: number;
  once?: boolean;
  notify?: boolean;
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
  public readonly lockId: string;
  public readonly leaseTtlSec: number;
  public readonly heartbeatIntervalMs: number;
  public readonly pollIntervalMs: number;
  public readonly ownerToken: string;
  public readonly targetAgentFilter?: string;
  public readonly notifyEnabled: boolean;
  public readonly webhookUrl?: string;

  private isRunning: boolean = false;
  private isLeader: boolean = false;
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
        notifyOperator('Shutdown', `Received ${sig}, terminating children and releasing lease...`);
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
        return true;
      }
      this.isLeader = false;
      return false;
    } catch (err) {
      this.isLeader = false;
      if (this.notifyEnabled) {
        notifyOperator('Lease Error', `Acquire lease error: ${err instanceof Error ? err.message : String(err)}`);
      }
      return false;
    }
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
          notifyOperator('Lease Lost', `Failed to renew lease '${this.lockId}': ${res.message}. In-flight contract released and children terminated.`);
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
        notifyOperator('Lease Error', `Heartbeat exception: ${err instanceof Error ? err.message : String(err)}. Contract released and children terminated.`);
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

    const pollResult: PollNextTaskResult = this.engine.pollNextTask({
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

    try {
      // Forward configured args and pass_env (contract's own exec_ttl_sec is authoritative)
      const execResult = await executeTaskAndFulfill(
        this.engine,
        contract,
        {
          execFile: handler.exec_file,
          passEnv: handler.pass_env,
          args: handler.args,
        }
      );

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
      this.activeInFlightContract = null;
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
          notifyOperator('Heartbeat Ticker Error', err instanceof Error ? err.message : String(err));
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
          notifyOperator('Daemon Loop Error', err instanceof Error ? err.message : String(err));
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
