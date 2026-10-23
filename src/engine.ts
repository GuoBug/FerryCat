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
  FileFingerprint,
  FulfillContractInput,
  FulfillContractResult,
  InspectMeshStateInput,
  PollNextTaskInput,
  PollNextTaskResult,
} from './types.js';

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
        claimed_at INTEGER,
        completed_at INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_contracts_poll
      ON contracts(target_agent, status, created_at);
    `);

    try {
      this.db.exec('ALTER TABLE contracts ADD COLUMN verified_sha256_json TEXT;');
    } catch {
      // Column already exists in existing database
    }
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
    const queueTtlSec = input.queue_ttl_sec ?? 1800;
    const execTtlSec = input.exec_ttl_sec ?? 300;

    const stmt = this.db.prepare(`
      INSERT INTO contracts (
        id, requester_agent, target_agent, task_type, title, context_summary,
        workspace_root, pointers_json, contract_schema_json, status,
        retry_count, max_retries, queue_ttl_sec, exec_ttl_sec, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'SUBMITTED', 0, 2, ?, ?, ?)
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
         WHERE (status = 'SUBMITTED' AND (created_at + queue_ttl_sec * 1000) < ?)
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
           WHERE (status = 'SUBMITTED' AND (created_at + queue_ttl_sec * 1000) < ?)
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
       ORDER BY created_at ASC
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

    const row = this.db
      .prepare(`SELECT * FROM contracts WHERE id = ?`)
      .get(input.contract_id) as unknown as ContractRow | undefined;

    if (!row) {
      throw new Error(`Contract "${input.contract_id}" not found.`);
    }

    if (row.target_agent !== agentId) {
      throw new Error(
        `Permission denied: contract "${row.id}" was assigned to "${row.target_agent}", but fulfillment was attempted by "${agentId}".`
      );
    }

    if (row.status !== 'CLAIMED') {
      throw new Error(
        `Cannot fulfill contract "${input.contract_id}": expected status 'CLAIMED', but current status is '${row.status}'.`
      );
    }

    // Check execution TTL
    if (row.claimed_at && nowMs > row.claimed_at + row.exec_ttl_sec * 1000) {
      this.db
        .prepare(
          `UPDATE contracts SET status = 'TIMED_OUT', error_reason = 'EXEC_TTL_EXPIRED' WHERE id = ? AND status = 'CLAIMED'`
        )
        .run(row.id);

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
          this.db
            .prepare(`UPDATE contracts SET retry_count = ? WHERE id = ? AND status = 'CLAIMED'`)
            .run(nextRetryCount, row.id);

          return {
            ok: false,
            contract_id: row.id,
            status: 'RETRY_NEEDED',
            retry_count: nextRetryCount,
            max_retries: row.max_retries,
            validation_errors: validation.errors,
            message: `structured_output failed schema validation (failed attempt ${nextRetryCount}, max_retries=${row.max_retries}). Fix the fields and call fulfill_contract again.`,
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
      const isLogicallyExpired =
        (r.status === 'SUBMITTED' && nowMs > r.created_at + r.queue_ttl_sec * 1000) ||
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
        claimed_at: r.claimed_at,
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
