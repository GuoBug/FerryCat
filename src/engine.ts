import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  computeFingerprints,
  verifyFingerprintsWithRetry,
  verifySingleRun,
} from './fingerprint.js';
import { validateContractOutput } from './schema-validator.js';
import type {
  ContractRow,
  DispatchContractInput,
  DispatchContractResult,
  ExtendTtlInput,
  ExtendTtlResult,
  FailContractInput,
  FailContractResult,
  FileFingerprint,
  FulfillContractInput,
  FulfillContractResult,
  InspectMeshStateInput,
  PollNextTaskInput,
  PollNextTaskResult,
  ReleaseContractInput,
  ReleaseContractResult,
  TaskType,
} from './types.js';

/** Default queue window (SUBMITTED) in seconds. */
export const DEFAULT_QUEUE_TTL_SEC = 1800;

/**
 * Tiered default execution window (CLAIMED) per task type.
 * Review/audit work usually involves deep reasoning or a human in the loop,
 * while implementation/test generation is expected to run as an automated pipeline.
 */
export const DEFAULT_EXEC_TTL_SEC_BY_TASK_TYPE: Readonly<Record<TaskType, number>> = {
  code_review: 1800,
  architecture_audit: 1800,
  implementation: 300,
  test_generation: 300,
};

/** Max extend_ttl calls per holder (counter resets when the contract is released). */
export const MAX_TTL_EXTENSIONS = 5;

/** Max times a contract may be released back to the queue before the holder must fail it. */
export const MAX_RELEASES = 3;

/**
 * extend_ttl is refused once now >= created_at + LIFETIME_QUEUE_TTL_MULTIPLIER * queue_ttl_sec,
 * bounding the total lifetime of a contract even under a misbehaving heartbeat loop.
 */
export const LIFETIME_QUEUE_TTL_MULTIPLIER = 4;

/** SQL expression for the start of the current queue window (NULL-safe for rows from older hosts). */
const QUEUE_START_SQL = 'COALESCE(queued_at, created_at)';

export function expandTilde(filePath: string): string {
  const trimmed = filePath.trim();
  if (trimmed === '~') {
    return os.homedir();
  }
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return path.join(os.homedir(), trimmed.slice(2));
  }
  return trimmed;
}

export function resolveDbPath(customDbPath?: string): string {
  if (customDbPath) {
    return path.resolve(expandTilde(customDbPath));
  }
  if (process.env.FERRYCAT_DB_PATH) {
    return path.resolve(expandTilde(process.env.FERRYCAT_DB_PATH));
  }
  if (process.env.MESH_DB_DIR) {
    return path.resolve(expandTilde(process.env.MESH_DB_DIR), 'mesh.db');
  }
  return path.join(os.homedir(), '.ferrycat', 'mesh.db');
}

export interface FerryCatEngineOptions {
  dbPath?: string;
  defaultAgentName?: string;
  fingerprintRetryDelayMs?: number;
}

export class FerryCatEngine {
  public readonly dbPath: string;
  private readonly db: DatabaseSync;
  private readonly defaultAgentName?: string;
  private readonly fingerprintRetryDelayMs: number;

  constructor(options: FerryCatEngineOptions = {}) {
    this.assertNodeVersion();
    this.dbPath = resolveDbPath(options.dbPath);
    this.defaultAgentName = options.defaultAgentName ?? process.env.AGENT_NAME;
    this.fingerprintRetryDelayMs = options.fingerprintRetryDelayMs ?? 150;

    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new DatabaseSync(this.dbPath);
    this.initSchema();
  }

  private assertNodeVersion(): void {
    const [major, minor] = process.versions.node.split('.').map(Number);
    if (major < 22 || (major === 22 && minor < 5)) {
      throw new Error(
        `FerryCat requires Node.js >= 22.5.0 (current: ${process.version}). Please upgrade Node or configure MCP command to use Node >= 22.5 with --experimental-sqlite.`
      );
    }
  }

