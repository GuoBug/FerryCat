# FerryCat: Contract-Driven Cross-Host AI Agent Handoff Bus

<p align="center">
  <b>English</b> •
  <a href="README_zh.md">中文</a>
</p>

[![Node.js Version](https://img.shields.io/badge/Node.js-22.5%2B-339933?style=flat&logo=nodedotjs)](https://nodejs.org/)
[![Native Addons](https://img.shields.io/badge/Native_Addons-0_(node%3Asqlite)-success?style=flat)]()
[![Protocol](https://img.shields.io/badge/Protocol-MCP_Stdio-orange?style=flat)](https://modelcontextprotocol.io/)
[![License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

> **FerryCat** (`ferrycat`) is a lightweight, deterministic cross-host AI agent handoff and code review bus built on the Model Context Protocol (MCP) and Node.js built-in `node:sqlite` (WAL mode).  
> Purpose-built to safely bridge isolated desktop IDE agent hosts (such as Google Antigravity, WorkBuddy, Claude Code, and Cursor) across separate OS processes without context drift or blind reviews on stale files.

---

## Core Pain Points & Engineering Solutions

While the official MCP `Tasks` specification (2025-11 / 2026-07) addresses long-running operations within a **single `Client ↔ Server` connection**, it does not solve cross-host collaboration on a developer workstation:
1. **`stdio` Process Isolation**: Desktop IDEs spawn local MCP servers as independent child processes with isolated memory spaces and distinct Node.js runtimes.
2. **Silent Blind Reviews on Stale Code (`Stale Context`)**: When handing off a task from Host A to Host B, unushed IDE buffers, branch switches, or mid-review edits cause the receiving agent to audit outdated code and produce plausible but invalid conclusions.
3. **Context Window Bloat**: Pasting hundreds of lines of source code across chat windows duplicates token consumption on both ends.
4. **Unstructured Handoff Outputs**: Free-form prose responses lack deterministic schema enforcement, making downstream consumption unreliable and prone to infinite retry loops.

**FerryCat resolves these failure modes through a human-scheduled, contract-driven SQLite WAL bus:**

```
[Developer]             [Host A: Antigravity]            [~/.ferrycat/mesh.db]            [Host B: WorkBuddy]
     |                            |                                |                               |
     |-- 1. "Dispatch review" --->|                                |                               |
     |                            |-- dispatch_contract() -------->| Write status = SUBMITTED      |
     |                            |   (Full SHA-256 + Line Bounds) | Store size / sha256 snapshot  |
     |                            |                                |                               |
     |-- 2. Switch IDE: "Poll" ---|--------------------------------|------------------------------>|
     |                            |                                |<-- poll_next_task() ----------|
     |                            |                                |    (Atomic claim changes===1  |
     |                            |                                |     + Verify disk SHA-256)    |
     |                            |                                |                               |-- Read local files
     |                            |                                |<-- fulfill_contract() --------|-- Re-verify SHA-256
     |                            |                                |    (Validate Ajv JSON Schema  |   & submit JSON
     |                            |                                |     -> status = COMPLETED)    |
     |                            |                                |                               |
     |-- 3. Switch IDE: "Inspect" |                                |                               |
     |                            |-- inspect_mesh_state() ------->| Read-only query of COMPLETED  |
     |<-- Present structured res -|                                |                               |
```

---

## Key Architectural Pillars

### 1. Deterministic 6-State Machine
Every state transition is bound to an explicit SQL transaction with optimistic concurrency control (`changes === 1`), eliminating phantom or dangling states:

```
                  dispatch_contract()
                          │
                          ▼
                    ┌───────────┐
                    │ SUBMITTED │ (Queue TTL: default 1800s)
                    └─────┬─────┘
                          │
                 poll_next_task()
         ┌────────────────┼────────────────┐
         │ (Queue TTL)    │ (Hash Match)   │ (Missing / Size Diff / SHA-256 Mismatch)
         ▼                ▼                ▼
   ┌───────────┐    ┌───────────┐   ┌───────────────┐
   │ TIMED_OUT │    │  CLAIMED  │   │ POINTER_STALE │ (Terminal: Rejects blind review)
   └───────────┘    └─────┬─────┘   └───────────────┘
      ▲                   │ (Exec TTL: default 300s)
      │          fulfill_contract()
      │  ┌────────────────┼────────────────┬────────────────┐
      └──┤ (Exec TTL)     │ (Schema Valid) │ (Retries > 2)  │ (Mid-Review File Edit)
         │                ▼                ▼                ▼
         │          ┌───────────┐   ┌───────────────────┐ ┌───────────────┐
         └──────────│ COMPLETED │   │ VALIDATION_FAILED │ │ POINTER_STALE │
                    └───────────┘   └───────────────────┘ └───────────────┘
```

### 2. Full-File SHA-256 Fingerprinting & TOCTOU Closure
- **Dispatch Snapshot**: `dispatch_contract` reads target files on disk, recording byte `size`, full-file `sha256` (64 hex chars), `first_line`, and `last_line`. If a file was modified within the last 3 seconds, a `warning` is emitted to alert the requester of potential unsaved IDE buffers.
- **Claim Verification**: `poll_next_task` verifies `Existence -> Byte Size -> Full-File SHA-256` (never rejecting on `mtime_ms` alone to tolerate no-op IDE saves). On mismatch, it waits `150ms` and retries once to rule out transient IDE flushes before marking the contract `POINTER_STALE`.
- **Fulfill TOCTOU Guard**: `fulfill_contract` re-verifies file fingerprints upon submission, ensuring files were not mutated between `poll_next_task` and `fulfill_contract`.

### 3. Bounded Schema Validation (`RETRY_NEEDED` $\le 2$)
- Outputs are validated against the contract's JSON Schema via cached Ajv validators, with errors flattened into concise single-line paths (e.g., `["/passed: must be boolean"]`).
- Up to 2 validation failures return `RETRY_NEEDED` while keeping the contract `CLAIMED` for immediate self-correction; a 3rd failure transitions the contract to terminal `VALIDATION_FAILED`.

### 4. Dual-Stage TTL & Read-Before-Write Sweeping
- Separates `queue_ttl_sec` (default 1800s for `SUBMITTED`) from `exec_ttl_sec` (default 300s for `CLAIMED`, measured from `claimed_at`), preventing tasks claimed late in the queue window from timing out prematurely during execution.
- `poll_next_task` executes a lock-free `SELECT COUNT(*)` probe before attempting any `UPDATE` on expired rows; `inspect_mesh_state` is strictly read-only.

### 5. Defense-in-Depth Path Security
- Enforces path containment within `workspace_root` and blocks sensitive file patterns (`.env*`, `*.pem`, `*.key`, `id_rsa*`, `*credentials*`, `*secret*`, `.npmrc`, `.git/config`) on both `dispatch` and `worker` verification paths.

---

## Applicability Boundaries (When NOT to Use FerryCat)

1. **Disjoint File Systems**: FerryCat offloads context by file reference; both hosts must share access to the same local `workspace_root`.
2. **Trivial Single-Turn Queries**: Each cross-host handoff involves 3 explicit human window switches (~15–25s overhead).
3. **Unattended Background Pipelines**: Desktop IDE hosts follow a request-response model and cannot be woken up asynchronously by an idle MCP server. For unattended multi-step pipelines, use a standalone DAG workflow engine such as [PatchCat](https://github.com/GuoBug/ai-prompt-orchestrator).

---

## Quickstart

### 1. Build & Verify
```bash
git clone https://github.com/GuoBug/FerryCat.git
cd FerryCat
npm install
npm run build
npm test
```

### 2. Mount in Antigravity
Edit `%USERPROFILE%\.gemini\antigravity\mcp_config.json` (or `~/.gemini/antigravity/mcp_config.json` on macOS/Linux):
```json
{
  "mcpServers": {
    "ferrycat": {
      "command": "node",
      "args": [
        "--experimental-sqlite",
        "F:/git/FerryCat/dist/index.js"
      ],
      "env": {
        "AGENT_NAME": "antigravity"
      }
    }
  }
}
```

### 3. Mount in WorkBuddy / Claude Code / Cursor
Configure the target host's MCP settings with its respective `AGENT_NAME`:
```json
{
  "mcpServers": {
    "ferrycat": {
      "command": "node",
      "args": [
        "--experimental-sqlite",
        "F:/git/FerryCat/dist/index.js"
      ],
      "env": {
        "AGENT_NAME": "workbuddy"
      }
    }
  }
}
```
> **Note**: Both MCP Stdio and direct CLI invocation (`node --experimental-sqlite dist/cli.js <dispatch|poll|fulfill|inspect>`) share the same SQLite WAL database at `~/.ferrycat/mesh.db` and the same Zod validation schemas.

---

## Exposed MCP Tools

| Tool Name | Role | Transactional Behavior |
| :--- | :--- | :--- |
| **`dispatch_contract`** | Requester | Enforces path blacklist $\to$ computes full-file SHA-256 & line bounds $\to$ inserts `SUBMITTED`. |
| **`poll_next_task`** | Worker | Sweeps expired TTLs (read-before-write) $\to$ claims via `changes === 1` (`CLAIMED`) $\to$ verifies disk SHA-256 (or marks `POINTER_STALE`). |
| **`fulfill_contract`** | Worker | Re-verifies SHA-256 (TOCTOU guard) $\to$ validates Ajv JSON Schema ($\le 2$ retries via `RETRY_NEEDED`, 3rd marks `VALIDATION_FAILED`) $\to$ marks `COMPLETED`. |
| **`inspect_mesh_state`** | Any (Read-Only) | Pure read-only query of contract states, outputs, and dynamic `is_logically_expired` flags. |

> 💡 **Architecture Decision Records & Engineering Verification**:
> - [ADR-0001: Cross-Host SQLite WAL Bus & Human-Scheduled Poll Model](docs/adr/0001-cross-host-sqlite-wal-and-poll-model.md) (Why `node:sqlite` WAL + `poll_next_task` instead of 60s Blocking Hold or single-connection MCP Tasks)
> - [ADR-0002: Full-File SHA-256 Fingerprinting, TOCTOU Guard & Cross-Model Audit](docs/adr/0002-fingerprint-toctou-and-cross-model-audit.md) (Stale-context prevention and real-world cross-host verification records)
> - [FerryCat Requirements Backlog & Roadmap](docs/roadmap.md)

---

> **About the Author**  
> **Guo Qiang (GuoBug)**, Product Engineer specializing in platform engineering and growth. Currently focused on AI workflow orchestration, DAG state machines, and deterministic system architectures.  
> Open Source & Homepage: [https://github.com/GuoBug](https://github.com/GuoBug) · [https://guobug.github.io](https://guobug.github.io)  
> Inquiries and discussions on workflow engine architecture, topological scheduling, and developer experience are warmly welcomed.
