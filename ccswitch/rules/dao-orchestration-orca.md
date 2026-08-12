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
**选项自动驾驶（2026-08-12 用户拍板）**：分工拍板时可同批授予「本窗选项按推荐自动走」——
此后只有真分歧、推荐拿不准才弹问，其余以「已按推荐选 X」状态陈述留痕、随时可叫停。
**永不自动的四类**：单向门、密钥/权限面、生死裁决（删留判决）、用户体感偏好题。

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

## 二、派单（Orca 推荐模式 · 用户 2026-08-12 拍板全体系遵守）

**flags 与子命令的唯一真相源是版本匹配指南**：动手前跑 `orca skills get orchestration` 现查——
它由将要执行你命令的那个二进制自己吐出，永不漂移。本文件刻意不背参数表（内容决定的字段只写去哪查），
只固化**模式本身**：

1. **一次绑定 Run**（`run-create --objective`），**先建全部独立 Task**（`task-create --spec`），再起工兵。
2. **树的谱系跟随工作独立性**（指南原话判据）：独立关注点/独立修复 ⇒ 各开 `new-top-level` 树，
   一分支＝一关注点＝一 PR；概念上叠在当前工作之上、依赖它的 ⇒ `new-child`；**同一交付物拆给多工兵
   且文件面不相交** ⇒ 同一棵树里 `worker-start --worktree <该树>` 加终端（指南自己的示例就是同树
   双工兵）。Orca 明说**不替你推断冲突**——同树多工兵先把文件 ownership 划死，写同一文件必互踩。
3. **工兵一律 `worker-start` 起可见终端**（组合 worktree+终端+就绪+派单一步到位）——pi 等外族工兵
   尤其如此：可见标签页，不起无头后台。模型/思考档随 `--model`/`--effort` 传——**只对
   Claude/Codex/Cursor 的新起终端生效**（pi 等不吃这两个 flag，指定 provider/model 走低层配方），
   `--effort` 必须搭配 `--model`，两者都不能与 `--terminal` 复用同传。**读回执**
   （`launch.effective`、setup 状态）再继续，失败看 `stage`/`effects` 不盲重试。
   **Claude 族工兵就绪后，同一分钟内切到 auto mode**（用户 2026-08-12 拍板：新工兵默认 auto mode；
   `worker-start` 没有这个参数）：worker-start 一返回就连做——`--enter` 补一发（回车常被吞）→
   `orca terminal send --text "<ESC>[Z"`（Shift+Tab 的 PTY 编码，PowerShell 写 `"$([char]27)[Z"`）
   循环 manual→accept edits→plan→auto，**每按一次读屏核对屏底状态行**，见「⏵⏵ auto mode on」才停手。
   窗口期功能无害（工兵读完任务书才发第一条命令），但**别把烧起来没有的观察排在切模式前面**——
   那会把窗口拖到用户眼皮底下。审批弹窗挂着时按了不生效，先答掉弹窗再切；pi 等外族无此芯片，跳过。
   **零窗口的两条路（写 worktree 级 `.claude/settings.local.json` 的 defaultMode / `claude
   --permission-mode bypassPermissions` 起进程）2026-08-12 实测均被宿主权限分类器拦死**——权限面
   归用户，AI 不绕；用户一次性授权后才可改走（拍板记录见 issue #324）。
4. **收活循环**：`check --wait --types worker_done,escalation,question` → 逐条处理 → 同一工兵有接续任务
   用 `worker-start --terminal <handle>` 转交，否则 `worker-release`（成败都释放，用户明说留才
   `worker-retain`）→ 全处理完才 `--ack`。超时/TUI 空闲/心跳/status/question/escalation/被拒或过期的
   worker_done——这七样都不是释放理由。
   **合并链的 -RepoPath 禁手抄，从 PR 反查**（2026-08-12 实咬：两棵 `dao-batch-*` 树只差一词，
   语境切换时手打抄串，被脚本基点核对拦下）：`gh pr view <N> --json headRefName` →
   `orca worktree show --worktree "branch:<head>"` 取 `.result.worktree.path` 传给脚本
   （`worktreePath` 是 terminal show 的字段名，两者不同——首跑就取错过一次）——凡是能从
   真相源推导的值都推导，不转写。
5. **恢复条件化**：`worker-show` 判 ready（继续等）/ failed·stopped（`--retry-of` 重起，位置显式重选不默继承）/
   outcome_unknown（stop 后再查或显式 abandon），同一 task 连败 3 次 dispatch 自动熔断。
6. **禁替代**：说了走编排就必须有 task/dispatch 出处（`task-list`/`dispatch-show` 查得到）；
   用非 Orca 途径起的工兵不许事后描述成「已编排」。worker-start 表达不了的自定义 argv
   （如 pi 指定 provider/model）走低层配方：worktree create → terminal create 自定义命令 → dispatch --inject。

> `scripts/dao-orch.mjs` 的条款渲染半边已判退役（全仓三问裁决，随规则合并批处置）；
> 它改形完成前，直接按上面模式手派。

spec 四段式骨架（写进 task-create 的 --spec）：

