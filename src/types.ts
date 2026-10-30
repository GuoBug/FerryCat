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
  /** Number of fulfill-time TOCTOU mismatch strikes (contract-level, max 1 soft warning before POINTER_STALE). */
  toctou_strike: number;
  /** Preserved submission payload if fulfill transitions to terminal POINTER_STALE. */
  salvaged_result_json?: string | null;
  /** Exclusive lease token issued at claim time (FC-301). NULL for unassigned or released rows. */
  claim_token?: string | null;
  /** Optional unified git diff patch payload for cross-branch / self-contained reviews (FC-202). */
  git_patch?: string | null;
  /** SHA-256 hex digest of git_patch when present (FC-202). */
  patch_sha256?: string | null;
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
  /** Optional unified git diff patch snapshot (max 512KB) for cross-branch / disjoint workspace handoffs (FC-202). */
  git_patch?: string;
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
  patch_sha256?: string;
  patch_bytes?: number;
  warning?: string;
}

export interface PollNextTaskInput {
  agent_id?: string;
  task_types?: TaskType[];
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
    /** Exclusive lease token issued for this claim session (FC-301). Pass to mutating operations. */
    claim_token?: string;
    /** Optional unified git diff patch carried by the contract (FC-202). */
    git_patch?: string | null;
    /** SHA-256 hex digest of git_patch when present (FC-202). */
    patch_sha256?: string | null;
    /** Indicates whether the contract was claimed with an attached patch or via self-contained cross-branch fallback (FC-202). */
    patch_mode?: 'ATTACHED' | 'SELF_CONTAINED';
    /** Explicit warning emitted when patch_mode === 'SELF_CONTAINED' alerting the worker that on-disk files do not match the reviewed revision (FC-202). */
    workspace_warning?: string;
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
  claim_token?: string;
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
  toctou_strike?: number;
  max_toctou_strikes?: number;
  dirty_files?: Array<{
    path: string;
    reason: string;
    detail: string;
  }>;
  validation_errors?: string[];
  /** True when a mutation contract ('implementation' | 'test_generation') completed with 0 modified pointers and 0 added artifacts. */
  no_op?: boolean;
  message: string;
}

export interface VerifyContractInput {
  contract_id: string;
  agent_id?: string;
  claim_token?: string;
}

export interface VerifyContractResult {
  ok: boolean;
  valid: boolean;
  contract_id: string;
  status: ContractStatus;
  /** True only when status === 'CLAIMED'; file validity alone does not imply fulfillability. */
  fulfillable?: boolean;
  target_agent: string;
  toctou_strike: number;
  max_toctou_strikes: number;
  dirty_files: Array<{
    path: string;
    reason: string;
    detail: string;
  }>;
  message: string;
}

export interface ReleaseContractInput {
  contract_id: string;
  agent_id?: string;
  claim_token?: string;
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
  claim_token?: string;
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
  claim_token?: string;
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
  target_agent?: string;
  status?: ContractStatus | 'ACTIVE' | 'ALL';
  limit?: number;
  /** When true, includes the raw git_patch string in each inspected contract row (default: false to avoid multi-hundred-KB responses). */
  include_patch?: boolean;
}

export interface DaemonLockRow {
  id: string;
  owner_token: string;
  heartbeat_at: number;
  expires_at: number;
  metadata_json: string | null;
}

export interface AcquireDaemonLeaseInput {
  lock_id?: string;
  owner_token: string;
  ttl_sec?: number;
  metadata?: Record<string, unknown>;
}

export interface AcquireDaemonLeaseResult {
  ok: boolean;
  lock_id: string;
  owner_token: string;
  expires_at: number;
  message?: string;
}

export interface RenewDaemonLeaseInput {
  lock_id?: string;
  owner_token: string;
  ttl_sec?: number;
}

export interface RenewDaemonLeaseResult {
  ok: boolean;
  lock_id: string;
  expires_at: number;
  message?: string;
}

export interface ReleaseDaemonLeaseInput {
  lock_id?: string;
  owner_token: string;
}

export interface ReleaseDaemonLeaseResult {
  ok: boolean;
  lock_id: string;
  message?: string;
}

