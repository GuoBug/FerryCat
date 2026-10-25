# Architecture Decision Records (ADR)

This directory records key architectural decisions made during the design and evolution of FerryCat.

| ADR | Title | Status | Date |
| :--- | :--- | :--- | :--- |
| [ADR-0001](0001-cross-host-sqlite-wal-and-poll-model.md) ([中文](0001-cross-host-sqlite-wal-and-poll-model_zh.md)) | Cross-Host SQLite WAL Bus & Human-Scheduled Poll Model | Accepted | 2026-10-22 |
| [ADR-0002](0002-fingerprint-toctou-and-cross-model-audit.md) ([中文](0002-fingerprint-toctou-and-cross-model-audit_zh.md)) | Full-File SHA-256 Fingerprinting, TOCTOU Closure & Cross-Model Verification | Accepted | 2026-10-22 |
| [ADR-0003](0003-gui-cli-hybrid-architecture.md) ([中文](0003-gui-cli-hybrid-architecture_zh.md)) | GUI Sandbox vs CLI Process Hybrid Layering Architecture & Wake-Up Boundaries | Accepted | 2026-10-23 |
| [ADR-0004](0004-review-mutation-separation-and-toctou-buffer.md) ([中文](0004-review-mutation-separation-and-toctou-buffer_zh.md)) | Separation of Review and Mutation (SRM), TOCTOU Soft-Failure Buffering & Immutable Baseline | Accepted | 2026-10-23 |
| [ADR-0005](0005-controlled-daemon-and-process-supervision.md) ([中文](0005-controlled-daemon-and-process-supervision_zh.md)) | Controlled Daemon, Micro-Transaction CAS Leases & Process Tree Supervision (Reversal of ADR-0003 Rule 3) | Accepted | 2026-10-25 |
