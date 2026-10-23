# Phase B (v0.3.0) 交付与 Glama MCP 文档大修 —— 白盒审查报告

- **工单**：`fc_1792765837119_2685e76b`（`antigravity` → `workbuddy`，`architecture_audit`）
- **审查者**：WorkBuddy
- **日期**：2026-10-23
- **基线**：7 个指针文件 SHA-256 全部校验通过（审查期间严格只读，未做任何磁盘修改）
- **结论**：`changes_requested`

---

## 0. 执行摘要

Phase B 的工程量是实打实的：`--help` 树、`--version` 动态读取、stdin/BOM、ASCII 表格、worker 三模式、Zod 友好报错、ADR-0004 的 `verify` 与 TOCTOU 缓冲，逐项落地且质量高于 Phase A。**Glama 描述大修的方向也完全正确**——把工具说明从散文改成 Purpose / Usage Guidelines / Behavior / Return Value 四段式，是提升 agent 可发现性的正确手段。

但恰好在「Glama 大修要解决的三个痛点」上，本次交付出现了反向退化：

| Glama 痛点 | 官方宣称的改善 | 实测结果 |
|---|---|---|
| Usage Guidelines (2/5) | 声明 1 次缓冲后再终态 | **文档承诺 2 次机会，代码只给 1 次** |
| Behavior (2/5) | 明确 Strike 1 / Strike 2 行为 | **自动化 worker 路径下 Strike 1 窗口被自家循环吃掉** |
| Completeness (2/5) | 补齐 Return Value 字段清单 | **`dispatch_contract` 声称 12 个字段，实际返回 5 个** |
| Parameters (3/5) | 用 Zod `.describe` 约束参数 | **`--agent` 显式覆盖被静默丢弃，正是声称修复的 P2-1** |

即：**描述写得越像规格，与实现的距离就越刺眼。** 一份声称 "Strike 2 才终态" 的描述，会让 agent 在第一次被拒时以为还有机会，从而不去恢复文件——比当初那份含糊的描述更容易造成废单。

以下 P0/P1 共 5 项，P2/P3 共 6 项。

---

## 1. P0 级发现（必须修复后才能发布 v0.3.0）

### P0-1　`MAX_TOCTOU_STRIKES = 1` 使「1 次缓冲」实为「0 次缓冲」，与全部文档矛盾

**位置**：`src/engine.ts:58`、`:459`、文档 `src/index.ts:171-173`、`src/cli.ts:42`、`:107`

**代码事实**：

```ts
export const MAX_TOCTOU_STRIKES = 1;          // engine.ts:58
...
if (nextStrike <= MAX_TOCTOU_STRIKES) {       // engine.ts:459
  // Strike 1: 返回 RETRY_NEEDED，保持 CLAIMED
}
// 否则 -> 终态 POINTER_STALE
```

**实测**（脏指针后连续 fulfill）：

```
fulfill attempt #1 -> status=RETRY_NEEDED  strike=1/1
fulfill attempt #2 -> status=POINTER_STALE strike=2/1
```

即：**仅有的 1 次豁免额度就是那个 "Strike 1" 本身**。所谓「Strike 2 才进终态」在代码里根本没有对应的第 2 次机会——`strike=1` 时走的是「豁免并保留」，`strike=2` 时直接越过 `<=1` 进入终态。文档描述的 `Strike 1 | Strike 2` 是两个**独立分支**，代码里只有**一个**豁免槽。

**为什么这是 P0 而不只是措辞问题**：

ADR-0004 的立论基础是「误改文件不该直接废掉 30 分钟审查」。当前实现下，审查者第一次被拒、正准备 `git stash` 时，如果因为任何原因（in-editor 保存、另一个 agent 动了文件、甚至只是撤销自己改动的中间态）在恢复完成前再碰一次 fulfill，契约立刻终态。**而文档明确告诉它将有第 2 次机会**，这恰恰会诱导它做出错误判断——「还有一次，我可以先在 IDE 里改回来再交」。

