import { z } from 'zod';

export const DispatchContractShape = {
  requester_agent: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .describe('Requester agent identifier. Defaults to AGENT_NAME env var (e.g., "antigravity", "workbuddy").'),
  target_agent: z
    .string()
    .min(1)
    .max(64)
    .describe('Target worker agent identifier expected to claim and execute this contract (e.g., "workbuddy", "antigravity").'),
  task_type: z
    .enum(['code_review', 'architecture_audit', 'implementation', 'test_generation'])
    .describe(
      'Type of contract task. Tiered default execution TTL: 1800s for code_review/architecture_audit, 300s for implementation/test_generation.'
    ),
  title: z
    .string()
    .min(1)
    .max(120)
    .describe('Concise contract title (1-120 chars) summarizing the goal of the request.'),
  context_summary: z
    .string()
    .min(1)
    .max(20000)
    .describe(
      'Detailed task instructions, audit focus areas, architectural constraints, and background context for the worker agent (1-20000 chars).'
    ),
  workspace_root: z
    .string()
    .min(1)
    .max(512)
    .describe(
      'Absolute canonical path to the shared local workspace directory accessible by both hosts (e.g. "F:/git/FerryCat"). Path escapes and sensitive files are blocked.'
    ),
  pointers: z
    .array(
      z.object({
        path: z
          .string()
          .min(1)
          .max(512)
          .describe(
            'File path relative to workspace_root. Must exist on disk. Sensitive files (.env*, *.pem, *.key, id_rsa*, *credentials*, *secret*, .npmrc, .git/config) and path escapes are strictly rejected.'
          ),
        line_range: z
          .tuple([z.number().int().positive(), z.number().int().positive()])
          .optional()
          .describe('Optional [startLine, endLine] 1-based inclusive line range focus for the task.'),
      })
    )
    .min(1)
    .max(50)
    .describe('Array of 1 to 50 target file pointers hashed with full-file SHA-256 and snapshot boundaries for tamper detection.'),
  contract_schema: z
    .record(z.unknown())
    .optional()
    .describe(
      'Optional Draft-07 JSON Schema that structured_output must validate against. Enforces bounded retry (max 2 RETRY_NEEDED attempts before terminal VALIDATION_FAILED).'
    ),
  queue_ttl_sec: z
    .number()
    .int()
    .positive()
    .max(86400)
    .optional()
    .describe('Queue expiration TTL in seconds while status is SUBMITTED (default: 1800s / 30m). Transitions to TIMED_OUT if unclaimed before expiry.'),
  exec_ttl_sec: z
    .number()
    .int()
    .positive()
    .max(7200)
    .optional()
    .describe(
      'Execution TTL in seconds once CLAIMED (default: 1800s for review/audit, 300s for implementation/test). Worker must fulfill, extend, release, or fail within this window.'
    ),
};

export const PollNextTaskShape = {
  agent_id: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .describe('Worker agent identifier claiming tasks (defaults to AGENT_NAME env var, e.g., "workbuddy").'),
};

export const FulfillContractShape = {
  contract_id: z
    .string()
    .min(1)
    .max(128)
    .describe('The contract ID returned by poll_next_task that is currently in CLAIMED status.'),
  agent_id: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .describe('Worker agent identifier. Must match the contract target_agent (defaults to AGENT_NAME env var).'),
  result_summary: z
    .string()
    .min(1)
    .max(20000)
    .describe('Detailed markdown or plain text summary of review findings, implementation details, or test execution outcomes (1-20000 chars).'),
  structured_output: z
    .record(z.unknown())
    .optional()
    .describe(
      'Structured JSON payload matching contract_schema. For code reviews, pass proposed patches in fixes: [{ path, patch, description }] rather than editing pointer files directly (ADR-0004).'
    ),
  artifacts_pointers: z
    .array(
      z.object({
        path: z.string().min(1).max(512).describe('File path of created or modified artifact relative to workspace_root'),
        description: z.string().min(1).max(1000).describe('Description of the artifact and its role'),
      })
    )
    .max(50)
    .optional()
    .describe('Optional pointers to new or modified artifact files created during task execution (max 50 files).'),
};

