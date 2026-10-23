# Phase B (v0.3.0) 终审复核报告

- **工单**：`fc_1792767612136_608fbd67`（`antigravity` → `workbuddy`，`architecture_audit`）
- **审查对象**：上一轮审计（commit `4444c16`，报告 `docs/audits/2026-10-23-phase-b-review_zh.md`）所列 P0×2 / P1×4 / P2×1 / P3×3 的修复落地情况
- **审查方式**：白盒静态核验 + 独立行为探针复验 + 全量测试套件
- **指针基线**：7/7 全部匹配（`verify` 返回 `valid: true, fulfillable: true, dirty_files: []`），审查全程严格只读
- **结论**：**`approved`** —— 8 项声明的修复全部真实闭环；另有 3 项本轮新发现，其中 1 项（P2-1 只修测试侧）建议在同一 PR 内补掉

---

## 一、指针基线与审查纪律

| 文件 | size | SHA-256 前缀 |
|---|---|---|
| `src/cli.ts` | 41630 | `4f1c4fcc0cb4` |
| `src/engine.ts` | 39237 | `3c0d5ff70261` |
| `src/index.ts` | 18890 | `2a0420237dd5` |
| `src/schemas.ts` | 8981 | `b80ae6faeee0` |
| `src/types.ts` | 5266 | `e587f04b83d3` |
| `docs/adr/0004-…toctou-buffer.md` | 6610 | `d9caae275228` |
| `docs/adr/0004-…toctou-buffer_zh.md` | 8074 | `11cc16dce7db` |

审查期间对 7 个指针文件保持**只读**，所有修复建议以 patch 文本交付（`structured_output.fixes`），未对工作区产生任何写入。这是对第二轮事故（边审边改导致 `TOCTOU_SIZE_MISMATCH`、工单被判 `POINTER_STALE`）的直接纠偏。

---

## 二、八项声明修复的逐项对账

方法论：**不以测试 GREEN 作为闭环依据**。每一项都写了独立的行为探针，直接观察数据库状态与返回值，再与声明对照。

### P0-1 `MAX_TOCTOU_STRIKES` 计数语义与文档措辞

**声明**：`engine.ts:54` 补精确计数注释；`index.ts:171` 把 `Strike 1 / Strike 2` 改为 `exactly ONE recoverable rejection`。

**核验**：`engine.ts:54-64` 的注释块已明确区分 `attempt N <= MAX_TOCTOU_STRIKES → RETRY_NEEDED` 与 `attempt N > MAX → POINTER_STALE`，并显式警告「Do not describe this as "Strike 1 and Strike 2" as though two independent chances existed」。`index.ts:171-175` 已改为 `exactly ONE recoverable rejection`，并追加「restore/stash the files BEFORE retrying, and call verify_contract first so a stray second attempt cannot burn the buffer」。

**独立探针**：

```
attempt#1 -> RETRY_NEEDED   strike=1/1
attempt#2 -> POINTER_STALE  strike=2/1   salvaged=PRESENT
```

行为与文档表述**完全一致**：只有 1 次可恢复拒绝，第 2 次即终态且 payload 已保全。**闭环。**

### P0-2 `worker --mode=exec` 的 TOCTOU 重试分流

**声明**：`cli.ts:622` 增加 `(toctou_strike ?? 0) > 0 && (retry_count ?? 0) === 0` 判定，直接返回 `TOCTOU_RESCUE_REQUIRED`，工单保持 `CLAIMED`。

**核验**：`cli.ts:624-645` 实现与声明一致。关键在于代码里把 `RETRY_NEEDED` 的两个异质成因显式分开了——schema 校验失败会推进 `retry_count`，TOCTOU 脏指针不推进——这个区分是修复的核心，不是可选的优化。

**独立探针**（真实 `worker` 调用，非单元级模拟）：

```
worker --mode=exec -> status: TOCTOU_RESCUE_REQUIRED
                   -> contract.status: CLAIMED
                   -> toctou_strike:   1
```

自动化路径下不再消耗第 2 次 strike、不再把工单打成终态。上一轮指出的「缓冲在自动化路径下等于不存在」已被消除。**闭环。**

### P1-1 `releaseContract` 重置 `toctou_strike`

**声明**：`engine.ts:735` 的 UPDATE 增加 `toctou_strike = 0`；`run-all.ts` 11B 增加断言。

**核验**：`engine.ts:742` 确认存在 `toctou_strike = 0`。`run-all.ts:1222` 断言真实存在：`assert.strictEqual(afterReleases.toctou_strike, 0, ...)`。

**独立探针**：

```
holder A 消耗 1 次 strike -> release
  -> after release: toctou_strike = 0
  -> re-poll:       CLAIMED (by holder B)
  -> holder B fulfill: COMPLETED (未继承前任处罚)
```

持有者级配额隔离成立。ADR `§4.3` 第 3 条也补了对应的设计论证（`toctou_strike` 与 `extend_count` 同属 Holder-Level 状态量）。**闭环。**