  private initSchema(): void {
    this.db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;

      CREATE TABLE IF NOT EXISTS contracts (
        id TEXT PRIMARY KEY,
        requester_agent TEXT NOT NULL,
        target_agent TEXT NOT NULL,
        task_type TEXT NOT NULL,
        title TEXT NOT NULL,
        context_summary TEXT NOT NULL,
        workspace_root TEXT NOT NULL,
        pointers_json TEXT NOT NULL,
        contract_schema_json TEXT,
        status TEXT NOT NULL DEFAULT 'SUBMITTED',
        retry_count INTEGER NOT NULL DEFAULT 0,
        max_retries INTEGER NOT NULL DEFAULT 2,
        queue_ttl_sec INTEGER NOT NULL DEFAULT 1800,
        exec_ttl_sec INTEGER NOT NULL DEFAULT 300,
        result_summary TEXT,
        structured_output_json TEXT,
        artifacts_pointers_json TEXT,
        verified_sha256_json TEXT,
        error_reason TEXT,
        created_at INTEGER NOT NULL,
        queued_at INTEGER,
        claimed_at INTEGER,
        completed_at INTEGER,
        extend_count INTEGER NOT NULL DEFAULT 0,
        release_count INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_contracts_poll
      ON contracts(target_agent, status, created_at);
    `);

    // Additive, idempotent column migrations for databases created by older FerryCat versions.
    // Older hosts sharing the same mesh.db keep working: they simply leave the new columns at defaults.
    const migrations: Array<[column: string, ddl: string]> = [
      ['verified_sha256_json', 'TEXT'],
      ['queued_at', 'INTEGER'],
      ['extend_count', 'INTEGER NOT NULL DEFAULT 0'],
      ['release_count', 'INTEGER NOT NULL DEFAULT 0'],
    ];
    const existingColumns = new Set(
      (this.db.prepare('PRAGMA table_info(contracts)').all() as Array<{ name: string }>).map(
        (c) => c.name
      )
    );
    for (const [column, ddl] of migrations) {
      if (existingColumns.has(column)) continue;
      try {
        this.db.exec(`ALTER TABLE contracts ADD COLUMN ${column} ${ddl};`);
      } catch {
        // Another process added the column concurrently
      }
    }

    // Poll order follows the current queue window so released contracts go to the tail.
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_contracts_queue_order
      ON contracts(target_agent, status, ${QUEUE_START_SQL});
    `);
  }

  private resolveAgentIdentity(explicitAgent?: string, roleLabel: string = 'agent'): string {
    const resolved = (explicitAgent ?? this.defaultAgentName ?? '').trim();
    if (!resolved) {
      throw new Error(
        `${roleLabel} identity is missing: please provide it explicitly in tool arguments or set AGENT_NAME in the MCP server env configuration.`
      );
    }
    return resolved;
  }

  public dispatchContract(
    input: DispatchContractInput,
    nowMs: number = Date.now()
  ): DispatchContractResult {
    const requester = this.resolveAgentIdentity(input.requester_agent, 'requester_agent');
    const target = input.target_agent.trim();
    if (!target) {
      throw new Error('target_agent must not be empty.');
    }
    if (!input.pointers || input.pointers.length === 0) {
      throw new Error('pointers must contain at least one file pointer.');
    }

    const resolvedWorkspace = path.resolve(expandTilde(input.workspace_root));
    const { fingerprints, recentlyModified } = computeFingerprints(
      resolvedWorkspace,
      input.pointers,
      nowMs
    );

    const contractId = `fc_${nowMs}_${crypto.randomBytes(4).toString('hex')}`;
    const queueTtlSec = input.queue_ttl_sec ?? DEFAULT_QUEUE_TTL_SEC;
    const execTtlSec =
      input.exec_ttl_sec ?? DEFAULT_EXEC_TTL_SEC_BY_TASK_TYPE[input.task_type] ?? 300;

    const stmt = this.db.prepare(`
      INSERT INTO contracts (
        id, requester_agent, target_agent, task_type, title, context_summary,
        workspace_root, pointers_json, contract_schema_json, status,
        retry_count, max_retries, queue_ttl_sec, exec_ttl_sec, created_at, queued_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'SUBMITTED', 0, 2, ?, ?, ?, ?)
    `);

    stmt.run(
      contractId,
      requester,
      target,
      input.task_type,
      input.title,
      input.context_summary,
      resolvedWorkspace,
      JSON.stringify(fingerprints),
      input.contract_schema ? JSON.stringify(input.contract_schema) : null,
      queueTtlSec,
      execTtlSec,
      nowMs,
      nowMs
    );

    const result: DispatchContractResult = {
      contract_id: contractId,
      status: 'SUBMITTED',
      created_at: nowMs,
      files: fingerprints.map((fp) => ({
        path: fp.path,
        size: fp.size,
        mtime_ms: fp.mtime_ms,
        sha256: fp.sha256,
        first_line: fp.first_line,
        last_line: fp.last_line,
        ...(fp.line_range ? { line_range: fp.line_range } : {}),
      })),
    };

    if (recentlyModified) {
      result.warning =
        'One or more target files were modified within the last 3 seconds. Verify first_line/last_line to ensure unsaved IDE buffer changes were flushed to disk.';
    }

    return result;
  }

