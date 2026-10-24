# FerryCat 专栏“1 + 6”体系规划底册 (Series Roadmap & Editorial Index)

> 本底册作为后续《FerryCat 契约编排中枢演进》系列文章生产、架构映射与技术点串联的持久化参考索引。  
> 核心定位：**Product Engineer 视角下的 AI 工作流编排、确定性系统架构与多智能体实战协作**。

---

## 一、 专栏全局总览与篇目映射

| 序号 | 专栏篇目 | 角色隐喻（主管视点） | 核心工程与架构实体 | 对应源码 / ADR / 检查点 |
| :---: | :--- | :--- | :--- | :--- |
| **00** | **《如何像主管一样组织 Agent 协作：FerryCat 契约编排中枢的演进之路》** *(当前总篇)* | **会议主持与议席主席**：从人肉传话筒到研发主管，掌控议程与终审裁决 | **AI 工作流编排**、**确定性工作流**、**DAG 状态机**、三方智能体辩论推演 | `docs/audits/2026-10-24-phase-3-multi-agent-consensus-audit_zh.md` |
| **01** | **《不开重型云服务：为什么我们用 SQLite WAL 极简搭建无锁 Agent 协作底座？》** | **极简会议室搭建**：免配置、无端口冲突、断网可用 | SQLite WAL、单文件总线、`daemon_locks`、短事务 CAS 租约替代行级锁 | `src/engine.ts` (WAL 配置、CAS UPSERT), ADR-0001, ADR-0005 |
| **02** | **《严禁拿旧资料开会：全文件 SHA-256 指纹与 ADR-0004 缓冲，彻底杜绝 Agent 脏读写》** | **参会材料基线校准**：防范下属拿着未存盘旧代码“一本正经胡说八道” | 全文件 SHA-256、首尾行指纹、TOCTOU 防御、ADR-0004 1 击软失败缓冲 | `src/fingerprint.ts`, `src/engine.ts` (verifyAllPointers, strike buffer), ADR-0004 |
| **03** | **《多个下属并发抢单怎么办？基于 UUID 独占租约令牌的无锁并发治理》** | **抢麦发言防撞车**：多 Worker 并发抢单不打架、不冒充、不串单 | UUID 独占租约令牌 (`claim_token`)、无锁乐观锁、同 Agent 多实例隔离 | `src/engine.ts` (pollNextTask CAS, loadClaimedContractForHolder), FC-301 |
| **04** | **《防范员工开会开到失联：At-most-once 隐性 P0 与自动心跳 / 超时残片打捞机制》** | **任务开小差看门狗**：长任务超时不再直接蒸发，自动续期并强保产物 | 自动心跳保活 (Heartbeat Keep-Alive)、At-most-once 丢产物修复、`recordSalvage`、`salvaged_result_json` | `src/supervisor.ts` (executeTaskAndFulfill, tick), `src/engine.ts`, CK-01, CK-02, CK-07 |
| **05** | **《散会必须离场：跨平台孙进程树递归清理，杜绝散会后孤儿暗箱操作》** | **会场秩序与散会清理**：防范后台孤儿进程继续暗中修改源码污染下次评审 | 进程树递归终止 (`taskkill /T /F` vs POSIX Process Group)、`SupervisedChild` 句柄强引用防裸 PID 误杀 | `src/supervisor.ts` (terminateProcessTree, terminateActiveChildrenSync), CK-04, CK-05 |
| **06** | **《别让员工顺走公司密钥：环境变量沙箱陷阱与测试库气密性极限排雷》** | **员工背调与工位隔离**：防泄露又保留登录态，避免测试污染生产总线 | 环境变量白名单反向陷阱、敏感 Token 剔除与凭证目录保留、Hermetic 测试隔离与生产库防泄漏 | `src/supervisor.ts` (buildChildEnv), `test/run-all.ts` (Test 13 气密性隔离), CK-06, CK-08 |

---

## 二、 关键写作规范与特色贯穿

1. **三方智能体真实对抗素材融入**：
   - 每篇必须按主题调用 Antigravity $\leftrightarrow$ ChatGPT $\leftrightarrow$ WorkBuddy 真实流转的 4 轮契约工单与审查批注（如 ChatGPT 论述长事务瘫痪全库被 WorkBuddy 纠偏、WorkBuddy 连续两次打回 Windows 假全绿并抓出生产库泄漏等）。
2. **Product Engineer 务实双轨哲学**：
   - 学习研究模式：极致严谨，求真不糊弄（深入 SQLite 锁本质与 libuv 进程句柄）；
   - 生产落地模式：敏捷务实，小步快跑，不陷入过度设计。
3. **排版与去 AI 味红线**：
   - 全篇加粗控制在 $\le 10$ 处；
   - 反转句式“不是…而是…”最多 1 处；
   - 破折号每个自然段 $\le 1$ 处；
   - 坚决杜绝“赋能/闭环/抓手/颗粒度/护城河”等空话。
