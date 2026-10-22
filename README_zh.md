# FerryCat: 契约驱动的跨宿主 AI Agent 交接与评审总线

<p align="center">
  <a href="README.md">English</a> •
  <b>中文</b>
</p>

[![Node.js Version](https://img.shields.io/badge/Node.js-22.5%2B-339933?style=flat&logo=nodedotjs)](https://nodejs.org/)
[![Native Addons](https://img.shields.io/badge/Native_Addons-0_(node%3Asqlite)-success?style=flat)]()
[![Protocol](https://img.shields.io/badge/Protocol-MCP_Stdio-orange?style=flat)](https://modelcontextprotocol.io/)
[![License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

> **FerryCat** (`ferrycat`) 是一个基于 Model Context Protocol (MCP) 与 Node.js 内置 `node:sqlite`（WAL 并发模式）构建的轻量级、确定性跨宿主 AI Agent 工单交接与交叉评审总线。  
> 专为解决单机桌面环境下不同 IDE 宿主（如 Google Antigravity、WorkBuddy、Claude Code、Cursor）因进程物理隔离导致的上下文割裂、未落盘代码静默盲审与非结构化交付痛点而设计。

<p align="center">
  <img src="https://guobug.github.io/assets/images/flowchart-ferrycat-cross-host-demand-and-workflow.svg" alt="FerryCat 跨宿主契约摆渡全景" width="960" />
</p>

> 📖 **深度长文**：[为什么我开始做 FerryCat：当你的电脑上同时开着两个 AI 编程软件](https://guobug.github.io/posts/2026/10/22/why-we-built-ferrycat-cross-host-agent-review-bus/)

---

## 核心痛点与工程解法

MCP 官方的 `Tasks` 规范（2025-11 / 2026-07）解决的是**单条 `Client ↔ Server` 连接内部**的长耗时任务状态跟踪，但无法解决桌面端跨宿主协同的四个物理难题：
1. **`stdio` 子进程内存隔离**：各 IDE 宿主分别拉起独立的 MCP 子进程，内存空间与注入的 Node.js 运行时完全隔离；
2. **陈旧代码静默盲审（Stale Context）**：宿主 A 修改代码尚未保存或切换了分支，宿主 B 在旧文件上输出看似专业实则失真的审查结论；
3. **跨窗口全文粘贴导致 Token 膨胀**：将数百行源码塞入两侧对话上下文，造成重复的 Token 消耗与截断失真；
4. **自由文本交付缺乏结构化约束**：缺乏强 Schema 校验与重试上限控制，容易引发模型无限重试。

**FerryCat 采用“人类担任调度器，协议保障不丢、不重、不盲审、结构化交付”的 SQLite WAL 总线架构化解上述问题：**

```
[开发者]                [宿主 A: Antigravity]            [~/.ferrycat/mesh.db]            [宿主 B: WorkBuddy]
   |                              |                                |                               |
   |-- 1. "派发代码审查工单" ----->|                                |                               |
   |                              |-- dispatch_contract() -------->| 写入 status = SUBMITTED       |
   |                              |   (全文件 SHA-256 + 首末行快照)  | 记录文件 size / sha256        |
   |                              |                                |                               |
   |-- 2. 切窗口："拉取待办工单" ---|--------------------------------|------------------------------>|
   |                              |                                |<-- poll_next_task() ----------|
   |                              |                                |    (原子抢占 changes===1       |
   |                              |                                |     + 校验磁盘文件 SHA-256)    |
   |                              |                                |                               |-- 就地读取本地文件
   |                              |                                |<-- fulfill_contract() --------|-- 二次校验 SHA-256
   |                              |                                |    (校验 Ajv JSON Schema      |   并提交结构化结果
   |                              |                                |     -> status = COMPLETED)    |
   |                              |                                |                               |
   |-- 3. 切回："查看审查结论" ---->|                                |                               |
   |                              |-- inspect_mesh_state() ------->| 纯只读查询 COMPLETED 结论      |
   |<-- 汇总展示并决定是否合入 ----|                                |                               |
```

---

## 五大核心架构支柱

### 1. 确定性 6 态状态机 (Deterministic 6-State Machine)
每个状态跃迁均绑定独立的 SQL 事务与乐观锁校验（`changes === 1`），杜绝悬空状态与并发重复领单：

```
                  dispatch_contract()
                          │
                          ▼
                    ┌───────────┐
                    │ SUBMITTED │ (排队期 TTL: 默认 1800s)
                    └─────┬─────┘
                          │
                 poll_next_task()
         ┌────────────────┼────────────────┐
         │ (排队超时)      │ (指纹匹配)      │ (文件缺失 / 大小变动 / 全文 SHA-256 不一致)
         ▼                ▼                ▼
   ┌───────────┐    ┌───────────┐   ┌───────────────┐
   │ TIMED_OUT │    │  CLAIMED  │   │ POINTER_STALE │ (终态：拒绝在陈旧代码上盲审)
   └───────────┘    └─────┬─────┘   └───────────────┘
      ▲                   │ (执行期 TTL: 默认 300s)
      │          fulfill_contract()
      │  ┌────────────────┼────────────────┬────────────────┐
      └──┤ (执行超时)      │ (Schema 通过)   │ (重试 > 2 次)   │ (审查期间文件被篡改)
         │                ▼                ▼                ▼
         │          ┌───────────┐   ┌───────────────────┐ ┌───────────────┐
         └──────────│ COMPLETED │   │ VALIDATION_FAILED │ │ POINTER_STALE │
                    └───────────┘   └───────────────────┘ └───────────────┘
```

### 2. 全文件 SHA-256 指纹校验与 TOCTOU 窗口闭合
- **派单快照**：`dispatch_contract` 读取磁盘文件，记录字节数 `size`、全文件 `sha256`（64 位 hex）以及非空首末行 `first_line` / `last_line`。若文件在最近 3 秒内刚被修改，返回 `warning` 提醒确认 IDE 缓冲区已落盘。
- **领单核验**：`poll_next_task` 严格按 `存在性 -> 字节数 size -> 全文件 sha256` 顺序核验（绝不以 `mtime` 单独判死刑，避免 IDE 无变更保存导致误杀）。若不一致，等待 `150ms` 重试一次排除瞬态写入，仍不一致则直接置为终态 `POINTER_STALE`。
- **交单 TOCTOU 复核**：`fulfill_contract` 在交单落库前二次执行 `verifySingleRun`，防止领单后至交单前目标文件被篡改。

### 3. 单方向交付与有界 Schema 重试 (`RETRY_NEEDED` $\le 2$)
- 使用带缓存的 Ajv 校验器验证 `structured_output`，并将校验错误压平为单行路径列表（如 `["/passed: must be boolean"]`）。
- 前 2 次校验失败返回 `RETRY_NEEDED` 供模型当轮修正；第 3 次失败直接流转至终态 `VALIDATION_FAILED`，防止模型陷入无限重试消耗 Token。

### 4. 两阶段独立 TTL 与先读后写惰性清理
- 排队期 `queue_ttl_sec`（默认 1800s）与执行期 `exec_ttl_sec`（默认 300s，从 `claimed_at` 起算）分离，防止排队 29 分钟的任务刚被认领 1 分钟就被误判超时。
- `poll_next_task` 先执行无写锁的 `SELECT COUNT(*)` 探测过期项，仅当存在过期工单时才执行 `UPDATE`；`inspect_mesh_state` 保持纯只读，零写锁竞争。

### 5. 双端纵深路径安全防线
- 在派单（`dispatch`）与领单/交单（`worker`）两侧同时强制执行工作区目录包含校验（阻断 `..` 路径逃逸）与敏感文件黑名单拦截（`.env*`、`*.pem`、`*.key`、`id_rsa*`、`*credentials*`、`*secret*`、`.npmrc`、`.git/config`）。

---

## 适用边界（什么情况下不该用 FerryCat）

1. **两端不共享同一本地文件系统**：FerryCat 依赖按引用传递文件指针（Context Offloading by Reference），要求双方能访问同一份 `workspace_root`。
2. **单轮简单问答即可解决的任务**：每次跨宿主交接需要 3 次人工窗口切换（约 15~25 秒操作开销），简单问题直接在单个 IDE 内完成即可。
3. **需要无人值守全自动流水线的场景**：桌面 IDE 宿主受限于请求-响应模型，无法在空闲时被 MCP 服务端主动推流唤醒；若需无人值守编排，请使用独立的 DAG 状态机工作流引擎（如 [PatchCat](https://github.com/GuoBug/ai-prompt-orchestrator)）。

---

## 快速上手

### 1. 安装与编译测试
```bash
git clone https://github.com/GuoBug/FerryCat.git
cd FerryCat
npm install
npm run build
npm test
```

> **关于 `--experimental-sqlite`**：启动参数中恒定携带 `--experimental-sqlite`，以同时兼容 Node 22.12 LTS（需 flag）与 Node 22.22+ / Node 24+（原生免 flag，携带亦不报错），实现零原生 C++ 编译依赖。

### 2. Antigravity 侧挂载
编辑 `%USERPROFILE%\.gemini\antigravity\mcp_config.json`（macOS/Linux 为 `~/.gemini/antigravity/mcp_config.json`）：
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

### 3. WorkBuddy / Claude Code / Cursor 侧挂载
在目标宿主的 MCP 配置文件中添加对应 `AGENT_NAME`：
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
> **注**：MCP `stdio` 模式与 CLI 直接调用模式（`node --experimental-sqlite dist/cli.js <dispatch|poll|fulfill|inspect>`）共享同一份 `~/.ferrycat/mesh.db` 数据库与同一套 Zod 参数校验契约。

---

## 暴露的 4 个 MCP 工具契约

| 工具名 | 调用角色 | 职责与事务行为 |
| :--- | :--- | :--- |
| **`dispatch_contract`** | 发起方 (Requester) | 校验路径黑名单 $\to$ 计算全文件 SHA-256 与首末行快照 $\to$ 写入 `SUBMITTED`。 |
| **`poll_next_task`** | 接收方 (Worker) | 先读后写清理超时工单 $\to$ `changes === 1` 原子抢占为 `CLAIMED` $\to$ 校验文件指纹（不匹配则置为 `POINTER_STALE`）。 |
| **`fulfill_contract`** | 接收方 (Worker) | 二次复核文件指纹（防 TOCTOU）$\to$ 校验 Ajv JSON Schema（失败 $\le 2$ 次返回 `RETRY_NEEDED`，第 3 次置为 `VALIDATION_FAILED`）$\to$ 通过则置为 `COMPLETED`。 |
| **`inspect_mesh_state`** | 任意方 (Read-Only) | 纯只读查询工单状态、结构化产出与错误原因，动态计算 `is_logically_expired`。 |

> 💡 **架构决策记录 (ADR) 与工程验证沉淀**：
> - [ADR-0001: 采用跨宿主 SQLite WAL 总线与人工调度即时轮询模型](docs/adr/0001-cross-host-sqlite-wal-and-poll-model_zh.md)（为什么采用 `node:sqlite` WAL + `poll_next_task`，而非 60s 长轮询挂起或单连接 MCP Tasks）
> - [ADR-0002: 全文件 SHA-256 指纹防盲审、TOCTOU 闭合与跨宿主多模型实测记录](docs/adr/0002-fingerprint-toctou-and-cross-model-audit_zh.md)（指针陈旧防护设计与 3 模型真实互审复盘记录）
> - [FerryCat 演进路线图 (Roadmap)](docs/roadmap_zh.md)

---

> **关于作者**  
> **郭强 (GuoBug)**，Product Engineer，做平台工程也做业务增长。目前主要在折腾 AI 工作流编排、DAG 状态机与确定性系统架构。  
> 开源项目与主页：[https://github.com/GuoBug](https://github.com/GuoBug) · [https://guobug.github.io](https://guobug.github.io)  
> 欢迎就工作流引擎架构、拓扑调度和低门槛开发体验交流指教。