  /**
   * Read-before-write lazy timeout sweep:
   * Only acquires a write lock if expired active contracts actually exist.
   */
  private sweepExpiredContractsIfNeeded(nowMs: number): void {
    const countRow = this.db
      .prepare(
        `SELECT COUNT(*) AS c FROM contracts
         WHERE (status = 'SUBMITTED' AND (${QUEUE_START_SQL} + queue_ttl_sec * 1000) < ?)
            OR (status = 'CLAIMED'   AND (claimed_at + exec_ttl_sec * 1000) < ?)`
      )
      .get(nowMs, nowMs) as { c: number | bigint } | undefined;

    if (countRow && Number(countRow.c) > 0) {
      this.db
        .prepare(
          `UPDATE contracts
           SET status = 'TIMED_OUT',
               error_reason = CASE
                 WHEN status = 'SUBMITTED' THEN 'QUEUE_TTL_EXPIRED'
                 ELSE 'EXEC_TTL_EXPIRED'
               END
           WHERE (status = 'SUBMITTED' AND (${QUEUE_START_SQL} + queue_ttl_sec * 1000) < ?)
              OR (status = 'CLAIMED'   AND (claimed_at + exec_ttl_sec * 1000) < ?)`
        )
        .run(nowMs, nowMs);
    }
  }

  public pollNextTask(
    input: PollNextTaskInput = {},
    nowMs: number = Date.now()
  ): PollNextTaskResult {
    const agentId = this.resolveAgentIdentity(input.agent_id, 'agent_id');

    // Step 1: Lazy timeout sweep (SELECT first to avoid write lock contention)
    this.sweepExpiredContractsIfNeeded(nowMs);

    // Step 2: Fetch and evaluate candidate SUBMITTED contracts with continuous pagination
    const claimStmt = this.db.prepare(
      `UPDATE contracts
       SET status = 'CLAIMED', claimed_at = ?
       WHERE id = ? AND status = 'SUBMITTED'`
    );

    const candidatesStmt = this.db.prepare(
      `SELECT * FROM contracts
       WHERE target_agent = ? AND status = 'SUBMITTED'
       ORDER BY ${QUEUE_START_SQL} ASC, rowid ASC
       LIMIT 10`
    );

    let lastStaleError: PollNextTaskResult['stale_error'] | undefined;
    let anyCandidatesSeen = false;

    while (true) {
      const candidates = candidatesStmt.all(agentId) as unknown as ContractRow[];
      if (candidates.length === 0) {
        break;
      }
      anyCandidatesSeen = true;

      for (const candidate of candidates) {
        // Step 3: Atomic optimistic lock preemption
        const updateResult = claimStmt.run(nowMs, candidate.id);
        if (Number(updateResult.changes) !== 1) {
          // Preempted by another concurrent worker process; try next candidate
          continue;
        }

        // Step 4: Verify file fingerprints on disk (with 150ms transient write retry & exception guard)
        let fingerprints: FileFingerprint[];
        let verification;
        try {
          fingerprints = JSON.parse(candidate.pointers_json) as FileFingerprint[];
          verification = verifyFingerprintsWithRetry(
            candidate.workspace_root,
            fingerprints,
            this.fingerprintRetryDelayMs
          );
        } catch (err) {
          const errMsg = `UNEXPECTED_FS_ERROR: ${err instanceof Error ? err.message : String(err)}`;
          this.db
            .prepare(
              `UPDATE contracts SET status = 'POINTER_STALE', error_reason = ? WHERE id = ?`
            )
            .run(errMsg, candidate.id);
          lastStaleError = {
            contract_id: candidate.id,
            reason: 'UNEXPECTED_FS_ERROR',
            message: `Contract "${candidate.id}" marked POINTER_STALE due to filesystem error (${errMsg}).`,
          };
          continue;
        }

        if (!verification.valid) {
          const errorReason = `${verification.reason}: ${verification.detail}`;
          this.db
            .prepare(
              `UPDATE contracts
               SET status = 'POINTER_STALE', error_reason = ?
               WHERE id = ?`
            )
            .run(errorReason, candidate.id);

          lastStaleError = {
            contract_id: candidate.id,
            reason: verification.reason!,
            message: `Contract "${candidate.id}" rejected as POINTER_STALE (${errorReason}). Please ask requester "${candidate.requester_agent}" to re-dispatch with fresh file fingerprints.`,
          };
          continue;
        }

        return {
          has_task: true,
          status: 'CLAIMED',
          contract: {
            contract_id: candidate.id,
            requester_agent: candidate.requester_agent,
            target_agent: candidate.target_agent,
            task_type: candidate.task_type,
            title: candidate.title,
            context_summary: candidate.context_summary,
            workspace_root: candidate.workspace_root,
            pointers: fingerprints,
            contract_schema: candidate.contract_schema_json
              ? (JSON.parse(candidate.contract_schema_json) as Record<string, unknown>)
              : null,
            claimed_at: nowMs,
            exec_ttl_sec: candidate.exec_ttl_sec,
          },
        };
      }
    }

    if (lastStaleError) {
      return {
        has_task: false,
        status: 'POINTER_STALE',
        stale_error: lastStaleError,
      };
    }

    return {
      has_task: false,
      message: anyCandidatesSeen
        ? `All candidate contracts for "${agentId}" were preempted by concurrent workers.`
        : `No pending SUBMITTED contracts for agent "${agentId}".`,
    };
  }