这不是「文档写得不准」，而是**文档与实现共同构成了一个陷阱**。

**修复**：把语义统一到一个方向上，不要两边都改。

- 若意图是「1 次缓冲 + 1 次终态」（即总共 2 次 fulfill 尝试），应设 `MAX_TOCTOU_STRIKES = 2`，并保持 `nextStrike <= MAX_TOCTOU_STRIKES` 的写法；此时 `strike=1` 豁免、`strike=2` 豁免、`strike=3` 终态 —— **这样又变成 2 次豁免了**，与「缓冲 1 次」不符。
- 因此正确写法是**保持 `MAX_TOCTOU_STRIKES = 1`，把文档改成符合实现的措辞**：

```ts
// engine.ts:58 注释
/**
 * Total number of TOCTOU-blocked fulfill attempts tolerated before the contract
 * transitions to terminal POINTER_STALE. Counting semantics:
 *   attempt N where N <= MAX_TOCTOU_STRIKES  -> RETRY_NEEDED (contract stays CLAIMED)
 *   attempt N where N >  MAX_TOCTOU_STRIKES  -> POINTER_STALE (terminal)
 * With MAX_TOCTOU_STRIKES = 1 the holder gets exactly ONE recoverable rejection:
 * the 1st blocked fulfill returns RETRY_NEEDED, the 2nd is terminal.
 */
```

并把 `index.ts:172-173` 的两条 bullet 合并为一条如实描述：

```
- 1-Strike TOCTOU Buffer (ADR-0004): The first fulfill attempt that detects dirty pointer
  files returns status='RETRY_NEEDED', keeps the contract CLAIMED, and renews the execution
  window (claimed_at=now) so you can restore/stash the files. The SECOND blocked attempt is
  terminal POINTER_STALE, preserving your payload in salvaged_result_json.
  IMPORTANT: you get exactly ONE recoverable rejection — restore the files before retrying,
  and prefer verify_contract first to avoid burning it.
```

**关键**：无论选哪个方向，`index.ts:171-173` 的 "Strike 1 / Strike 2" 二分叙述必须删除，因为它在当前实现里对应的是一个豁免槽的两个计数状态，而不是两次独立机会。

---

### P0-2　`worker --mode=exec` 自动重试循环把唯一的 TOCTOU 豁免瞬间烧掉

**位置**：`src/cli.ts:618-626`

```ts
if (fulfillRes.status === 'RETRY_NEEDED') {
  const maxAttempts = (fulfillRes.max_retries ?? 2) + 1;
  for (let i = fulfillRes.retry_count ?? 1; i < maxAttempts; i++) {
    fulfillRes = engine.fulfillContract(validatedFulfillInput);
    if (fulfillRes.status !== 'RETRY_NEEDED') break;
  }
}
```

**实测**（`worker --mode=exec --once --exec-file handler.mjs`，handler 修改了指针文件）：

```json
"status": "POINTER_STALE",
"toctou_strike": 2,
"max_toctou_strikes": 1
```

**根因**：这个循环是为「schema 校验失败」设计的——`retry_count` 会随每次失败递增，所以 `for` 循环能正常推进并在 `maxAttempts` 处停下。但 **TOCTOU 失败完全不碰 `retry_count`**（实测 `RETRY_NEEDED` 时 `retry_count` 恒为 0）。于是：

- `maxAttempts = 2 + 1 = 3`
- `i` 从 `retry_count ?? 1` = 1 开始
- 第 1 次重试（`i=1`）拿到 `strike=2` → **立刻 `POINTER_STALE`**

也就是说，**在自动化 worker 路径下，ADR-0004 的软失败缓冲等于不存在**。而这恰恰是最需要它的场景：无人值守的自动执行器改了文件，没有任何人能手动施救。

更讽刺的是，`cli.ts:618` 的注释明确写着 *"schema retry or TOCTOU strike 1"*——作者知道这里会分流到 TOCTOU，但循环条件只对 schema 计数器有效。

