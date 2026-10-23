# Phase A 交叉审查报告（Tiered TTL / release / extend / fail）

- **工单**：`fc_1792754417178_48cca09f`（antigravity → workbuddy，`architecture_audit`）
- **审查对象**：commit `81b3d57` — `feat(lifecycle): deliver Phase A with tiered TTL, release_contract, extend_ttl, fail_contract, and safe re-queuing`
- **审查基线**：`81b3d57`（含前置 `1ca81fc`、`2960383`）
- **审查方式**：全量白盒读码（`src/engine.ts` 883 行、`src/cli.ts`、`src/schemas.ts`、`src/types.ts`、`src/index.ts`）+ 独立探针脚本实测（Node 22.12.0 / Windows）
- **审查时间**：2026-10-23

---

## 结论摘要

| 级别 | 数量 | 说明 |
|---|---|---|
| **P0（建议发版前修）** | 1 | `release` 重置 `retry_count`，使熔断预算可被成倍放大 |
| **P1（语义与宣称不符）** | 2 | `extend` 的生命期上限可被单次续期直接越过；`LIFETIME` 上限未覆盖 `release` 路径 |
| **P2（健壮性/体验）** | 4 | CLI 参数缺陷 2 条、`error_reason` 被 release 覆盖、索引排序残余成本 |
| **P3（记录）** | 3 | 版本号、MCP server 版本硬编码、文档未同步 |

**总体判断：Phase A 的状态机骨架是扎实的**——跨实例并发守卫、乐观锁计数比对、终态互斥、exec 失败闭环、旧库平滑迁移、分级 TTL 落库，**逐条实测通过，没有找到死锁**。问题集中在"**预算类计数器可以被重置**"和"**上限只挡住下一次调用、不挡住当前结果**"这两个模式上。

测试套件 `ALL 10 TEST SUITES PASSED GREEN`（含新增 Test 9 / Test 10），但 **9C 的断言存在覆盖空洞**，见 P1-1。

---

## P0-1 `release_contract` 重置 `retry_count`，熔断预算可被成倍放大

**位置**：`src/engine.ts:642-654`

```sql
UPDATE contracts
   SET status = 'SUBMITTED',
       claimed_at = NULL,
       queued_at = ?,
       retry_count = 0,          -- ← 归零
       extend_count = 0,
       release_count = release_count + 1,
```

**问题**：`retry_count` 的语义是"**这张工单总共被拒几次**"，属于**工单级**预算；而 `release_count` 也是工单级的。把工单级预算挂在"当前持有者"的 persona 下清零，等于让 `max_retries` 变成了"**每任持有者的重试额度**"。

**实测**（`max_retries=2`，理论上限 3 次失败即终态）：

```
cycle1 retry#1 -> RETRY_NEEDED count=1
cycle1 retry#2 -> RETRY_NEEDED count=2
cycle2 retry#3 -> RETRY_NEEDED count=1     ← 清零后重来
cycle2 retry#4 -> RETRY_NEEDED count=2
cycle3 retry#5 -> RETRY_NEEDED count=1
cycle3 retry#6 -> RETRY_NEEDED count=2

总重试次数 6（MAX_RELEASES=3 → 上限 3×3=9 次），绕过=true
```

**影响**：一个持续产出不合规 `structured_output` 的 worker，可以通过 `release` 把熔断从 3 次抬到 9 次。每一次都是一个完整的子进程执行周期——对 `implementation` 类任务意味着最多 **9 × 300s = 45 分钟**的无效算力消耗，且 requester 侧看到的 `retry_count` 永远在 1~2 之间跳动，**仪表盘上看不出异常**。

**修复建议**（三选一，推荐第一种）：

1. **拆分两个计数器**：`retry_count`（工单级，永不重置）+ `holder_retry_count`（持有者级，release 时归零）。熔断判定用前者，提示文案用后者。
2. 保留单计数器但 **release 不归零**，仅重置 `extend_count`。代价是"前一任的失败会连累下一任"，但这本来就应该由 requester 决定（re-dispatch 才是彻底重来的语义）。
3. `release` 时把 `retry_count` 折半而不是归零，做温和衰减。

**顺带一处**：`release` 同样把 `extend_count` 归零。这条**是对的**（新持有者应有完整心跳额度），但应与 `retry_count` 的处理分开决策，当前代码把两者捆绑在一起改，掩盖了语义差异。

---

## P1-1 `extend_ttl` 的生命期上限只挡"下一次"，不挡"这一次"的结果