  public fulfillContract(
    input: FulfillContractInput,
    nowMs: number = Date.now()
  ): FulfillContractResult {
    const agentId = this.resolveAgentIdentity(input.agent_id, 'agent_id');
    const row = this.loadClaimedContractForHolder(input.contract_id, agentId, 'fulfill');

    // Check execution TTL
    if (this.expireIfExecTtlElapsed(row, nowMs)) {
      return {
        ok: false,
        contract_id: row.id,
        status: 'TIMED_OUT',
        retry_count: row.retry_count,
        max_retries: row.max_retries,
        message: `Contract "${row.id}" exceeded execution TTL (${row.exec_ttl_sec}s) and was marked TIMED_OUT.`,
      };
    }

    // Re-verify file fingerprints at fulfill time to close the claim->read->fulfill TOCTOU window
    const fingerprints = JSON.parse(row.pointers_json) as FileFingerprint[];
    const toctouCheck = verifySingleRun(row.workspace_root, fingerprints);
    if (!toctouCheck.valid) {
      const toctouReason = `TOCTOU_${toctouCheck.reason}: ${toctouCheck.detail}`;
      this.db
        .prepare(
          `UPDATE contracts SET status = 'POINTER_STALE', error_reason = ?, completed_at = ? WHERE id = ? AND status = 'CLAIMED'`
        )
        .run(toctouReason, nowMs, row.id);

      return {
        ok: false,
        contract_id: row.id,
        status: 'POINTER_STALE',
        retry_count: row.retry_count,
        max_retries: row.max_retries,
        message: `Contract "${row.id}" rejected at fulfill time as POINTER_STALE because target file changed during execution (${toctouReason}).`,
      };
    }

    const verifiedShaMap = Object.fromEntries(fingerprints.map((fp) => [fp.path, fp.sha256]));
    const verifiedSha256Json = JSON.stringify(verifiedShaMap);

    // Validate against contract_schema if defined
    if (row.contract_schema_json) {
      const schema = JSON.parse(row.contract_schema_json) as Record<string, unknown>;
      const validation = validateContractOutput(schema, input.structured_output);

      if (!validation.valid) {
        const nextRetryCount = row.retry_count + 1;

        if (nextRetryCount <= row.max_retries) {
          // A rejected submission renews the execution window so the fix attempt is not starved by TTL
          this.db
            .prepare(
              `UPDATE contracts SET retry_count = ?, claimed_at = ? WHERE id = ? AND status = 'CLAIMED'`
            )
            .run(nextRetryCount, nowMs, row.id);

          return {
            ok: false,
            contract_id: row.id,
            status: 'RETRY_NEEDED',
            retry_count: nextRetryCount,
            max_retries: row.max_retries,
            validation_errors: validation.errors,
            message: `structured_output failed schema validation (failed attempt ${nextRetryCount}, max_retries=${row.max_retries}). Execution window renewed for ${row.exec_ttl_sec}s. Fix the fields and call fulfill_contract again.`,
          };
        } else {
          const errSummary = `Schema validation failed after ${row.max_retries} retries: ${validation.errors.join('; ')}`;
          this.db
            .prepare(
              `UPDATE contracts
               SET status = 'VALIDATION_FAILED',
                   retry_count = ?,
                   error_reason = ?,
                   completed_at = ?
               WHERE id = ? AND status = 'CLAIMED'`
            )
            .run(nextRetryCount, errSummary, nowMs, row.id);

          return {
            ok: false,
            contract_id: row.id,
            status: 'VALIDATION_FAILED',
            retry_count: nextRetryCount,
            max_retries: row.max_retries,
            validation_errors: validation.errors,
            message: `Contract "${row.id}" transitioned to terminal VALIDATION_FAILED after exceeding max_retries (${row.max_retries}).`,
          };
        }
      }
    }

    // Validation succeeded (or no schema required): transition to COMPLETED
    const completeRes = this.db
      .prepare(
        `UPDATE contracts
         SET status = 'COMPLETED',
             result_summary = ?,
             structured_output_json = ?,
             artifacts_pointers_json = ?,
             verified_sha256_json = ?,
             completed_at = ?
         WHERE id = ? AND status = 'CLAIMED'`
      )
      .run(
        input.result_summary,
        input.structured_output ? JSON.stringify(input.structured_output) : null,
        input.artifacts_pointers ? JSON.stringify(input.artifacts_pointers) : null,
        verifiedSha256Json,
        nowMs,
        row.id
      );

    if (Number(completeRes.changes) !== 1) {
      throw new Error(
        `Concurrent state change detected: contract "${row.id}" is no longer in 'CLAIMED' state.`
      );
    }

    return {
      ok: true,
      contract_id: row.id,
      status: 'COMPLETED',
      retry_count: row.retry_count,
      max_retries: row.max_retries,
      message: `Contract "${row.id}" fulfilled by "${agentId}" and marked COMPLETED.`,
    };
  }