**修复**：重试循环必须按失败类型分流，且 **TOCTOU 分支绝不能自动重试**（自动重试没有任何意义：文件状态不会在两个微秒内自己变干净）。

```ts
// cli.ts:618 替换
if (fulfillRes.status === 'RETRY_NEEDED') {
  const isToctou = (fulfillRes.toctou_strike ?? 0) > 0 && (fulfillRes.retry_count ?? 0) === 0;
  if (isToctou) {
    // ADR-0004: a TOCTOU rejection is NOT auto-retryable. The on-disk baseline
    // cannot heal between two consecutive calls; retrying would burn the single
    // strike and force a terminal POINTER_STALE with no human in the loop.
    // Leave the contract CLAIMED (already renewed by the engine) and surface the
    // rescue instructions to the operator instead.
    resolve({
      ok: false,
      status: 'TOCTOU_RESCUE_REQUIRED',
      fulfill_result: fulfillRes,
      error: 'Automated exec mutated pointer files. Contract stays CLAIMED with a renewed window; restore the files and re-run, or deliver edits via structured_output.fixes.',
    });
    return;
  }
  const maxAttempts = (fulfillRes.max_retries ?? 2) + 1;
  for (let i = fulfillRes.retry_count ?? 1; i < maxAttempts; i++) {
    fulfillRes = engine.fulfillContract(validatedFulfillInput);
    if (fulfillRes.status !== 'RETRY_NEEDED') break;
  }
}
```

若一时无法改结构，最小止血是：**检测到 `toctou_strike` 增长就立刻 break**，不要继续循环。

---

## 2. P1 级发现

### P1-1　`releaseContract` 不清 `toctou_strike`，导致「挽救通道」被历史 strike 堵死

**位置**：`src/engine.ts:727-738`

`releaseContract` 重置 `extend_count = 0`（持有者级配额），刻意保留 `retry_count`（契约级熔断配额）——这个区分在 ADR-0004 附录 §4.1 里论证得很清楚，是对的。但 **`toctou_strike` 既没被归入前者，也没被归入后者，它被静默地留着了**。

**实测**（A 持有期间文件被第三方改动 → A 拿到 strike 1 → A 退单 → A 重新领单）：

```
A fulfill  -> RETRY_NEEDED  strike=1
A release  -> true SUBMITTED release_count=1
A re-poll  -> POINTER_STALE        ← 注意这里
verify     -> valid=true  toctou_strike=1
fulfill    -> throw: expected 'CLAIMED', but current status is 'POINTER_STALE'
```

`verify` 明明说 `valid=true`（文件已恢复干净），但契约已经进终态，**连交单的机会都没有了**。

**为什么这违背 ADR-0004 的立论**：`toctou_strike` 语义上是「**持有者**在本次持单期间搞脏了文件」，与 `extend_count` 同类（持有者级），而不是与 `retry_count` 同类的「契约级系统防御配额」。`retry_count` 之所以不能清零，是因为它防的是「循环 agent 反复提交垃圾 payload」这种**恶意持续行为**；而 TOCTOU strike 防的是「手滑改了一次文件」，一个诚实持有者退单后下一位持有者完全无辜。

当前实现下，「release 是抢救手段」这句话（`index.ts:167` 的 RESCUE 指引第 (2) 条）**在某些路径上是假的**。

**注意**：此处还有一个更严重的问题——`re-poll` 直接返回 `POINTER_STALE` 而不是「退单后重新领到」。因为 `releaseContract` 没有触碰 `pointers_json`，重新领单时 `verifyFingerprintsWithRetry` 对着**过时的基线**校验已恢复的文件……等一下，实测显示 re-poll 得到的是 `POINTER_STALE`，而随后 `verify` 却报 `valid=true`。这说明 re-poll 时刻文件仍是脏的（脚本里恢复文件是在 re-poll **之后**执行的）。所以此处行为本身没错，真正的缺陷只是 **strike 残留**。

