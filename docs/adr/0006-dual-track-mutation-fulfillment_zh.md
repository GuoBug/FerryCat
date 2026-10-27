# ADR-0006: 读写双轨 TOCTOU 语义与变更型任务双哈希交单存证协议

- **状态**: Accepted（针对变更型任务修订 [ADR-0004](0004-review-mutation-separation-and-toctou-buffer_zh.md)）
- **日期**: 2026-10-27
- **作者**: Guo Qiang (GuoBug), Antigravity Engine, WorkBuddy Multi-Model Team
- **上下文**: `fc_1793100801409_4eedf544` 实战交单死锁（`UNFULFILLABLE_BY_DESIGN`）与 `fc_1793103161311_aa71d377` 交叉审计决议

---

## 1. 背景与问题定义

在 [ADR-0004](0004-review-mutation-separation-and-toctou-buffer_zh.md) 中，FerryCat 为防止审查者在 `code_review` / `architecture_audit` 期间误改源码，在 `fulfill_contract` 阶段对所有任务类型统一执行了严格不可变基线校验（`verifyAllPointers`）。

然而在派发 `fc_1793100801409_4eedf544`（`task_type: 'implementation'`，委托 `workbuddy` 实现 `FC-403`）时，暴露了变更型任务的生命周期悖论：
1. `pointers` 锁定了 `workbuddy` 必须修改的目标文件（`src/daemon.ts`、`src/schemas.ts`、`test/run-all.ts` 等）；
2. 当 `workbuddy` 完成代码编写并尝试调用 `fulfill_contract` 交单时，`verifyAllPointers` 因文件字节变化直接触发 `TOCTOU_SIZE_MISMATCH` 拦截；
3. `workbuddy` 被迫调用 `release_contract` 退单并标记 `UNFULFILLABLE_BY_DESIGN`。

---

## 2. 核心架构决策：按任务类型分流的双轨 TOCTOU 与双哈希审计链

我们将 `fulfill_contract` 与 `verify_contract` 的校验语义按 `task_type` 拆分为两条确定性轨道：

### 轨道 A：只读审查任务（`code_review` | `architecture_audit`）
- **认领期（`poll_next_task`）**：`pointers` 必须与派单基线 SHA-256 完全一致。
- **交单期（`fulfill_contract`）**：严格执行 `verifyAllPointers` 不可变校验；任何磁盘修改触发 ADR-0004 Strike 1 (`RETRY_NEEDED`) $\to$ Strike 2 (`POINTER_STALE`)。
- **预检与复核（`verify_contract`）**：始终以 `pointers` 初始不可变基线为准。

### 轨道 B：变更生成任务（`implementation` | `test_generation`）
- **认领期（`poll_next_task`）**：`pointers` 必须与派单前基线 SHA-256 完全一致，确保执行方从干净的工作区基线起步。
- **交单期（`fulfill_contract` / `verifyAndSnapshotMutationPointers`）**：
  - **坚守安全与存在性硬边界**：`SECURITY_REJECTED`（路径逃逸、敏感文件黑名单、软链越界）与 `FILE_MISSING`（误删 pointer 目标文件，或在 `artifacts_pointers` 中声明了磁盘上不存在的幽灵产物）依然作为硬失败阻断交单并触发 TOCTOU 计数；
  - **放行合法变更并重算产物哈希**：允许 `SIZE_MISMATCH` 与 `CONTENT_CHANGED`，引擎实时计算所有 `pointers` 文件及 `artifacts_pointers` 新增文件的**修改后全文件 SHA-256**，写入 `verified_sha256_json`；
  - **双 SHA-256 加密审计链**：
    - `pointers_json` 永久保留**修改前输入基线 SHA-256（Pre-Mutation Baseline）**；
    - `verified_sha256_json` 永久记录**修改后交付产物 SHA-256（Post-Mutation Deliverable）**；
  - **零变更告警（No-Op Warning）**：若变更型任务交单时既未修改任何 pointer 文件也未新增任何 artifact 文件，允许交单并在返回 `message` 中附带 `WARNING: no-op fulfillment` 审计提示。
- **状态感知预检与事后审计（`verify_contract`）**：
  - `SUBMITTED` 状态：对比認领前 `pointers` 初始基线；
  - `CLAIMED` 状态：执行 `verifyAndSnapshotMutationPointers`，只要安全与文件存在性通过即返回 `valid: true, fulfillable: true`，并在 `dirty_files` 中列出已修改文件明细；
  - `COMPLETED` 状态：执行 `verifyCommittedMutationSnapshot`，以落库的 `verified_sha256_json` 交付快照作为基准进行校验（磁盘文件与交付快照一致则返回 `valid: true, fulfillable: false`；若交单后文件再次被篡改则精准报错）。

---

## 3. 代价与边界说明

- **共享工作区并发写边界**：由于变更型任务直接在 `workspace_root` 原地修改文件，若同时派发两张涉及重叠文件的 `implementation` 契约，后认领的契约会在认领期因前一张契约修改了基线而被判为 `POINTER_STALE`。涉及同一批文件的变更型契约应串行派发或配合 Git Worktree 隔离。
