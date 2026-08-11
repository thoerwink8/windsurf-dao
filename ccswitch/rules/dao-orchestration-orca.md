# dao × Orca 编排层（派单与收活的唯一真相源）

> 一句话：派单走 Orca 结构化通道一条命令，收活走出口门阀五道秒级门，中间夹一层
> 「动态编排策略」——谁干什么由开机探测 + 用户拍板定，不靠记忆里的固定表。

本层管的事：协调者（主会话）怎么把活派给 worker、worker 干完怎么交、交的东西凭什么算数。
不管的事：为什么要派这活（那是 issue 层）、worker 干活时怎么思考（那是条款层）。

前置阅读（动手派单前）：`_tmp` 时代已归档 ⇒
`docs/decisions/2026-08-11-orca-orchestration-explore.md`（机制地图 v3，四个本可以不死 + 结论A/B）。
背协议细节再查 skill：`~/.agents/skills/orca-cli/`。

---

## 一、动态编排策略（2026-08-11 用户拍板追加）

**档位=固定模型表的时代结束。** 谁干什么由三样东西现算：任务性质 × 开机探测 roster × 成本。

### 1. 开机探测：先探测，再提案

```powershell
node scripts/dao-roster.mjs    # 一行 JSON：编排织物（orca）活不活 + 各执行体 CLI 在不在
```

探测面刻意含**编排织物本身**：orca 挂了 ⇒ roster 里 `fabric.orca.available=false` ⇒
分配方案里自然只剩原生 Agent 路径。**断供预案就是探测本身**，不另写双轨文档（拷问局定案②）。

### 2. 策略提案：协调者拟方案，用户拍板

接到一批活，协调者按「任务性质 × roster × 成本」拟分配方案，用 AskUserQuestion 呈用户拍板后开派。
任务性质的常用三档：侦察/审计类（便宜模型足够）· 实现类（要强模型）· 对抗验证类（要换个模型当外人）。

提问模板样例（选项组织照这个形态，第三个选项是防打扰的关键）：

```
本批 3 单拟分配（roster: orca✓ claude✓ codex✓ pi✗）：
❶ 条款库审计（侦察）→ deepseek-v4-flash（便宜，量大）
❷ 出口门阀实现（实现）→ claude-sonnet
❸ 合并链对抗验证   → codex-gpt5.5（当外人）

选项：
A. 照此派
B. 调整（说明哪单换谁）
C. 照此派，且本窗口同类活照此办 ← 问一次管一窗
```

**防打扰**（用户原话的落点）：选项 C 让一次拍板管一窗；小活（改错字、跑个脚本这类）
直接走已确认的默认，不逐个问。换机器只是探测结果变，策略逻辑不变。
**触发粒度（2026-08-12 用户拍板）＝只在派单类任务弹**（批量/并行/要交付 PR 的）；协调者亲手一次
Edit 级小活与纯问答不弹。

### 3. 回退红线（拷问局定案①，无条件生效）

出现任一 ⇒ **停新单、回评架构**，不许硬扛：
- 出口门阀连续放过 2 个后来才被抓的真缺陷；
- 单窗编排折腾时间 > 干活时间。

### 4. 重大单向门决策：可先 /grill-me 一轮

「单向门」= 拍板后难回退的决策（删库表、退役机制、换部署形态这类）。
拍板前**可**跑一轮 `/grill-me`（决策树逐轮拷问：查事实归 AI，做决定归用户）——
这是可选项不是强制仪式：问题已经想得清楚的直接拍，只在大分叉前用。
今天这场重设计本身就是用法实例（grill 八问 ⇒ 本节定案）。

---

## 二、派单（结论 B：一条命令）

```powershell
node scripts/dao-orch.mjs --role implementer --spec-file <路径> --title "<标题>" \
  --skills orca-cli --dry-run   # 先看渲染出的完整 spec，确认后去掉 --dry-run
```

这条命令替协调者做完：按 worker 类型渲染条款进 spec → 建 Orchestration 任务 → 起 worker。
产物落点：worktree 在 `<repo>-workers\<任务名>`，分支 `orca/<任务名>`。

spec 四段式骨架（按此写，条款段由 dao-orch 自动渲入）：

```
背景：一段说清来龙去脉。
范围（改这几处）：文件级清单。
约束（不许碰）：禁项 + 边界。
验收：跑哪条命令、exit 0 才算过；完工交 exit-gate 交活单。
```