export const VerifyContractShape = {
  contract_id: z
    .string()
    .min(1)
    .max(128)
    .describe(
      'The contract ID whose on-disk pointer files should be verified against the baseline SHA-256 snapshot without mutating contract state.'
    ),
  agent_id: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .describe('Optional caller agent identifier for audit logging. Does not restrict read-only verification.'),
};

export const ReleaseContractShape = {
  contract_id: z
    .string()
    .min(1)
    .max(128)
    .describe('The CLAIMED contract ID to release back to the queue tail as SUBMITTED.'),
  agent_id: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .describe('Current holder agent identifier. Must match target_agent of the claimed contract (defaults to AGENT_NAME env var).'),
  reason: z
    .string()
    .min(1)
    .max(2000)
    .optional()
    .describe('Optional reason for releasing (e.g., "wrong context", "missing tool", "switching git branch"). Appended to error_reason history.'),
};

export const ExtendTtlShape = {
  contract_id: z
    .string()
    .min(1)
    .max(128)
    .describe('The CLAIMED contract ID whose active execution window should be renewed.'),
  agent_id: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .describe('Current holder agent identifier. Must match target_agent of the claimed contract (defaults to AGENT_NAME env var).'),
};

export const FailContractShape = {
  contract_id: z
    .string()
    .min(1)
    .max(128)
    .describe('The CLAIMED contract ID to mark as terminal FAILED.'),
  agent_id: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .describe('Current holder agent identifier. Must match target_agent of the claimed contract (defaults to AGENT_NAME env var).'),
  reason: z
    .string()
    .min(1)
    .max(2000)
    .describe('Mandatory explanation of why the task cannot be completed. Stored in error_reason for the requester.'),
};

export const InspectMeshStateShape = {
  contract_id: z
    .string()
    .min(1)
    .max(128)
    .optional()
    .describe('Optional specific contract_id to inspect single contract details, counters, errors, and output payloads.'),
  target_agent: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .describe('Optional filter by target worker agent identifier (e.g., "workbuddy") to view pending or completed queue items.'),
  status: z
    .enum([
      'SUBMITTED',
      'CLAIMED',
      'COMPLETED',
      'POINTER_STALE',
      'VALIDATION_FAILED',
      'TIMED_OUT',
      'FAILED',
      'ACTIVE',
      'ALL',
    ])
    .optional()
    .describe('Filter by status (default: ALL)'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe('Maximum number of records to return (default: 10)'),
};

export const DispatchContractSchema = z.object(DispatchContractShape);
export const PollNextTaskSchema = z.object(PollNextTaskShape);
export const FulfillContractSchema = z.object(FulfillContractShape);
export const VerifyContractSchema = z.object(VerifyContractShape);
export const ReleaseContractSchema = z.object(ReleaseContractShape);
export const ExtendTtlSchema = z.object(ExtendTtlShape);
export const FailContractSchema = z.object(FailContractShape);
export const InspectMeshStateSchema = z.object(InspectMeshStateShape);

export const WorkerCommandShape = {
  agent_id: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .describe('Worker agent identifier (defaults to AGENT_NAME env var)'),
  mode: z
    .enum(['watch', 'claim', 'exec'])
    .optional()
    .describe(
      'Explicit worker behavior mode: "watch" (persistent non-claiming notifier), "claim" (single-shot claim and exit), or "exec" (auto-claim and run --exec / --exec-file)'
    ),
  once: z
    .boolean()
    .optional()
    .describe('Run single poll attempt and exit immediately (Subprocess-per-Task mode)'),
  interval_ms: z
    .number()
    .int()
    .min(100)
    .max(60000)
    .optional()
    .describe('Polling interval in milliseconds for persistent worker loop (default: 1000)'),
  exec: z
    .string()
    .min(1)
    .max(1024)
    .optional()
    .describe('Optional command or script to execute upon task claim; stdout will be used to fulfill contract automatically'),
  exec_file: z
    .string()
    .min(1)
    .max(1024)
    .optional()
    .describe('Optional script file (.js/.mjs/.cjs/.ts/.ps1/.sh) to execute upon task claim without shell quote escaping'),
};

export const WorkerCommandSchema = z.object(WorkerCommandShape).strict();
