# ADR-0003: GUI Sandbox vs CLI Process Hybrid Layering Architecture, Wake-Up Boundaries & Dual-Channel Worker Selection

<p align="center">
  <b>English</b> •
  <a href="0003-gui-cli-hybrid-architecture_zh.md">中文</a>
</p>

- **Status**: Accepted
- **Date**: 2026-10-23
- **Decider**: Guo Qiang (GuoBug)
- **Scope**: Contract Engine (`src/engine.ts`), Fingerprint Validator (`src/fingerprint.ts`), CLI Dispatcher (`src/cli.ts`), Hybrid Interaction Protocol
- **Upstream ADRs**: [ADR-0001: Cross-Host SQLite WAL Bus & Poll Model](0001-cross-host-sqlite-wal-and-poll-model.md), [ADR-0002: Full-File SHA-256 Fingerprinting, TOCTOU Closure & Cross-Model Verification](0002-fingerprint-toctou-and-cross-model-audit.md)

---

## 1. Context & Core Dilemma

Following the successful cross-host desktop code review between Google Antigravity and WorkBuddy in FerryCat v0.1/v1.0, expanding towards autonomous workflows surfaced a central obstacle: **"How can an idle Agent Host be awakened?"**

Physical verification across desktop IDEs and OS primitives revealed two non-negotiable realities:
1. **The Inevitability of Desktop IDEs "Hibernating"**:
   Agent execution loops in desktop IDEs (e.g., VS Code, Cursor, WorkBuddy) are designed around Human-in-the-Loop (HITL) and token run-away protection. Once LLM generation concludes, the execution thread rests. External processes cannot penetrate Webview sandboxes, nor can bare URI schemes (e.g., `vscode://`) inject prompts and trigger execution without an installed extension registering custom handlers;
2. **The Failure of a "One-Size-Fits-All" Model**:
   Isolating all workers into headless background daemons eliminates the direct value of desktop dual-IDE peer review, while black-box keystroke simulation inside GUI environments remains fragile and unmaintainable.

---

## 2. Decision Outcome: GUI + CLI Hybrid Layering Architecture

We adopt a hybrid layered model: **"GUI layer for high-cognitive human approval; CLI layer for low-latency machine autonomy."**

```
     ┌────────────────────────────────┐       ┌────────────────────────────────┐
     │       GUI Host (Antigravity)   │       │       GUI Host (WorkBuddy)     │
     └───────────────┬────────────────┘       └────────────────┬───────────────┘
                     │                                         │
                     │ dispatch_contract (HITL)                │ poll / fulfill (Human Approval)
                     ▼                                         ▼
   ═════════════════════════════════════════════════════════════════════════════════
                      [Shared Substrate: ~/.ferrycat/mesh.db (SQLite WAL)]
                      [State Machine: SUBMITTED -> CLAIMED -> COMPLETED / STALE]
   ═════════════════════════════════════════════════════════════════════════════════
                     ▲                                         ▲
                     │ WAL pulse / 500ms safety poll           │ Optimistic Claim / Double SHA-256
                     │                                         │
     ┌───────────────┴────────────────┐       ┌────────────────┴───────────────┘
     │   CLI Worker (Dual-Channel)    │       │   Subprocess Worker (--once)   │
     └────────────────────────────────┘       └────────────────────────────────┘
```

### 2.1 Layering & Responsibility Matrix

| Dimension | GUI Layer (Desktop IDE Hosts) | CLI Layer (In-House Terminal Worker) |
| :--- | :--- | :--- |
| **Typical Hosts** | **Antigravity** (Architecture/Planning) + **WorkBuddy** (Audit/Review) | **`ferrycat-worker`** (Native Node.js process) |
| **Core Responsibility** | Complex system understanding, architectural trade-offs, merge sign-off | Deterministic pipeline execution, batch test generation, static analysis |
| **Wake-Up Model** | **Human-Scheduled Instant Poll (Human-as-Scheduler)** | **Dual-Channel REPL (I/O Multiplexing) + Subprocess-per-Task** |
| **Security & Sandbox**| Contained within Webview sandboxes; human serves as natural approval gate | Native OS process permissions; high-speed filesystem autonomy |