铁律（每条都有尸检报告，见探索报告痛点矩阵）：
1. **派单只走 Orchestration 通道**（结论 A），禁手建 worktree+终端的散装路。
2. spec 一次给全（背景/范围/约束/验收四段），缺一段就是下一轮往返。
3. **dispatch 上下文 worker 拿不到**——交回的东西必须落盘成文件，worker_done 只报路径。
4. 开工契约占 spec 开头：分支名、唯一停手点、worker_done 契约（3 句、taskId+dispatchId、--outcome、--files-modified、--report-path）。
5. orca CLI 只信 `--json` 出口；`report read` 拿不到正文要落 `task_claim_error`。
6. worker 体内没有 AskUserQuestion（会挂死）；要问走 `orca orchestration ask`。
7. **底座缺省 = Orca 编排**（#299 裁决，2026-08-11 用户拍板「编排底座整体迁 Orca：Fable 主会话做协调，
   派活/收活/观测走 Orca」，裁决正文 `docs/ops/orca-dao-conflict-ruling.md` 修订版处置表）：
   **供审查/追踪的供给线走 `orchestration`**（task-create + worker-start 的 supervised dispatch，要验要等，
   是结构事实不是措辞解释）；**完全移交走 `orca-cli`**（仅剩「用户显式说派完不用管」一个合法场景）；
   **Claude subagent 降为非 Orca 环境备选**，只保留给轻量读码与 dao worker 类型条款强绑定的场景。
8. **陌生执行者名先查环境再问，禁静默替换成最像的已知档**（#312 方向，2026-08-12 用户确认）：
   「执行者」是内容决定的字段，只有环境知道本机有哪些执行者——用户点名一个执行者而协调者不认识时，
   次序固定：①先查环境（orca 可用 agent 面 / 已装 skill 清单 / `scripts/dao-roster.mjs`）②仍不识再
   AskUserQuestion ③**无论如何轮不到静默替换**（替换执行者=判断档，改用户可见面的取舍，须问）；
   「worker / 派 worker」语义 ⇒ 优先本编排通道。

## 二½、观测与打回（issue #304，2026-08-11 首日实战沉淀）

- 观测走织物内置通道：日常 = `worker-show`（状态+终端预览）+ 心跳 + 提交流三样，不翻别的。
- `worker-read` 只对 claude/codex 族是深通道；对 pi 降级（provider_unsupported，只吐有界终端尾巴）。
- 直翻 worker 的会话文件只作事故取证的最后手段，不作日常观测面。
- 给已有终端挂任务必须显式 `--worktree` 选择器（默认瞄协调者所在树，会报 mismatch）。
- 打回用 `terminal send`，且排在 `worker-release` 之前（空闲 worker 不查收件箱；release 会关终端标签页）。
- `check --wait --types` 只认 `worker_done,escalation`（没有 `ask` 这个类型名）。
- 探测即预案：每次派单先跑 roster 探测，AskUserQuestion 只呈现真实可选项（定案②）。

## 三、收活（出口门阀）

worker_done 不是验收，只是铃响。验收 = `scripts/dao-exit-gate.mjs` 五道秒级门
（格式 / 凭证边界 / 卫生+guardEvidence / 限时重放），契约见该脚本头注。
人工最终审核不退役——门阀只抬门槛，判断仍是人的。

合并链的验证步走**改谁才检谁**（tests 终局拍板）：`dao-pr-merge.ps1` 在本仓免传
`-VerifyCommand`——`scripts/dao-affected-tests.mjs` 按 diff 映射受影响的留守测试套
（碰了某 hook 才跑它那套，秒级；没碰闸一套不跑；判不出 diff 时 fail-closed 跑全量）。
映射表住脚本里不住文字，加删留守套时同步改它。

## 四、grill 技能的归位（2026-08-11 用户拍板引入）

`grilling` / `grill-me`（Matt Pocock 原版，MIT）收进 `ccswitch/skills/` 随 `link-claude`
部署——拷问局是决策机制的一部分，该随 dao 走，换机自带。
用法锚点只有一处（上面 §一.4），不撒引用。

## 五、已知边界（照直写）

- 探测是 spawn `--version` 级别的——CLI 在 PATH 才算在；装在别处的执行体探测不到（标 absent，不猜）。
- 「本窗口同类活照此办」是窗口内约定，没有跨窗持久机制（刻意：持久化会再长出配置账）。
- Orca 静默失败面（结论 D）未被编排层治愈——worker_done 发送失败仍可能无声，出口门阀的
  「凭证边界」门只能事后兜底。收件箱活跃清扫的架构性修复未做（探索报告 §12）。