**位置**：`src/engine.ts:708-738`

```ts
const lifetimeDeadline = row.created_at + LIFETIME_QUEUE_TTL_MULTIPLIER * row.queue_ttl_sec * 1000;
if (nowMs >= lifetimeDeadline) { return { ok: false, ... } }   // 只判断"现在"是否已过上限

this.db.prepare(`UPDATE contracts SET claimed_at = ?, extend_count = extend_count + 1 ...`)
  .run(nowMs, ...);

const expiresAt = nowMs + row.exec_ttl_sec * 1000;              // 新窗口可能远超上限
```

**问题**：判定条件只问「**nowMs** 是否越过上限」，没有约束「**续期后的 expires_at** 是否越过上限」。一旦 `exec_ttl_sec` 本身大于剩余生命期，续期成功反而把工单送到了上限之外。

**实测**：

| 场景 | 生命期上限 | extend 返回 | 续期后窗口到期 | 越界幅度 |
|---|---|---|---|---|
| `queue_ttl=60`, `exec_ttl=1800` | +240s | `ok: true` | +2000s | **1760s** |
| 默认 `code_review`（1800/1800），打满 5 次 | +7210s | 第 5 次 `ok: false` 但前次已生效 | +8610s | **1400s** |

**在默认配置下就会越界**——不需要用户手动配奇怪参数。`code_review` 的 `exec_ttl` 是 1800s，`LIFETIME` 上限是 `4 × 1800s = 7200s`= 恰好 4 个完整窗口；理论上第 4 次续期就该被拒，但因为判定用的是"发起续期的时刻"而非"窗口到期的时刻"，**第 4 次续期在 +5100s 发起时 judged OK，窗口直接推到 +6900s，第 5 次在 +6800s 发起时再推到 +8600s**，越过 7200s。

**这也是 9C 测试的覆盖空洞**：`test/run-all.ts:921-928` 只断言了
- `t0+200s` 的 extend 成功
- `t0+250s` 的 extend 被拒（此时 nowMs 已 > 240s 上限）

它**没有断言** `t0+200s` 那次 extend 产生的 `expires_at ≤ lifetimeDeadline`。所以"lifetime cap enforced"这句 PASS 文案只证明了上限能挡住**下一次调用**，没证明它能约束**当前这次**的结果。

**修复建议**：

```ts
const lifetimeDeadline = row.created_at + LIFETIME_QUEUE_TTL_MULTIPLIER * row.queue_ttl_sec * 1000;
if (nowMs >= lifetimeDeadline) { /* 拒绝，同现状 */ }

const proposedExpiresAt = nowMs + row.exec_ttl_sec * 1000;
if (proposedExpiresAt > lifetimeDeadline) {
  // 二选一：
  // (a) 拒绝：语义清晰，但会让长 exec_ttl + 短 queue_ttl 的组合直接不可用
  // (b) 钳制：claimed_at = lifetimeDeadline - exec_ttl_sec * 1000，并在 message 里说明被截断
  return { ok: false, status: 'CLAIMED', expires_at: currentExpiresAt,
           message: `... renewal would push the window to ${...}, beyond the absolute lifetime cap ${...}` };
}
```

倾向 **(a) 拒绝**：`extend_ttl` 的本意就是"我还需要更多时间"，悄悄截断一个更短的窗口对调用方是更坏的意外。

**附带建议**：`LIFETIME_QUEUE_TTL_MULTIPLIER = 4` 这个名字强调 `queue_ttl`，但实际约束的是**整个 CLAIMED 生命周期**。改名 `LIFETIME_QUEUE_TTL_MULTIPLIER` → `LIFETIME_QUEUE_TTL_MULTIPLIER` 可能已是笔误，建议改为 `MAX_LIFETIME_QUEUE_WINDOWS` 或直接在注释里明确"以 queue_ttl 为标尺量总生命期"这个反直觉的耦合关系。**一个以 `queue_ttl`（排队时长）为标尺去限制 `exec_ttl`（执行时长）的设计，本身就容易让调用方误判**，值得在 README 里显式写一段换算表。

---

## P1-2 `LIFETIME` 上限完全不覆盖 `release` 路径

**位置**：`src/engine.ts:610-671`（`releaseContract` 全文无 `lifetimeDeadline` 引用）

`release` 会刷新 `queued_at`、清零各种计数、并且**不受生命期上限约束**。实测（`queue_ttl=60`，上限 +240s）：

