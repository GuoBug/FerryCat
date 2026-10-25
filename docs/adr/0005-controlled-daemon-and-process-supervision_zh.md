# ADR-0005: 受控守护进程、短事务 CAS 租约与安全执行边界（决策反转与架构收敛）

<p align="center">
  <a href="0005-controlled-daemon-and-process-supervision.md">English</a> •
  <b>中文</b>
</p>

- **状态**: Accepted (已通过)
- **日期**: 2026-10-25
- **决策人**: 郭强 (GuoBug)
- **涉及模块**: 守护进程控制器 (`src/daemon.ts`)、执行监管器 (`src/supervisor.ts`)、存储引擎 (`src/engine.ts`)、CLI 调度层 (`src/cli.ts`)、配置模式 (`src/schemas.ts`)
- **上游 ADR**: [ADR-0001: 跨宿主 SQLite WAL 总线](0001-cross-host-sqlite-wal-and-poll-model_zh.md)、[ADR-0003: GUI 沙箱与 CLI 分层](0003-gui-cli-hybrid-architecture_zh.md)、[ADR-0004: 审查与修改分离与 TOCTOU 缓冲](0004-review-mutation-separation-and-toctou-buffer_zh.md)
- **关联三方审查决议**: [Phase 3 三方异构多智能体架构评审与定稿决议](../audits/2026-10-24-phase-3-multi-agent-consensus-audit_zh.md)

---

## 1. 决策反转背景与核心动因 (Context & Reversal Motivation)

### 1.1 历史决策及其局限性
在 [ADR-0003 §3](0003-gui-cli-hybrid-architecture_zh.md) 中，FerryCat 曾明确**否决了无人值守的后台常驻守护进程与无交互盲目自动化**，主张“人类作为天然调度器（Human-as-Scheduler）与意图确认闸”。

这一历史决策在 v0.1~v0.2 阶段极具合理性：它阻止了团队陷入对黑盒 GUI 模拟按键与开放式 PTY 盲注的无意义探索，确立了以人工切窗口为前提的安全基线。然而，随着 FerryCat 被深度集成进真实开发工作流，三大新的生产级矛盾暴露：
1. **认知负荷与搬运工疲劳**：
   当审查已标准化为静态分析、测试回归与合规校验等确定性任务时，人类工程师每改几行代码就被迫在 2~3 个 IDE 窗口之间机械敲命令，丧失了深度心流；
2. **At-most-once 丢单隐患**：
   此前无心跳保活机制，耗时超过 `exec_ttl`（300s）的长任务在提交时直接被系统判死为 `TIMED_OUT`，耗费算力的推理日志全量蒸发；
3. **失控自由 Shell 的安全灾难**：
   如果为了省事直接在命令行开放裸 `--exec <arbitrary_command>` 常驻监听，一旦有恶意工单注入，将直接以宿主权限执行破坏性命令。

### 1.2 决策反转原则
我们决定**反转对后台常驻守护进程的否决**，但**绝不滑向无边界的自由聊天注入**。  
核心原则为：**“严格收敛执行载体，以无锁短事务 CAS 为底座，以严密进程树监管为防线”**。

---

## 2. 核心架构决策 (Architecture Decisions)

```
   ┌────────────────────────────────────────────────────────────┐
   │             人类技术主管 (Tech Lead / Human-in-the-Loop)   │
   │  - 声明 ferrycat.config.json（白名单脚本、配额、代理绑定） │
   │  - 监听终端高亮事件 / OS Toast 通知                        │
   │  - 行使最终代码审查裁决与 Commit & Push 批准权             │
   └─────────────────────────────┬──────────────────────────────┘
                                 │ 一键启动受控守护
                                 ▼
   ┌────────────────────────────────────────────────────────────┐
   │            FerryCat Daemon（受控常驻守护中枢）             │
   │  1. 短事务原子 CAS 租约竞争 (daemon_locks, expires_at)     │
   │  2. 严格绑定白名单 Handler (--exec-file, 禁用自由 shell)   │
   │  3. 多 Agent 队列分发与安全轮询                            │
   └─────────────────────────────┬──────────────────────────────┘
                                 │ 任务派发与状态持久化
                                 ▼
   ══════════════════════════════════════════════════════════════
               【SQLite WAL 底座: ~/.ferrycat/mesh.db】
     - contracts (严格 7 态有限状态机)
     - daemon_locks (原子微秒级 CAS 租约表，零全库锁)
   ══════════════════════════════════════════════════════════════
                                 │
                 ┌───────────────┴───────────────┐
                 ▼                               ▼
   ┌───────────────────────────┐   ┌───────────────────────────┐
   │ Supervised Child (Agent A)│   │ Supervised Child (Agent B)│
   │ - 独立进程组 (detached)   │   │ - 独立进程组 (detached)   │
   │ - 动态自动心跳保活 (CK-01)│   │ - 动态自动心跳保活 (CK-01)│
   │ - 环境变量白名单过滤(CK-06)│   │ - 环境变量白名单过滤(CK-06)│
   │ - 进程树级强杀灭活 (CK-04)│   │ - 进程树级强杀灭活 (CK-04)│
   │ - 超时残片打捞 (CK-07)    │   │ - 超时残片打捞 (CK-07)    │
   └───────────────────────────┘   └───────────────────────────┘
```