### 2.2 Shared Substrate Guarantees (Verified against Engine Source)
1. **Unambiguous Tilde Expansion**: [`expandTilde()`](file:///f:/git/FerryCat/src/engine.ts#L24-L33) in `src/engine.ts` resolves paths using `os.homedir()`, preventing relative `~` directory splitting across different CWDs;
2. **Full-File SHA-256 Fingerprinting**: Evaluated over entire file buffers in `src/fingerprint.ts`, eliminating partial-header hash ambiguity;
3. **Optimistic Preemption**: `UPDATE contracts SET status='CLAIMED' WHERE id=? AND status='SUBMITTED'` strictly verifies `changes === 1`;
4. **Fulfill TOCTOU Closure**: Re-checks `verifySingleRun` at `fulfill_contract` (`src/engine.ts` L382), terminating with `POINTER_STALE` if files changed during audit;
5. **Fulfill Concurrency Guard**: Added `completeRes.changes === 1` verification in `src/engine.ts` L470, preventing false `ok: true` returns during duplicate fulfill races;
6. **Init Lock Timeout Priority**: Placed `PRAGMA busy_timeout = 5000` before `PRAGMA journal_mode = WAL` in `src/engine.ts` L86, eliminating initial concurrent connection lock contention within a 5000ms window.

### 2.3 CLI Worker Architecture & Grounded Scope
1. **v1.2 Delivered Baseline (Lightweight Worker CLI)**:
   - **Subprocess-per-Task Mode (`--once`)**: Claims a task atomically. If `--exec <cmd>` is provided, executes the script and automatically invokes `fulfillContract` with its output; without `--exec`, operates as an explicit Claim-only step;
   - **Safe Watcher Loop**: When running without `--exec`, operates strictly in non-claiming watcher/notifier mode to avoid abandoning claimed tasks;
   - **Graceful Shutdown & Deferred Init**: Supports interruptible sleep and dual-SIGINT hard exit, with deferred database engine instantiation to avoid ghost database creation on argument errors.
2. **v2.0 Planned Evolution (Dual-Channel REPL, Planned)**:
   - Multiplexed EventLoop (`process.stdin` + WAL fs.watch notifications);
   - Clean Terminal IO with readline buffer preservation and streaming log redirection.

---

## 3. Rejected Alternatives & Falsifications

1. **Rejected: GUI-side simulated keystrokes / URI auto-triggers**:
   - URI schemes cannot inject prompts without companion extension handlers. WorkBuddy maintains an isolated sandbox without public injection hooks;
2. **Rejected: Sending `SIGUSR1` to third-party CLI agents**:
   - Default POSIX behavior for `SIGUSR1` is **Terminate**. Unhandled signals terminate external processes; Windows lacks POSIX user signals;
3. **Rejected: PTY injection into third-party CLIs as mainline architecture**:
   - Transport-level wake-up does not equal semantic execution. Text piped into external stdin is often processed as chat prompts rather than explicit tool invocations, alongside serious command injection risks.

---

## 4. Operational Invariant & Roadmap

* **Read-Only / Artifact Invariant**: CLI workers must remain read-only or write to distinct artifact files. In-place modification of target pointer files triggers TOCTOU content mismatch upon fulfill.
* **Evolutionary Roadmap**:
  - **v1.0 / v1.1 (Delivered)**: Cross-host desktop review + atomic preemption & TOCTOU closure;
  - **v1.2 (Active)**: In-house CLI Worker (Subprocess claim, safe watcher, and `--exec` automated fulfillment);
  - **v2.0 (Planned)**: Dual-channel REPL terminal multiplexing + two-phase write contracts.
