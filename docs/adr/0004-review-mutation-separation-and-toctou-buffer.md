# ADR-0004: Separation of Review and Mutation (SRM), TOCTOU Soft-Failure Buffering, and Read-Only Baseline Protocol

- **Status**: Accepted (Amended for `implementation` / `test_generation` tasks by [ADR-0006](0006-dual-track-mutation-fulfillment.md))
- **Date**: 2026-10-23
- **Authors**: Guo Qiang (GuoBug), Antigravity Engine, WorkBuddy Multi-Model Team
- **Context**: Real-world collision incident in contract `fc_1792755474459_099b018e` and architecture consensus in `fc_1792757763323_a5d5da12`

---

## 1. Context & Incident Post-Mortem

During the Phase A final verification of FerryCat, a critical multi-agent write collision occurred:

1. **The Setup**: Requester (`antigravity`) dispatched a code audit contract locking SHA-256 fingerprints across 5 pointer files including `src/engine.ts`.
2. **The Action**: Reviewer (`workbuddy`) spotted 6 documentation and comment drifts regarding `release_contract` semantics. Being proactive, it directly patched those comments in the local working directory.
3. **The Collision**: Upon calling `fulfill_contract`, FerryCat's TOCTOU guard detected `src/engine.ts` size changed from 32,909 to 33,103 bytes. It immediately transitioned the contract to terminal `POINTER_STALE`, invalidating 30 minutes of deep review labor.

While the watchdog performed its deterministic duty ("never fulfill against mutated baseline"), it exposed a fundamental architectural tension:
**FerryCat had a single `pointers` channel burdened with two conflicting semantics**:
- **Semantic A: Evidence Anchor ("What I read")** $\to$ Must remain 100% immutable to prove what baseline was audited.
- **Semantic B: Deliverables ("What I changed")** $\to$ Inevitably mutates disk bytes.

Loosening pointer validation for mutable tasks ruins the `verified_sha256` audit trail. Hard-failing immediately causes severe friction when reviewers attempt helpful fixes.

---

## 2. Architectural Decisions: 4-Layer Evolution Model

```mermaid
flowchart TD
    subgraph L4 ["Layer 4: Structural Target (Separation of Review & Mutation)"]
        P1["Pointers Channel<br>(Read-Only Evidence, SHA-256 Immutable)"]
        P2["structured_output.fixes Channel<br>(Diff/Patch Payloads, No In-Place Disk Pollution)"]
    end

    subgraph L2 ["Layer 2: DX & Tooling Guards"]
        D1["Read-Only verify Pre-Flight<br>(Detect Drifts Before Attempting Fulfill)"]
        D2["TOCTOU Soft-Failure Buffering<br>(Keep CLAIMED on First Drift, Advise git stash)"]
    end

    subgraph L3 ["Layer 3: SOP & Explicit Guidance"]
        S1["MCP / CLI Tool Descriptions Mandate Read-Only Snapshot"]
        S2["Error Messages Provide Actionable Rescue Guidance"]
    end
```

### 2.1 Decision 1: Separation of Review and Mutation (SRM Protocol)
- **Rule**: In audit tasks (`code_review` / `architecture_audit`), reviewers must **never mutate files referenced in `pointers`**.
- **Fix Delivery Protocol**: Code fixes and patches must be delivered as patch/diff structures inside `structured_output.fixes`:
  ```json
  {
    "result_summary": "Audit passed cleanly. Included 2 suggested patches.",
    "structured_output": {
      "verdict": "approved_with_fixes",
      "fixes": [
        {
          "path": "src/engine.ts",
          "patch": "@@ -613,2 +613,4 @@ ...",
          "description": "Fix release semantics comment"
        }
      ]
    }
  }
  ```
- **Benefits**:
  1. `pointers` remain pristine, ensuring fulfill success and uncompromised audit trail.
  2. Requester retains full sovereignty to review, apply, reject, or adjust the proposed diffs.
  3. **Zero engine code modifications**: `structured_output` is already a freeform JSON record.

### 2.2 Decision 2: DX Pre-Flight & TOCTOU Soft-Failure Buffering
- **Read-Only Verification**: Phase B will expose a non-destructive `ferrycat verify` or pre-flight check so workers can verify file hygiene before submitting.
- **Soft-Failure Buffering**: First-time TOCTOU mismatches should return a recoverable error keeping the contract `CLAIMED`, allowing the worker to `git stash` and retry fulfill without aborting the contract.

### 2.3 Decision 3: Actionable Error Messages (P0)
- Error messages must explicitly suggest recovery paths:
  > `TOCTOU_MISMATCH: pointers were modified on disk during execution. If unintentional, restore/stash files and retry fulfill; if you have fixes to deliver, provide them via structured_output.fixes instead of mutating workspace files directly.`

---

## 3. Consequences

### Positive
- Eliminates accidental contract invalidation during audit sessions.
- Preserves the purity of `verified_sha256` as true baseline proof.
- Standardizes patch structures for upcoming **FC-202 (Self-Contained Git Patch Mode)**.

### Trade-offs
- Reviewers cannot directly edit and commit files in-place during review contracts. They must provide diffs in structured output for the requester to apply.

---

## 4. Appendix: Lifecycle Invariants & Architectural Rationale

During cross-model verification of Phase A & Phase B, two core lifecycle contract invariants were explicitly established:

1. **Why `release_contract` strictly preserves `retry_count` (Preventing Quota Laundering)**:
   - When a contract is released back to the queue (`CLAIMED → SUBMITTED`), `extend_count` is reset to 0 because renewals are holder-specific execution heartbeats. However, **`retry_count` is strictly preserved**.
   - **Rationale**: Schema validation circuit breaking (`max_retries = 2`) is a **contract-level system defense quota**. If releasing a contract reset `retry_count`, a malfunctioning or looping agent could launder its quota indefinitely via "bad payload $\to$ release $\to$ re-claim $\to$ bad payload", circumventing circuit-breaking guarantees.
2. **Why `extend_ttl` uses strict inequality (`proposedExpiresAt > lifetimeDeadline`)**:
   - A proposed renewal that lands exactly on the lifetime deadline (`proposedExpiresAt === lifetimeDeadline`) is valid and admitted. Only proposals that would overshoot the ceiling (`>`) are rejected, protecting the absolute contract lifetime boundary while never prematurely failing boundary-aligned renewals.
3. **Why `release_contract` resets `toctou_strike` to 0 (Holder-Level Quota Isolation)**:
   - `toctou_strike` measures whether the current holder encountered an active pointer drift during their review session. It is a **holder-level state variable** (like `extend_count`), not a contract-level breaker quota (like `retry_count`).
   - If Worker A releases a contract after encountering Strike 1, Worker B should not inherit A's strike. Resetting `toctou_strike` to 0 upon release guarantees that `release_contract` serves as a legitimate rescue path without penalizing the next worker.
