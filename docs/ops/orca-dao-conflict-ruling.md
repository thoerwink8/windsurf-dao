# Orca × dao 冲突优先级裁决（issue #299）

> 🔺 **2026-08-11 修订（前提已变，见下面「修订版处置」节）**：用户拍板**编排底座从 Claude Code CLI 迁向 Orca**（四取向：帅位 Fable+Opus 质检官 / 质量门轻量化+门阀机制化 / issue 主账+Orca 回写 / 一步切换）。本文原版按「两套并存、撞上听谁」的旧前提写成——新前提下冲突性质改变：**不是裁决优先级，是 dao 派单层向 Orca 迁移**。原版各条保留作历史与过渡期依据，迁移完成前**过渡期规则仍然有效**；迁移落地后以下面修订表为准。完整架构提案见探索报告（`_tmp/orca-orchestration-explore.md`，未入库）。

> （原版前提）2026-08-10 装进来的两个 Orca skill（`orchestration` / `orca-cli`）与 dao 派单规则在 6 处重叠、其中 2 处硬冲突。用户当日拍板：**现场不隔离**（两个 skill 继续留在 `~/.claude/skills/` 生效，不移出、不改 frontmatter）。本文件是那 6 处的处置结论与优先级裁决——**不修任何一边的文件，只立「撞上时听谁」的规矩**。
>
> 适用范围：windsurf-dao 仓（已实测为 Orca 托管 project/repo，见 #299 补证据评论）。裁决逐条写明理由与剩余风险，不是和稀泥的「两边都对」。

---

## 修订版处置（2026-08-11 · 新前提：迁移，不是并存）

| # | 旧裁决（并存前提） | 修订（迁移前提） |
|---|---|---|
| ①派活（硬） | dao 为默认，Orca 走显式 | **反转**：目标态 Orca 是默认底座；「dao 优先」只剩过渡期意义，迁移完成后 Claude Code subagent 派官降级为非 Orca 环境备选 |
| ③handoff（硬） | 永不默认 full handoff | **保留且强化为架构默认**：dao 语义的「交给另一个 agent」= **supervised dispatch**（要验要等）；落实形态是帅侧固定动作「凡派活必走 task-create + worker-start」，让 supervised 成为结构事实而非措辞解释。full handoff 只剩「用户显式说派完不用管」一个合法场景 |
| ②worker_done 自动终态 | 改判不冲突，各管各账本 | **转正为架构组件**：终态归 Orca DB 记账；终审归 gate + 帅手 `gh pr merge`（动作权从不在任何状态机里） |
| ④worktree 谁建 | 默认 orca worktree create | **转正**：本仓托管默认不变；非托管仓照旧 `git worktree add` |
| ⑤自动调用不对等 | 不处理，用裁决覆盖触发 | **消解**：迁移完成后 dao 侧没有「等被触发」的派单 skill，触发层问题消失 |
| ⑥两套账本 | 桥接约定 | **转正为分工**：issue=工作项真相源（人读、跨机、拍板留痕），Orca DB=执行运行态（机器跑）；完工回写 issue 是帅 Delivery 处理环的固定一步（不 ack 重放兜住「漏回写」） |

**过渡期规则（迁移完成前有效）**：旧版正文各条照旧——dao 为默认、Orca 走显式；永不默认 full handoff；记账归 Orca、终审归 dao。防的是迁移未完成时两套混用各跑一半。

---

## 原版正文（2026-08-10 · 并存前提，留作历史与过渡期依据）

## 一句话总纲

**dao 为默认，Orca 走显式。** 用户没有点名 Orca 概念时，一切「派活 / 交接 / 建树」按 dao 流水线走；用户显式说「用 Orca / 建 Run / 起 worker / task-create」时，走 Orca 全套且中途不混用 dao 官种顶替它的 dispatch。

---

## 两处硬冲突的裁决

### ① 派活：`orca orchestration task-create + worker-start` vs dao 的 `Agent` 工具派官

**裁决：默认听 dao。** 同一句「把活派给另一个 agent」命中时：

- **默认路径** = dao 派单流水线：`Agent` 工具 + `dao-implementer` 等官种 + 派单令首行 + 三节点留痕 + 验流水线。
- **Orca 路径只在两种情形下启用**：(a) 用户显式点名 Orca 概念；(b) 任务本质是跨 worktree / 跨终端的长跑编排（dao 官种覆盖不了的形态，如「起一个终端让它自己跑一晚上」）。

**理由**：dao 的派官不是「派活工具」而是本仓质量门的载体——对抗验证前置、终审不可让渡都挂在它上面；换成 Orca dispatch 这些语义全丢。Orca 手册那句「不要拿非 Orca 的 subagent 工具替代」的适用前提是「你已经在跑一个 Orca Run」，不能反推成「任何时候都禁止原生工具」。**例外是真例外**：一旦进了 Orca 路径（已建 Run），该 Run 内的派活就必须用 Orca 原语（task-create / worker-start），不拿 dao 官种顶替——手册那句话在这个范围内是对的。

### ③ 「交给另一个 agent」被 Orca 判成 full handoff（不追踪 / 不等结果 / 不读输出）

