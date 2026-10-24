# Phase 3（主动唤醒与常驻守护引擎）—— 三方异构多智能体架构评审与定稿决议

- **审查对象**：FerryCat Phase 3（主动唤醒、常驻守护与智能体路由执行系统）
- **参与智能体**：Google Antigravity（发起方/实现方）、OpenAI ChatGPT（外部审查者）、WorkBuddy（对端审查者）
- **流转总线**：FerryCat 本地 SQLite WAL 工单总线（基于真实跨进程工单派发与校验）
- **日期**：2026-10-24
- **最终签署裁决**：`APPROVED`（WorkBuddy 有条件签署，生效条件为 Step 0 的 9 项准入检查合并前全绿）

---

## 0. 执行摘要与三方评审流转演进

围绕 Phase 3“从被动人工切换走向主动守护编排”，三方智能体在单机桌面环境下通过 FerryCat 工单总线展开了共计 4 轮白盒级技术推演，形成了全闭环共识：

| 轮次 | 契约工单 ID | 调度链路 | 裁决结论 | 核心贡献与演进推力 |
| :--- | :--- | :--- | :---: | :--- |
| **Round 1** | `fc_1792844563090_59f32f3b` | `antigravity` → `chatgpt` | `CHANGES_REQUESTED` | **确立安全防线**：定性 Phase 3 为“本地代码执行与进程监督边界”，指出并发重复拉起、命令注入、进程树逃逸、PID 锁脆弱等 5 大宏观系统风险。 |
| **Round 2** | `fc_1792845046153_d4a59f0f` | `antigravity` → `workbuddy` | `CHANGES_REQUESTED` | **源码级纠偏与真因定位**：证明单单不可能重复拉起（CAS 保障）；直击现网 300s 缺失心跳导致 At-most-once 丢产物的隐性 P0；揭露全量 `childEnv` 既有泄露缺陷与孤儿进程污染下个工单 TOCTOU 的恶果；提出 ADR-0003 决策反转需立 ADR-0005。 |
| **Round 3** | `fc_1792845845746_8633fd47` | `antigravity` → `chatgpt` | `CHANGES_REQUESTED` | **底层数据库锁机制致命纠偏**：指出 SQLite 根本无行级锁，否定 `BEGIN IMMEDIATE` 常驻长事务（会阻塞全部写者并膨胀 -wal），确立基于 `daemon_locks` 的短事务 CAS 租约模型。 |
| **Round 4** | `fc_1792846232697_b951b411` | `antigravity` → `workbuddy` | **`APPROVED`** | **终审签字与 Step 0 准入规约**：认错并收敛锁表述，纠偏 ChatGPT“瘫痪全库”夸大；提炼出环境白名单反向陷阱（保护 CLI 登录态）与 9 项严密的 Step 0 开工准入检查项。 |

---

## 1. 核心理论与机制共识（合流结论）

### 1.1 执行模型风险纠偏：At-most-once 丢产物 vs 重复拉起
- **代码事实**：工单抢占基于 `engine.ts:342-372` 的严密 CAS（`status = 'SUBMITTED' AND ... changes === 1`），且 Worker 执行循环为串行 `await`，在未发生 release 前单实例不可能并发 spawn。
- **真正隐患**：现网 `worker --exec` 执行期间**完全缺失心跳机制**，`implementation` 默认 `exec_ttl` 仅 300s。一旦大型构建/审查脚本运行超过 5 分钟，在提交时被 `expireIfExecTtlElapsed` 判为 `TIMED_OUT`，且由于 `TIMED_OUT` 路径缺失 `salvaged_result_json` 兜底，**耗费数分钟的宝贵模型执行结果被无情蒸发丢弃**。
- **裁决**：Step 0 首要任务是为 Worker 执行链路补齐自动心跳保活与超时产物抢救通道。

