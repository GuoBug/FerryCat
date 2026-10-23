export type ContractStatus =
  | 'SUBMITTED'
  | 'CLAIMED'
  | 'COMPLETED'
  | 'POINTER_STALE'
  | 'VALIDATION_FAILED'
  | 'TIMED_OUT'
  | 'FAILED';

export type TaskType =
  | 'code_review'
  | 'architecture_audit'
  | 'implementation'
  | 'test_generation';

export interface FilePointerInput {
  path: string;
  line_range?: [number, number];
}

export interface FileFingerprint {
  path: string;
  size: number;
  mtime_ms: number;
  sha256: string; // Full-file SHA-256 (64 hex chars)
  first_line: string;
  last_line: string;
  line_range?: [number, number];
}

export interface ArtifactPointer {
  path: string;
  description: string;
}

export interface ContractRow {
  id: string;
  requester_agent: string;
  target_agent: string;
  task_type: TaskType;
  title: string;
  context_summary: string;
  workspace_root: string;
  pointers_json: string;
  contract_schema_json: string | null;
  status: ContractStatus;
  retry_count: number;
  max_retries: number;
  queue_ttl_sec: number;
  exec_ttl_sec: number;
  result_summary: string | null;
  structured_output_json: string | null;
  artifacts_pointers_json: string | null;
  verified_sha256_json?: string | null;
  error_reason: string | null;
  created_at: number;
  /** Start of the current queue window; reset on release. NULL for rows written by pre-0.2 hosts. */
  queued_at: number | null;
  claimed_at: number | null;
  completed_at: number | null;
  /** Number of extend_ttl calls by the current holder (reset on release). */
  extend_count: number;
  /** Number of times the contract was released back to the queue. */
  release_count: number;
}

export interface DispatchContractInput {
  requester_agent?: string;
  target_agent: string;
  task_type: TaskType;
  title: string;
  context_summary: string;
  workspace_root: string;
  pointers: FilePointerInput[];
  contract_schema?: Record<string, unknown>;
  queue_ttl_sec?: number;
  exec_ttl_sec?: number;
}

export interface DispatchContractResult {
  contract_id: string;
  status: 'SUBMITTED';
  created_at: number;
  files: Array<{
    path: string;
    size: number;
    mtime_ms: number;
    sha256: string;
    first_line: string;
    last_line: string;
    line_range?: [number, number];
  }>;
  warning?: string;
}

export interface PollNextTaskInput {
  agent_id?: string;
}

export interface PollNextTaskResult {
  has_task: boolean;
  status?: 'CLAIMED' | 'POINTER_STALE';
  contract?: {
    contract_id: string;
    requester_agent: string;
    target_agent: string;
    task_type: TaskType;
    title: string;
    context_summary: string;
    workspace_root: string;
    pointers: FileFingerprint[];
    contract_schema: Record<string, unknown> | null;
    claimed_at: number;
    exec_ttl_sec: number;
  };
  stale_error?: {
    contract_id: string;
    reason: string;
    message: string;
  };
  message?: string;
}

export interface FulfillContractInput {
  contract_id: string;
  agent_id?: string;
  result_summary: string;
  structured_output?: Record<string, unknown>;
  artifacts_pointers?: ArtifactPointer[];
}

export interface FulfillContractResult {
  ok: boolean;
  contract_id: string;
  status: 'COMPLETED' | 'RETRY_NEEDED' | 'VALIDATION_FAILED' | 'TIMED_OUT' | 'POINTER_STALE';
  retry_count: number;
  max_retries: number;
  validation_errors?: string[];
  message: string;
}

export interface ReleaseContractInput {
  contract_id: string;
  agent_id?: string;
  reason?: string;
}

export interface ReleaseContractResult {
  ok: boolean;
  contract_id: string;
  status: 'SUBMITTED' | 'CLAIMED' | 'TIMED_OUT';
  release_count: number;
  max_releases: number;
  message: string;
}

export interface ExtendTtlInput {
  contract_id: string;
  agent_id?: string;
}

export interface ExtendTtlResult {
  ok: boolean;
  contract_id: string;
  status: 'CLAIMED' | 'TIMED_OUT';
  claimed_at?: number;
  expires_at?: number;
  extend_count: number;
  max_extends: number;
  message: string;
}

export interface FailContractInput {
  contract_id: string;
  agent_id?: string;
  reason: string;
}

export interface FailContractResult {
  ok: boolean;
  contract_id: string;
  status: 'FAILED' | 'TIMED_OUT';
  message: string;
}

export interface InspectMeshStateInput {
  contract_id?: string;
  status?: ContractStatus | 'ACTIVE' | 'ALL';
  limit?: number;
}
