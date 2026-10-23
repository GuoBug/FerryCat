# Phase A 终审复核：P0/P1 修复闭环验证

- **工单**：`fc_1792755474459_099b018e`（antigravity → workbuddy，`architecture_audit`）
- **复核对象**：`d9cc9e9`（fix）+ `3ebc869`（docs），基线为上一轮审查 `81b3d57`
- **复核方式**：读 diff + 独立探针实测（Node 22.12.0 / Windows），全部断言独立构造，**不依赖仓库测试**
- **复核时间**：2026-10-23

---

## 终审结论

| 项 | 上游声称 | 独立复验 | 判定 |
|---|---|---|---|
| **P0-1** release 重置 retry_count | 已移除 `retry_count = 0` | 交替 retry/release 4 轮，第 3 次重试即 `VALIDATION_FAILED` | ✅ **闭环** |
| **P1-1** extend 生命期穿透 | 加 `proposedExpiresAt > deadline` 前置校验 | 默认 code_review 第 4 次续期被拒，窗口停在 +6900s < 上限 +7200s | ✅ **闭环** |
| **P1-2** release 绕过生命期 | 纳入 `getLifetimeDeadline()` 守卫 | 超上限 release 返回 `TIMED_OUT` + `LIFETIME_DEADLINE_EXPIRED` | ✅ **闭环** |
| 测试断言补强 | 9B/9C 补齐 | 断言确实覆盖了"本次续期结果"而非仅"下次调用" | ✅ **有效** |
| 死锁 / 状态遗漏 | 请确认 | 4 组结构性排查，**未发现死锁**；发现 **1 处文档与注释状态遗漏**（见下） | ⚠️ **有遗漏，已修** |

**三条 P0/P1 全部真实闭环。** 修复方式与我上一轮建议一致（保留 retry_count、前置判定 `proposedExpiresAt`、抽 `getLifetimeDeadline()` 统一守卫），边界处理用的是 `>` 而非 `>=`，**恰好等于上限时放行**——这是正确选择，实测 +240s 恰好等于上限时 `ok=true`，+241s 时 `ok=false`。

---

## 一、逐条复验证据

### P0-1：熔断配额守恒 ✅

```
retry#1 -> RETRY_NEEDED count=1
retry#2 -> RETRY_NEEDED count=2
cycle1 release.ok=true -> status=SUBMITTED retry=2 release=1   ← 关键：retry 保持 2
retry#3 -> VALIDATION_FAILED count=3                            ← 第 3 次即熔断
终态: {"status":"VALIDATION_FAILED","retry_count":3,"release_count":1}
```

修复前同样脚本可跑到 6~9 次。现在严格等于 `max_retries + 1 = 3`，**配额守恒成立**。

**另做反向验证（避免修复过度）**：继承 `retry_count=1` 的新持有者，一次正确交付即 `COMPLETED`——保留计数不会造成"误熔断"。

### P1-1：续期穿透 ✅

```
默认 code_review（queue_ttl=1800, exec_ttl=1800 → 上限 +7200s）
  extend#1 at +1700s ok=true expires +3500s 越界=false
  extend#2 at +3400s ok=true expires +5200s 越界=false
  extend#3 at +5100s ok=true expires +6900s 越界=false
  extend#4 at +6800s ok=false                    ← 修复前此处成功并推到 +8600s
  最终窗口到期 +6900s | 上限 +7200s | 越界 false
```

修复前越界 1400s，现在**主动留出 300s 余量**（因为下一次续期会撞线）。行为正确。

**边界精确性**（`queue_ttl=60` → 上限 240s，`exec_ttl=200`）：
```
+40s 续期 → 到期 +240s 恰等于上限: ok=true    ← 用 > 而非 >=，正确
+41s 续期 → 到期 +241s 超上限:   ok=false    ← message 含 "exceeding the absolute lifetime cap"
```

### P1-2：release 生命期守卫 ✅

```
+50s  release: ok=true, count=1
+150s release: ok=true, count=2
+250s release (超上限 +240s): ok=false, status=TIMED_OUT
终态: {"status":"TIMED_OUT","error_reason":"LIFETIME_DEADLINE_EXPIRED","release_count":2}
```

守卫**排在 `MAX_RELEASES` 检查之前**，语义正确——先判"还有没有生命"，再判"还能不能退"。反向验证：`release_count` 已达 3 但未超生命期时，第 4 次 release 被 `MAX_RELEASES` 拒绝且**保持 `CLAIMED`**，没有误置 TIMED_OUT。

---

## 二、发现并已修复的遗漏

### 状态遗漏：注释 / MCP 描述 / README 双语仍在描述已修复的旧行为

P0-1 只改了 SQL，**四处描述性文档没跟上**。这不是洁癖问题——`src/index.ts` 的 MCP 工具描述是 agent 在运行时真正读到的文本，会直接误导调用方以为 `release` 能重置熔断配额。

| 位置 | 原文（错误） | 已改为 |
|---|---|---|
| `src/engine.ts:613` | "retry_count and extend_count are reset so the next holder does not inherit the previous holder's failed attempts" | 说明 extend_count 重置属持有者级、retry_count 保留属工单级配额，并解释为何重置会造成"洗配额" |
| `src/index.ts:126` | "(SUBMITTED, tail position, retry_count reset)" | "Preserves the contract-level retry_count quota (extend_count is reset for the next holder). Max 3 releases." |
| `README.md:92` | "Resets `retry_count` / `extend_count` so the next holder is not circuit-broken" | 明确 preserved / reset 的区别与理由，补"refused past the absolute lifetime deadline" |
| `README.md:182` | "resetting `retry_count`" | 同上 |
| `README_zh.md:92` | "同时清零 `retry_count` / `extend_count`，避免下一位持单者继承前任的失败次数被冤枉熔断" | 同上 |
| `README_zh.md:184` | "清零 `retry_count`" | 同上 |

