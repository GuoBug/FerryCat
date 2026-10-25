/**
 * FerryCat Controlled Daemon (Phase 3 Step 1, ADR-0005).
 *
 * Provides a production-grade, background-ready execution orchestrator:
 *   - Short-transaction CAS leases on `daemon_locks` table.
 *   - Configuration file loading (`ferrycat.config.json` / `~/.ferrycat/config.json`).
 *   - Strict handler dispatch using script files (`--exec-file`) mapped to task types.
 *   - Full integration with supervisor process lifecycle & safety checkpoints (CK-01 ~ CK-09).
 *   - Graceful shutdown on SIGINT/SIGTERM with lease release and child tree termination.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

export function notifyOperator(title: string, message: string): void {
  const timestamp = new Date().toISOString();
  // Always emit structured line to stderr/stdout
  process.stderr.write(`[FerryCat Daemon Notice] ${timestamp} | ${title}: ${message}\n`);
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

  private isRunning: boolean = false;
  private isLeader: boolean = false;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private signalCleanupRegistered: boolean = false;

  constructor(options: DaemonOptions = {}) {
    const { config, resolvedPath } = loadFerryCatConfig(options.configPath);
    this.config = config;
    this.configPath = resolvedPath;

    this.engine = new FerryCatEngine({ dbPath: options.dbPath });

    this.lockId = options.lockId ?? config.daemon.lock_id ?? 'global';
    this.leaseTtlSec = options.leaseTtlSec ?? config.daemon.lease_ttl_sec ?? 30;
    this.heartbeatIntervalMs =
      options.heartbeatIntervalMs ?? config.daemon.heartbeat_interval_ms ?? 5000;
    this.pollIntervalMs = options.pollIntervalMs ?? config.daemon.poll_interval_ms ?? 1000;
    this.ownerToken =
      config.daemon.owner_token ?? `daemon-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    this.targetAgentFilter = options.targetAgent;
    this.notifyEnabled = options.notify ?? config.daemon.notify ?? true;
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
  }

  public renewLease(): boolean {
    if (!this.isLeader) return false;
    const res = this.engine.renewDaemonLease({
      lock_id: this.lockId,
      owner_token: this.ownerToken,
      ttl_sec: this.leaseTtlSec,
    });
    if (!res.ok) {
      this.isLeader = false;
      if (this.notifyEnabled) {
        notifyOperator('Lease Lost', `Failed to renew lease '${this.lockId}': ${res.message}`);
      }
      return false;
    }
    return true;
  }

  public releaseLease(): void {
    if (this.isLeader) {
      this.engine.releaseDaemonLease({
        lock_id: this.lockId,
        owner_token: this.ownerToken,
      });
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
    const pollResult: PollNextTaskResult = this.engine.pollNextTask({
      agent_id: agentId,
    });

    if (!pollResult.has_task || !pollResult.contract || pollResult.status !== 'CLAIMED') {
      return { processed: false, reason: 'NO_TASK_AVAILABLE' };
    }

    const contract = pollResult.contract;
    const handler = this.resolveHandler(contract.target_agent, contract.task_type);

    if (!handler) {
      // No authorized handler declared for this task in config
      const warningMsg = `No handler configured in ferrycat.config.json for agent '${contract.target_agent}' task '${contract.task_type}'. Release contract back to queue.`;
      if (this.notifyEnabled) {
        notifyOperator('Unhandled Task', warningMsg);
      }
      this.engine.releaseContract({
        contract_id: contract.contract_id,
        agent_id: contract.target_agent,
        claim_token: contract.claim_token,
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

    const execResult = await executeTaskAndFulfill(
      this.engine,
      contract,
      {
        execFile: handler.exec_file,
        passEnv: handler.pass_env,
      },
      {}
    );

    if (this.notifyEnabled) {
      notifyOperator(
        'Task Finished',
        `Contract ${contract.contract_id} concluded with status '${execResult.status}' (ok=${execResult.ok})`
      );
    }

    return {
      processed: true,
      contract_id: contract.contract_id,
      status: execResult.status,
    };
  }

  public async start(): Promise<void> {
    this.registerSignalHandlers();
    this.isRunning = true;

    // Heartbeat ticker loop for lease renewal
    this.heartbeatTimer = setInterval(() => {
      if (this.isRunning && this.isLeader) {
        this.renewLease();
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
