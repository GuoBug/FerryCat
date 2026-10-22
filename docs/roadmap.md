# FerryCat Requirements Backlog & Evolution Roadmap

<p align="center">
  <b>English</b> •
  <a href="roadmap_zh.md">中文</a>
</p>

## Phase 1: Deterministic Single-Round Handoff Core (v0.1 — Completed)

- [x] **FC-101**: Zero-addon SQLite WAL persistence via Node.js built-in `node:sqlite` (`--experimental-sqlite` compatibility across Node 22.12+ and Node 24+).
- [x] **FC-102**: Deterministic 6-state machine (`SUBMITTED`, `CLAIMED`, `COMPLETED`, `POINTER_STALE`, `VALIDATION_FAILED`, `TIMED_OUT`) with optimistic concurrency (`changes === 1`).
- [x] **FC-103**: Full-file SHA-256 fingerprinting, 3-second dirty-buffer warning, and fulfill-time TOCTOU re-verification.
- [x] **FC-104**: Bounded Ajv JSON Schema validation (`RETRY_NEEDED` up to 2 attempts, terminal `VALIDATION_FAILED` on 3rd failure) with flattened single-line errors.
- [x] **FC-105**: Dual-stage TTL (`queue_ttl_sec` = 1800s, `exec_ttl_sec` = 300s) with lock-free read-before-write sweeping.
- [x] **FC-106**: Shared Zod input validation across MCP Stdio Server (`dist/index.js`) and CLI (`dist/cli.js`).

---

## Phase 2: Developer Ergonomics & Multi-Workspace Support (Planned)

- [ ] **FC-201 (`POINTER_STALE` Queue Continuation)**: When the head-of-line contract fails fingerprint verification and transitions to `POINTER_STALE`, optionally continue scanning the remaining candidate contracts in the same `poll_next_task` call while surfacing the stale warning in metadata.
- [ ] **FC-202 (Self-Contained Git Patch Mode)**: Support optional inline `git diff` patch snapshots for cross-branch or disjoint workspace reviews where both hosts are not on the exact same working tree file state.
- [ ] **FC-203 (Async Non-Blocking Transient Retry)**: Replace synchronous `Atomics.wait(150ms)` with async `setTimeout` promise delay in `pollNextTask` to avoid blocking the MCP stdio event loop during transient IDE save retries.