**裁决：在 dao 语境下，永不默认 full handoff。** 「交给另一个 agent」「给另一个 worktree」这类说法**一律按 dao 语义处理**：派出去 → 等结果 → 走验流水线。full handoff（不建追踪、不等完成、不读输出）只在用户显式表达「派完不用管 / 全权移交 / 不用等它」时才成立。

**理由**：full handoff 放弃的是验证，而「未验不声明、验证不可跳步」是本仓交付物的根基，没有等价物可让渡。用户「先放着」的拍板接受的是**误判风险**，不是授权 AI 主动选择不验证。**剩余风险照直写**：Orca 的 frontmatter 触发词照样宽，skill 照样可能被加载——本裁决管的是「加载之后听谁的」，管不了「会不会被加载」（那是冲突 5，见下，判定不处理）。

---

## 四处非硬冲突的处置结论

### ② `worker_done` 自动流转终态 vs dao「终审不可让渡」——**重新定性：不冲突，各管各的账本**

原标「疑似」，缺的一格是「协调者会不会因任务已 completed 而跳过对抗验证」。本裁决**用一条明文规则把这格填掉**，不再留作开放问题：

> Orca DB 里任务状态怎么记账，归 Orca（`worker_done` 自动流转照它的来）；交付物能不能合并，归 dao（对抗验证 + 帅手终审，一样不少）。**即使 Orca 侧已 completed，合并前的验证一步不许跳。** 记账终态 ≠ 质量终审。

两边作用对象本就不同（一个是任务追踪 DB，一个是合并判据），「疑似」来自于把两个「终态」读成了一个。现定性：**软重叠，规则已分界，不需改任何文件**。

### ④ worktree 由谁建 —— **重新定性：条件成立，默认 Orca**

#299 补证据评论已坐实前提：`D:/frank/windsurf-dao` 是 Orca 托管仓，`orca-cli` 那句 "Prefer this over raw `git worktree`" 在本仓条件成立。裁决：

- **在本仓内新建需要被追踪/可能要起 agent 的工作树 → 默认 `orca worktree create`**（Orca 建的树它才看得见，才能挂 worker、报状态）。
- **原生 `git worktree add` 保留给显式例外**：纯临时实验树、测试沙盒、一次性验证树——不需要 Orca 追踪的，不必进它的账本。
- dao 五步仪式里的 `git worktree add` 一句，在本仓读作「建一棵树」，具体命令按上两条选；**在非托管仓，dao 原文照走**（本裁决只覆盖本仓）。

剩余一格未坐实（Orca 是否**强制**托管仓子树必须走它）不影响这个默认：Orca 建树成本不高于原生，选它不是被迫，是顺手拿到追踪能力。

### ⑤ 自动调用权不对等（dao 的 worktree skill 关了自动调用，Orca 两个没关）——**判定：不处理，用裁决覆盖触发**

理由三条：

1. 用户已拍板现场不隔离、不改 frontmatter——改 Orca skill 的 frontmatter 不在可选动作集里。
2. 真正的风险不是「两个 skill 被同时加载」，而是「同时加载后听谁的」——后者已由硬冲突①③的裁决覆盖。**触发层管不住，就在判断层管住。**
3. Claude Code 多 skill 同时命中时的选择算法是宿主行为，本仓改不了；为它写规避文字属于无标记时刻的自由裁量条款，实测携带率 9–24%，写了也是加厚。

### ⑥ 两套认领账本互相看不见（`dao-claim:` 在 GitHub 评论，Dispatch 状态在 Orca 本地库）——**判定：软重叠，立一条桥接约定，不改代码**

> 凡经 Orca 派出去处理一张 dao 追踪的 issue：派活人（帅）负责在该 issue 评论补 `dao-claim:`，并把 Orca 的 taskId/dispatchId 写进同一条评论。dao 侧的标签与评论永远是工作项状态的**唯一真相源**；Orca 的 Dispatch 状态只是它自己那台机器上的执行账本，不作为「这张单有没有人认领」的判据。反向防撞：Orca 派单前先看目标 issue 有没有 `dao-claim:` 或 `在途` 标签。

---

## 未尽处现状（从 #299 继承，本次未推进）

- **本会话进程是否跑在 Orca 内嵌终端里**：仍未验（仓与 Orca 的托管关系已确认，进程关系是另一格）。
- **`worker-start --agent claude` 的合法性与叠加效应**：未实测（会真建 worktree/终端、消耗额度，且正是硬冲突触发场景）。被 spawn 的 Claude Code 会同时背着 dao 场域（经 `~/.claude/CLAUDE.md` 的 `@import`）和 Orca 注入的 lifecycle preamble，两层规则在 worker 内是否打架——**开着，等真要用 Orca 起 Claude worker 的那天再验**。
- **orca-cli 完整手册**：只有发现存根 + 406 行 orchestration 手册；cardStatus / artifacts / browser 自动化无原文可引。不影响本裁决（那些面与 dao 无重叠）。

## 本裁决不做什么（边界）

- 不改 `~/.claude/skills/` 任何文件（用户拍板保持现状）。
- 不改 dao 侧任何规则文件（裁决是「撞上时听谁」，两边原文各自保持）。
- 不实测 Orca 写路径（task-create / worker-start / worktree create）——那要制造真实运行态，留给真正要用它的那天。
