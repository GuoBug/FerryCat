# ADR-0005: Controlled Daemon, Short-Transaction CAS Leases & Secure Execution Boundaries (Decision Reversal)

<p align="center">
  <b>English</b> •
  <a href="0005-controlled-daemon-and-process-supervision_zh.md">中文</a>
</p>

- **Status**: Accepted
- **Date**: 2026-10-25
- **Decider**: Guo Qiang (GuoBug)
- **Scope**: Daemon Controller (`src/daemon.ts`), Execution Supervisor (`src/supervisor.ts`), Storage Engine (`src/engine.ts`), CLI Dispatcher (`src/cli.ts`), Configuration Schemas (`src/schemas.ts`)
- **Upstream ADRs**: [ADR-0001: SQLite WAL Mesh](0001-cross-host-sqlite-wal-and-poll-model.md), [ADR-0003: GUI Sandbox vs CLI Layering](0003-gui-cli-hybrid-architecture.md), [ADR-0004: SRM & TOCTOU Buffer](0004-review-mutation-separation-and-toctou-buffer.md)
- **Multi-Agent Audit Consensus**: [Phase 3 Multi-Agent Architecture Consensus & Final Audit](../audits/2026-10-24-phase-3-multi-agent-consensus-audit_zh.md)

---

## 1. Context & Reversal Motivation

### 1.1 Historical Decision and Its Limits
In [ADR-0003 §3](0003-gui-cli-hybrid-architecture.md), FerryCat explicitly **rejected unattended background daemon processes and blind unconstrained automation**, mandating "Human as Scheduler and Intent Gateway".

While this decision was sound during v0.1–v0.2 to avoid fragile GUI key-press simulation and unbounded PTY injection, real-world development highlighted three emerging tensions:
1. **Cognitive Fatigue from Manual Context Delivery**:
   When audits become standardized deterministic routines (static analysis, regression suites, compliance checks), humans should not be forced into repetitive multi-window switching.
2. **At-Most-Once Execution Loss**:
   Prior to heartbeat keep-alives, tasks running longer than `exec_ttl` (300s) were unconditionally terminated upon fulfillment as `TIMED_OUT`, causing extensive reasoning output to evaporate.
3. **Unbounded Shell Command Injection Risks**:
   Letting unattended daemons execute arbitrary string `--exec` flags opens a catastrophic backdoor for prompt code injection attacks.

### 1.2 Decision Reversal Principle
We reverse the rejection of background daemons, but strictly refuse to slide into unconstrained agent loops:  
**"Constrain execution targets to declared static script handlers, build on micro-transaction CAS leases, and enforce strict process tree supervision."**

---

## 2. Architectural Decisions

### 2.1 Database Locking: Short-Transaction CAS Leases over Long-Lived Transactions
- **Physical Reality**: SQLite lacks row-level locks. Holding a long-lived `BEGIN IMMEDIATE` lock to enforce single-instance mutual exclusion holds a database-wide RESERVED lock, blocking all concurrent `dispatch`, `poll`, and `extend` operations while preventing WAL checkpoints and blowing up `-wal` files.
- **Decision**:
  Deploy a dedicated `daemon_locks` table. Daemon instances acquire and renew leases via single-statement atomic UPSERTs in microsecond-level implicit transactions without holding database-wide write locks:
  ```sql
  CREATE TABLE IF NOT EXISTS daemon_locks (
    id TEXT PRIMARY KEY,
    owner_token TEXT NOT NULL,
    heartbeat_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    metadata_json TEXT
  );

  INSERT INTO daemon_locks(id, owner_token, heartbeat_at, expires_at, metadata_json)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    owner_token = excluded.owner_token,
    heartbeat_at = excluded.heartbeat_at,
    expires_at = excluded.expires_at,
    metadata_json = excluded.metadata_json
  WHERE daemon_locks.expires_at < ? OR daemon_locks.owner_token = ?;
  ```

### 2.2 Security Hardening: `ferrycat.config.json` Handler Whitelist
- **Ban Freeform Shells**: In daemon mode, arbitrary shell commands via `--exec` are strictly disabled by default.
- **Whitelist File Handlers**: Task handlers must map to statically configured files (`.js`, `.ts`, `.ps1`, `.sh`) invoked via `execFile`, eliminating shell interpolation escapes (config write permissions equal host execution privileges).
- **Declarative Configuration Schema (`ferrycat.config.json`)**:
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

### 2.3 Integrated Process Supervision
The daemon inherits all Phase 3 Step 0 runtime safeguards:
1. **Dynamic Heartbeat Keep-Alive**: `min(60s, exec_ttl / 3)` preventing task timeouts during long workloads (CK-01).
2. **Strict Process-Tree Cleanup**: Detached process groups (`kill(-pgid)`) on POSIX and `taskkill /T /F` on Windows, preventing orphaned grandchild processes from corrupting subsequent contract TOCTOU baselines (CK-04, CK-05).
3. **Environment Allowlist Sandbox**: Stripping sensitive tokens while preserving user profile credentials (`~/.config`, `%APPDATA%`), avoiding the "all users unauthenticated" reverse DX trap (CK-06).
4. **Output Salvage**: Preserving partial stdout into `salvaged_result_json` on unexpected exits or timeouts (CK-07).

---

## 3. Status & Consequences

- **Status**: Accepted
- **Consequences**: Enables reliable background worker processing while maintaining zero database deadlocks, deterministic process boundaries, and zero token leakage.