  /**
   * Shared holder guard for every CLAIMED-state mutation (fulfill / release / extend / fail):
   * the contract must exist, belong to the calling agent, and still be CLAIMED.
   */
  private loadClaimedContractForHolder(
    contractId: string,
    agentId: string,
    operation: 'fulfill' | 'release' | 'extend' | 'fail'
  ): ContractRow {
    const row = this.db
      .prepare(`SELECT * FROM contracts WHERE id = ?`)
      .get(contractId) as unknown as ContractRow | undefined;

    if (!row) {
      throw new Error(`Contract "${contractId}" not found.`);
    }

    if (row.target_agent !== agentId) {
      const action = operation === 'fulfill' ? 'fulfillment' : operation;
      throw new Error(
        `Permission denied: contract "${row.id}" was assigned to "${row.target_agent}", but ${action} was attempted by "${agentId}".`
      );
    }

    if (row.status !== 'CLAIMED') {
      throw new Error(
        `Cannot ${operation} contract "${contractId}": expected status 'CLAIMED', but current status is '${row.status}'.`
      );
    }

    return row;
  }

  /**
   * If the execution window already elapsed, deterministically transition to TIMED_OUT
   * (the same outcome the lazy sweep would produce) and return true.
   */
  private expireIfExecTtlElapsed(
    row: ContractRow,
    nowMs: number,
    errorReason: string = 'EXEC_TTL_EXPIRED'
  ): boolean {
    if (row.claimed_at === null || nowMs <= row.claimed_at + row.exec_ttl_sec * 1000) {
      return false;
    }
    this.db
      .prepare(
        `UPDATE contracts SET status = 'TIMED_OUT', error_reason = ? WHERE id = ? AND status = 'CLAIMED'`
      )
      .run(errorReason, row.id);
    return true;
  }

  /**
   * Helper to compute the absolute lifetime deadline:
   * created_at + LIFETIME_QUEUE_TTL_MULTIPLIER * queue_ttl_sec.
   */
  private getLifetimeDeadline(row: ContractRow): number {
    return row.created_at + LIFETIME_QUEUE_TTL_MULTIPLIER * row.queue_ttl_sec * 1000;
  }