修正后的实测链路（恢复文件 → re-poll）仍会以 `strike=1` 起步，下一次任何风吹草动就直接终态。这是 P1。

**修复**：在 `releaseContract` 的 UPDATE 中把 `toctou_strike = 0` 一并重置，并在 ADR-0004 附录 §4 增加第 3 条论证。

```sql
UPDATE contracts
   SET status = 'SUBMITTED',
       claimed_at = NULL,
       queued_at = ?,
       extend_count = 0,
       toctou_strike = 0,        -- holder-scoped, same rationale as extend_count
       release_count = release_count + 1,
       error_reason = ?
 WHERE id = ? AND status = 'CLAIMED' AND target_agent = ? AND release_count = ?
```

---

### P1-2　`dispatch` 子命令中 `--agent` 被静默丢弃，正是本工单声称修复的 P2-1

**位置**：`src/cli.ts:977-979`

```ts
if (!data.requester_agent && data.agent_id) {
  data.requester_agent = data.agent_id;
}
```

**实测**：

```
$ ferrycat-cli dispatch --agent override_me '{"requester_agent":"IGNORED", ...}'
$ ferrycat-cli inspect --json
fc_1792766011930_a6312995  requester=IGNORED   ← 应为 override_me
```

**根因**：`parseArgs` 已经正确地实现了「`--file` < 位置 JSON < 显式 Flag」的三级优先级（`cli.ts:445-449`），`--agent` 也确实被写进了 `flagOverrides.agent_id`。但 `dispatch` 分支的这个 `if` 判断的是 `!data.requester_agent`——**而 `data.requester_agent` 此时已经被 payload 里的值填上了**。守卫条件写反了：它想说的是「用户没有通过 flag 指定」，实际写成了「payload 里没有这个字段」。

**影响**：调用方显式传 `--agent` 想覆盖 payload，结果契约被记在 payload 声称的 requester 名下。跨 agent 取证链条会被污染——**而这正是 FerryCat 存在的意义**。Glama 的 Parameters (3/5) 扣分点正在此。

**修复**：需要区分「值从哪来」，而不是看值在线性合并结果里是否存在。最小改动是让 `parseArgs` 额外暴露 `explicitFlags` 集合：

```ts
// ParsedCliArgs 增加
explicitFlags: Set<string>;

// dispatch 分支改为
if (!parsed.explicitFlags.has('requester_agent') && data.agent_id) {
  data.requester_agent = data.agent_id;
}
```

---

### P1-3　`verify_contract` 对终态契约仍回 "Safe to fulfill"，属误导性表述

**位置**：`src/engine.ts:915-927`

**实测**（契约已 `FAILED` 后调用 verify）：

```
fail 后 verify.status = FAILED  valid = true
message: "...match the dispatched SHA-256 baseline. Safe to fulfill."
```

`verifyContract` 完全不判 `row.status`——它对 `COMPLETED`、`FAILED`、`TIMED_OUT`、`POINTER_STALE`、`VALIDATION_FAILED` 的契约一律做文件校验，只要文件没变就宣称 **"Safe to fulfill"**。而实际上此时 fulfill 会直接抛 `expected status 'CLAIMED'`。

这是 Glama Behavior 分项上的硬伤：**一个只读预检工具，在契约已无法交单时给出「可以交单」的正向结论**。比不给结论更糟。

**修复**：`valid` 仅描述「文件是否与基线一致」，`safe_to_fulfill` 应是独立字段，并在 message 里按 status 分流。

```ts
const fulfillable = row.status === 'CLAIMED';
return {
  ok: true,
  valid: true,
  status: row.status,
  fulfillable,                                     // 新增
  message: fulfillable
    ? `All ${fingerprints.length} pointer file(s) match the baseline. Safe to fulfill.`
    : `All ${fingerprints.length} pointer file(s) match the baseline, but contract status is '${row.status}' — it can no longer be fulfilled. Ask the requester to re-dispatch.`,
  ...
};
```