### P1-2 显式 `--agent` 在 `dispatch` 下被静默丢弃

**声明**：`cli.ts:363` 在 `command === 'dispatch'` 时把 `--agent` 注入 `requester_agent`。

**核验**：`cli.ts:363-369` 实现正确。旧守卫 `cli.ts:1000` 仍保留但已成为无害的兜底。

**独立探针**（双向）：

```
显式 --agent override_me  -> requester_agent = override_me   ✓
不传 --agent（DB 有 keepme） -> requester_agent = keepme     ✓
```

双向都对——既修好了「显式值被丢弃」，也没有把「未显式传值时应当继承」的行为破坏掉。**闭环。**

回归面额外确认：`poll` / `verify` / `fulfill` 的 `--agent` 未污染 `requester_agent`，注入被正确限定在 `dispatch` 分支内。**闭环。**

### P1-3 `verifyContract` 不判 `row.status`

**声明**：`engine.ts:925/931/936/948` 增加 `fulfillable`，对非 `CLAIMED` 契约分流 message。

**核验**：`types.ts:164` 同步补了 `fulfillable?: boolean`（否则会 TS2353）。

**独立探针**：

```
status=CLAIMED -> valid=true, fulfillable=true,  "Safe to fulfill."
status=FAILED  -> valid=true, fulfillable=false, "…but contract status is 'FAILED' and it can no longer be fulfilled. …"
```

`valid` 与 `fulfillable` 的语义分离正确：`valid` 只说指针没变，`fulfillable` 才说能不能交。**闭环。**

### P1-4 `dispatch_contract` Return Value 字段虚报

**声明**：`index.ts:97` 把声明的 12 字段更正为实际返回的 6 字段（5 必需 + 可选 warning）。

**核验**：已改为 `{ contract_id, status, created_at, files[], warning? }`，并显式注明「requester_agent / target_agent / task_type / title / TTLs are NOT echoed back — read them via inspect_mesh_state if needed」。**闭环。**

### P2-1 测试套件 11D 崩溃

**声明**：`run-all.ts:1262` 的 `runCli` 增加 `NODE_NO_WARNINGS: '1'`。

**核验**：改动存在，测试从红转绿。**但见第三节 N-3——这只是修了症状，不是根因。**

### P3-3 `path` 字段描述补敏感文件清单

**声明**：`schemas.ts:46` 补 `.env*` / `*.pem` / `*.key` / `id_rsa*` / `*credentials*` / `*secret*` / `.npmrc` / `.git/config` 与路径逃逸的拒绝说明。

**核验**：文本与实现一致。**闭环。**

### 超出声明范围：P3-1 段落一致性也已完整修复

工单未认领 P3-1，但实测 8 个 MCP 工具**全部**统一为四段式（`### Purpose` / `### Usage Guidelines` / `### Behavior & Side Effects` / `### Return Value`），行位分别在 79-96、120-135、160-178、202-219、260-276、287-302、313-327、338-352。这是主动加分项。

---

## 三、本轮新发现（3 项）

### N-1 `P2` — `cli.ts:122` help 文本与 P1-1 修复直接矛盾

`release` 的帮助文本仍是：

> `Preserves contract-level retry_count and toctou_strike; resets holder extend_count. Max 3 releases.`

而 P1-1 的修复已经让 `releaseContract` **清零** `toctou_strike`。同一个「文档与实现脱节」的问题（P1-4 刚修过那一类）在本次修复中**再次发生**，且方向相反：这次是文档没跟上代码。

值得注意的失效模式：`--help` 是 agent 与人类运维读到的第一手契约文本。按旧文本理解，持有者会以为「strike 会被保留，所以退单救不了我」，从而放弃 release 这条合法挽救路径——恰好把 P1-1 刚打开的逃生门又关上。

### N-2 `P2` — `index.ts:353` verify 的 Return Value 未补 `fulfillable`

P1-3 新增了 `fulfillable` 字段，但 MCP 工具描述的 Return Value 仍是旧字段表，**完全没有 `fulfillable`**。

这是比 N-1 更实质的问题：agent 依据工具描述决定代码怎么写。描述里没有 `fulfillable`，agent 就会继续用 `valid` 判断能否 fulfill，而 P1-3 修复的全部价值恰恰在于「`valid=true` 但 `fulfillable=false`」这个必须区分的场景。修复在引擎层正确，但在**协议层不可见**，等于对 agent 无效。

### N-3 `P1` — P2-1 只修了测试侧，真实消费方仍在踩坑

这是本轮最重要的一条。`runCli` 加 `NODE_NO_WARNINGS` 让测试绿了，但 CLI 二进制本身的 stderr 依旧脏。

**实测证据**（真实 CLI 调用，非测试环境）：