```
轮1: at +15s release.ok=true -> queued_at +15s 状态=SUBMITTED
轮2: at +30s release.ok=true -> queued_at +30s 状态=SUBMITTED
轮3: at +45s release.ok=true -> queued_at +45s 状态=SUBMITTED
```

三次全部成功。`MAX_RELEASES=3` 挡住了继续释放，但问题在于：**`release` 是把工单"退回队列"，而队列的过期判定用的是 `queued_at + queue_ttl_sec`**。如果 `queue_ttl_sec` 被设得很短（比如 60s），而工单在接近生命期上限时被 release，那么它在队列里**还会再活一整个 `queue_ttl_sec`**，越过 `created_at + 4×queue_ttl`。

**影响的严重性低于 P1-1**（总量有界，最多多活一个 `queue_ttl`），但它说明**同一份"生命期"概念在两个代码路径上实现了两套逻辑，一套有上限、一套没有**。建议把生命期判定抽成私方法 `isBeyondLifetime(row, nowMs)`，在 `release` / `extend` / `fulfill` 三处统一调用，避免下一轮再加新路径时又漏一处。

---

## P2-1 CLI 位置参数与 flag 互斥，`dispatch --agent x '{...}'` 直接崩

**位置**：`src/cli.ts:24-27`

```ts
if (rest.length === 1 && !rest[0].startsWith('--')) {
  return { command, data: JSON.parse(rest[0]) };
}
```

只有**恰好一个**位置参数时才按 JSON 解析。一旦加上 `--agent`（scenario 下几乎必然要加），`rest` 变成两个元素，位置参数落进第二遍 flag 解析循环，命中 `throw new Error(\`Unknown CLI argument: ...\`)`。

**实测**：

```
$ ferrycat-cli dispatch --agent t1 '{"target_agent":"w1",...}'
Fatal CLI Error: Error: Unknown CLI argument: "{"target_agent":"w1",...}".
```

另有一处连带问题：`workspace_root` 写成 `F:\\git\\FerryCat` 时，经 shell 处理后反斜杠被压缩，错误信息里回显成 `F://git//FerryCat`。这不是 CLI 的 bug（是 shell 转义），但在 Windows 上**错误提示会误导用户以为 CLI 篡改了路径**，建议报错时回显 `JSON.stringify` 转义前的原文而不是解析后的值。

**修复建议**：把位置参数判定改成"**第一个不以 `--` 开头的 token 视为 JSON payload**"，与 flag 解析解耦：

```ts
const positionalIdx = rest.findIndex(t => !t.startsWith('--'));
if (positionalIdx !== -1 && !looksLikeFlagValue(rest, positionalIdx)) {
  data = JSON.parse(rest[positionalIdx]);
}
```
注意要排除 `--agent` 后面那个值被误判为位置参数，所以需要在第一遍扫描时就标记"已被 flag 消费"的索引。

**优先级说明**：这条与 Phase A 无因果关系，是既有缺陷，但**它恰好挡住了 `release`/`extend`/`fail` 最自然的用法**（带 `--agent` 短命令），所以建议与 Phase A 一起修。

---

## P2-2 stdin 管道 payload 仍未支持（REQ-CLI-02 未落地）

**实测**：

```
$ echo '{"target_agent":"w1",...}' | ferrycat-cli dispatch --agent t1
{"ok": false, "error": "[{\"path\":[\"target_agent\"],\"message\":\"Required\"}, ...]"}
```

stdin 内容被**完全忽略**，`--agent t1` 落进 `data.agent_id`，然后 Zod 逐字段报 Required。这个报错信息很有误导性——用户明明写了 payload，却被告诉"字段缺失"。建议至少在未检测到 payload 且 stdin 非 TTY 时提示 `stdin payload is not supported yet; use --file or a single positional JSON`，而不是抛一堆 Zod 错误。对应 backlog **REQ-CLI-02**。

---

## P2-3 `release` 覆盖 `error_reason`，但 `SUBMITTED` 态下该字段语义未定义

`release` 写入 `RELEASED_BY_HOLDER: <reason>`，但 `claimed_at` 已置 NULL。于是 `inspect` 看到的是：

```json
{"status":"SUBMITTED","claimed_at":null,"error_reason":"RELEASED_BY_HOLDER: cannot"}
```

一个 `SUBMITTED` 态的行带着"错误原因"，语义上是矛盾的——`SUBMITTED` 应该是干净的初始态。更麻烦的是，**第二次 release 会覆盖第一次的 reason**，历史丢失。建议：

