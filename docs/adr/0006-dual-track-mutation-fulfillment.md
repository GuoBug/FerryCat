# ADR-0006: Dual-Track TOCTOU Semantics & Post-Mutation SHA-256 Fulfillment

- **Status**: Accepted (Amends [ADR-0004](0004-review-mutation-separation-and-toctou-buffer.md) for mutation task types)
- **Date**: 2026-10-27
- **Authors**: Guo Qiang (GuoBug), Antigravity Engine, WorkBuddy Multi-Model Team
- **Context**: Real-world fulfillment block in contract `fc_1793100801409_4eedf544` (`UNFULFILLABLE_BY_DESIGN`) and cross-audit review in `fc_1793103161311_aa71d377`

---

## 1. Context & Problem Statement

In [ADR-0004](0004-review-mutation-separation-and-toctou-buffer.md), FerryCat enforced a strict immutable baseline check (`verifyAllPointers`) at `fulfill_contract` time across all task types to prevent reviewers from mutating files during `code_review` or `architecture_audit`.

However, when dispatching `fc_1793100801409_4eedf544` (`task_type: 'implementation'`) to `workbuddy` to implement `FC-403`, a fundamental lifecycle contradiction emerged:
1. `pointers` locked the target files (`src/daemon.ts`, `src/schemas.ts`, `test/run-all.ts`, `ferrycat.config.example.json`) that `workbuddy` was instructed to modify;
2. Once `workbuddy` modified those files on disk, `fulfillContract` unconditionally called `verifyAllPointers`, rejecting the delivery with `TOCTOU_SIZE_MISMATCH`;
3. `workbuddy` had to release the contract with `RELEASED_BY_HOLDER: UNFULFILLABLE_BY_DESIGN`.

---

## 2. Decision: Dual-Track TOCTOU & Post-Mutation Cryptographic Audit Trail

We split `fulfill_contract` and `verify_contract` verification into two deterministic tracks based on `task_type`:

### Track A: Read-Only Audit Tasks (`code_review` | `architecture_audit`)
- **Claim Time (`poll_next_task`)**: `pointers` must match dispatched SHA-256 baseline on disk.
- **Fulfill Time (`fulfill_contract`)**: `pointers` must remain **100% unchanged** (`verifyAllPointers`). Any byte or size modification triggers ADR-0004 Strike 1 (`RETRY_NEEDED`) $\to$ Strike 2 (`POINTER_STALE`).
- **Pre-Flight / Post-Audit (`verify_contract`)**: Always verifies against the immutable `pointers` baseline.

### Track B: Mutation Tasks (`implementation` | `test_generation`)
- **Claim Time (`poll_next_task`)**: `pointers` must match the dispatched pre-mutation SHA-256 baseline on disk, guaranteeing the worker starts from a clean, uncorrupted working tree.
- **Fulfill Time (`fulfill_contract` via `verifyAndSnapshotMutationPointers`)**:
  - **Hard Blockers Kept**: `SECURITY_REJECTED` (workspace escape, sensitive file blacklist, symlink escape) and `FILE_MISSING` (deleted pointer file or non-existent declared `artifacts_pointers` file) remain hard failures that trigger TOCTOU strikes.
  - **Mutations Permitted & Hashed**: `SIZE_MISMATCH` and `CONTENT_CHANGED` on pointer files are permitted. The engine computes the **post-mutation full-file SHA-256** of every pointer file and every declared `artifacts_pointers` file, committing that map into `verified_sha256_json`.
  - **Dual SHA-256 Audit Chain**:
    - `pointers_json` permanently preserves the **Pre-Mutation Input Baseline SHA-256**;
    - `verified_sha256_json` permanently records the **Post-Mutation Delivered Artifact SHA-256**.
  - **No-Op Warning**: If a mutation contract is fulfilled with zero modified pointers and zero new artifacts, completion succeeds with an explicit `WARNING: no-op fulfillment` in the response message.
- **Verification (`verify_contract`)**:
  - While `SUBMITTED`: verifies against the pre-claim `pointers` baseline.
  - While `CLAIMED`: runs `verifyAndSnapshotMutationPointers`, returning `valid: true, fulfillable: true` if all pointer files pass security and existence checks, while listing modified files in `dirty_files` for pre-delivery inspection.
  - Once `COMPLETED`: runs `verifyCommittedMutationSnapshot` against the committed `verified_sha256_json` map (`valid: true, fulfillable: false` when on-disk files match the delivered snapshot; `valid: false` if any delivered file drifted *after* completion).

---

## 3. Trade-Offs & Boundaries

- **Shared-Workspace Concurrency**: Because mutation tasks modify files in place inside `workspace_root`, dispatching concurrent mutation contracts that touch overlapping files in the same working tree will cause the second contract's pre-claim or post-completion check to detect drift. Callers should serialize overlapping `implementation` contracts or isolate them via git worktrees.
