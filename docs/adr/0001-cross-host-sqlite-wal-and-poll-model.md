# ADR-0001: Cross-Host SQLite WAL Bus & Human-Scheduled Poll Model

<p align="center">
  <b>English</b> •
  <a href="0001-cross-host-sqlite-wal-and-poll-model_zh.md">中文</a>
</p>

- **Status**: Accepted
- **Date**: 2026-10-22
- **Decider**: Guo Qiang (GuoBug)
- **Modules**: Cross-Process Storage Engine & Tool Dispatch (`src/engine.ts`)

---

## 1. Context & Problem Statement

In desktop AI engineering workflows, developers frequently run multiple IDE hosts side by side (e.g., Google Antigravity for architecture planning and WorkBuddy for independent code review).

Falsifiable testing on the target workstation revealed three physical constraints:
1. **`stdio` Process Isolation**: Desktop IDEs spawn local MCP servers as independent OS child processes with isolated memory spaces.
2. **Heterogeneous Host Node.js Runtimes**: On the same Windows machine, the system PATH resolved to `Node v24.19.0`, whereas WorkBuddy injected its managed runtime (`Node v22.12.0` / `v22.22.2`).
3. **Passive MCP Server Execution**: MCP follows a request-response model; an MCP server cannot push an unsolicited event to wake up an idle host's LLM loop.

---

## 2. Considered Alternatives

### Issue 1: Cross-Process Task Consumption

#### Option A: 60-Second Server-Side Blocking Hold (`await_next_task`)
- **Flaws**:
  1. Most MCP clients enforce a default 60s tool call timeout, turning an idle wait into a tool error.
  2. When a hold returns empty, the host LLM summarizes "no tasks available" and ends the conversation turn without re-entering `await_next_task`.
- **Verdict**: **Rejected**.

#### Option B: Official MCP `Tasks` Primitive (2025-11 / 2026-07)
- **Flaws**: MCP `Tasks` tracks long-running state within a **single `Client ↔ Server` connection** and does not bridge two separate host processes with distinct models and contexts.
- **Verdict**: **Not Applicable**.

#### Option C: Human-Scheduled Atomic Polling (`poll_next_task`)
- **Mechanism**: The human developer acts as the scheduler across 3 explicit trigger points, while the protocol guarantees atomic claiming (`changes === 1`), file freshness verification, and schema validation in `<50ms`.
- **Trade-off**: Requires 3 manual window switches (~15–25s human overhead) per handoff.
- **Verdict**: **Accepted**.

---

### Issue 2: SQLite Driver Selection

- **Decision**: Use Node.js built-in `node:sqlite` with `--experimental-sqlite` always included in `args`. Empirical testing confirmed `--experimental-sqlite` is required on `Node 22.12.0` and harmlessly accepted on `Node 22.22.2` and `Node 24.19.0`, achieving zero native C++ addon compilation dependencies.

---

## 3. Decision Outcome

1. **6-State Deterministic State Machine**: Implemented in [`src/engine.ts`](../../src/engine.ts) (`SUBMITTED`, `CLAIMED`, `COMPLETED`, `POINTER_STALE`, `VALIDATION_FAILED`, `TIMED_OUT`).
2. **Optimistic Concurrency Preemption**: Enforced via `WHERE id = ? AND status = 'SUBMITTED'` and `Number(updateResult.changes) === 1`.
3. **Dual-Stage TTL & Read-Before-Write Sweep**: Separates `queue_ttl_sec` (1800s) from `exec_ttl_sec` (300s) and checks `SELECT COUNT(*)` before acquiring write locks.