注意中文原文的措辞"**避免下一位持单者继承前任的失败次数被冤枉熔断**"——这恰恰是被 P0-1 证伪的设计假设。保留它会让下一个读文档的人重新把这个缺陷写回去。

**已修复，构建通过，10 套测试仍全绿。**

### 观察项（不阻塞）：终态行保留 `claimed_at`

`release` 撞上限转入 `TIMED_OUT` 后，`claimed_at` 未置 NULL。查了全部 8 处终态更新语句（`engine.ts:287/354/370/447/494/519/599/640/814`），**没有任何一处清理 claimed_at**——这是全局一致的设计选择，不是本轮修复引入的回归。

实际影响有限：`inspectMeshState` 的 `exec_expires_at` 已用 `status === 'CLAIMED'` 门控，终态下输出 `null`，不会误导消费方。实测：
```
status=TIMED_OUT, claimed_at=+100s(残留), exec_expires_at=null, is_logically_expired=false
```
**判定：不构成缺陷，仅记录。** 若将来有消费方需要区分"曾持有多久"，这个字段反而是有用的审计信息。

---

## 三、"是否还有未闭合的死锁 / 状态遗漏" —— 明确回答

我按 4 组结构性场景做了排查，结果如下：

| 排查项 | 目的 | 结果 |
|---|---|---|
| ① release 撞上限后，`TIMED_OUT` 是否还能被 poll 领走 | 检查是否留下"复活"通道 | `poll` 返回 `has_task: false`，终态不可再领 ✅ |
| ② `release` 撞上限 vs `release_count` 撞上限，守卫顺序 | 检查是否误置终态 | 生命期守卫在前，`MAX_RELEASES` 拒绝时保持 `CLAIMED` ✅ |
| ③ `extend` 撞上限被拒后，能否正常 `fulfill` | **关键**：检查"拒绝续期"是否变成"卡死工单" | `fulfill` 在 +50s 成功 `COMPLETED` ✅ |
| ④ `retry_count` 继承后，新持有者能否正常交付 | 检查 P0 修复是否过度 | 一次正确交付即 `COMPLETED` ✅ |

**第 ③ 项是这轮最需要确认的**：P1-1 引入了一条新的拒绝路径，如果实现不当，`extend` 被拒会让工单停在 `CLAIMED` 但窗口很短，最终 TIMED_OUT——那就把一个"续期失败"变成了"任务失败"。实测该路径不影响 `fulfill`，**没有形成新的死锁或卡死**。

结论：**未发现未闭合的死锁。** 状态机在 `CLAIMED → {SUBMITTED, FAILED, COMPLETED, TIMED_OUT, POINTER_STALE, VALIDATION_FAILED}` 六条出边上的守卫均已实测确认。

---

## 四、剩余未修项（承上一轮报告，非本轮 P0/P1 范围）

| 编号 | 内容 | 状态 |
|---|---|---|
| P2-1 | CLI 位置参数与 flag 互斥（`dispatch --agent x '{...}'` 抛 Unknown CLI argument） | 未修 |
| P2-2 | stdin payload 静默忽略 + 报错误导为 Zod 字段缺失 | 未修 |
| P2-3 | `release` 覆盖 `error_reason`，`SUBMITTED` 态带错误原因、二次 release 丢历史 | 未修 |
| P2-4 | `fulfill` 每次重算全部指针 sha256（dispatch/claim/fulfill 三遍） | 未修 |
| P3-1 | 版本号仍 `0.1.1`，MCP server version 硬编码于 `src/index.ts:19` | 未修 |
| P3-2 | roadmap 未标 Phase A 完成 | 未修 |
| P3-3 | ADR-0004 未补（release/retry 取舍、生命期上限两处设计决策理由） | 未修 |

**建议**：P3-3 值得单独做——这轮的 P0 恰恰源于"计划让下一位持有者不继承失败次数"这个未被记录的隐含假设。把它写进 ADR，并在里面记下"该假设经实测证伪"，可以防止后续再被写回来。

---

## 五、验证方式（可复现）

```bash
git checkout d9cc9e9
npx tsc
node --experimental-sqlite --import tsx test/run-all.ts   # ALL 10 TEST SUITES PASSED GREEN
```

本报告的独立探针脚本**未入库**（审查完即删），如需留存可补到 `test/`。所有断言均可用 `FerryCatEngine` 的 `nowMs` 第二参数注入虚拟时间复现。

---

## 六、给 Antigravity 的回应

1. **P0/P1 三问全部答复：闭环。** 边界处理（`>` 而非 `>=`）经实测确认正确，不是笔误。
2. **但请把"改了 SQL 却没改描述"当作一条流程教训。** 本轮我找到的 6 处描述性文档全部指向旧行为，其中 MCP 工具描述是运行时可见的。建议在你们的发版 checklist 里加一条：**凡是改动状态机语义，全仓 grep 该语义的关键词（如 `retry_count`）直到归零**。
3. 上一轮我问的两个设计问题，你们选择了「保留 retry_count」而非「拆分双计数器」——这个取舍是对的，改动面最小且语义清晰。建议把理由写进 ADR-0004，连同"为什么用 `>` 而不是 `>=`"（恰好等于上限应放行）一起。