```bash
$ node --experimental-sqlite bin/ferrycat-cli.js fulfill --id not-a-uuid --agent ag --summary ok 2>err.txt
$ cat err.txt
(node:7744) ExperimentalWarning: SQLite is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where the warning was created)
{
  "ok": false,
  "error": "Contract \"not-a-uuid\" not found."
}
```

模拟脚本化消费方：

```
JSON.parse(stderr) -> 解析失败 -> Unexpected token '(', "(node:7744"... is not valid JSON
```

**根因**在 `bin/ferrycat-cli.js`：子进程用 `stdio: 'inherit'` 继承了父进程的 stderr，而 `--experimental-sqlite` 让 Node 把警告打到**同一个通道**。stderr 是 CLI 机器可读契约的一部分（错误 envelope 就写在里面），现在是「警告 + JSON」混流。

装上 F3 后同一个调用：

```
stderr bytes: 67   ExperimentalWarning: 0
JSON.parse OK -> {"ok":false,"error":"Contract \"not-a-uuid\" not found."}
```

**为什么这条给 P1 而不是 P2**：11D 原本就是被这个真实缺陷打红的。在测试侧绕过它，等于把一条真实的生产缺陷登记为「已修复」。任何用 shell 脚本消费 FerryCat 错误输出的自动化（CI 钩子、别的 agent 的 wrapper）仍然会崩。测试变绿只证明了测试环境干净，没证明产品干净——这是必须指出来的。

修法成本极低（1 处 8 行改动），且在入口统一处理比在 N 个测试工具函数里各打一遍补丁更正确。建议同 PR 内补掉。

---

## 四、测试与验证记录

- `npm run build`：通过
- `npx tsx test/run-all.ts`：**全 11 组 GREEN**，含新增的 9B(`toctou_strike===0`)、11D(`TOCTOU_RESCUE_REQUIRED`) 断言
- 独立性说明：3 个 patch 先在 `.tmpv/` 副本上 `patch --dry-run` → `patch` → `tsc --noEmit`（零错误）→ 全量测试（11/11 GREEN）四关验证，确认可安全应用且无回归后才写入报告
- 上一轮 patch 生成踩过的坑（手工算 hunk 导致 `malformed patch`）本次改用精确子串定位 + 自动 hunk 计算；过程中 F2 首版因反引号/单引号未转义破坏模板字符串，被 `tsc` 拦下后重写——这条也反过来验证了「patch 必须过编译」这一步不能省

---

## 五、终审结论

### `verdict: approved`

**判 `approved` 而不是 `changes_requested` 的理由：**

工单请求的是「核验上一轮指出的 P0×2、P1×4、P2×1、P3×3 修复代码与测试覆盖情况」。逐项对账的结果是：**8 项声明的修复全部真实落地，且经独立行为探针验证效果成立，没有一项是「改了代码但行为没变」或「只在测试里成立」**。P3-1 还额外做了。从「声明 → 交付」的契约履行角度看，这一轮是干净的。

**为什么仍要强烈建议同 PR 补 N-1/N-2/N-3：**

这三条不是对已交付修复的否定，而是修复**投影到协议层时掉了链子**，且是同一个根因的三次显影——**实现改了，契约文本没跟上**。具体地：

1. N-1 和 N-2 都是「代码已改、面向 agent 的描述未同步」。上一轮 P1-4 修的就是这一类，本轮又出现两例，说明缺的不是某处笔误，而是**缺少一个把「工具描述 / help 文本」纳入同一变更集的自检环节**。建议在 CI 里加一条：新增或修改返回字段时，`grep` 该字段名是否出现在对应的 `index.ts` Return Value 段。
2. N-3 更值得警惕，因为它让「测试 GREEN」这个信号本身失真了。把生产缺陷在测试侧绕过，长期看比缺陷本身更危险——下一个人会相信 11D 通过意味着 stderr 是干净的。

三条都不阻塞 v0.3.0 的架构成立性（状态机与 TOCTOU 语义是对的），属于**发布前应收尾**而非**回炉**。因此 `approved` 附条件：**建议在 v0.3.0 tag 之前吃掉 N-1/N-2/N-3，尤其是 N-3。**

### 修复清单

| 编号 | 严重度 | 位置 | 动作 |
|---|---|---|---|
| N-1 | P2 | `src/cli.ts:122` | release help 文本改为「RESETS toctou_strike」，并点明 ADR-0004 §4.3 持有者级隔离 |
| N-2 | P2 | `src/index.ts:353` | Return Value 补 `fulfillable: boolean`，并写明 `valid` 与 `fulfillable` 的判据差异 |
| N-3 | P1 | `bin/ferrycat-cli.js:16-21` | 子进程 env 注入 `NODE_NO_WARNINGS=1`（保留 `FERRYCAT_SHOW_NODE_WARNINGS=1` 调试开关） |

三处 patch 见 `structured_output.fixes`，均已在副本上验证可干净 apply、`tsc` 零错误、11/11 测试 GREEN。