  /**
   * CLAIMED -> SUBMITTED. Hands a contract back to the queue (tail position) with a fresh
   * queue window. extend_count is reset because the renewal budget belongs to the holder;
   * retry_count is deliberately PRESERVED because the schema-failure circuit breaker is a
   * contract-level quota. Resetting it would let a holder launder retry budget by cycling
   * release -> re-claim. Refused once past the absolute lifetime deadline (-> TIMED_OUT).
   */
  public releaseContract(
    input: ReleaseContractInput,
    nowMs: number = Date.now()
  ): ReleaseContractResult {
    const agentId = this.resolveAgentIdentity(input.agent_id, 'agent_id');
    const row = this.loadClaimedContractForHolder(input.contract_id, agentId, 'release');

    if (this.expireIfExecTtlElapsed(row, nowMs)) {
      return {
        ok: false,
        contract_id: row.id,
        status: 'TIMED_OUT',
        release_count: row.release_count,
        max_releases: MAX_RELEASES,
        message: `Contract "${row.id}" exceeded execution TTL (${row.exec_ttl_sec}s) before release and was marked TIMED_OUT.`,
      };
    }

    const lifetimeDeadline = this.getLifetimeDeadline(row);
    if (nowMs >= lifetimeDeadline) {
      this.db
        .prepare(
          `UPDATE contracts SET status = 'TIMED_OUT', error_reason = 'LIFETIME_DEADLINE_EXPIRED' WHERE id = ? AND status = 'CLAIMED'`
        )
        .run(row.id);
      return {
        ok: false,
        contract_id: row.id,
        status: 'TIMED_OUT',
        release_count: row.release_count,
        max_releases: MAX_RELEASES,
        message: `Contract "${row.id}" reached its absolute lifetime cap (${LIFETIME_QUEUE_TTL_MULTIPLIER} x queue_ttl_sec) and cannot be released; marked TIMED_OUT.`,
      };
    }

    if (row.release_count >= MAX_RELEASES) {
      return {
        ok: false,
        contract_id: row.id,
        status: 'CLAIMED',
        release_count: row.release_count,
        max_releases: MAX_RELEASES,
        message: `Contract "${row.id}" has already been released ${row.release_count} times (max ${MAX_RELEASES}). It stays CLAIMED by "${agentId}"; call fail_contract with a reason if it cannot be completed.`,
      };
    }

    const reason = input.reason?.trim();
    const errorReason = reason ? `RELEASED_BY_HOLDER: ${reason}` : 'RELEASED_BY_HOLDER';

    const res = this.db
      .prepare(
        `UPDATE contracts
         SET status = 'SUBMITTED',
             claimed_at = NULL,
             queued_at = ?,
             extend_count = 0,
             release_count = release_count + 1,
             error_reason = ?
         WHERE id = ? AND status = 'CLAIMED' AND target_agent = ? AND release_count = ?`
      )
      .run(nowMs, errorReason, row.id, agentId, row.release_count);

    if (Number(res.changes) !== 1) {
      throw new Error(
        `Concurrent state change detected: contract "${row.id}" is no longer in 'CLAIMED' state.`
      );
    }

    const releaseCount = row.release_count + 1;
    return {
      ok: true,
      contract_id: row.id,
      status: 'SUBMITTED',
      release_count: releaseCount,
      max_releases: MAX_RELEASES,
      message: `Contract "${row.id}" released by "${agentId}" and re-queued as SUBMITTED (release ${releaseCount}/${MAX_RELEASES}, fresh ${row.queue_ttl_sec}s queue window).`,
    };
  }