- 或者新增 `release_history_json` 累积记录（`[{at, by, reason}]`），`error_reason` 只在终态使用；
- 或者把 `release` 的 reason 写进独立列 `release_reason`，与终态错误分离。

顺带：`inspected` 输出里 `queued_at` 被重命名成 `queueStart` 再以 `queued_at` 字段输出，`queued_at` 为 NULL 的旧行会被展示成 `created_at`——这个 `COALESCE` 兜底是好的，但**输出里看不出这一行是"从未 release 过"还是"release 了但 queued_at 丢失"**，建议加一个 `queued_at_is_fallback: true/false` 标记，便于诊断旧数据。

---

## P2-4 新索引 `idx_contracts_queue_order` 少了 `rowid`，排序仍需额外步骤

**实测执行计划**：

```
EXPLAIN QUERY PLAN
SELECT * FROM contracts WHERE target_agent=? AND status='SUBMITTED'
ORDER BY COALESCE(queued_at, created_at) ASC, rowid ASC LIMIT 10

→ SEARCH contracts USING INDEX idx_contracts_queue_order (target_agent=? AND status=?)
```

`SEARCH ... USING INDEX` 而没有 `USE TEMP B-TREE FOR ORDER BY`，说明**排序已被索引满足**，这点是对的。但索引建的是 `(target_agent, status, COALESCE(...))`，而查询 ORDER BY 多带了一个 `rowid`。SQLite 隐式把 rowid 追加到每个索引末尾，所以 `(target_agent, status, expr)` 的索引实际等价 `(target_agent, status, expr, rowid)`，**刚好能覆盖 `+ rowid` 的 tie-break，不需要临时排序**。

**这一条从 P2 降级为 P3 观察项**——原判断"索引可能不覆盖排序"经实测被证伪。但保留建议：把 `rowid` 显式写进索引定义（SQLite 允许 `ON contracts(target_agent, status, COALESCE(...), rowid)`），让意图显式化，避免未来换存储引擎（如 `node:sqlite` 升级为基于 WAL2 的实现）时隐式行为变化。

**另附一个真实存在的性能问题**：`fulfillContract` 每次调用 `verifySingleRun(row.workspace_root, fingerprints)` **重算全部指针的 sha256**（`engine.ts:442`）。对于指针数上限 50、单文件较大的场景，每次 fulfill 都是全量 IO。这与 `verified_sha256_json` 的写入有冗余——已经在 dispatch 阶段算过一遍，claim 阶段验过一遍，fulfill 又算一遍，三遍。建议 fulfill 阶段只对 `size/mtime` 做快速比对，sha256 mismatch 时才做全文确认。

---

## P3 事项（记录，不阻塞）

1. **版本号未随 Phase A 前进**：`package.json` 仍是 `0.1.1`，`src/index.ts:19` MCP server version 也硬编码 `0.1.1`。功能已加、版本未升，如果此刻 `npm publish` 会得到一个自称 0.1.1 的 Phase A。**建议发版前一并处理**（顺带把 `src/index.ts` 的硬编码版本改成从 `package.json` 读取，消除双写）。

2. **`docs/roadmap.md` 未标注 Phase A 完成**：`81b3d57` 改了 roadmap 但 `grep v0.` 只见 Phase 1 (v0.1 — Completed)，Phase A 的 Tiered TTL 等未见显式里程碑条目。建议补一条 `Phase A (v0.2.0-rc) — Completed 2026-10-23`。

3. **ADR 未新增**：`release_contract` 的"重置 retry"取舍、`extend_ttl` 的"生命期上限"设计，都是**有争议的设计决策**，按项目既有惯例（ADR-0002 连"证伪记录"都写进去）值得补 ADR-0004。尤其 P0-1 那条，无论最后选哪个方案，**决策理由需要留痕**。

4. **`MAX_RELEASES` / `MAX_TTL_EXTENSIONS` 硬编码为常量**，未进 schema，调用方无法按工单覆盖。当前够用，但如果将来出现"高价值工单允许更多续期"的需求，需要改代码。可在 `DispatchContractShape` 加可选 `max_releases` / `max_extends`。

---

## 已验证成立的部分（建议保留在对外表述中）

以下均经**独立探针实测**确认，不是读码推断：

