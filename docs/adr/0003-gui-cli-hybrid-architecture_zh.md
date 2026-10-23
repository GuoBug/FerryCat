# ADR-0003: GUI 沙箱与 CLI 进程混合分层架构、唤醒边界与双通道 Worker 选型

<p align="center">
  <a href="0003-gui-cli-hybrid-architecture.md">English</a> •
  <b>中文</b>
</p>

- **状态**: Accepted (已通过)
- **日期**: 2026-10-23
- **决策人**: 郭强 (Guo Qiang)
- **涉及模块**: 契约存储引擎 (`src/engine.ts`)、指纹校验器 (`src/fingerprint.ts`)、CLI 调度器 (`src/cli.ts`)、双端交互层
- **上游 ADR**: [ADR-0001: 跨宿主 SQLite WAL 总线与即时轮询模型](0001-cross-host-sqlite-wal-and-poll-model_zh.md)、[ADR-0002: 全文件指纹防盲审与 TOCTOU 闭合](0002-fingerprint-toctou-and-cross-model-audit_zh.md)

---

## 1. 背景与核心困境 (Context)

在 FerryCat v0.1.0 成功跑通 Google Antigravity 与 WorkBuddy 的跨桌面宿主互审后，系统面临向自动化场景拓展的核心难题：**“如何唤醒空闲的 Agent 宿主（Wake up Idle Host）？”**

通过对桌面 IDE 与操作系统底层原语的深入物理验证，识别出两大本质现实：
1. **桌面 IDE 宿主“装睡”的安全必然性**：
   桌面 IDE（如 VS Code、Cursor、WorkBuddy）的 Agent 循环遵循人在回路（Human-in-the-Loop）与防 Token 失控原则。LLM 吐字结束后线程即休眠。外部进程既无法穿透 Webview 隔离沙箱，也不能在未安装特定扩展时通过裸 URI（如 `vscode://`）自动灌入 Prompt 并触发提交；
2. **单一模型通吃的破产**：
   如果强行将所有 Worker 抽离为后台无头脚本，将彻底消解双 IDE 桌面协同互审的直观交互价值；而如果在 GUI 内部做黑盒按键模拟，则极其脆弱且安全风险失控。

---

## 2. 架构决策：GUI + CLI 混合分层 (Decision Outcome)

确立 **“GUI 层做高认知人机审批，CLI 层做低延迟自动化自治”** 的混合分层模型：

```
     ┌────────────────────────────────┐       ┌────────────────────────────────┐
     │       GUI 宿主 (Antigravity)    │       │       GUI 宿主 (WorkBuddy)     │
     └───────────────┬────────────────┘       └────────────────┬───────────────┘
                     │                                         │
                     │ dispatch_contract (人机交互)             │ poll / fulfill (人工确认)
                     ▼                                         ▼
   ═════════════════════════════════════════════════════════════════════════════════
                      【底层共享总线: ~/.ferrycat/mesh.db (SQLite WAL)】
                      【状态机: SUBMITTED ➔ CLAIMED ➔ COMPLETED / STALE】
   ═════════════════════════════════════════════════════════════════════════════════
                     ▲                                         ▲
                     │ 500ms 安全轮询 / 任务探测               │ 原子乐观锁抢占 / 二次散列交单
                     │                                         │
     ┌───────────────┴────────────────┐       ┌────────────────┴───────────────┘
     │ CLI Worker (安全轮询/自动交付)  │       │   CI / 子进程 Worker (--once)  │
     └────────────────────────────────┘       └────────────────────────────────┘
```

### 2.1 职责划分与唤醒范式

| 维度 | GUI 层（桌面 IDE 交互宿主） | CLI 层（自研终端 Worker） |
| :--- | :--- | :--- |
| **典型宿主** | **Antigravity**（架构/规划）+ **WorkBuddy**（审计/落地） | **`ferrycat-worker`**（基于 Node.js 原生构建） |
| **核心职责** | 复杂业务理解、架构权衡裁决、最终合并审批 | 确定性执行、批量测试生成、只读静态分析 |
| **唤醒模型** | **人工调度即时轮询（Human-as-Scheduler）** | **安全轮询监听器 + `--once` 子进程 + `--exec` 自动交付** |
| **安全与执行边界**| Webview 沙箱，人作为天然的意图确认闸 | 宿主 OS 进程权限，利用原生文件系统高速自治 |