  /**
   * Heartbeat / renewal: resets claimed_at to now, i.e. restarts the full exec_ttl_sec window.
   * Bounded by MAX_TTL_EXTENSIONS per holder and an absolute lifetime cap
   * (created_at + LIFETIME_QUEUE_TTL_MULTIPLIER * queue_ttl_sec).
   */
  public extendTtl(input: ExtendTtlInput, nowMs: number = Date.now()): ExtendTtlResult {
    const agentId = this.resolveAgentIdentity(input.agent_id, 'agent_id');
    const row = this.loadClaimedContractForHolder(input.contract_id, agentId, 'extend');

    if (this.expireIfExecTtlElapsed(row, nowMs)) {
      return {
        ok: false,
        contract_id: row.id,
        status: 'TIMED_OUT',
        extend_count: row.extend_count,
        max_extends: MAX_TTL_EXTENSIONS,
        message: `Contract "${row.id}" exceeded execution TTL (${row.exec_ttl_sec}s) before renewal and was marked TIMED_OUT. Renewal must happen inside the active window.`,
      };
    }

    const currentExpiresAt = (row.claimed_at ?? nowMs) + row.exec_ttl_sec * 1000;

    if (row.extend_count >= MAX_TTL_EXTENSIONS) {
      return {
        ok: false,
        contract_id: row.id,
        status: 'CLAIMED',
        claimed_at: row.claimed_at ?? undefined,
        expires_at: currentExpiresAt,
        extend_count: row.extend_count,
        max_extends: MAX_TTL_EXTENSIONS,
        message: `Extension limit reached for contract "${row.id}" (${MAX_TTL_EXTENSIONS}/${MAX_TTL_EXTENSIONS}). Deliver via fulfill_contract, hand it back via release_contract, or call fail_contract before the window closes.`,
      };
    }

    const lifetimeDeadline = this.getLifetimeDeadline(row);
    if (nowMs >= lifetimeDeadline) {
      return {
        ok: false,
        contract_id: row.id,
        status: 'CLAIMED',
        claimed_at: row.claimed_at ?? undefined,
        expires_at: currentExpiresAt,
        extend_count: row.extend_count,
        max_extends: MAX_TTL_EXTENSIONS,
        message: `Contract "${row.id}" reached its absolute lifetime cap (created_at + ${LIFETIME_QUEUE_TTL_MULTIPLIER} x queue_ttl_sec) and can no longer be renewed. The current window still ends at ${new Date(currentExpiresAt).toISOString()}.`,
      };
    }

    const proposedExpiresAt = nowMs + row.exec_ttl_sec * 1000;
    if (proposedExpiresAt > lifetimeDeadline) {
      return {
        ok: false,
        contract_id: row.id,
        status: 'CLAIMED',
        claimed_at: row.claimed_at ?? undefined,
        expires_at: currentExpiresAt,
        extend_count: row.extend_count,
        max_extends: MAX_TTL_EXTENSIONS,
        message: `Contract "${row.id}" renewal would push execution window to ${new Date(proposedExpiresAt).toISOString()}, exceeding the absolute lifetime cap (${new Date(lifetimeDeadline).toISOString()}). The current window still ends at ${new Date(currentExpiresAt).toISOString()}.`,
      };
    }

    const res = this.db
      .prepare(
        `UPDATE contracts
         SET claimed_at = ?, extend_count = extend_count + 1
         WHERE id = ? AND status = 'CLAIMED' AND target_agent = ? AND extend_count = ?`
      )
      .run(nowMs, row.id, agentId, row.extend_count);

    if (Number(res.changes) !== 1) {
      throw new Error(
        `Concurrent state change detected: contract "${row.id}" was modified while extending its TTL.`
      );
    }

    const extendCount = row.extend_count + 1;
    const expiresAt = nowMs + row.exec_ttl_sec * 1000;
    return {
      ok: true,
      contract_id: row.id,
      status: 'CLAIMED',
      claimed_at: nowMs,
      expires_at: expiresAt,
      extend_count: extendCount,
      max_extends: MAX_TTL_EXTENSIONS,
      message: `Execution window for contract "${row.id}" renewed for ${row.exec_ttl_sec}s (extension ${extendCount}/${MAX_TTL_EXTENSIONS}).`,
    };
  }