---

### P1-4　`dispatch_contract` 的 Return Value 描述与实际返回结构严重不符

**位置**：`src/index.ts:97` vs `src/engine.ts:259-272`

**实测返回的 key**：`contract_id, status, created_at, files, warning`

**MCP 描述声称的 key**：`ok, contract_id, status, requester_agent, target_agent, task_type, title, created_at, queue_ttl_sec, exec_ttl_sec, pointers, warnings`

- **缺失 8 个**：`ok`、`requester_agent`、`target_agent`、`task_type`、`title`、`queue_ttl_sec`、`exec_ttl_sec`、`pointers`
- **多出 2 个**：`files`（实际是 `pointers` 数组，但换了名）、`warning`（单数，描述里写的是 `warnings`）

这不是笔误级别。agent 拿到 `dispatch_contract` 的回执后，若按描述去读 `result.requester_agent` 或 `result.pointers`，会得到 `undefined`。Glama 的 Completeness (2/5) 想解决的正是这个问题，改完反而更不准确了。

**修复**：以实际 `DispatchContractResult` 为准重写 `index.ts:97`，或在 `engine.ts` 补齐 `ok: true` 等字段。**推荐前者**（不改引擎行为），并统一 `files` / `pointers` 命名。

---

## 3. P2 级发现

### P2-1　测试套件在仓库当前状态下是**红的**（11D 崩溃）

```
TEST SUITE FAILED: SyntaxError: Unexpected token '(', "(node:1720"... is not valid JSON
    at test11_PhaseBCliErgonomicsAndToctouBuffer (run-all.ts:1370:31)
```

11A、11B、11C 全 PASS，11D 在 `JSON.parse(resBadZod.stderr)` 崩溃。

**根因**：`run-all.ts:1252-1255` 的 `runCli` 没有屏蔽 Node 的 `ExperimentalWarning`：

```ts
const child = spawn(process.execPath, ['--experimental-sqlite', cliPath, ...args], {
  env: { ...process.env, FERRYCAT_DB_PATH: dbPath },
```

`node:sqlite` 会往 stderr 打 `ExperimentalWarning: SQLite is an experimental feature...`，于是 `stderr` 变成 `(node:1720) ExperimentalWarning... \n{ "ok": false ... }`，`JSON.parse` 直接炸。

**这不只是测试问题**——它揭示了一个真实的 CLI 契约缺陷：**`ferrycat-cli` 的 JSON 输出与 Node 警告共用一个 stderr 通道**。任何脚本化消费方（CI、agent、glama 探针）都会踩同样的坑。

**修复（两处都要）**：
1. `runCli` 增加 `NODE_NO_WARNINGS: '1'`（测试侧止血）。
2. CLI 在 `main()` 入口设置 `process.removeAllListeners('warning')` 或把警告重定向——更稳妥的是 **把成功 JSON 走 stdout、错误 JSON 也走 stdout 并配合退出码**，stderr 只留给人类可读诊断。这是 CLI 惯例，也顺带解决 Glama 探针解析问题。

---

### P2-2　`toctou_strike` 永不衰减，与 `retry_count` 的语义不对称

**实测**：`strike=1` → 提交非法 payload（`retry=1`）→ 文件再次变脏 → 直接 `POINTER_STALE (strike=2)`。

即便中间已成功完成一次「文件干净」的 fulfill 尝试，`toctou_strike` 也从不回落。这意味着**一个持单 30 分钟的审查者，只要累计被拒 2 次（无论是否已恢复）就死**，而 schema 重试额度却是可以「用掉一次、修好、过关」的。

建议：`toctou_strike` 在**任意一次 `verifyContract` 返回 valid** 或**任意一次非 TOCTOU 原因的 RETRY_NEEDED** 后回落为 0。这让它度量「当前是否处于脏状态」，而非「历史一共被拒过几次」。