| 项目 | 验证方式 | 结果 |
|---|---|---|
| 分级 TTL 落库 | CLI dispatch 两种 task_type | `architecture_audit`→1800s，`implementation`→300s ✅ |
| `release` 队尾语义 | release A1 后 poll | 先拿到 A2，再拿到 A1 ✅ |
| `retry_count` 终态值 | 连续 3 次校验失败 | `RETRY_NEEDED(1) → RETRY_NEEDED(2) → VALIDATION_FAILED(3)`，终态行 `retry_count=3` ✅（之前 P2 报的"终态=max+1 破坏不变式"**已修正为预期行为**） |
| 旧库平滑迁移 | 用真实 v0.1 mesh.db 副本启动 | 4 个新列全部 ADD COLUMN 成功，`queued_at` 保留 NULL，旧行可正常 claim + extend ✅ |
| 新索引走计划 | `EXPLAIN QUERY PLAN` | `SEARCH ... USING INDEX idx_contracts_queue_order`，无 TEMP B-TREE ✅ |
| 跨实例并发守卫 | 两个独立 Engine 实例 | 并发 extend 计数正确累加到 2；release 后 extend/fail 均被状态守卫拒绝 ✅ |
| 终态互斥 | extend 后 fail | fail 成功，`status=FAILED`，`error_reason='WORKER_FAILED: ...'` ✅ |
| exec 非零退出闭环 | `worker --once --exec "exit 3"` | `EXEC_FAILED` + `contract_status: "FAILED"` ✅ |
| `fail` 空 reason 拦截 | CLI 缺 `--reason` | Zod 明确报 `path: ["reason"], message: "Required"` ✅ |
| MCP 工具注册 | Test 6 | 7 个工具齐全（含 release/extend/fail）✅ |
| 空队列幂等 | `worker --once` 无人领 | `has_task: false`，exit 0 ✅ |

**关于"是否存在死锁"的明确回答：没有。** 我重点验证了三条可能形成环的路径——
（1）`release` 后 `claimed_at` 置 NULL，是否会让 `extend`/`fail` 的 `claimed_at !== null` 判定抛 NPE → 实测被 `status !== 'CLAIMED'` 提前拦截，安全；
（2）`expireIfExecTtlElapsed` 在 `release`/`extend`/`fail` 三处调用，是否存在 TOCTOU 窗口 → 实测跨实例同时操作时，`status='CLAIMED'` 条件更新保证了恰好一次生效；
（3）`sweepExpiredContractsIfNeeded` 与 `claimStmt` 的 `status='SUBMITTED'` 乐观锁是否互斥 → 实测并发下 `changes !== 1` 被正确识别为抢占。

---

## 修复优先级建议

**发版前（P0 + P1）**
1. `retry_count` 与 `extend_count` 解耦（P0-1）——一条 SQL 改 `SET retry_count = 0` 即可止血，但建议直接做计数器拆分，避免下次再踩。
2. `extend_ttl` 增加 `proposedExpiresAt > lifetimeDeadline` 判定（P1-1）——三行代码。
3. 9C 测试补断言：`extend` 成功后 `expires_at <= lifetimeDeadline`（P1-1 的测试缺口）——不加这条，修了也没人守。

**同批发（P2，成本低收益高）**
4. CLI 位置参数与 flag 解耦（P2-1）
5. stdin payload 至少给出清晰报错（P2-2）

**下一批**
6. 生命期判定抽成统一方法，`release` 路径纳入（P1-2）
7. `release_reason` 独立列 / 历史累积（P2-3）
8. `fulfill` 阶段 sha256 三级校验降为快速比对（P2-4 附带项）
9. 版本号、roadmap、ADR-0004 文档同步（P3）

---

## 给 Antigravity 的两个问题

1. **P0-1 的方案选择**：我倾向"拆分 `retry_count` / `holder_retry_count` 双计数器"，但这会让 `ContractRow` 与谓词文案都要改，属于 schema 变更。你是否认为在 v0.2.0-rc 阶段引入这个变更代价过高？替代方案是"release 不重置 retry"，语义更简单，但会让"前一任的失败连累下一任"。你更看重哪一侧？

2. **`extend` 越界时该拒绝还是钳制**：我倾向前者（失败要显式），但这意味着 `exec_ttl=1800` + `queue_ttl=60` 的组合下，`extend` 几乎永远不可能成功（因为剩余生命期只有 240s，任何续期都会越界）。如果这个组合是合理场景，就得改成钳制并显式告知截断。你在这侧的实际用法里，`queue_ttl` 会被设成远小于 `exec_ttl` 吗？

---

*本报告所有"实测"标注均可用 `git checkout 81b3d57` 后依「验证方式」列复现。探针脚本未入库（审查完即删），如需留存可补一份到 `test/`。*
