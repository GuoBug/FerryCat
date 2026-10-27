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

## Phase A: 生命周期与执行模型纠偏 (v0.2.0 — 已完成)

- [x] **FC-A01（分级默认执行期 TTL）**：`code_review` / `architecture_audit` 默认 1800s，`implementation` / `test_generation` 默认 300s；派单显式传入的 `exec_ttl_sec` 优先。
- [x] **FC-A02（`release_contract` 退回）**：仅持单方可调用，`CLAIMED → SUBMITTED` 回到队尾并重新计算排队窗口；清零 `extend_count`，保留 `retry_count`（熔断配额）；单张工单最多退回 3 次。
- [x] **FC-A03（`extend_ttl` 心跳续期）**：仅持单方可调用，重置 `claimed_at`；每位持单者最多续期 5 次，超过 `created_at + 4 × queue_ttl_sec` 后拒绝续期。`RETRY_NEEDED` 同样会重置执行窗口。
- [x] **FC-A04（`fail_contract` 与 `FAILED` 终态）**：仅持单方可调用，必须携带失败原因；`worker --exec` 子进程非零退出时自动置为 `FAILED`。
- [x] **FC-A05（原地表结构迁移）**：增量新增 `queued_at` / `extend_count` / `release_count` 列；旧版宿主写入的行（`queued_at IS NULL`）仍可被正常认领。

---

## Phase B: CLI 人体工程学、开发者体验与 TOCTOU 软失败缓冲 (v0.3.0 — 已完成)

- [x] **FC-B01（全局与子命令标准 `--help` / `--version`）**：全量 9 个子命令的分层帮助树体系，包含参数说明、模式枚举与典型示例。
- [x] **FC-B02（Stdin 管道 Payload 支持与 BOM 兼容）**：支持 `--file -`、位置参数 `-` 以及自动探测 stdin 管道，并透明去除 UTF-8 BOM。
- [x] **FC-B03（Inspect ASCII 表格终端视图与 Target 过滤）**：默认以高可读性 ASCII 表格输出，支持 `--target <agent>` 过滤，保留 `--json` / `--format=json` 原始输出。
- [x] **FC-B04（Worker 三模式收敛与脚本文件执行）**：明确收敛 `--mode=watch|claim|exec` 语义，并提供 `--exec-file <script>` 直接执行脚本文件，杜绝 Shell 引号转义灾难。
- [x] **FC-B05（结构化友好 Zod 错误格式化）**：消灭 SQLite 裸错误堆栈泄漏，提供字段级定位与对应的 `--help` 提示。
- [x] **FC-B06（ADR-0004 只读预检 verify_contract）**：新增 `verify_contract` MCP 工具与 `ferrycat-cli verify` 命令，纯只读核验指针一致性。
- [x] **FC-B07（ADR-0004 1 次 TOCTOU 软失败缓冲）**：Strike 1 返回 `RETRY_NEEDED` 与脏文件清单及恢复指引；Strike 2 置为 `POINTER_STALE` 并在 `salvaged_result_json` 抢救提交产物。

---

## Phase 0.3.1: 安全严谨性热修复与租约隔离 (v0.3.1 — 已完成)

- [x] **FC-301（Lease Token 独占租约隔离）**：`contracts` 表新增 `claim_token` 列；`poll_next_task` 抢占成功时签发随机 UUID；`fulfill` / `release` / `extend` / `fail` 强制校验凭据，彻底杜绝同名 Worker 并发交叉操作。
- [x] **FC-302（Payload 尺寸与深度上限校验）**：对 `structured_output` 与 `contract_schema` 引入 1MB~2MB 序列化大小限制，防止 SQLite 单行数据膨胀。
- [x] **FC-303（CLI Worker 执行安全加固）**：以 `--exec-file`（无 Shell 注入风险）为主推执行方式，将 `--exec` 标记为显式 Shell 兼容模式。
- [x] **FC-304（文档与严谨性热修复）**：增补 Threat Model 章节、严谨化 TOCTOU 纳秒级收敛措辞、规范 `workspace_root` 相对/绝对路径说明。

---

## Phase 2: 开发者体验与跨分支补丁支持 (v0.4.0 — 部分完成)

- [x] **FC-201（队头陈旧工单非阻塞跳过）**：当队列首条工单因文件变更被判定为 `POINTER_STALE` 时，支持在记录告警的同时继续扫描同批次后续有效工单，彻底解除队头阻塞（已在 2026-10-27 真实总线工单 `fc_1793098036393_aea8bb9b` 漂移跳过并成功认领后续工单实测验收）。
- [ ] **FC-202（可选 Git Patch 自包含载荷模式）**：针对两端处于不同 Git 分支的场景，支持可选携带轻量 `git diff` 切片，解除对同一磁盘工作树状态的强依赖。
- [ ] **FC-203（异步非阻塞瞬态重试）**：将 `verifyFingerprintsWithRetry` 中的 `Atomics.wait(150ms)` 升级为异步微任务调度，消灭同步阻塞技术债。
- [x] **FC-204（零配置沙箱演练 `ferrycat demo`）**：支持单命令 `npx ferrycat demo` 在 OS 临时目录自动构建隔离沙箱并跑通 4 步全流程（派单 $\to$ 认领 $\to$ 执行与真实心跳续约 $\to$ TOCTOU 复核 COMPLETED），并支持 `--keep`、`--json` 与 `--no-color`（v0.4.0 交付）。

---

## Phase 3: 主动唤醒与常驻守护编排引擎 (Active Wake-up & Daemon Orchestration — 已完成)

- [x] **FC-401（后台常驻守护与服务管理 `ferrycat daemon`）**：基于 SQLite WAL 短事务原子 CAS 租约（`daemon_locks`）与进程树严密监管（`taskkill /T /F` 与 `kill(-pgid)`）落地，无长锁无膨胀（ADR-0005，已在 v0.3.3 完成）。
- [x] **FC-402（配置驱动声明式 Handler 与脚本执行）**：引入声明式配置文件（`ferrycat.config.json`），强绑定白名单执行文件，彻底消除任意自由 Shell 注入面（ADR-0005，已在 v0.3.3 完成）。
- [x] **FC-403（桌面系统通知与本地事件 Hook）**：支持操作系统级原生桌面通知（Windows WinRT Toast / macOS osascript argv / Linux notify-send，全异步非阻塞 `unref` + `error` 吞吐保护）与本地 HTTP Webhook（`webhook_url` / `FERRYCAT_WEBHOOK_URL`，3s 超时熔断），在契约认领、终态完成/失败或租约丢失时即时唤醒开发者或外部流水线。