---

### P2-3　`structured_output.fixes` 无准入约束，ADR-0004 的核心协议只靠口头约定

`src/schemas.ts:106-111` 里 `structured_output` 是 `z.record(z.unknown())`，`.describe` 提到 `fixes: [{ path, patch, description }]`，但**没有任何 schema 强制**。而 ADR-0004 §2.1 把它列为唯一合法的修复通道。

也就是说：声称的「审议分离协议」在参数层完全没有牙齿。若调用方漏传 `fixes` 或写错结构，只能靠上层 `contract_schema`（而它本身是 optional）。

**建议**（不阻塞 v0.3.0）：提供一个 `FixesChannelShape` 导出，让 requester 可以一键引用；或在 `fulfill` 检测到「`structured_output` 含 `fixes`」时，用内置 Ajv schema 做一次自校验，不合格则 `RETRY_NEEDED` 并给出正确结构示例。这会把 ADR-0004 从「文档规范」升级为「契约规范」。

---

## 4. P3 级发现

### P3-1　`index.ts` 中 8 个工具的描述段落结构不一致

`dispatch/poll/fulfill/inspect` 使用 `### Purpose / Usage Guidelines / Behavior & Side Effects / Return Value` 四段式；`release/extend/fail/verify` 只有 `### Purpose / Usage Guidelines / Behavior & Side Effects / Return Value` 中的后三段（缺 `### Purpose` 之外的独立小节编号一致性）。这不是内容错误，但 Glama 这类自动评分器按段落标题做结构化抽取时，不一致会导致部分工具取不到 Purpose。建议统一四段式。

### P3-2　`RELEASED_BY_HOLDER` 历史被 `slice(0, 2000)` 截断，尾部（最新）信息优先丢失风险

`engine.ts:724`：`? \`${releaseEntry} | prev: ${row.error_reason}\`.slice(0, 2000) : releaseEntry`

新原因拼在**头部**，因此 `slice(0, 2000)` 截掉的是**旧的**历史——方向是对的（保新弃旧）。但多次 release + 长 reason 会静默丢历史，且无任何标记。建议截断时在末尾加 `... (truncated)` 提示。

### P3-3　`schemas.ts:46` 的 `.describe` 列了敏感文件黑名单，但漏了 `credentials`/`secret` 两个实际生效的正则

`fingerprint.ts:10-11` 有 `/credentials/i` 和 `/secret/i`，`.describe` 里只写了 `.env, *.pem, *.key, id_rsa, .git/config`。调用方看到描述以为 `secret-config.ts` 可用，实际会被拒。建议描述里加一句「any path containing "credential" or "secret" is also rejected」。

---

## 5. 逐条回应工单的四个审查要点

### 5.1 Glama 结构化工具描述与 Zod 描述是否准确、完备？

**不完备，且有 4 处误导**：P1-3（verify 对终态说 Safe）、P1-4（dispatch 返回字段清单错误）、P0-1（Strike 1/2 二分实为单槽）、P3-3（黑名单漏项）。

正面评价：`fulfill_contract` 的描述是三段式里写得最好的一份——它把 `RETRY_NEEDED`、`POINTER_STALE`、`VALIDATION_FAILED` 三条失败分支都列进了 Return Value，这在 MCP 生态里不常见。`poll_next_task` 里那句 ADR-0004 的 "IMPORTANT" 提示位置也很好（agent 一领到单就看得到约束）。

### 5.2 CLI 的模式划分、错误拦截、stdin 管道与参数优先级是否存在边界漏洞？

**存在**：
- P0-2：`--mode=exec` 的重试循环吃掉 TOCTOU 豁免（最严重）
- P1-2：`dispatch` 的 `--agent` 覆盖失效（声称修复的 P2-1 未修全）
- P2-1：stderr 被 Node 警告污染，破坏 JSON 消费契约