### 2.2 共享底座的确定性防护（已合入源码核验）
1. **路径无歧义展开**：在 [`src/engine.ts`](../../src/engine.ts) 中通过 `expandTilde()` 强制展开为 `os.homedir()`，严禁向 SQLite 传递字面量 `~`，杜绝不同 CWD 下产生分裂库；
2. **全文件 SHA-256 指纹**：在 [`src/fingerprint.ts`](../../src/fingerprint.ts) 中对文件全文计算 64 位十六进制散列，杜绝局部哈希漏检；
3. **Claim 乐观锁抢占**：`UPDATE contracts SET status='CLAIMED' WHERE id=? AND status='SUBMITTED'` 严格校验 `changes === 1`；
4. **Fulfill 二次验散列（TOCTOU 闭合）**：在 [`src/engine.ts`](../../src/engine.ts) L382 交单前重新执行 `verifySingleRun`，若目标文件在审查期被篡改，立即熔断置为 `POINTER_STALE`；
5. **Fulfill 并发状态守卫**：在 [`src/engine.ts`](../../src/engine.ts) L470 显式校验 `completeRes.changes === 1`，彻底消除并发交单冲突导致的虚假成功；
6. **初始化并发锁超时前置**：在 [`src/engine.ts`](../../src/engine.ts) L86 将 `PRAGMA busy_timeout = 5000` 置于 `PRAGMA journal_mode = WAL` 之前，在 5000ms 窗口内消除多进程初次并发连接初始化时的瞬态锁竞争。

### 2.3 CLI Worker 架构与落地定调
1. **v0.1.1 当前落地形态（轻量 Worker CLI）**：
   - **子进程按需模式（Subprocess `--once`）**：支持单次任务处理。若附带 `--exec <cmd>` 则在子进程执行完成后自动调用 `fulfillContract` 提交交付物，实现接单->执行->交付全自动闭环；若未带 `--exec` 则作为显式的人工认领模式（CLAIM_ONLY，并明确提示需后续执行交付）；
   - **安全轮询与监听模式（Watcher / Notifier Loop）**：在常驻未配置 `--exec` 时，仅只读探测排队任务输出通知，**不进行未授权抢占**，彻底杜绝守护进程在缺乏处理脚本时“盲目认领弃单”导致的超时堆积；配置 `--exec` 后才执行抢占与自动化交付；
   - **优雅停机与资源保护**：支持 `SIGINT` / `SIGTERM` 信号打断休眠并优雅退出，二次中断强制退出；延迟实例化引擎，消除无效命令预建库副作用。
2. **v0.2.0 演进规划（双通道 REPL，规划中）**：
   - 挂载异步多路复用 EventLoop（`process.stdin` + SQLite WAL 写入加速）；
   - 终端防污染保护（Clean Terminal IO：基于 readline 行缓冲保存与流式日志文件重定向）。

---

## 3. 被否决路线与证伪记录 (Negative Decisions)

1. **否决：桌面 GUI 侧模拟按键/URI 自动唤醒**：
   - URI 协议仅能唤起应用，在缺乏伴生 Extension 挂载业务 Handler 时无法注入 Prompt；WorkBuddy 等宿主具备封闭私有沙箱，黑盒模拟按键极其脆弱，且破坏了“人在回路”的最高确认准则。
2. **否决：对第三方 CLI 发送 `SIGUSR1` 信号**：
   - POSIX 下 `SIGUSR1` 默认动作为 **Terminate（终止进程）**。对未预埋 Handler 的第三方 CLI 发送信号会导致目标直接崩溃；Windows 原生亦不支持该信号。
3. **否决：将外挂第三方 CLI 作为主线（PTY 注入）**：
   - **传输层能唤醒 $\ne$ 语义层会执行**。向外部 CLI 的 stdin 盲注文本，模型易将其作为普通闲聊处理，无法保证严格调用 `poll_next_task`，且伴随终端命令注入隐患。

---

## 4. 混合协同铁律与演进路线

1. **只读与输出新文件铁律**：当前 CLI 执行必须严格遵守“只读分析”或“将产物写入新文件（Artifacts）”，严禁原地覆写原文件，否则触发 TOCTOU 散列熔断；
2. **版本路线**：
   - **v0.1.1 (当前落地)**：GUI 桌面双宿主互审 + 乐观锁与 TOCTOU 散列全闭环 + 自研轻量 CLI Worker（安全轮询监听、`--once` 子进程与 `--exec` 自动交付闭环）；
   - **v0.2.0 (规划中)**：双通道 REPL 终端多路复用 + 原地代码修改两阶段写入契约。
