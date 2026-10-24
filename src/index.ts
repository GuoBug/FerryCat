#!/usr/bin/env node
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { FerryCatEngine } from './engine.js';
import {
  DispatchContractShape,
  ExtendTtlShape,
  FailContractShape,
  FulfillContractShape,
  InspectMeshStateShape,
  PollNextTaskShape,
  ReleaseContractShape,
  VerifyContractShape,
} from './schemas.js';

function loadPackageVersion(): string {
  try {
    const pkgPath = fileURLToPath(new URL('../package.json', import.meta.url));
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { version?: string };
    return pkg.version ?? '0.3.1';
  } catch {
    return '0.3.1';
  }
}

const PKG_VERSION = loadPackageVersion();

if (process.argv.includes('--version') || process.argv.includes('-v')) {
  console.log(PKG_VERSION);
  process.exit(0);
}

if (
  process.argv.includes('--help') ||
  process.argv.includes('-h') ||
  process.argv[2] === 'help'
) {
  console.log(`FerryCat MCP Stdio Server v${PKG_VERSION}
Contract-driven cross-host AI agent handoff & review bus over MCP and SQLite WAL.

Usage:
  ferrycat                        Start MCP stdio server (for IDE/Host integration)
  ferrycat --help | -h            Show this help message
  ferrycat --version | -v         Print version

Environment Variables:
  AGENT_NAME                      Default agent identity for this host (e.g., "antigravity", "workbuddy")
  FERRYCAT_DB_PATH                Custom SQLite database path (default: ~/.ferrycat/mesh.db)

Exposed MCP Tools (8):
  dispatch_contract               Dispatch a contract locking full-file SHA-256 pointers
  poll_next_task                  Atomically claim oldest SUBMITTED contract & verify pointers
  verify_contract                 Read-only pre-flight check of on-disk pointer files (ADR-0004)
  fulfill_contract                Submit results (with TOCTOU soft-failure buffering & Ajv schema validation)
  release_contract                Return CLAIMED contract to queue tail (max 3 releases)
  extend_ttl                      Heartbeat renewal of execution window (max 5 extensions)
  fail_contract                   Mark CLAIMED contract as terminal FAILED with reason
  inspect_mesh_state              Read-only query of contracts by status, ID, or target_agent

For CLI command usage (dispatch/poll/fulfill/verify/release/extend/fail/inspect/worker), run:
  ferrycat-cli --help`);
  process.exit(0);
}

const engine = new FerryCatEngine();

const server = new McpServer({
  name: 'ferrycat',
  version: PKG_VERSION,
});

// Tool 1: dispatch_contract
server.tool(
  'dispatch_contract',
  `Dispatch a task or code review contract to another local AI agent host via the shared SQLite WAL mesh.

### Purpose
Registers a new contract in SUBMITTED status with full-file SHA-256 fingerprint snapshots of all target files, establishing an immutable baseline for cross-host verification.

### Usage Guidelines
- When to use: Use when requesting code reviews, architecture audits, implementation, or test generation from a target agent (e.g., target_agent="workbuddy" or "antigravity").
- When NOT to use:
  - Do NOT use to claim or execute tasks (use poll_next_task).
  - Do NOT use to check task status or inspect outputs (use inspect_mesh_state).
  - Do NOT use if the target host does not share the same local filesystem access to workspace_root.
- Prerequisites: workspace_root must be a valid directory accessible by both hosts. Pointer files must exist on disk and be saved. Sensitive files (.env, keys, credentials, .git/config) and path escapes are strictly blocked.

### Behavior & Side Effects
- Mutates database: Synchronously inserts a single row into contracts with status='SUBMITTED' in SQLite WAL (~/.ferrycat/mesh.db).
- SHA-256 Snapshot: Computes 64-char hex SHA-256, byte size, and first/last lines for each pointer. Emits a warning if any file was modified within the last 3 seconds (indicating unsaved IDE buffers).
- Lifecycle & Expiry: Starts the queue_ttl_sec countdown (default: 1800s / 30m). If the target agent never claims it before queue_ttl_sec elapses, the contract lazily transitions to TIMED_OUT.
- Once claimed, execution is governed by exec_ttl_sec (tiered default: 1800s for review/audit, 300s for implementation/test).

### Return Value
Returns { contract_id: string, status: 'SUBMITTED', created_at: number, files: Array<{ path, size, mtime_ms, sha256, first_line, last_line, line_range? }>, warning?: string }. Note: requester_agent / target_agent / task_type / title / TTLs are NOT echoed back — read them via inspect_mesh_state if needed.`,
  DispatchContractShape,
  async (args) => {
    try {
      const result = engine.dispatchContract(args);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        isError: true,
        content: [{ type: 'text', text: JSON.stringify({ ok: false, error: message }, null, 2) }],
      };
    }
  }
);

