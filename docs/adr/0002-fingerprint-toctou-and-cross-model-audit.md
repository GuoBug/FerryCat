# ADR-0002: Full-File SHA-256 Fingerprinting, TOCTOU Closure & Cross-Model Verification

<p align="center">
  <b>English</b> •
  <a href="0002-fingerprint-toctou-and-cross-model-audit_zh.md">中文</a>
</p>

- **Status**: Accepted
- **Date**: 2026-10-22
- **Decider**: Guo Qiang (GuoBug)
- **Modules**: Fingerprint Verifier (`src/fingerprint.ts`), Schema Validator (`src/schema-validator.ts`), Contract Engine (`src/engine.ts`)

---

## 1. Context & Problem Statement

FerryCat offloads context by reference: the requester passes `workspace_root` and relative file `pointers`, and the worker agent reads the target files directly from local disk.

Passing references introduces three consistency hazards:
1. **Partial Hash Ambiguity**: Hashing only file header bytes fails to detect same-length edits in the middle or tail of a source file.
2. **Unsaved IDE Buffers (`Dirty Buffer`)**: If the requester dispatches a contract before flushing IDE buffer edits to disk, both sides read the old disk state—passing hash verification while auditing stale code.
3. **Claim-to-Fulfill TOCTOU Window**: If fingerprints are checked only during `poll_next_task`, edits made while the worker is analyzing the file go undetected upon `fulfill_contract`.

---

## 2. Decision Outcome

### 2.1 Full-File SHA-256 & Fast-Fail Verification Order
Implemented in [`src/fingerprint.ts`](../../src/fingerprint.ts):
1. **Dual-Side Security Blacklist**: `assertSafePointerPath` runs on both `dispatch` and `worker` verification paths to block `.env*`, `*.pem`, `id_rsa*`, and `..` traversal.
2. **Existence Check**: Missing files fail immediately with `FILE_MISSING`.
3. **Byte-Size Short-Circuit**: `stat.size !== fp.size` fails immediately with `SIZE_MISMATCH`.
4. **Full-File SHA-256 Verification**: Computes full-file 64-char hex SHA-256 (verified by unit tests mutating head, middle, and tail with identical byte lengths). Mismatches wait `150ms` and re-verify once before transitioning to `POINTER_STALE`. `mtime_ms` is never used to reject valid hashes.

### 2.2 First/Last Line Snapshots & 3-Second Dirty-Buffer Warning
`dispatch_contract` returns `first_line` and `last_line` snapshots and validates `line_range` bounds against actual line counts. If `Date.now() - mtime_ms < 3000`, a `warning` is attached.

### 2.3 Fulfill-Time TOCTOU Re-Verification
`fulfill_contract` re-runs `verifySingleRun` prior to accepting results. Mid-execution file mutations transition the contract to `POINTER_STALE` (`TOCTOU_CONTENT_CHANGED`).

---

## 3. Cross-Host 3-Model Empirical Audit Log

During v0.1 verification, three live code review contracts were dispatched from **Antigravity** to **WorkBuddy** across three distinct models (`Deepseek-V4.1-Flash`, `Step-5-Preview`, `Hy3`). Full SQLite records are preserved in [`docs/real-mesh-trajectory.json`](../real-mesh-trajectory.json):

| Contract ID | Target Agent / Model | Pointers | State Trajectory | Execution Time | Findings Hardened into v0.1 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `fc_1792681532295_a7c57f16` | `workbuddy` (`Deepseek-V4.1-Flash`) | `src/engine.ts`<br>`src/fingerprint.ts` | `SUBMITTED` $\to$ `CLAIMED` $\to$ `COMPLETED` | `241.5s` | 1. **TOCTOU Closure**: Re-verify fingerprints in `fulfillContract`;<br>2. **Worker Blacklist**: Enforce `assertSafePointerPath` inside `verifySingleRun`;<br>3. **Claim Exception Guard**: Catch unexpected FS errors post-claim and mark `POINTER_STALE`;<br>4. **Line Range Validation**: Validate `line_range` against total file lines. |
| `fc_1792681532323_cf6f9d99` | `workbuddy-step5` (`Step-5-Preview`) | `src/schema-validator.ts`<br>`src/engine.ts` | `SUBMITTED` $\to$ `CLAIMED` $\to$ `COMPLETED` | `354.1s` | 1. **`Array.isArray` Guard**: Reject arrays in `validateContractOutput`;<br>2. **Ajv Compilation Cache**: Cache compiled schemas by serialized JSON key;<br>3. **Optimistic Guards**: Add `AND status = 'CLAIMED'` and `Number(changes) === 1` checks across `fulfill` updates. |
| `fc_1792681532336_31d1b6e4` | `workbuddy-hy3` (`Hy3`) | `src/index.ts`<br>`src/cli.ts` | `SUBMITTED` $\to$ `CLAIMED` $\to$ `COMPLETED` | `463.6s` | 1. **Shared Zod Schemas**: Extracted [`src/schemas.ts`](../../src/schemas.ts) so CLI and MCP enforce identical constraints;<br>2. **Payload Bounds & Flag Checks**: Added `.max(50)` on `pointers` and fail-fast checks on missing CLI flag values. |