```
背景：一段说清来龙去脉。
范围（改这几处）：文件级清单。
约束（不许碰）：禁项 + 边界 + commit 前缀（按宿主：[cc]/[pi]/[codex]）。
验收：跑哪条命令、exit 0 才算过；完工交 exit-gate 交活单。
```

铁律（每条都有尸检报告，见探索报告痛点矩阵）：
1. **派单只走 Orchestration 通道**（结论 A），禁手建 worktree+终端的散装路（低层配方也要 dispatch 挂钩，见上第 6 条）。
2. spec 一次给全（背景/范围/约束/验收四段），缺一段就是下一轮往返。
3. **dispatch 上下文 worker 拿不到**——交回的东西必须落盘成文件，worker_done 只报路径。
4. worker_done **恰好一次**、带 `--outcome`（失败禁只写在散文里）与 `--files-modified`。
5. orca CLI 只信 `--json` 出口。
6. worker 体内没有 AskUserQuestion（会挂死）；要问走 `orca orchestration ask`，协调者 `reply` 答；
   gate 只用于协调者自己的 DAG 决策，不用于答 worker 的 ask。
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

- 🔴 **派完看一眼首回合真的烧起来了**（2026-08-12 实咬：A 批 claude 工兵 `input_accepted` 但任务书
  卡在 TUI 输入框 12 分钟、$0.00 一个回合没跑——注入比 TUI 就绪早一步，回车被吞）。判据：终端
  预览里计费/API 时长在动才算开跑；躺着的补一发 `terminal send --enter` 即活。`input_accepted`
  是「送到了」不是「跑起来了」。
- 🔴 **卡滞侦测不靠人眼**（2026-08-12 同日实咬四次，用户点名两次）：工兵终端的审批门（权限弹窗）不产生
  任何编排消息，收活等待对它是瞎的——在跑工兵除 `check --wait` 外必配**看门狗**（周期读屏，
  异常即退出上报，静默轮询不算侦测）。**发现卡滞第一动作是读屏底模式芯片**：见「manual mode on」
  即根因——那是 Claude Code 默认权限模式，每条 Bash 都会弹审批门，逐条帮它按 1 是跑步机；
  根治 = 隔空切 auto mode（配方见上 §二.3），切完再答掉当前弹窗。本仓工兵最常见卡点就是审批门
  （实录：心跳命令、dao check、git rm 连环三连，切 auto mode 后清零）。

- 观测走织物内置通道：日常 = `worker-show`（状态+终端预览）+ 心跳 + 提交流三样，不翻别的。
- `worker-read` 的深通道是 Codex/Claude/OpenClaude/Grok 四家（指南 1.4.179）；对 pi 降级成有界终端尾巴
  （降级码 `provider_unsupported` 是本仓 #304 实测值，指南只说 typed fallbackReason 不列举）。
- 直翻 worker 的会话文件只作事故取证的最后手段，不作日常观测面。
- 给已有终端挂任务必须显式 `--worktree` 选择器（默认瞄协调者所在树，会报 mismatch）——
  #304 实战经验，指南文本没这条，版本升级后若行为变以实测为准。
- 打回用 `orchestration send --to dispatch:<id>`（结构化收件箱，跨服务器也送达）或 `terminal send`，
  且都排在 `worker-release` 之前（release 会关终端标签页）。
- `check --wait --types` 的类型名以当前指南为准（1.4.179 实况：`worker_done,escalation,question`——
  此处曾记「没有 ask 类型」，那是旧版本实况，版本一换就过期，故不再背具体清单）。
- 探测即预案：每次派单先跑 roster 探测，AskUserQuestion 只呈现真实可选项（定案②）。

## 三、收活（出口门阀）

worker_done 不是验收，只是铃响。验收 = `scripts/dao-exit-gate.mjs` 五道秒级门
（格式 / 凭证边界 / 卫生+guardEvidence / 限时重放），契约见该脚本头注。
人工最终审核不退役——门阀只抬门槛，判断仍是人的。

合并链的验证步 = `dao check` 一条命令（issue #325 起）：`dao-pr-merge.ps1` 在本仓免传
`-VerifyCommand`，缺省即在合并态跑它，exit 0 才合。

## 四、grill 技能的归位（2026-08-11 用户拍板引入）

`grilling` / `grill-me`（Matt Pocock 原版，MIT）收进 `ccswitch/skills/` 随 `link-claude`
部署——拷问局是决策机制的一部分，该随 dao 走，换机自带。
用法锚点只有一处（上面 §一.4），不撒引用。

## 五、已知边界（照直写）

- 探测是 spawn `--version` 级别的——CLI 在 PATH 才算在；装在别处的执行体探测不到（标 absent，不猜）。
- 「本窗口同类活照此办」是窗口内约定，没有跨窗持久机制（刻意：持久化会再长出配置账）。
- Orca 静默失败面（结论 D）未被编排层治愈——worker_done 发送失败仍可能无声，出口门阀的
  「凭证边界」门只能事后兜底。收件箱活跃清扫的架构性修复未做（探索报告 §12）。