// Tool 2: poll_next_task
server.tool(
  'poll_next_task',
  `Atomically claim the oldest pending SUBMITTED contract assigned to this agent and verify local file fingerprints.

### Purpose
Retrieves and claims next available contract work for the current agent, transitioning it from SUBMITTED to CLAIMED.

### Usage Guidelines
- When to use: Call periodically or when notified to discover and atomically take ownership of pending tasks assigned to your agent_id.
- When NOT to use:
  - Do NOT use to non-destructively inspect queue depth or monitor status without claiming (use inspect_mesh_state).
  - Do NOT use to create contracts (use dispatch_contract).
- IMPORTANT (ADR-0004): Pointers are an immutable baseline snapshot ("what I read"). Never edit pointer files directly on disk while holding a review contract; deliver any proposed code fixes via structured_output.fixes in fulfill_contract.

### Behavior & Side Effects
- Mutates database: Atomically claims the oldest SUBMITTED contract for agent_id using optimistic concurrency (UPDATE ... WHERE status='SUBMITTED', checked by changes===1). Starts the exec_ttl_sec window.
- Lazy TTL sweep: Automatically sweeps and marks expired contracts as TIMED_OUT using lock-free read-before-write probing.
- Fingerprint verification: Verifies Existence -> Byte Size -> SHA-256 for all pointers. If on-disk files were altered or missing, marks the contract POINTER_STALE and transparently advances to claim the next valid candidate in the queue.

### Return Value
- When work is claimed: { ok: true, has_task: true, status: 'CLAIMED', contract: { contract_id, requester_agent, target_agent, task_type, title, context_summary, workspace_root, pointers, contract_schema, claimed_at, exec_ttl_sec } }.
- When queue is empty: { ok: true, has_task: false, message: 'No pending contracts for agent "<agent_id>"' }.`,
  PollNextTaskShape,
  async (args) => {
    try {
      const result = engine.pollNextTask(args);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        isError: true,
        content: [{ type: 'text', text: JSON.stringify({ ok: false, error: message }, null, 2) }],
      };
    }
  }
);

// Tool 3: fulfill_contract
server.tool(
  'fulfill_contract',
  `Submit execution or review deliverables for a CLAIMED contract, with TOCTOU soft-failure buffering and Ajv JSON Schema validation.

### Purpose
Delivers the final output of a task, verifies that the code baseline was not mutated during execution, validates structured payloads, and transitions the contract to terminal COMPLETED.

### Usage Guidelines
- When to use: Use after completing task work to deliver result_summary, optional structured_output, and optional artifacts_pointers.
- When NOT to use:
  - Do NOT use if you cannot complete the task (use release_contract to re-queue, or fail_contract to record failure).
  - Do NOT use if you modified pointer files directly on disk. If modified accidentally, run "git stash" or restore the files, run verify_contract, and pass proposed fixes inside structured_output.fixes.

### Behavior & Side Effects
- Authorization: Caller agent_id must match target_agent of the claimed contract.
- TOCTOU Guard & Soft-Failure Buffer (ADR-0004) — exactly ONE recoverable rejection:
  - 1st blocked fulfill: returns status='RETRY_NEEDED', keeps the contract CLAIMED, renews the execution window (claimed_at=now), and lists dirty_files with restore instructions.
  - 2nd blocked fulfill: transitions to terminal status='POINTER_STALE', preserving your summary and payload in salvaged_result_json so the work is not lost.
  - Only ONE rejection is recoverable: restore/stash the files BEFORE retrying, and call verify_contract first so a stray second attempt cannot burn the buffer.
- Schema Validation: If contract_schema was defined, validates structured_output via cached Ajv validator. Failures 1 & 2 return RETRY_NEEDED with flattened error paths and renew the execution window; 3rd failure transitions to terminal VALIDATION_FAILED.
- On Success: Transitions to terminal status='COMPLETED', recording result_summary, structured_output, artifacts_pointers, and verified SHA-256 snapshot.

### Return Value
Returns { ok: boolean, contract_id: string, status: 'COMPLETED' | 'RETRY_NEEDED' | 'POINTER_STALE' | 'VALIDATION_FAILED', retry_count: number, max_retries: number, toctou_strike?: number, max_toctou_strikes?: number, dirty_files?: Array<{ path, reason, detail }>, validation_errors?: string[], message: string }.`,
  FulfillContractShape,
  async (args) => {
    try {
      const result = engine.fulfillContract(args);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        isError: true,
        content: [{ type: 'text', text: JSON.stringify({ ok: false, error: message }, null, 2) }],
      };
    }
  }
);

