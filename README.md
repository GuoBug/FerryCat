# FerryCat: Contract-Driven Cross-Host AI Agent Handoff Bus

<p align="center">
  <b>English</b> •
  <a href="README_zh.md">中文</a>
</p>

[![npm version](https://img.shields.io/npm/v/ferrycat.svg?style=flat&color=cb3837&logo=npm)](https://www.npmjs.com/package/ferrycat)
[![MCP Registry](https://img.shields.io/badge/MCP_Registry-Active-10b981?style=flat)](https://registry.modelcontextprotocol.io/v0/servers?search=ferrycat)
[![Node.js Version](https://img.shields.io/badge/Node.js-22.5%2B-339933?style=flat&logo=nodedotjs)](https://nodejs.org/)
[![Native Addons](https://img.shields.io/badge/Native_Addons-0_(node%3Asqlite)-success?style=flat)]()
[![Protocol](https://img.shields.io/badge/Protocol-MCP_Stdio-orange?style=flat)](https://modelcontextprotocol.io/)
[![Glama](https://img.shields.io/badge/Glama-MCP_Server-18181b?style=flat)](https://glama.ai/mcp/servers/GuoBug/FerryCat)
[![License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

> **FerryCat** (`ferrycat`) is a lightweight, deterministic cross-host AI agent handoff and code review bus built on the Model Context Protocol (MCP) and Node.js built-in `node:sqlite` (WAL mode).  
> Purpose-built to safely bridge isolated desktop IDE agent hosts (such as Google Antigravity, WorkBuddy, Claude Code, and Cursor) across separate OS processes without context drift or blind reviews on stale files.

<p align="center">
  <img src="https://guobug.github.io/assets/images/flowchart-ferrycat-cross-host-demand-and-workflow-en.svg" alt="FerryCat Architecture and Workflow" width="960" />
</p>

> 📖 **Deep Dive**: [Why I Started Building FerryCat: When Two AI Coding Hosts Live on the Same Desktop](https://guobug.github.io/posts/2026/10/22/why-we-built-ferrycat-cross-host-agent-review-bus/)

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

### 1. Deterministic 7-State Machine
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

Holder-side lifecycle controls on a `CLAIMED` contract (all require `agent_id === target_agent`):

| Call | Transition | Guard rails |
| :--- | :--- | :--- |
| `release_contract` | `CLAIMED → SUBMITTED` (tail of queue, fresh queue window) | Resets `extend_count` (renewal budget is per holder) but **preserves** `retry_count`: the schema-failure circuit breaker is a contract-level quota, so releasing cannot launder retry budget. Refused past the absolute lifetime deadline. Max 3 releases per contract. |
| `extend_ttl` | `CLAIMED → CLAIMED` (`claimed_at = now`) | Must be called inside the active window; max 5 renewals per holder; refused once `now ≥ created_at + 4 × queue_ttl_sec`. |
| `fail_contract` | `CLAIMED → FAILED` (terminal) | Requires a `reason`, stored as `WORKER_FAILED: <reason>`. A report arriving after the window closed becomes `TIMED_OUT` with the reason attached. |

### 2. Full-File SHA-256 Fingerprinting, Pre-Flight Verify & TOCTOU Soft-Failure Buffering (ADR-0004)
- **Dispatch Snapshot**: `dispatch_contract` reads target files on disk, recording byte `size`, full-file `sha256` (64 hex chars), `first_line`, and `last_line`. If a file was modified within the last 3 seconds, a `warning` is emitted to alert the requester of potential unsaved IDE buffers.
- **Claim Verification**: `poll_next_task` verifies `Existence -> Byte Size -> Full-File SHA-256` (never rejecting on `mtime_ms` alone to tolerate no-op IDE saves). On mismatch, it waits `150ms` and retries once to rule out transient IDE flushes before marking the contract `POINTER_STALE`.
- **Pre-Flight Verify (`verify_contract`)**: A strictly read-only check allowing workers or scripts to audit pointer health (`valid: true` vs `valid: false` with dirty files list) before submitting.
- **TOCTOU Soft-Failure Buffering**: `fulfill_contract` checks on-disk pointer fingerprints. If dirty pointers are detected:
  - **Strike 1** returns `RETRY_NEEDED`, leaves the contract `CLAIMED`, renews the execution window, and lists dirty files with recovery instructions (`git stash` / `git checkout -- <file>`).
  - **Strike 2** transitions to terminal `POINTER_STALE` and saves the full submitted review payload into `salvaged_result_json` so review effort is never lost.
- **TOCTOU Race Narrowing**: While no file-based system can eliminate the microsecond race between reading disk bytes and committing a database row, FerryCat's dual-verification (at `poll` and at `fulfill`) drastically narrows the TOCTOU window from minutes of blind review down to the sub-millisecond atomic SQL transition boundary.

### 3. Bounded Schema Validation (`RETRY_NEEDED` $\le 2$)
- Outputs are validated against the contract's JSON Schema via cached Ajv validators, with errors flattened into concise single-line paths (e.g., `["/passed: must be boolean"]`).
- Up to 2 validation failures return `RETRY_NEEDED` while keeping the contract `CLAIMED` for immediate self-correction (each rejection also renews the execution window); a 3rd failure transitions the contract to terminal `VALIDATION_FAILED`.

### 4. Dual-Stage TTL & Read-Before-Write Sweeping
- Separates `queue_ttl_sec` (default 1800s for `SUBMITTED`) from `exec_ttl_sec` (measured from `claimed_at`), preventing tasks claimed late in the queue window from timing out prematurely during execution.
- `exec_ttl_sec` defaults are tiered by `task_type`: `code_review` / `architecture_audit` → 1800s (deep reasoning or human-in-the-loop), `implementation` / `test_generation` → 300s. An explicit `exec_ttl_sec` always wins.
- `poll_next_task` executes a lock-free `SELECT COUNT(*)` probe before attempting any `UPDATE` on expired rows; `inspect_mesh_state` is strictly read-only.

### 5. Defense-in-Depth Path Security
- Enforces path containment within `workspace_root` and blocks sensitive file patterns (`.env*`, `*.pem`, `*.key`, `id_rsa*`, `*credentials*`, `*secret*`, `.npmrc`, `.git/config`) on both `dispatch` and `worker` verification paths.
- **Path Resolution**: `workspace_root` is strongly recommended to be passed as an absolute path. If a relative path is provided, it is deterministically resolved against `process.cwd()` via `path.resolve`.

### 6. Threat Model & Security Assumptions (Local Workstation IPC)
- **Assumed Trust Environment**: FerryCat is intentionally designed as a **Trusted Local Workstation Bus** bridging isolated IDE hosts operating under the **same OS user account**. Callers and workers share the local file system (`workspace_root`) and SQLite database (`~/.ferrycat/mesh.db`).
- **Defense Scope**: Path containment (`assertSafePointerPath`) and sensitive file pattern filters prevent unintentional workspace escapes, symlink traversals, or accidental leakage of credentials/secret files during handoffs.
- **Daemon Execution Surface**: In daemon mode (`ferrycat-cli daemon`), handler scripts are invoked directly via `execFile`. Write permissions to `ferrycat.config.json` or handler script paths are equivalent to host execution privileges (ADR-0005 §2.2). Keep configurations local and version-controlled.
- **Out of Scope (Non-Goals)**: FerryCat does **not** provide adversarial sandboxing, multi-tenant isolation, or network authorization against malicious local processes or adversarial agents spoofing `AGENT_NAME`.

---

## Applicability Boundaries (When NOT to Use FerryCat)

1. **Disjoint File Systems**: FerryCat offloads context by file reference; both hosts must share access to the same local `workspace_root`.
2. **Trivial Single-Turn Queries**: Each cross-host handoff involves 3 explicit human window switches (~15–25s overhead).
3. **Multi-Step Dynamic DAG Pipelines**: FerryCat's background daemon (`ferrycat-cli daemon`, ADR-0005) manages single-step contract dispatch and supervised worker lifecycles; for complex multi-step branching DAG orchestrations, use dedicated DAG workflow engines such as [PatchCat](https://github.com/GuoBug/ai-prompt-orchestrator).

---

## Controlled Daemon & Declarative Handlers (ADR-0005)

FerryCat provides a controlled daemon mode governed by SQLite microsecond CAS leases on `daemon_locks` and declarative scripts defined in `ferrycat.config.json`:

```bash
# Run a single dispatch cycle with declared handlers
ferrycat-cli daemon --config ./ferrycat.config.json --once

# Start continuous daemon loop
ferrycat-cli daemon --config ./ferrycat.config.json
```

Example `ferrycat.config.json`:
```json
{
  "version": 1,
  "daemon": {
    "poll_interval_ms": 1000,
    "lease_ttl_sec": 30,
    "heartbeat_interval_ms": 10000,
    "notify": true
  },
  "agents": {
    "workbuddy": {
      "handlers": {
        "code_review": {
          "exec_file": "./scripts/review-handler.js",
          "pass_env": ["CUSTOM_ANALYZER_PATH"]
        }
      }
    }
  }
}
```

---

## Quickstart

### 0. See what it actually does first (`ferrycat demo`)

Before configuring any MCP server, watch the whole loop in ~3 seconds:

```bash
npx ferrycat demo
```
*(or `npx -p ferrycat ferrycat-cli demo`)*

It spins up a fully isolated sandbox under the OS temp dir (dedicated SQLite database,
sample source file, sample handler), runs `dispatch → claim → supervised execution →
TOCTOU re-verification → COMPLETED`, then deletes the sandbox.
**Your real workspace and `~/.ferrycat/mesh.db` are never read or written.**

```text
⚡ FerryCat Zero-Config Sandbox Demo ⚡
Sandbox: /tmp/ferrycat-demo-c5iK6V

  ✔ [1/4] Contract Dispatched
    Locked    src/calc.ts (sha256: ce3ba9a5...bc5d)
  ✔ [2/4] Contract Claimed
    Lease     7424261d-9a3f-4a86-a7ff-de278c273e96
  ✔ [3/4] Execution & Schema Check
    Heartbeat 1 lease renewal(s)
  ✔ [4/4] Contract Completed
    TOCTOU    fingerprints matched (0 dirty files)

  🎉 End-to-end multi-agent handoff verified successfully!
```

| Option | Effect |
| :--- | :--- |
| `--json` | Emit a structured result for CI / upstream assertions |
| `--keep` | Keep the sandbox and print its path for manual `sqlite3` inspection |
| `--no-color` | Disable ANSI colors (auto-off when not a TTY or `NO_COLOR` is set) |

### 1. Recommended: Zero-Install MCP Mounting (via npx)

No local clone or manual compilation required. Mount directly into your IDE's MCP configuration using `npx -y ferrycat`:

#### Antigravity Configuration
Edit `%USERPROFILE%\.gemini\antigravity\mcp_config.json` (or `~/.gemini/antigravity/mcp_config.json` on macOS/Linux):
```json
{
  "mcpServers": {
    "ferrycat": {
      "command": "npx",
      "args": ["-y", "ferrycat"],
      "env": {
        "AGENT_NAME": "antigravity"
      }
    }
  }
}
```

#### WorkBuddy / Claude Code / Cursor / Codex Configuration
Configure the target host's MCP settings with its respective `AGENT_NAME`:
```json
{
  "mcpServers": {
    "ferrycat": {
      "command": "npx",
      "args": ["-y", "ferrycat"],
      "env": {
        "AGENT_NAME": "workbuddy"
      }
    }
  }
}
```

### 2. Global Installation & Source Build

- **Global CLI Installation**:
  ```bash
  npm install -g ferrycat
  ```
  Then simply set `"command": "ferrycat"` in your MCP config.
- **Local Source Build (For Contributors)**:
  ```bash
  git clone https://github.com/GuoBug/FerryCat.git
  cd FerryCat
  npm install
  npm run build
  npm test
  ```
  Mount using your local path:
  `"command": "node"`, `"args": ["--experimental-sqlite", "/path/to/FerryCat/dist/index.js"]`.

---

## First-Class CLI Experience (`ferrycat-cli`)

Beyond serving as an in-IDE MCP Server, FerryCat provides a first-class CLI utility (`ferrycat-cli`). The single `ferrycat` executable dispatches on its first argument: no argv starts the MCP stdio server, a known subcommand routes to the CLI. So you can run `npx ferrycat <command>` with zero install (or `ferrycat-cli <command>` once installed globally). Sharing the same `~/.ferrycat/mesh.db` SQLite WAL database and Zod validation contracts, the CLI allows developers to inspect mesh health, verify working tree safety, and hook into automated CI/Git scripts without leaving their terminal:

### 1. Terminal Visual Inspection (ASCII Status Table)
Inspect all cross-host handoffs and error reasons formatted as an ASCII table:
```bash
# View all contracts in an ASCII table
npx ferrycat inspect

# Filter by target agent (e.g., only tasks for antigravity)
npx ferrycat inspect --target antigravity
```

### 2. Pre-Flight Verification (Auditing Before Mutation)
Audit on-disk pointer file integrity against the contract's baseline SHA-256 before committing review work (ADR-0004), eliminating false-positive deliveries:
```bash
npx ferrycat verify <CONTRACT_ID>
```

### 3. Local CI & Headless Worker Execution
Poll the queue, claim tasks, and execute local review/test scripts with automatic failure closure:
```bash
# Safely run a script upon task arrival (no shell quotation hazards)
npx ferrycat worker --agent codex --mode=exec --exec-file ./scripts/review.sh
```

---

## Exposed MCP Tools

| Tool Name | Role | Transactional Behavior |
| :--- | :--- | :--- |
| **`dispatch_contract`** | Requester | Enforces path blacklist $\to$ computes full-file SHA-256 & line bounds $\to$ inserts `SUBMITTED`. |
| **`poll_next_task`** | Worker | Sweeps expired TTLs (read-before-write) $\to$ claims via `changes === 1` (`CLAIMED`) $\to$ verifies disk SHA-256 (or marks `POINTER_STALE`). |
| **`fulfill_contract`** | Worker | Re-verifies SHA-256 (TOCTOU guard) $\to$ validates Ajv JSON Schema ($\le 2$ retries via `RETRY_NEEDED`, 3rd marks `VALIDATION_FAILED`) $\to$ marks `COMPLETED`. |
| **`release_contract`** | Worker (holder) | Hands a `CLAIMED` contract back to the queue tail as `SUBMITTED`. `retry_count` is preserved (contract-level circuit breaker); `extend_count` is reset. Max 3 releases; refused once past the absolute lifetime deadline. |
| **`extend_ttl`** | Worker (holder) | Heartbeat: restarts the execution window (`claimed_at = now`), max 5 renewals and bounded total lifetime. |
| **`fail_contract`** | Worker (holder) | Marks a `CLAIMED` contract terminal `FAILED` with a mandatory `reason`. |
| **`verify_contract`** | Worker / Any (Read-Only) | Pre-flight check: validates on-disk pointer files against the baseline SHA-256 without mutating contract state (ADR-0004). |
| **`inspect_mesh_state`** | Any (Read-Only) | Pure read-only query of contract states, outputs, and dynamic `is_logically_expired` flags. |

> 💡 **Architecture Decision Records & Engineering Verification**:
> - [ADR-0001: Cross-Host SQLite WAL Bus & Human-Scheduled Poll Model](docs/adr/0001-cross-host-sqlite-wal-and-poll-model.md) (Why `node:sqlite` WAL + `poll_next_task` instead of 60s Blocking Hold or single-connection MCP Tasks)
> - [ADR-0002: Full-File SHA-256 Fingerprinting, TOCTOU Guard & Cross-Model Audit](docs/adr/0002-fingerprint-toctou-and-cross-model-audit.md) (Stale-context prevention and real-world cross-host verification records)
> - [ADR-0003: GUI Sandbox vs CLI Process Hybrid Layering Architecture & Wake-Up Boundaries](docs/adr/0003-gui-cli-hybrid-architecture.md) (Desktop HITL approval vs in-house CLI dual-channel autonomy)
> - [ADR-0004: Separation of Review and Mutation (SRM), TOCTOU Soft-Failure Buffering & Immutable Baseline Protocol](docs/adr/0004-review-mutation-separation-and-toctou-buffer.md) (How to prevent review abortion from concurrent or well-intended reviewer edits)
> - [FerryCat Requirements Backlog & Roadmap](docs/roadmap.md)

---

> **About the Author**  
> **Guo Qiang (GuoBug)**, Product Engineer specializing in platform engineering and growth. Currently focused on AI workflow orchestration, DAG state machines, and deterministic system architectures.  
> Open Source & Homepage: [https://github.com/GuoBug](https://github.com/GuoBug) · [https://guobug.github.io](https://guobug.github.io)  
> Inquiries and discussions on workflow engine architecture, topological scheduling, and developer experience are warmly welcomed.