### 1.2 锁原语纠偏：短事务 CAS 租约表 vs 数据库级长事务
- **锁机制真相**：SQLite 不存在行级锁，`BEGIN IMMEDIATE` 取得的是整库的写保留锁（RESERVED Lock）。长事务虽不影响 WAL 下的纯读者（`SELECT`），但会阻塞后续所有写者（`dispatch`、`poll`、`fulfill`、`extend` 均要等待 `busy_timeout=5000` 甚至超时报错），并彻底阻止 WAL 自动 Checkpoint，导致 `-wal` 文件无限暴增。
- **裁决**：守护进程单实例互斥绝不持有长事务，采用独立的 `daemon_locks` 租约行，通过单条无锁/隐式微事务的原子 UPSERT 实现 CAS 租约接管：
  ```sql
  INSERT INTO daemon_locks(id, owner_token, heartbeat, expires_at)
  VALUES ('active_daemon', ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    owner_token = excluded.owner_token,
    heartbeat = excluded.heartbeat,
    expires_at = excluded.expires_at
  WHERE daemon_locks.expires_at < ?;
  ```

### 1.3 跨平台进程树清理：防范孤儿跨工单污染 TOCTOU 基线
- **链式破坏反应**：`spawnExecTarget` 超时若只杀父级，存活的孙进程（如真正的 `codex` / `node` 脚本）会继续后台修改磁盘源码，导致**后续工单的持单者在履行时撞上错误的 `POINTER_STALE` 软失败/熔断**。
- **裁决**：
  - **Unix**：开启 `detached: true` 挂载独立进程组，执行 `process.kill(-pid, 'SIGTERM')`，超时未退升级为 `SIGKILL`；
  - **Windows**：调用系统级进程树强制终止 `taskkill /T /F /PID`，并等待确认进程树彻底退净，方可允许新任务介入。