// Tool 4: inspect_mesh_state
server.tool(
  'inspect_mesh_state',
  `Strictly read-only query of contracts, execution progress, outputs, diagnostic counters, and failure causes.

### Purpose
Provides comprehensive observability into the multi-agent mesh state without acquiring database locks or mutating rows.

### Usage Guidelines
- When to use:
  - Check whether a contract you dispatched has been claimed or completed.
  - Inspect result summaries, structured outputs, or salvaged results of completed/stale contracts.
  - Monitor queue depth or pending contracts for a specific agent via target_agent filter.
- When NOT to use:
  - Do NOT use to claim tasks (use poll_next_task).
  - Do NOT use to dispatch tasks (use dispatch_contract).
  - Do NOT use to verify on-disk file pointer hygiene (use verify_contract).

### Behavior & Side Effects
- Zero side effects: Pure read-only SELECT query against SQLite WAL. Never alters rows or triggers sweeps.
- Dynamically calculates is_logically_expired: true when a contract has exceeded its queue or execution TTL based on the current timestamp, even before the next lazy sweep runs.

### Return Value
Returns { total_returned: number, contracts: Array<{ contract_id, requester_agent, target_agent, task_type, title, status, is_logically_expired, created_at, claimed_at, completed_at, retry_count, extend_count, release_count, toctou_strike, result_summary, structured_output, artifacts_pointers, error_reason, salvaged_result, verified_sha256 }> }.`,
  InspectMeshStateShape,
  async (args) => {
    try {
      const result = engine.inspectMeshState(args);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        isError: true,
        content: [{ type: 'text', text: JSON.stringify({ ok: false, error: message }, null, 2) }],
      };
    }
  }
);

function toToolResult(run: () => unknown) {
  try {
    const result = run();
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      isError: true,
      content: [
        { type: 'text' as const, text: JSON.stringify({ ok: false, error: message }, null, 2) },
      ],
    };
  }
}

// Tool 5: release_contract
server.tool(
  'release_contract',
  `Hand a CLAIMED contract back to the queue tail as SUBMITTED with a fresh queue window.

### Purpose
Allows an agent holding a claimed task to safely release ownership back to the queue without failing or aborting the task.

### Usage Guidelines
- When to use: Use when your agent claimed a task by mistake, encounters missing local dependencies/tools, or needs to switch git branches before processing.
- When NOT to use:
  - Do NOT use if the task permanently failed or cannot ever be completed (use fail_contract).
  - Do NOT use if you simply need more time to finish active execution (use extend_ttl).
- Prerequisites: Caller must be the current holder (agent_id matches target_agent) and contract status must be CLAIMED.

### Behavior & Side Effects
- Mutates database: Resets claimed_at=NULL, updates queued_at=nowMs, resets extend_count=0 (renewal quota is per holder), and increments release_count.
- Preserves retry_count: The schema validation circuit-breaker quota is contract-level; releasing a contract cannot launder previously consumed retry attempts.
- Audit history: Appends reason to error_reason history ("RELEASED_BY_HOLDER: <reason> | prev: ...").
- Limits: Maximum 3 releases per contract. Refused once the contract reaches its absolute lifetime ceiling (nowMs >= created_at + 4 * queue_ttl_sec).

### Return Value
Returns { ok: boolean, contract_id: string, status: 'SUBMITTED' | 'CLAIMED' | 'TIMED_OUT', release_count: number, max_releases: number, message: string }.`,
  ReleaseContractShape,
  async (args) => toToolResult(() => engine.releaseContract(args))
);

