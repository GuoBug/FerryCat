# ADR-0001: 采用跨宿主 SQLite WAL 总线与人工调度即时轮询模型

<p align="center">
  <a href="0001-cross-host-sqlite-wal-and-poll-model.md">English</a> •
  <b>中文</b>
</p>

- **状态**: Accepted (已通过)
- **日期**: 2026-10-22
- **决策人**: 郭强 (Guo Qiang)
- **涉及模块**: 跨进程存储引擎与工具触发机制 (`src/engine.ts`)

---

## 1. 背景与问题定义 (Context)

在单机桌面开发环境中，工程师往往同时开启多个 AI 宿主（例如使用 Google Antigravity 进行系统架构设计，同时使用 WorkBuddy 调用本地模型进行独立代码审计）。

在设计 FerryCat 时，通过可证伪核验识别出三个底层物理约束：
1. **`stdio` 进程物理隔离**：桌面 IDE 挂载本地 MCP Server 时，各自 `spawn` 独立的操作系统子进程，内存完全隔离；
2. **宿主注入的 Node.js 运行时版本差异**：实测同一台 Windows 机器上，系统 PATH 为 `Node v24.19.0`，而 WorkBuddy 注入的托管运行时为 `Node v22.12.0` / `v22.22.2`；
3. **MCP 被动触发限制**：MCP 是请求-响应模型，服务端无法主动向空闲状态的宿主推送消息并唤醒其 LLM 推理。

---

## 2. 备选方案权衡 (Considered Alternatives)

### 议题一：跨进程唤醒机制

#### 备选 A：服务端挂起 60 秒长轮询 (`Blocking Hold / await_next_task`)
- **设想**：Worker 调用 `await_next_task` 后服务端故意挂起连接 60 秒轮询数据库，有任务时立即返回。
- **证伪与缺陷**：
  1. 多数 MCP 客户端默认全局请求超时恰为 60 秒，超时后客户端直接判定为 Tool Call Error；
  2. 若 60 秒内无任务返回空结果，宿主 LLM 总结“暂无任务”后即结束当前对话轮次，无法自动重入，第 61 秒派发的工单依然无人接管。
- **结论**：**否决 (Rejected)**。

#### 备选 B：依赖 MCP 官方 `Tasks` 规范 (2025-11 / 2026-07)
- **证伪与缺陷**：MCP `Tasks` 解决的是**单条 `Client ↔ Server` 连接内部**的异步长任务状态机，无法跨越两个独立宿主进程与两套独立上下文窗口传递任务。
- **结论**：**不适用 (Not Applicable to Cross-Host Handoff)**。

#### 备选 C：人工调度 + 原子即时轮询 (`poll_next_task`)
- **机制**：诚实定义“人类担任调度器，协议负责不丢、不重、不盲审、结构化交付”。`poll_next_task` 在 `<50ms` 内通过 SQL 乐观锁（`changes === 1`）完成单次抢占并立即返回。
- **代价**：每次跨宿主互审需要 3 次显式人工窗口切换（约 15~25 秒操作开销）。
- **收益**：100% 确定性跑通，不踩客户端超时红线，不产生后台空转轮询。
- **结论**：**通过 (Accepted)**。

---

### 议题二：跨进程 SQLite 驱动选型

| 维度 | `node:sqlite` + 恒定 `--experimental-sqlite` *(FerryCat 采用)* | `better-sqlite3` |
| :--- | :--- | :--- |
| **依赖形态** | Node.js v22.5+ 内置模块，零外部二进制依赖 | C++ 原生扩展 (`node-addon-api`) |
| **跨宿主 Node 版本兼容性** | 实测 `--experimental-sqlite` 在 Node 22.12、22.22、24.19 下均兼容无报错 | 依赖对应平台与 ABI 的预编译二进制或本地 MSVC/Python 编译链 |
| **并发控制** | 支持 `PRAGMA journal_mode = WAL` 与 `busy_timeout = 5000` | 同左 |

- **结论**：选用 Node.js 内置 `node:sqlite`，并在 MCP 启动参数中恒定携带 `--experimental-sqlite`。

---

## 3. 最终工程落地 (Decision Outcome)

1. **单表 6 态状态机**：在 [`src/engine.ts`](../../src/engine.ts) 中落地 `SUBMITTED`、`CLAIMED`、`COMPLETED`、`POINTER_STALE`、`VALIDATION_FAILED`、`TIMED_OUT` 6 个状态，每态对应唯一 SQL 写入事务。
2. **乐观锁并发抢占**：`UPDATE contracts SET status = 'CLAIMED', claimed_at = ? WHERE id = ? AND status = 'SUBMITTED'`，严格校验 `Number(updateResult.changes) === 1`。
3. **两阶段独立 TTL 与先读后写清理**：将排队期 `queue_ttl_sec`（1800s）与执行期 `exec_ttl_sec`（300s）解耦；仅当 `SELECT COUNT(*)` 大于 0 时才执行过期 `UPDATE`，避免每次 `poll` 争抢 WAL 写锁。
