import { z } from 'zod';

export const DispatchContractShape = {
  requester_agent: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .describe('Requester agent identifier (defaults to AGENT_NAME env var, e.g., "antigravity")'),
  target_agent: z
    .string()
    .min(1)
    .max(64)
    .describe('Target worker agent identifier (e.g., "workbuddy", "antigravity")'),
  task_type: z
    .enum(['code_review', 'architecture_audit', 'implementation', 'test_generation'])
    .describe('Type of contract task'),
  title: z.string().min(1).max(120).describe('Concise contract title'),
  context_summary: z
    .string()
    .min(1)
    .max(20000)
    .describe('Task instructions, audit focus, and background context'),
  workspace_root: z
    .string()
    .min(1)
    .max(512)
    .describe('Absolute path to the shared local workspace root directory'),
  pointers: z
    .array(
      z.object({
        path: z.string().min(1).max(512).describe('File path relative to workspace_root'),
        line_range: z
          .tuple([z.number().int().positive(), z.number().int().positive()])
          .optional()
          .describe('Optional [startLine, endLine] 1-based inclusive range'),
      })
    )
    .min(1)
    .max(50)
    .describe('File pointers to be hashed and verified on the worker side (max 50 files)'),
  contract_schema: z
    .record(z.unknown())
    .optional()
    .describe('Optional JSON Schema that the worker structured_output must satisfy'),
  queue_ttl_sec: z
    .number()
    .int()
    .positive()
    .max(86400)
    .optional()
    .describe('Queue expiration TTL in seconds for SUBMITTED state (default: 1800)'),
  exec_ttl_sec: z
    .number()
    .int()
    .positive()
    .max(7200)
    .optional()
    .describe('Execution expiration TTL in seconds for CLAIMED state (default: 300)'),
};

export const PollNextTaskShape = {
  agent_id: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .describe('Current worker agent identifier (defaults to AGENT_NAME env var, e.g., "workbuddy")'),
};

export const FulfillContractShape = {
  contract_id: z.string().min(1).max(128).describe('The contract ID returned by poll_next_task'),
  agent_id: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .describe('Worker agent identifier (defaults to AGENT_NAME env var)'),
  result_summary: z
    .string()
    .min(1)
    .max(20000)
    .describe('Human-readable summary of findings or implementation'),
  structured_output: z
    .record(z.unknown())
    .optional()
    .describe('Structured JSON payload matching the contract_schema'),
  artifacts_pointers: z
    .array(
      z.object({
        path: z.string().min(1).max(512),
        description: z.string().min(1).max(1000),
      })
    )
    .max(50)
    .optional()
    .describe('Optional pointers to files created or modified during task execution'),
};

export const InspectMeshStateShape = {
  contract_id: z
    .string()
    .min(1)
    .max(128)
    .optional()
    .describe('Optional specific contract_id to inspect'),
  status: z
    .enum([
      'SUBMITTED',
      'CLAIMED',
      'COMPLETED',
      'POINTER_STALE',
      'VALIDATION_FAILED',
      'TIMED_OUT',
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
export const InspectMeshStateSchema = z.object(InspectMeshStateShape);

export const WorkerCommandShape = {
  agent_id: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .describe('Worker agent identifier (defaults to AGENT_NAME env var)'),
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
};

export const WorkerCommandSchema = z.object(WorkerCommandShape).strict();