### 2.1 数据库锁模型：短事务 CAS 租约替代全库长事务
- **物理真相**：SQLite 没有行级锁。如果使用 `BEGIN IMMEDIATE` 长期持有长事务以防多实例并发，会导致写保留锁（RESERVED Lock）锁死整个数据库，外部所有 `dispatch`、`poll`、`extend` 均会超时崩溃，且阻塞 WAL 自动 Checkpoint 导致 `-wal` 膨胀失控。
- **裁决**：
  在数据库中创建独立的 `daemon_locks` 租约表。守护进程实例通过单条原子 UPSERT 抢占与续约，全过程在微秒级隐式短事务中完成，绝不持有长事务：
  ```sql
  CREATE TABLE IF NOT EXISTS daemon_locks (
    id TEXT PRIMARY KEY,             -- 'active_daemon' 或指定命名空间
    owner_token TEXT NOT NULL,       -- 守护进程实例 UUID
    heartbeat_at INTEGER NOT NULL,   -- 最近一次心跳时间戳 (ms)
    expires_at INTEGER NOT NULL,     -- 租约绝对过期时间 (ms)
    metadata_json TEXT               -- 宿主 PID、运行配置等元数据
  );

  -- 短事务 CAS 抢占与续约原子语句：
  INSERT INTO daemon_locks(id, owner_token, heartbeat_at, expires_at, metadata_json)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    owner_token = excluded.owner_token,
    heartbeat_at = excluded.heartbeat_at,
    expires_at = excluded.expires_at,
    metadata_json = excluded.metadata_json
  WHERE daemon_locks.expires_at < ? OR daemon_locks.owner_token = ?;
  ```
  - 当原持有者在心跳窗口内正常运行，其他试图启动的守护实例在 0 更改返回中识别到冲突，优雅退化为待命备机或直接退出；
  - 若原实例异常崩溃（死机/掉电），其租约在 `expires_at` 过去后自动失效，新实例无缝接管，全库读者与写者零阻塞。

### 2.2 执行安全收敛：`ferrycat.config.json` 强绑脚本 Handler
- **禁止自由 Shell**：守护进程在无人值守模式下，**默认严禁使用 `--exec <arbitrary_string>`**。
- **强绑定可信文件**：所有任务处理必须映射到预先声明的静态脚本文件（`.js`, `.ts`, `.ps1`, `.sh`），通过 `execFile` 直接执行，将注入面从任意 Shell 字符串收敛到受信配置与脚本文件（配置文件写入权限等价于宿主执行权限）。
- **配置文件形态 (`ferrycat.config.json`)**：
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

### 2.3 进程监督防线完整下沉 (继承 Phase 3 Step 0 成果)
守护进程在拉起任务脚本时，必须全量集成 Step 0 的成熟防护契约：
1. **自动心跳 keep-alive**：以 $\min(60\text{s}, \text{exec\_ttl} / 3)$ 动态向工单发送续约，彻底根绝 At-most-once 丢单（CK-01）；
2. **严格进程树清理**：POSIX 使用独立进程组 `kill(-pgid)`，Windows 使用 `taskkill /PID <pid> /T /F`，严禁通过裸数字 PID 操作，杜绝孙进程残留破坏后续工单 TOCTOU 指纹（CK-04, CK-05）；
3. **环境白名单沙箱**：自动剥离 `*_TOKEN/*_KEY`，但保留 `USERPROFILE/APPDATA/HOME`，防范凭证窃取同时消除“全员未登录”反向 DX 陷阱（CK-06）；
4. **残片自动打捞**：非正常退出或超时前，自动将已产生 stdout 截获写入 `salvaged_result_json`（CK-07）。

---

## 3. 架构收益与权衡对比 (Consequences & Trade-offs)

| 维度 | v0.1~v0.2 纯人工扳道模型 | 开放式盲目 Agent 自治 (如部分开源框架) | ADR-0005 受控契约守护中枢 (本次决策) |
| :--- | :--- | :--- | :--- |
| **操作负担** | 高（每次工单需手工切窗口执行命令） | 极低（但容易失控） | **极低**（后台自动化静默处理，人类仅终审把关） |
| **命令注入风险** | 低（由人工在终端手敲） | 极高（任意提示词可拼接 Shell 执行） | **零**（严格限制在静态配置的白名单脚本 Handler） |
| **数据库并发稳定性** | 高（纯短事务） | 极低（盲目挂常驻长事务导致锁死） | **极高**（无锁微秒级 CAS 租约，WAL 零膨胀） |
| **异常恢复与丢单** | 存在长任务超时丢产物缺陷 | 经常死锁跑飞，无产物捕获 | **强保障**（动态心跳 + 自动残片打捞 + 孙进程必杀） |

---

## 4. 实施计划 (Implementation Roadmap)

1. **Step 1.1**：在 [`src/engine.ts`](../../src/engine.ts) 中增加 `daemon_locks` 表与 CAS 抢占/续期原语；
2. **Step 1.2**：在 [`src/schemas.ts`](../../src/schemas.ts) 中定义 `FerryCatConfigSchema` 与配置解析器；
3. **Step 1.3**：实现 [`src/daemon.ts`](../../src/daemon.ts) 核心控制器，纳管多 Agent 队列与 `src/supervisor.ts` 进程调用；
4. **Step 1.4**：实现终端轻量事件输出与测试验证套件。