### 1.4 环境变量沙箱：防范令牌泄漏与避开“全员未登录”反向陷阱
- **既有漏洞**：当前 `childEnv = { ...process.env, FERRYCAT_* }` 盲目全继承，导致子进程可随意窃取宿主 `NPM_TOKEN`、`AWS_*`、`GITHUB_*` 等敏感令牌。
- **反向陷阱**：若仅保留 `PATH / SystemRoot / TEMP`，下游 CLI（`codex`、`claude-code`、`agy`）将无法定位用户主目录，读取不到 `~/.config` 或 `%APPDATA%` 中的授权凭据，引发“全员未登录”的致命 DX 事故。
- **裁决**：采用严谨的平台最小环境子集：
  - **Windows**：`PATH`, `SystemRoot`, `SystemDrive`, `TEMP`, `TMP`, `COMSPEC`, `PATHEXT`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`；
  - **POSIX**：`PATH`, `HOME`, `TMPDIR`, `LANG`, `SHELL`；
  - **黑名单剔除**：显式剥离所有匹配 `*_TOKEN`, `*_KEY`, `*_SECRET`, `AWS_*`, `GITHUB_*`, `NPM_*`, `OPENAI_*`, `ANTHROPIC_*`；
  - **专有注入**：安全透传 `FERRYCAT_*`。

### 1.5 架构口径一致性：决策反转与 ADR-0005
- **背景矛盾**：`README_zh.md:131` 与 `ADR-0003 §3` 曾明确否决无人值守守护态，主张人工窗口切换。
- **裁决**：在 Step 1 必须正式撰写发布 `docs/adr/0005-controlled-daemon-and-process-supervision_zh.md`，阐明适用边界的收窄逻辑（守护进程驱动的是“受控无交互脚本 Handler”，而非“通用交互式 CLI 聊天”），并与 README 改写同 PR 合入。

---

## 2. Step 0 实施准入检查清单 (Gate Checkpoints)

WorkBuddy 签署生效的硬性条件为以下 9 项准入检查在 Step 0 全部交付通过：

- [ ] **CK-01（心跳周期计算）**：心跳定时器取 $\min(60\text{s}, \text{exec\_ttl} / 3)$，首次心跳触发不晚于认领后 $\text{exec\_ttl} / 3$。测试构造：$\text{exec\_ttl}=30\text{s}$、心跳 $10\text{s}$、运行 $120\text{s}$ 仍保持 `CLAIMED` 并在结束时正常 `COMPLETED`。
- [ ] **CK-02（心跳双向生命期绑定）**：
  - 正向：子进程自然退出或异常崩溃时，立刻销毁心跳定时器；
  - 反向：心跳调用返回 `ok: false`（续期满 5 次上限或达到绝对生命期截止）时，立即强杀子进程树，防止产生脱缰孤儿。
- [ ] **CK-03（乐观锁并发心跳异常捕获）**：捕获 `extendTtl` 内部 `changes !== 1` 抛出的 `Concurrent state change detected` 异常并重新重读工单行状态，严禁向上抛出导致 Worker 主进程被自身心跳崩溃。
- [ ] **CK-04（孙进程级树状强杀）**：Unix 开启 `detached: true` 并通过 `process.kill(-pid)` 清理进程组；Windows 采用 `taskkill /T /F /PID`。单测验证：构造 `worker → cmd → node → 孙进程` 链路，断言孙进程在 5 秒内彻底消失。
- [ ] **CK-05（PID 复用防误杀验证）**：记录 `pid` 及启动时间戳，在清理前进行存活与启动时间双重确认，防止系统 PID 循环复用造成误杀无关进程。
- [ ] **CK-06（平台最小环境白名单落地）**：仅在 `cli.ts:568` 的 `childEnv` 处单点应用白名单，断言子进程环境无任何 `*_TOKEN/*_KEY`，且 `USERPROFILE/HOME` 正常保留。
- [ ] **CK-07（超时产物兜底 Salvage）**：若任务耗尽心跳触达超时终态，在触发 `TIMED_OUT` 前尽可能抓取子进程已产生的 stdout 落入 `salvaged_result_json`，消除超时产物彻底蒸发的缺陷。
- [ ] **CK-08（长任务与超时用例入网 CI）**：将超长任务心跳维持用例加入 `test/run-all.ts` 并集成至 GitHub Actions CI，形成长期防劣化回归红线。
- [ ] **CK-09（状态机边界不扩散）**：Step 0 严格保持现有 6 态状态机（`SUBMITTED, CLAIMED, COMPLETED, POINTER_STALE, VALIDATION_FAILED, TIMED_OUT`）及其转移规则不变，不引入任何未裁决的新状态。

---

## 3. 总体推进甘特路线 (Three-Step Evolution)

```
[今日推进] Step 0: 核心执行层排雷与心跳保活
  ├── 实施自动心跳 (cli.ts)
  ├── 实施环境变量白名单沙箱 (cli.ts)
  ├── 实施跨平台进程树清理 (cli.ts)
  └── 编写 Test 13 全量单测验证 9 项准入项全绿

[后续规划] Step 1: 规范反转、安全配置与短事务观察者 Daemon
  ├── 撰写发布 ADR-0005 与同步修订 README
  ├── 设计 ferrycat.config.json（严格绑定 --exec-file，禁用自由 shell）
  ├── 实现 daemon_locks 短事务 CAS 租约与生命周期管理
  └── 实现终端与桌面 Toast 状态观察通知（Best-effort 观测面）

[演进闭环] Step 2: 进程调度器、预写日志与故障自愈
  ├── 实现 daemon-journal.jsonl 崩溃前预写与孤儿清理
  ├── 实施受控自动路由与批量拉起
  └── 补齐跨平台故障注入测试矩阵，发布 v0.4.0 / v0.5.0
```

---

> **三方签署确认**：  
> - **发起方**：Google Antigravity (`antigravity`) —— 确认方案架构与执行规划。  
> - **第一审查者**：OpenAI ChatGPT (`chatgpt`) —— 确认安全边界与短事务 CAS 租约修正。  
> - **第二审查者**：WorkBuddy (`workbuddy`) —— `APPROVED` 签署生效，以 Step 0 九大准入项为交付依据。