// Tool 6: extend_ttl
server.tool(
  'extend_ttl',
  `Heartbeat renewal for long-running execution: restarts the active execution window of a CLAIMED contract.

### Purpose
Prevents execution timeout during deep reasoning, extensive test execution, or complex multi-step refactoring by resetting the execution clock.

### Usage Guidelines
- When to use: Call periodically during long-running tasks before the active exec_ttl_sec countdown expires.
- When NOT to use:
  - Do NOT use after the window has already expired (expired contracts transition to TIMED_OUT).
  - Do NOT use to deliver task completion (use fulfill_contract).
  - Do NOT use if abandoning the task (use release_contract or fail_contract).
- Prerequisites: Caller must be the current holder and contract must be currently CLAIMED.

### Behavior & Side Effects
- Mutates database: Resets claimed_at=nowMs (restarting the full exec_ttl_sec window from the current moment) and increments extend_count.
- Quotas & Boundaries: Maximum 5 renewals per holder. Bounded by the contract's absolute lifetime ceiling (created_at + 4 * queue_ttl_sec); rejected if proposedExpiresAt > lifetimeDeadline.

### Return Value
Returns { ok: boolean, contract_id: string, status: 'CLAIMED' | 'TIMED_OUT', claimed_at?: number, expires_at?: number, extend_count: number, max_extends: number, message: string }.`,
  ExtendTtlShape,
  async (args) => toToolResult(() => engine.extendTtl(args))
);

// Tool 7: fail_contract
server.tool(
  'fail_contract',
  `Explicitly mark a CLAIMED contract as terminal FAILED with a mandatory failure reason.

### Purpose
Immediately terminates a claimed task that cannot be completed, recording actionable diagnostic reasons and freeing the requester from waiting for the execution TTL to expire.

### Usage Guidelines
- When to use: Use when a task encounters an unrecoverable failure (e.g. fatal syntax error, broken test suite, missing required environment).
- When NOT to use:
  - Do NOT use if the task succeeded (use fulfill_contract).
  - Do NOT use if the task is recoverable by another agent or retryable (use release_contract).
- Prerequisites: Caller must be the current holder and reason must be non-empty.

### Behavior & Side Effects
- Mutates database: Sets status='FAILED', error_reason='WORKER_FAILED: <reason>', and completed_at=nowMs.
- Late report handling: If the execution window already expired before fail_contract was called, the status becomes TIMED_OUT while faithfully preserving the worker's reason for the requester.

### Return Value
Returns { ok: boolean, contract_id: string, status: 'FAILED' | 'TIMED_OUT', message: string }.`,
  FailContractShape,
  async (args) => toToolResult(() => engine.failContract(args))
);

// Tool 8: verify_contract
server.tool(
  'verify_contract',
  `Read-only pre-flight consistency check (ADR-0004): audits on-disk pointer files against the baseline SHA-256 snapshot.

### Purpose
Enables agents or automated scripts to verify that on-disk files match the contract's dispatched baseline before calling fulfill_contract, preventing accidental TOCTOU strikes.

### Usage Guidelines
- When to use: Call before fulfill_contract while holding a CLAIMED contract to confirm file cleanliness, or when investigating why a fulfill call was blocked.
- When NOT to use:
  - Do NOT use to deliver results (use fulfill_contract).
  - Do NOT use to renew time (use extend_ttl).
- ADR-0004 Rule: Pointers are an immutable review baseline. If verify_contract reports dirty files, restore or stash them (e.g., git stash or git checkout -- <file>) and deliver proposed changes inside structured_output.fixes.

### Behavior & Side Effects
- Zero side effects: Pure read-only operation. Never updates the database, never alters contract status, and never consumes a TOCTOU strike.
- Complete pointer check: Verifies all pointer files on disk and returns every drifted file (reason: SIZE_MISMATCH, CONTENT_CHANGED, or FILE_MISSING).

### Return Value
Returns { ok: true, valid: boolean, fulfillable: boolean, contract_id: string, status: ContractStatus, target_agent: string, toctou_strike: number, max_toctou_strikes: number, dirty_files: Array<{ path, reason, detail }>, message: string }. NOTE: valid only means every pointer still matches its dispatched baseline. fulfillable additionally requires the contract to be CLAIMED. A contract that already went terminal (FAILED / POINTER_STALE / COMPLETED) can report valid=true while fulfillable=false, so branch on fulfillable rather than valid before calling fulfill_contract.`,
  VerifyContractShape,
  async (args) => toToolResult(() => engine.verifyContract(args))
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`[FerryCat Fatal] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