实测**正常**的部分：`--version` 动态读 0.3.0 ✅；BOM 透明剥离 ✅；`--file -` / 位置 `-` / 自动管道识别均正常 ✅；`--mode` 与 `--once`/`--exec` 的非法组合全部有明确报错 ✅；`inspect` 的 ASCII 表格与 `--json`/`--format` 切换 ✅；未知参数提示带 `--help` ✅。

### 5.3 ADR-0004 软失败缓冲与 Pre-flight verify 状态机是否严密无死锁？

**状态机无死锁**（我逐条走了六条出边，未发现 CLAIMED 无法脱身的路径）。但**语义有洞**：

- 缓冲层数是 1 还是 2，代码与文档不一致（P0-1）
- 自动化路径下缓冲层数实际为 0（P0-2）
- 退单后 strike 残留，使「挽救」语义名不副实（P1-1）
- strike 永不衰减，与 schema 重试额度不对称（P2-2）

### 5.4 11 组端到端测试是否充分？

**不充分，且当前是红的**（P2-1）。具体缺口：

1. **11A 只测了「strike 1 缓冲」和「恢复后成功」**，没有断言「连续两次被拒的第二次行为」。若断言了，P0-1 会立刻暴露。
2. **没有任何用例覆盖 `worker --mode=exec` 下的 TOCTOU 路径**。P0-2 完全在测试盲区。
3. **没有用例断言 `release` 后 `toctou_strike` 的值**。P1-1 在盲区。
4. **11C 的 `--agent` 优先级用例只测了「位置 JSON + flag」**，且断言的是 `title` 而非 `requester_agent`，所以 P1-2 被漏过。

建议补 4 条断言：
```ts
// 补 1: 连续两次被拒
assert.strictEqual(secondAttempt.status, 'POINTER_STALE');
assert.strictEqual(retryCountBefore, 0, 'TOCTOU must not consume schema retry quota');

// 补 2: worker exec 路径不得烧掉豁免
assert.notStrictEqual(execOut.execution.status, 'POINTER_STALE',
  'auto-exec must not burn the single TOCTOU strike');

// 补 3: release 重置 strike
assert.strictEqual(afterRelease.toctou_strike, 0);

// 补 4: --agent 真正覆盖 payload
assert.strictEqual(repoRow.requester_agent, 'override_me');
```

---

## 6. 建议的修复顺序

| 顺序 | 项 | 理由 |
|---|---|---|
| 1 | **P0-2**（worker 重试循环） | 唯一会导致「无人值守下必然废单」的缺陷，且改动最小 |
| 2 | **P0-1**（strike 语义对齐） | 文档层改动，成本极低，但不做就会继续误导 agent |
| 3 | **P1-1**（release 清 strike） | 让 ADR-0004 的「挽救」承诺变成真的 |
| 4 | **P2-1**（测试转绿 + stderr 通道） | 不转绿，以上修复都无法证明有效 |
| 5 | **P1-2 / P1-3 / P1-4** | 描述准确性，直接对应 Glama 三项低分 |
| 6 | P2-2/P2-3/P3-* | 可进 v0.3.1 |

---

## 7. 附：本次审查的取证方式

全部结论均来自**实测**，未依赖仓库自身测试结论：

- 7 个指针文件 SHA-256 逐一校验，审查全程只读（`verify_contract` 在收尾时仍报 7/7 一致）
- 独立脚本构造引擎实例（`FerryCatEngine({ dbPath })` + 显式 `nowMs`），绕开 CLI 与测试框架
- 覆盖：脏指针连续 fulfill、release→re-poll→fulfill 链路、schema 与 TOCTOU 双计数器叠加、worker exec 自动路径、终态契约 verify、dispatch 返回结构、`--agent` 覆盖
- 最后实跑 `npx tsx test/run-all.ts` 确认基线状态（结果：11D 崩溃，套件红）

所有建议改动均以 patch 形式提交在 `structured_output.fixes` 中，**工作区指针文件未做任何修改**，符合 ADR-0004 审议分离协议。
