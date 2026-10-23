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

## Phase A: 生命周期与执行模型纠偏 (已完成，待发版)

- [x] **FC-A01（分级默认执行期 TTL）**：`code_review` / `architecture_audit` 默认 1800s，`implementation` / `test_generation` 默认 300s；派单显式传入的 `exec_ttl_sec` 优先。
- [x] **FC-A02（`release_contract` 退回）**：仅持单方可调用，`CLAIMED → SUBMITTED` 回到队尾并重新计算排队窗口；清零 `retry_count` / `extend_count`；单张工单最多退回 3 次。
- [x] **FC-A03（`extend_ttl` 心跳续期）**：仅持单方可调用，重置 `claimed_at`；每位持单者最多续期 5 次，超过 `created_at + 4 × queue_ttl_sec` 后拒绝续期。`RETRY_NEEDED` 同样会重置执行窗口。
- [x] **FC-A04（`fail_contract` 与 `FAILED` 终态）**：仅持单方可调用，必须携带失败原因；`worker --exec` 子进程非零退出时自动置为 `FAILED`。
- [x] **FC-A05（原地表结构迁移）**：增量新增 `queued_at` / `extend_count` / `release_count` 列；旧版宿主写入的行（`queued_at IS NULL`）仍可被正常认领。

---

## Phase 2: 开发者体验与跨分支补丁支持 (规划中)

- [ ] **FC-201（队头陈旧工单非阻塞跳过）**：当队列首条工单因文件变更被判定为 `POINTER_STALE` 时，支持在记录告警的同时继续扫描同批次后续有效工单，避免队头阻塞一轮轮询。
- [ ] **FC-202（可选 Git Patch 自包含载荷模式）**：针对两端处于不同 Git 分支的场景，支持可选携带轻量 `git diff` 切片，解除对同一磁盘工作树状态的强依赖。
- [ ] **FC-203（异步非阻塞瞬态重试）**：将 `verifyFingerprintsWithRetry` 中的 `Atomics.wait(150ms)` 升级为异步 `await setTimeout`，避免瞬态复核期间阻塞 MCP 主线程。
