# ADR-0002: 全文件 SHA-256 指纹防盲审、TOCTOU 闭合与跨宿主三模型实测记录

<p align="center">
  <a href="0002-fingerprint-toctou-and-cross-model-audit.md">English</a> •
  <b>中文</b>
</p>

- **状态**: Accepted (已通过)
- **日期**: 2026-10-22
- **决策人**: 郭强 (Guo Qiang)
- **涉及模块**: 指纹校验器 (`src/fingerprint.ts`)、Schema 校验器 (`src/schema-validator.ts`)、契约引擎 (`src/engine.ts`)

---

## 1. 背景与问题定义 (Context)

FerryCat 采用“大载荷指针化（Context Offloading by Reference）”传递代码上下文：发起方仅传递 `workspace_root` 与文件相对路径 `pointers`，由接收方 Agent 就地读取本地磁盘文件。

但“按引用传递”存在三个致命的一致性风险：
1. **局部哈希歧义**：若仅对文件头部字节计算哈希，当文件中间或尾部代码被修改且总字节数不变时，指纹将发生漏检；
2. **IDE 未保存缓冲区（Dirty Buffer）**：发起方 LLM 刚修改了代码但尚未落盘，此时 `dispatch_contract` 读到的是旧文件，接收方读到的也是旧文件，指纹虽匹配但审查对象错误；
3. **领单与交单之间的 TOCTOU（Time-of-Check to Time-of-Use）窗口**：若仅在 `poll_next_task` 领单时校验一次指纹，而在接收方阅读分析代码的数分钟内文件被修改，最终提交的结论将与磁盘当前状态脱节。

---

## 2. 决策与防护机制 (Decision Outcome)

### 2.1 全文件 SHA-256 与快速失败校验序列
在 [`src/fingerprint.ts`](../../src/fingerprint.ts) 中严格定义 `FileFingerprint`，对**整个文件全文**计算 64 位十六进制 SHA-256，按以下顺序校验：
1. **双端安全黑名单复核**：派单侧与 Worker 侧均执行 `assertSafePointerPath`，拦截 `.env*`、`*.pem`、`id_rsa*` 及 `..` 目录越界；
2. **存在性检查**：文件缺失直接返回 `FILE_MISSING`；
3. **字节数快速短路**：`stat.size !== fp.size` 直接返回 `SIZE_MISMATCH`；
4. **全文件 SHA-256 比对**：不一致则在等待 `150ms` 后复核一次（排除 IDE 瞬态保存），仍不一致则判定 `CONTENT_CHANGED` 并置为终态 `POINTER_STALE`。
5. **不以 `mtime_ms` 判死刑**：IDE 格式化或无变更保存会更新 `mtime_ms`，只要全文件 `sha256` 一致即视为有效。

### 2.2 首末行快照与 3 秒修改告警（防 Dirty Buffer）
`dispatch_contract` 返回实际从磁盘读到的非空首行 `first_line` 与末行 `last_line`，并检查 `line_range` 是否越界。若 `Date.now() - mtime_ms < 3000`，附带 `warning` 提示发起方核对首末行，确认 IDE 缓冲区已落盘。

### 2.3 交单阶段二次指纹校验（闭合 TOCTOU 窗口）
在 `fulfill_contract` 写入 `COMPLETED` 之前，再次调用 `verifySingleRun`。若审查期间目标文件被篡改，拒绝交单并将状态流转至 `POINTER_STALE`（记录 `TOCTOU_CONTENT_CHANGED`）。

---

## 3. 跨宿主三模型真实互审验证记录 (Empirical Verification)

在 v0.1 核心引擎实现后，通过 FerryCat 将代码走查工单从 **Antigravity** 派发至 **WorkBuddy** 搭载的 3 个不同模型（`Deepseek-V4.1-Flash`、`Step-5-Preview`、`Hy3`）执行实测。原始 SQLite 轨迹存档于 [`docs/real-mesh-trajectory.json`](../real-mesh-trajectory.json)：

| 工单 ID (`contract_id`) | 接收方 (`target_agent`) | 审查范围 (`pointers`) | 状态流转 | 执行耗时 | 实测发现并已合入的工程问题 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `fc_1792681532295_a7c57f16` | `workbuddy` (`Deepseek-V4.1-Flash`) | `src/engine.ts`<br>`src/fingerprint.ts` | `SUBMITTED` $\to$ `CLAIMED` $\to$ `COMPLETED` | `241.5s` | 1. **TOCTOU 窗口闭合**：在 `fulfillContract` 交单时二次执行 `verifySingleRun`；<br>2. **Worker 侧黑名单复核**：`verifySingleRun` 内复调 `assertSafePointerPath`；<br>3. **Claim 异常兜底**：领单后文件校验异常自动置为 `POINTER_STALE`，防止工单永久卡死在 `CLAIMED`；<br>4. **`line_range` 行数越界校验**：派单时校验 `line_range` 不超过文件实际总行数。 |
| `fc_1792681532323_cf6f9d99` | `workbuddy-step5` (`Step-5-Preview`) | `src/schema-validator.ts`<br>`src/engine.ts` | `SUBMITTED` $\to$ `CLAIMED` $\to$ `COMPLETED` | `354.1s` | 1. **`Array.isArray` 拦截**：修复 JS 中 `typeof [] === 'object'` 绕过前置对象检查；<br>2. **Ajv 编译缓存**：按序列化 Schema 字符串缓存编译函数；<br>3. **并发状态守卫**：`fulfill` 所有分支的 `UPDATE` 均追加 `AND status = 'CLAIMED'` 与 `Number(changes) === 1` 校验。 |
| `fc_1792681532336_31d1b6e4` | `workbuddy-hy3` (`Hy3`) | `src/index.ts`<br>`src/cli.ts` | `SUBMITTED` $\to$ `CLAIMED` $\to$ `COMPLETED` | `463.6s` | 1. **MCP 与 CLI 共享 Zod 契约**：抽取 [`src/schemas.ts`](../../src/schemas.ts)，杜绝 CLI 入口绕过参数边界约束；<br>2. **上界与缺省值防御**：为 `pointers` 数组（上限 50）与长文本设上界，CLI 缺值或非整数参数立即报错退出。 |
