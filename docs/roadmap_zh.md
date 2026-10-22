# FerryCat 项目需求池与演进路线图 (Roadmap)

<p align="center">
  <a href="roadmap.md">English</a> •
  <b>中文</b>
</p>

## Phase 1: 确定性单轮契约交接核心 (v0.1 — 已完成)

- [x] **FC-101**：基于 Node.js 内置 `node:sqlite` 的零 C++ 扩展 WAL 并发存储（通过 `--experimental-sqlite` 同时兼容 Node 22.12+ 与 Node 24+）。
- [x] **FC-102**：确定性 6 态状态机（`SUBMITTED`、`CLAIMED`、`COMPLETED`、`POINTER_STALE`、`VALIDATION_FAILED`、`TIMED_OUT`）与 `changes === 1` 乐观锁抢占。
- [x] **FC-103**：全文件 SHA-256 指纹校验、3 秒未落盘缓冲区告警（首末行快照）与交单阶段 TOCTOU 二次指纹复核。
- [x] **FC-104**：有界 Ajv JSON Schema 校验（前 2 次返回 `RETRY_NEEDED`，第 3 次熔断进入 `VALIDATION_FAILED`）及编译缓存优化。
- [x] **FC-105**：排队期（1800s）与执行期（300s）双阶段独立 TTL，以及 `SELECT COUNT(*)` 先读后写无锁探测清理。
- [x] **FC-106**：MCP `stdio` 服务端（`dist/index.js`）与 CLI 入口（`dist/cli.js`）共享同一套 Zod 参数边界校验。

---

## Phase 2: 开发者体验与跨分支补丁支持 (规划中)

- [ ] **FC-201（队头陈旧工单非阻塞跳过）**：当队列首条工单因文件变更被判定为 `POINTER_STALE` 时，支持在记录告警的同时继续扫描同批次后续有效工单，避免队头阻塞一轮轮询。
- [ ] **FC-202（可选 Git Patch 自包含载荷模式）**：针对两端处于不同 Git 分支的场景，支持可选携带轻量 `git diff` 切片，解除对同一磁盘工作树状态的强依赖。
- [ ] **FC-203（异步非阻塞瞬态重试）**：将 `verifyFingerprintsWithRetry` 中的 `Atomics.wait(150ms)` 升级为异步 `await setTimeout`，避免瞬态复核期间阻塞 MCP 主线程。