  /**
   * CLAIMED -> FAILED (terminal). Lets the holder close the loop explicitly instead of
   * leaving the requester waiting for the execution TTL to expire.
   */
  public failContract(input: FailContractInput, nowMs: number = Date.now()): FailContractResult {
    const agentId = this.resolveAgentIdentity(input.agent_id, 'agent_id');
    const reason = (input.reason ?? '').trim();
    if (!reason) {
      throw new Error('reason must not be empty when failing a contract.');
    }

    const row = this.loadClaimedContractForHolder(input.contract_id, agentId, 'fail');

    // A late failure report still loses to the TTL, but the worker's reason is preserved for the requester
    if (this.expireIfExecTtlElapsed(row, nowMs, `EXEC_TTL_EXPIRED (late failure report: ${reason})`)) {
      return {
        ok: false,
        contract_id: row.id,
        status: 'TIMED_OUT',
        message: `Contract "${row.id}" had already exceeded execution TTL (${row.exec_ttl_sec}s); marked TIMED_OUT with the failure reason attached.`,
      };
    }

    const res = this.db
      .prepare(
        `UPDATE contracts
         SET status = 'FAILED', error_reason = ?, completed_at = ?
         WHERE id = ? AND status = 'CLAIMED' AND target_agent = ?`
      )
      .run(`WORKER_FAILED: ${reason}`, nowMs, row.id, agentId);

    if (Number(res.changes) !== 1) {
      throw new Error(
        `Concurrent state change detected: contract "${row.id}" is no longer in 'CLAIMED' state.`
      );
    }

    return {
      ok: true,
      contract_id: row.id,
      status: 'FAILED',
      message: `Contract "${row.id}" marked FAILED by "${agentId}".`,
    };
  }

  /**
   * Strictly read-only inspection: never mutates the SQLite database.
   * Computes `is_logically_expired` dynamically on read.
   */
  public inspectMeshState(
    input: InspectMeshStateInput = {},
    nowMs: number = Date.now()
  ): {
    total_returned: number;
    contracts: Array<Record<string, unknown>>;
  } {
    let rows: ContractRow[];
    const limit = Math.min(Math.max(input.limit ?? 10, 1), 100);

    if (input.contract_id) {
      const single = this.db
        .prepare(`SELECT * FROM contracts WHERE id = ?`)
        .get(input.contract_id) as unknown as ContractRow | undefined;
      rows = single ? [single] : [];
    } else if (!input.status || input.status === 'ALL') {
      rows = this.db
        .prepare(`SELECT * FROM contracts ORDER BY created_at DESC LIMIT ?`)
        .all(limit) as unknown as ContractRow[];
    } else if (input.status === 'ACTIVE') {
      rows = this.db
        .prepare(
          `SELECT * FROM contracts WHERE status IN ('SUBMITTED', 'CLAIMED') ORDER BY created_at DESC LIMIT ?`
        )
        .all(limit) as unknown as ContractRow[];
    } else {
      rows = this.db
        .prepare(`SELECT * FROM contracts WHERE status = ? ORDER BY created_at DESC LIMIT ?`)
        .all(input.status, limit) as unknown as ContractRow[];
    }

    const formatted = rows.map((r) => {
      const queueStart = r.queued_at ?? r.created_at;
      const isLogicallyExpired =
        (r.status === 'SUBMITTED' && nowMs > queueStart + r.queue_ttl_sec * 1000) ||
        (r.status === 'CLAIMED' &&
          r.claimed_at !== null &&
          nowMs > r.claimed_at + r.exec_ttl_sec * 1000);

      return {
        contract_id: r.id,
        requester_agent: r.requester_agent,
        target_agent: r.target_agent,
        task_type: r.task_type,
        title: r.title,
        context_summary: r.context_summary,
        workspace_root: r.workspace_root,
        status: r.status,
        is_logically_expired: isLogicallyExpired,
        retry_count: r.retry_count,
        max_retries: r.max_retries,
        extend_count: r.extend_count ?? 0,
        release_count: r.release_count ?? 0,
        pointers: JSON.parse(r.pointers_json),
        contract_schema: r.contract_schema_json ? JSON.parse(r.contract_schema_json) : null,
        result_summary: r.result_summary,
        structured_output: r.structured_output_json ? JSON.parse(r.structured_output_json) : null,
        artifacts_pointers: r.artifacts_pointers_json
          ? JSON.parse(r.artifacts_pointers_json)
          : null,
        verified_sha256: r.verified_sha256_json ? JSON.parse(r.verified_sha256_json) : null,
        error_reason: r.error_reason,
        created_at: r.created_at,
        queued_at: queueStart,
        claimed_at: r.claimed_at,
        exec_expires_at:
          r.status === 'CLAIMED' && r.claimed_at !== null
            ? r.claimed_at + r.exec_ttl_sec * 1000
            : null,
        completed_at: r.completed_at,
      };
    });

    return {
      total_returned: formatted.length,
      contracts: formatted,
    };
  }

  public close(): void {
    this.db.close();
  }
}
