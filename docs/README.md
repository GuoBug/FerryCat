# FerryCat Engineering Documentation

Welcome to the internal engineering documentation of FerryCat. This repository follows standard platform engineering documentation practices.

## Directory Structure

```
docs/
├── README.md                                                     # Documentation index (this file)
├── roadmap.md                                                    # Product positioning & phased requirements backlog (EN)
├── roadmap_zh.md                                                 # 项目需求池与演进路线图 (ZH)
├── real-mesh-trajectory.json                                     # Raw SQLite trajectory from cross-host 3-model verification
├── audits/                                                       # Multi-agent architecture audits & verification records
│   ├── 2026-10-23-phase-a-review_zh.md                           # Phase A white-box review
│   ├── 2026-10-23-phase-a-final-verification_zh.md               # Phase A final verification
│   ├── 2026-10-23-phase-b-review_zh.md                           # Phase B review & Glama audit
│   ├── 2026-10-23-phase-b-final-verification_zh.md               # Phase B final verification
│   └── 2026-10-24-phase-3-multi-agent-consensus-audit_zh.md       # Phase 3 tri-agent consensus audit & sign-off
└── adr/                                                          # Architecture Decision Records (ADR)
    ├── README.md                                                 # ADR registry and lifecycle index
    ├── 0001-cross-host-sqlite-wal-and-poll-model.md              # ADR-0001: Cross-Host SQLite WAL & Poll Model (EN)
    ├── 0001-cross-host-sqlite-wal-and-poll-model_zh.md           # ADR-0001: 跨宿主 SQLite WAL 与即时轮询模型 (ZH)
    ├── 0002-fingerprint-toctou-and-cross-model-audit.md          # ADR-0002: SHA-256 Fingerprinting, TOCTOU & Audit (EN)
    └── 0002-fingerprint-toctou-and-cross-model-audit_zh.md       # ADR-0002: 全文件指纹、TOCTOU 闭合与三模型实测记录 (ZH)
```

## Guidelines for Future Agents & Contributors

1. **Architecture Decisions**: When proposing structural changes (e.g., storage engine changes, state machine transitions, validation rules), create a new ADR under `docs/adr/` numbered sequentially (`0003-...md`).
2. **README Discipline**: Keep `README.md` and `README_zh.md` lean, punchy, and focused on quickstart and user onboarding. In-depth engineering rationale, trade-offs, and empirical verification records belong in `docs/adr/`.
3. **No Speculative Present Tense**: ADRs may state a decision, but anything not yet implemented must be marked with its roadmap ID and an explicit status note.
