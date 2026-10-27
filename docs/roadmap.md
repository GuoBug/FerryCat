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

## Phase A: Lifecycle & Execution Model Correction (v0.2.0 — Completed)

- [x] **FC-A01 (Tiered default exec TTL)**: `code_review` / `architecture_audit` default to 1800s, `implementation` / `test_generation` to 300s; explicit `exec_ttl_sec` overrides.
- [x] **FC-A02 (`release_contract`)**: Holder-only `CLAIMED → SUBMITTED` re-queue at the tail with a fresh queue window; resets `extend_count`; preserves `retry_count`; capped at 3 releases.
- [x] **FC-A03 (`extend_ttl`)**: Holder-only heartbeat resetting `claimed_at`; max 5 renewals per holder, refused after `created_at + 4 × queue_ttl_sec`. `RETRY_NEEDED` also renews the execution window.
- [x] **FC-A04 (`fail_contract` + `FAILED` terminal state)**: Holder-only explicit failure with mandatory reason; `worker --exec` non-zero exit now closes the contract as `FAILED`.
- [x] **FC-A05 (In-place schema migration)**: Additive `queued_at` / `extend_count` / `release_count` columns; rows written by older hosts (`queued_at IS NULL`) remain claimable.

---

## Phase B: CLI Ergonomics, DX & TOCTOU Soft-Failure Buffering (v0.3.0 — Completed)

- [x] **FC-B01 (Global & Subcommand `--help` / `--version`)**: Hierarchical CLI help system with clear usage, option descriptions, and examples across all 9 subcommands.
- [x] **FC-B02 (Stdin Pipe & BOM Stripping)**: Piped stdin payload support (`--file -`, positional `-`, and auto-detected piped stdin) with transparent UTF-8 BOM removal.
- [x] **FC-B03 (Inspect ASCII Table & Target Filtering)**: Human-friendly ASCII terminal table view by default with `--target <agent>` SQL filtering, alongside `--json` / `--format=json`.
- [x] **FC-B04 (Worker Modes & Direct Script Execution)**: Explicit `--mode=watch|claim|exec` options and `--exec-file <script>` executing `.js/.mjs/.cjs/.ts/.ps1/.sh` directly without shell quote escaping.
- [x] **FC-B05 (Human-Friendly Zod Error Formatting)**: Clean, actionable error reporting without raw SQLite stack leakage.
- [x] **FC-B06 (ADR-0004 Read-Only Pre-Flight Verification)**: `verify_contract` MCP tool and `ferrycat-cli verify` command auditing on-disk pointers without mutating state.
- [x] **FC-B07 (ADR-0004 1-Strike TOCTOU Soft-Failure Buffering)**: Strike 1 returns `RETRY_NEEDED` with dirty files and recovery instructions; Strike 2 transitions to `POINTER_STALE` while preserving review results in `salvaged_result_json`.

---

## Phase 0.3.1: Security Hygiene, Lease Isolation & Payload Limits (v0.3.1 — Completed)

- [x] **FC-301 (Lease Token Isolation)**: Add `claim_token` column to `contracts`; issue unguessable UUID on successful `poll_next_task` preemption; require token verification in `fulfill` / `release` / `extend` / `fail` to prevent cross-worker interference among same-named agent instances.
- [x] **FC-302 (Bounded Payload & Schema Depth Limits)**: Add explicit serialization byte limits (1MB~2MB) on `structured_output` and `contract_schema` to protect shared SQLite database from unbounded bloating.
- [x] **FC-303 (CLI Worker Execution Hardening)**: Promote `--exec-file` (execFile without shell injection risks) as primary recommendation, and explicitly mark `--exec` as shell compatibility mode.
- [x] **FC-304 (Docs & Security Hygiene Hotfix)**: Publish Threat Model chapter, refine TOCTOU race window descriptions down to atomic SQL boundaries, and unify `workspace_root` relative/absolute resolution rules.

---

## Phase 2: Developer Ergonomics & Multi-Workspace Support (v0.4.0 — Partially Complete)

- [x] **FC-201 (`POINTER_STALE` Queue Continuation)**: When the head-of-line contract fails fingerprint verification and transitions to `POINTER_STALE`, continue scanning the remaining candidate contracts in the same `poll_next_task` call without head-of-line blocking (verified in production on 2026-10-27 live mesh contract `fc_1793098036393_aea8bb9b`).
- [ ] **FC-202 (Self-Contained Git Patch Mode)**: Support optional inline `git diff` patch snapshots for cross-branch or disjoint workspace reviews where both hosts are not on the exact same working tree file state.
- [ ] **FC-203 (Async Non-Blocking Transient Retry)**: Replace synchronous `Atomics.wait(150ms)` with async microtask scheduling in `pollNextTask` to retire technical debt.
- [x] **FC-204 (Zero-Config Sandbox Walkthrough `ferrycat demo`)**: Single command `npx ferrycat demo` bootstrapping an isolated temporary sandbox verifying the full 4-stage lifecycle (dispatch $\to$ claim $\to$ execution with 1 heartbeat renewal $\to$ TOCTOU verification $\to$ COMPLETED) with `--keep`, `--json`, and `--no-color` support (delivered in v0.4.0).

---

## Phase 3: Active Wake-up & Daemon Orchestration (Completed)

- [x] **FC-401 (Headless Background Daemon Management `ferrycat daemon`)**: Short-transaction atomic CAS leases on `daemon_locks` table and strict process tree termination (`taskkill /T /F` & `kill(-pgid)`), eliminating table locks and `-wal` file bloat (ADR-0005, delivered in v0.3.3).
- [x] **FC-402 (Multi-Agent Declarative Config & Safe Execution Boundaries)**: Declarative configuration (`ferrycat.config.json`) strictly binding whitelist script handlers via `execFile`, eliminating arbitrary shell injection vectors (ADR-0005, delivered in v0.3.3).
- [x] **FC-403 (OS Desktop Notifications & Local Event Hooks)**: Support native OS desktop notifications (Windows WinRT Toast / macOS `osascript` via positional `argv` / Linux `notify-send`, non-blocking `unref` + `error` listener guard) and local HTTP webhooks (`webhook_url` / `FERRYCAT_WEBHOOK_URL`, 3s bounded timeout), alerting developers or external workflows immediately when contracts are claimed, completed, failed, or lose leases.
