# dao 生态 · 退役审查（哪些东西其实没人用）

> **2026-08-02 迁入说明（本节是新增的，其余正文与迁入前逐字节相同）**：本文件 2026-07-27
> 写在 **mousse-cli `docs/ops/dao-ecosystem-audit.md`**，而它盘点的对象（9 个 skill / 10 个
> command / 12 个 hook / `~/.codex/skills` 链接）**整个住在 dao**，dao 侧两个测试
> （`tests/link-codex.tests.ps1` / `tests/codex-skill-policy.tests.js`）反过来把一个项目文件
> 当契约真相源引。本文件 §8.7 那笔挂账自己就写着这件事：「这段破例记录只落在 mousse-cli，
> 而会撞上它的人在 windsurf-dao……那条契约现在与磁盘现状不符」——**本次迁入即是清偿它的落点**
> （挂账 id `codex-dao-links-upstream-note`；那两个测试的头注已同批改指本文件）。
> mousse-cli 原路径留一份指针存根，那边的历史账本（CHANGELOG / USER-ACTIONS / WORKBOARD）
> 指着它照常可达。**节号一律不重编**（§8 / §8.4 / §8.8 被两个测试逐节引用）。
>
> **⚠️ 本文的全部计数与「当前状态」判断都是 2026-07-27 那一刻的快照，迁入时一个数字都没有重测。**
> 迁入不等于刷新——引用任何一个数字前先自己核一遍现状。

> **盘点时刻：2026-07-27 05:21**（本机 `date` 实测）。本文含大量易腐计数，引用前先核时刻。
> **命题来源**：用户原始疑问——「9 个 skill + 10 个 command 里，哪些我从未提及、也无使用痕迹？
> 是『不知道有』还是『不需要』？」
> **它是什么**：dao.md 外向汲取六源里 **第⑤源「减法自问」** 的第一次真实执行。前四源只说该加什么。
> **它不是什么**：不是删除动作。本批**纯只读**，未删除、未修改任何 skill / command / 配置。

---

## 0 · 先说这份报告自己的处境（承 `user-facing-outlets-audit.md` §0）

它躺在 `docs/ops/`——那份审计判定为「用户不会打开」的目录，是自嗨类载体的第 14 个成员。
按它自己下面要论证的结论，**一个东西有没有人用，取决于有没有人在对话里把它递到用户面前**。
所以本文的送达形态见 §6，在那一步发生之前请把它当草稿。

---

## 1 · 全量清单（四栏）

### 1.0 先确认真实目录结构（不假设）

| 位置 | 实测 |
|---|---|
| `D:/frank/windsurf-dao/ccswitch/skills/` | **9 个** skill 目录，各含 `SKILL.md` |
| `D:/frank/windsurf-dao/ccswitch/commands/` | **10 个** `.md` |
| `D:/frank/windsurf-dao/ccswitch/agents/` | 8 个 subagent 人格（`dao-brainstormer` / `dao-debugger` / `dao-plan-writer` / `dao-reviewer` / `dao-reviewer-critical` / `dao-spec-writer` / `dao-strategist` / `dao-worker-batch`） |
| `D:/frank/windsurf-dao/ccswitch/hooks/` | **12 个 hook，12 个全部**在 `~/.claude/settings.json` 有注册（实查见 §4.3，零孤儿） |
| `D:/frank/windsurf-dao/ccswitch/workflows/` | 2 个 workflow 脚本 + README |
| `~/.claude/skills/` | 9 个 symlink → ccswitch/skills，**一一对应，零漂移** |
| `~/.claude/commands/` | 10 个 symlink → ccswitch/commands，**一一对应，零漂移** |
| `~/.cc-switch/skills/` | **20 个真实目录**（非 dao 系，Codex 侧素材库）。其中 **2 个孤儿**——`auto-commit-after-work`、`dao-terminal-resilience` 未被 `~/.codex/skills/` 链接 |
| `~/.codex/skills/` | 35 项：18 条 → cc-switch、14 条 → `~/.codex/superpowers/skills/`、3 个本地真实目录（`dao-design-taste`（**dao 侧已于 2026-06-23 删除的旧 skill 的遗留副本**）/ `delegation-preflight` / `reclaude-workers`） |
| `~/.codex/prompts/` | 4 个：`dao-commit` / `dao-dev` / `dao-evolve` / `dao-superpowers`（**均停留在 2026-06-03**，与 ccswitch 侧已脱节） |

> ⚠️ **`dao-loop` 同时是 skill 和 command**（两份文件、同名）。用户敲 `/dao-loop` 时实际命中哪一份，本批**未做隔离实验判定**（见 §7 未尽处）。

### 1.1 取证的四路来源

| 路 | 数据源 | 覆盖 | 强度 |
|---|---|---|---|
| A | `~/.claude/history.jsonl` | **2651 条用户实敲 prompt，2026-03-15 → 2026-07-27，跨全部项目** | ★★★ 最强。这是用户键盘的全史，不依赖任何人记录 |
| B | `~/.claude/projects/**/*.jsonl` | 1380 个会话文件（含 subagent / workflow），CC 项目侧最早 2026-06-24 | ★★☆ 能区分「谁调用的」 |
| C | 两仓 git log + 文档交叉引用 | 全史 | ★★☆ 只能证明「被引用」，不能证明「被使用」 |
| D | hook / 脚本 / manifest 引用面 | 现状 | ★☆☆ 说明它在链路里，不说明用户碰过 |

### 1.2 全量四栏表

**第③④栏取证纪律**：A 路是唯一能证明「用户本人打过」的证据；AI 提及/选项只证明「有机会知道」，不证明用过。
计数口径：`用户实敲(斜杠)` = prompt 以 `/name` 开头；`用户任意提及` = display + pastedContents 中出现该名（含讨论）。

#### 1.2.1 九个 skill（全部 `disable-model-invocation: true` ⇒ 唯一入口是用户手敲）

| # | skill | ①声称做什么（frontmatter 原文摘） | ②使用痕迹（出处） | ③用户提过吗（出处） | ④判类 |
|---|---|---|---|---|---|
| 1 | **dao-loop** | 双线程循环开发编排层，谋线生成五文档、造线自动执行 | **B：`<command-name>/dao-loop` 23 次**（mousse 14 / TraceyU 6 / windsurf-dao 2 / 用户家目录 1）+ Skill tool_use 8 次 | **A：实敲斜杠 11 次、任意提及 59 次**，跨 4 个项目 | ① **真在用**（生态第一） |
| 2 | **dao-design** | 设计双端统一入口，参数路由 `[sync\|实现 X\|升格\|…]` | **B：`<command-name>/dao-design` 13 次 + `/dao-design-sync` 13 次**（后者是已合并的旧名）+ Skill tool_use 3 次 | **A：实敲 6 次 + `/dao-design-sync` 4 次；任意提及 13 次** | ① **真在用**（生态第二） |
| 3 | **dao-verify** | 涅槃门验证 + 8 维度全面体检；孤儿分支回溯扫描 | **A/B 均零用户调用** | **A：0 次**。③栏关键：**AI 在主会话可见文本里提过 14 次、进过 AskUserQuestion 选项 2 次**（最近一次 mousse 2026-07-26T07:21） | ③ 零痕迹 · **入口太深 + 已被项目级替代** |
| 4 | **dao-worktree** | 隔离工作区铁律：worktree 沙箱 + 基线 + cleanup 归根 | **A/B 均零用户调用** | **A：0 次**。AI 主会话提过 6 次、AskUserQuestion 2 次（TraceyU 2026-06-26T19:59，选项字面「了解更多 worktree 机制」） | ③ 零痕迹 · **本就是 AI 内部环节** |
| 5 | **dao-plan** | 把已审批 design 拆成 2-5 分钟粒度任务清单 | **A/B 均零用户调用** | **A：0 次**。AI 主会话提过 7 次（**且全部来自 TraceyU 2026-07-02T14:28 同一条消息的三次重复**）、**AskUserQuestion 0 次** | ③ 零痕迹 · **本就是 AI 内部环节** |
| 6 | **dao-review** | 两阶段评审（spec compliance → code quality） | **A/B 均零用户调用** | **A：0 次**。AI 主会话提过 **2 次**、**AskUserQuestion 0 次**，两次都在 AI 自审 dump 里（列文件大小） | ③ 零痕迹 · **本就是 AI 内部环节 + 曝光近零** |
| 7 | **dao-brainstorm** | 模糊需求→设计文档的苏格拉底式精炼 | **B：Skill tool_use 1 次**（Open Design 侧临时项目 2026-06-27） | **A：0 次**。AI 主会话提过 6 次、AskUserQuestion 1 次 | ③ 零痕迹 · **本就是 AI 内部环节** |
| 8 | **dao-evolution** | 演化知识管理（三层归位），含 `scripts/search.py` | **B：Skill tool_use 1 次**（windsurf-dao，AI 发起） | **A：0 次**。AI 主会话提过 11 次、**AskUserQuestion 5 次**（全生态曝光最高的零痕迹项） | ③ 零痕迹 · **不需要（用户要自动，不要手动入口）** |
| 9 | **dao-project-scaffold** | 开工处方统一入口 + 技术栈门控 | **A/B 均零用户调用**；但 D 路极重：`scaffold-manifest.json` 13 refs、`dao-rhythm.js` 3 refs、`dao-scaffold-check.js` SessionStart hook、2 个测试文件 | **A：0 次**。AI 主会话提过 **60 次**（全表最高）、AskUserQuestion 3 次 | ③ 零痕迹 · **不需要用户触发（hook 已在替它跑）** |

#### 1.2.2 十个 command（**均无 `disable-model-invocation` ⇒ 模型可自行调用**）

| # | command | ①声称做什么 | ②使用痕迹（出处） | ③用户提过吗 | ④判类 |
|---|---|---|---|---|---|
| 10 | **dao-remove** | 标记删除当前会话（再按 `/clear` 即彻底丢弃） | **B：`<command-name>/dao-remove` 1 次** | **A：实敲 8 次（全生态第 2 名）、任意提及 10 次**，最近 2026-06-28 | ① **真在用** |
| 11 | **dao-commit** | 从代码变更生成 commit message 并提交 | B：0 次（会话日志覆盖期 2026-06-24 起，早于此的用量落在 A 路） | **A：实敲 7 次、任意提及 8 次**，但**最后一次 2026-06-19，此后 5 周零痕迹** | ② **知道但不用**（已被 dao.md「言·名之则」的 `[cc]` 前缀铁律 + AI 自动提交替代） |
| 12 | **gs** | `git status` 全景（唯一无 frontmatter 的文件） | B：0 次 | **A：实敲 1 次、任意提及 3 次**（2026-06-19，用户亲自要求把它同步进 dao 体系） | ② **知道但不用** |
| 13 | **dao-superpowers** | 五步工程仪式（worktree→plan→implementer→reviewer→cleanup） | B：0 次 | **A：实敲 1 次（2026-06-15）、任意提及 5 次**，最近一次讨论 2026-06-16 | ② **知道但不用**（被 `/dao-loop` 与「帅·指挥官」体系替代） |
| 14 | **dao-distill** | 会话级知识沉淀 | B：0 次 | **A：实敲 1 次（2026-06-16）、任意提及 5 次**。**关键原话（2026-06-16T18:39）**：「能不能每次对话，合适的时机自动会调用 `/dao-distill`，这样就不需要人为去干预了」 | ② **知道，且明确表达不想手动触发** |
| 15 | **dao-serve** | 一键在当前 worktree 启动 dev server | **B：Skill tool_use 11 次，100% 来自 subagent**（mousse 2026-07-16 → 07-26） | **A：0 次** | ③ 零痕迹（对用户）· **从来就是为 AI 自己用的** |
| 16 | **dao-dev** | 一句话需求 → 全流程交付管线 | B：0 次 | **A：0 次**。AI 主会话提过 14 次、**AskUserQuestion 2 次**（mousse 2026-07-09T17:33，选项字面「`/dao-dev` 全管线直行」，用户未选） | ③ 零痕迹 · **被 dao-loop 替代** |
| 17 | **dao-evolve** | 系统自我进化 + 健康检查 | B：0 次 | **A：0 次**。AI 主会话提过 7 次、AskUserQuestion 2 次；dao.md 反·归段提过 1 次 | ③ 零痕迹 · **与 dao-evolution / dao-distill 三重重叠** |
| 18 | **dao-doc** | 生成和更新项目文档 | B：0 次 | **A：0 次**。AI 主会话提过 **2 次，且两次都在 AI 自审 dump 里**（列 command 文件大小）；**AskUserQuestion 0 次；dao.md 索引 0 次** | ③ 零痕迹 · **全生态唯一的三零孤岛**（零使用 + 零曝光 + 零索引） |
| 19 | **dao-loop**（command，与 skill 同名） | 同 skill | 同 #1（无法与 skill 分离计数） | 同 #1 | 需澄清归属（见 §7 未尽处 ①） |

---

## 2 · 🔴 第③栏的实证 —— 「曾经有机会被用户知道吗」

**这是本批最要紧的一栏。** 它决定「零痕迹」该读成「不需要」还是「他压根没机会知道」。

### 2.1 唯一的决定性数字

dao.md「路由铁律」第 2 条强制规定了跨 skill 的交接格式：

> `📋 {摘要} → 请输入 /dao-loop {scope}`

**全部 1380 个会话文件里，这个格式实际出现过 16 次：**

| 指向 | 次数 | 可见性 |
|---|---|---|
| `/dao-design` | 12 | 主会话，用户可见 |
| `/dao-design` | 2 | subagent，**用户看不到** |
| `/dao-loop` | 2 | 主会话，用户可见 |
| **其余 17 个 skill/command** | **0** | — |

**⇒ AI 唯一递到用户手上的两个名字，恰好就是用户唯一在用的两个名字。**

这不是巧合。把三栏并排看：

| skill/command | AI 主动递过（「请输入 /X」） | 用户实敲次数 |
|---|---|---|
| dao-design | 14 | 6（+旧名 4） |
| dao-loop | 2 | 11 |
| 其余 17 个 | **0** | dao-remove 8 · dao-commit 7 · dao-superpowers 1 · dao-distill 1 · gs 1 · **其余 11 个全 0** |

**那 5 个「AI 从未递过、用户却敲过」的（dao-remove / dao-commit / dao-superpowers / dao-distill / gs）有一个共同点：用户是在 6 月中旬亲手参与建造它们时学会的名字。**
出处：`/gs` 是用户 2026-06-19 亲自要求同步进 dao 体系的（A 路原话：「我想让你把刚才的状态栏增强跟 `/gs` 加进去」）；`dao-commit` 是他 2026-05-31 讨论 commit 标识时用的；`dao-remove` 是他 2026-06-28 亲口要求加回来的。

**⇒ 发现性的真实公式：用户知道的 = ①他亲手造过的 ∪ ②AI 在对话里递过的。**
**两条都不占的东西，结构上没有第三条路径可以让他知道。** 而「两条都不占」的正是那 11 个零痕迹项。

### 2.2 dao.md 那张场景表是 AI 的索引，不是用户的

`ccswitch/dao.md:201-213` 有一张 11 行的「场景 → `/` 命令」表，覆盖 9 个 skill + `dao-serve`。
但 dao.md 是 `@import` 注入 **AI 上下文**的 always-on 文件，用户读它需要主动打开一个 47KB 的规则文件。
按 `user-facing-outlets-audit.md` 的结论（用户不看 GitHub、不看项目文件），**这张表的到达率无正面证据**。

**且它本身有三处不自洽**（实查 dao.md 全文）：

1. `dao-commit` / `dao-distill` / `dao-doc` / `dao-remove` / `gs` **完全不在 dao.md 任何位置**——五个 command 在体系的唯一索引里不存在。
2. `dao-serve` 在**用户 `/` 命令表的第 10 行**，而它的 11 次真实调用 **100% 来自 subagent**，零次来自用户。位置摆错了。
3. `dao-dev` / `dao-superpowers` 不在表里，只在「谋·重器之门」正文段（`dao.md:141,146`）——**用户要读到它们，得读完那一段散文**。

### 2.3 唯一存在的自动发现机制，指向的是用户从没敲过的那个

`dao-rhythm.js`（UserPromptSubmit hook，**已在 `~/.claude/settings.json` 注册**）有三条信号：

| 信号 | 动作 | 实测 |
|---|---|---|
| RECALL | 回顾类提问 → 先搜 memory/evolution | — |
| SCAFFOLD | 新建项目意图 → 注入「建议先执行 `/dao-project-scaffold`」（`dao-rhythm.js:116`） | 该 skill 用户**零调用** |
| CLOSING | 强收尾信号 → 提醒走 dao-evolution 沉淀（`:140`） | 埋点 `_tmp/rhythm-closing.log` **实测 13 行**，`.rhythm-v2-announced` 标记于 2026-07-20 生成 ⇒ **它真的触发过至少 13 次** |

**但 UserPromptSubmit 的 `additionalContext` 进的是 AI 的上下文，不是用户的屏幕。**
⇒ 这个机制在结构上只能让 **AI** 知道该推荐什么，**能不能到用户眼前，仍取决于 AI 那一轮愿不愿意转述**。
实测结果：触发 13 次，`/dao-project-scaffold` 与 `/dao-evolution` 的用户调用数**仍是 0**。

**这是「投递 ≠ 到达」在本生态里的第二个实例**（第一个是 `USER-ACTIONS.md` 的 0/11）。

---

## 3 · 三类分组与逐条判因

### ① 真在用（4 项）

`dao-loop` · `dao-design` · `dao-remove` · （半衰）`dao-commit`

- `dao-loop` 与 `dao-design` 占据全部用户调用的绝大部分，且是 AI 唯一会主动递的两个。
- `dao-remove` 是**引用面最小、用户使用率第二高**的那一个（全仓仅 10 处引用，其中 2 处在它自己的 hook 里）——它是「引用面 ≠ 使用量」的活证据，见 §5 的警告。

### ② 知道但不用（4 项）

| 项 | 用户确实知道的证据 | 不用的原因（带出处） |
|---|---|---|
| `dao-commit` | A：实敲 7 次 | dao.md「言·名之则」把 `[cc]` 前缀立成铁律后，提交由 AI 顺手做掉。实测 mousse 仓 719/719 commit 带前缀且 `.git/hooks/` 无钩子 ⇒ 手动入口已无必要 |
| `dao-superpowers` | A：实敲 1 次 + 讨论 4 次 | 被 `/dao-loop` 与 dao.md「帅·指挥官之位」的派单体系吸收。dao.md:141 自己写「拿不准时取 loop」 |
| `dao-distill` | A：实敲 1 次 + 讨论 4 次 | **用户明说要自动**（2026-06-16T18:39 原话见 §1.2.2）。`dao-rhythm.js` CLOSING 信号正是对这句话的回应 |
| `gs` | A：实敲 1 次，且是他亲自要求纳入体系的 | 被 Claude Code 内置 git 能力覆盖；且 2026-06-25 曾以「功能已被内置覆盖」为由删过，当天回滚 |

### ③ 零痕迹（11 项）· 逐个判因

判因取值：**不知道有 / 不需要 / 入口太深 / 被替代 / 本来就是 AI 用的**。

| 项 | 判因 | 依据 |
|---|---|---|
| `dao-plan` | **本来就是 AI 用的** | dao.md:147 明写五步链「worktree → **plan** → implementer → **reviewer** → cleanup」。且已有对应 subagent `dao-plan-writer.md`——帅派单派的是 agent，不是让用户敲 skill |
| `dao-review` | **本来就是 AI 用的**（+ 曝光近零） | 同上。对应 agent `dao-reviewer.md` / `dao-reviewer-critical.md`。全生态曝光最低之一：主会话 2 次、AskUserQuestion 0 次 |
| `dao-worktree` | **本来就是 AI 用的** | 同五步链首环。`dao-superpowers.md` 3 refs、`dao-loop/execution.md` 2 refs |
| `dao-brainstorm` | **本来就是 AI 用的** | dao.md:141 写「loop 的谋线会自己判断要不要先补 brainstorm」——设计上就是 loop 内部调度，不是用户入口。对应 agent `dao-brainstormer.md` |
| `dao-verify` | **入口太深 + 被项目级替代** | mousse 有自己的 `scripts/verify-all.ps1`（十余道检查，CLAUDE.md 五·1 定为「全套验证唯一入口」）。用户零调用但 AI 提过 14 次 ⇒ **他有机会知道名字，但没有理由去敲它** |
| `dao-project-scaffold` | **不需要用户触发** | `dao-scaffold-check.js`（SessionStart，已注册）+ `dao-rhythm.js` SCAFFOLD 信号已在替它跑；`scaffold-manifest.json` 13 refs 是它的真实执行面 |
| `dao-evolution` | **不需要（用户要自动不要手动）** | 用户 2026-06-16 对同域的 distill 明说过要自动。5 次进 AskUserQuestion 选项**一次没被选**——这是本表最强的「知道且不选」证据 |
| `dao-evolve` | **被替代（三重重叠）** | `dao-evolution`(skill) / `dao-evolve`(cmd) / `dao-distill`(cmd) / `dao-harvest`(workflow) 四个载体同域。dao.md 只在反·归段提过它一次 |
| `dao-dev` | **被 dao-loop 替代** | 唯一一次真实曝光：mousse 2026-07-09T17:33 的 AskUserQuestion，选项并排给了「/dao-loop（推荐）」与「/dao-dev 全管线直行」，**用户没选 dev** ⇒ 这是一次干净的 A/B，结果是 loop 胜 |
| `dao-doc` | **三零孤岛**（零使用 + 零曝光 + 零索引） | 全生态唯一：从未被用户提及、从未进过 AskUserQuestion、不在 dao.md 任何位置。仅存的 2 次 AI 提及都是列文件大小的自审 dump。功能与 `dao-dev` 文档段重叠（`dao-dev.md` 2 refs 指向它） |
| `dao-serve` | **从来就是为 AI 自己用的** | 11 次调用 **100% subagent**（mousse 2026-07-16 → 07-26）。它是这 11 项里**唯一活着**的——只是它的用户是 AI。**且本仓已明令绕开它**：`CLAUDE.md` 二·5 因「它的清理步骤会 kill 用户实例」改用 `scripts/start-isolated-dev.ps1` |

### ③补 · 一个必须说清的判据边界

**「零用户调用」在这 11 项里对应了 5 种完全不同的状况**，其中至少 2 项是**健康的**：
`dao-serve` 每周都在真跑、`dao-project-scaffold` 的逻辑天天由 hook 执行。
**⇒ 任何按「零调用即删」的机械规则都会误伤它们。** 这一点直接决定 §5 的答案。

---

## 4 · 交叉验证：引用面 vs 使用面（C/D 路）

### 4.1 排除自身目录后的仓内引用数（两仓合计）

| 项 | 引用数 | 主要引用方 | 用户实敲 |
|---|---|---|---|
| dao-loop | 114 | 全体系 | 11 |
| dao-dev | **80** | `USAGE.md` 16 · `_archive/` 大量 | **0** |
| dao-design | 66 | scaffold/design-assets 13 · dao.md 10 | 6 |
| dao-project-scaffold | 49 | manifest 13 · hooks · tests | **0** |
| dao-superpowers | 43 | `_archive/` 大量 · USAGE.md 8 | 1 |
| dao-evolution | 36 | `_archive/auto-behavior-design.md` 11 | **0** |
| dao-verify | 32 | 分散 25 文件 | **0** |
| dao-evolve | 25 | `_archive/` 为主 | **0** |
| dao-brainstorm / dao-plan | 各 19 | `_archive/` + superpowers | **0** |
| dao-commit | 17 | **其中 6 处在 mousse 的 `gearMeta.test.ts` / `CreativeWorkspace.test.ts`** | 7 |
| dao-review | 16 | superpowers 3 | **0** |
| dao-worktree | 14 | superpowers 3 | **0** |
| dao-remove | **10** | 自身 hook 2 · `_archive/` | **8** |
| dao-distill | 9 | `_archive/` 为主 | 1 |
| dao-doc | **7** | `dao-dev.md` 2 · `_archive/` 4 · README 1 | **0** |
| dao-serve | **6** | README 2 · dao.md 1 · **mousse CLAUDE.md 1（内容是「不要走它」）** | **0**（但 subagent 11 次） |

**两个结论**：

1. **引用数与用户使用量几乎不相关**（`dao-dev` 80 refs / 0 用；`dao-remove` 10 refs / 8 用）。
2. **零痕迹项的引用大量集中在 `docs/specs/_archive/`**——即它们的「活跃度」很大程度来自**已归档的历史 spec**，不是当前链路。

### 4.2 大量引用其实来自它们互相引用

`dao-plan` / `dao-review` / `dao-worktree` 的引用**几乎全部来自 `commands/dao-superpowers.md`（各 3 处）与 `skills/dao-loop/`**。
**⇒ 这四个 skill 构成一个只有 AI 走的闭环，用户从未进入过这个闭环的任何一个入口。**

### 4.3 hook 侧（D 路）

`~/.claude/settings.json` 实查注册了 **12 个** dao hook —— 与 `ccswitch/hooks/` 的文件数**恰好一一对应，零孤儿 hook**：
`dao-glob-gate` / `dao-rule-echo` / `dao-tool-nudge`（PostToolUse）· `dao-compact-log`（PostCompact）·
`dao-config-guard` / `dao-remove-session` / `dao-codegraph-ensure` / `dao-scaffold-check` / `dao-playwright-cleanup`（SessionStart）·
`dao-timecode`（Stop）· `dao-cn-title` / `dao-rhythm`（UserPromptSubmit）。

**12 个文件 = 12 个注册项，无孤儿 hook。** 但「已注册」不等于「真生效」——`dao-codegraph-ensure` / `dao-playwright-cleanup` 等的实际触发情况本批未验（见 §7 未尽处 ⑤）。

---

## 5 · ⚠️ 减法建议 —— 但先看这个仓自己的误删实证

### 5.1 本仓已经做过至少 4 轮退役，其中 **2 轮砍错**

| 日期 | commit | 动作 | 结果 |
|---|---|---|---|
| 2026-06-17 | `561b29e` | **38 → 7 skill 精简**（一次删 31 个） | 未见回滚 |
| 2026-06-23 | `81d6c03` | 废弃 3 个旧 UI skill | 未见回滚 |
| 2026-06-25 | `a084a82` | **删 `dao-remove` + `gs`**，理由原文「44 行，功能已被内置覆盖」 | 🔴 **同日 `aa32cf5`「恢复误删的 dao-remove + gs 命令」回滚**。触发点：用户当天问「你把 dao-remove / gs 删了，替代品是什么？」（A 路 2026-06-25T01:10）。而 `dao-remove` 是用户实敲次数**第 2 名** |
| 2026-06-25 | `844291a` | `dao-cycle` 并入 `dao-dev` | 用户此前实敲过 `/dao-cycle` **4 次**，最后一次 2026-06-24T19:31——**删除发生在最后一次使用的次日** |
| 2026-06-27 → 06-28 | `cb58882` / `7ed46e1` | 设计类 skill 10→6→并入 `dao-design` | 🟡 `dao-design-sync` 被删。用户此前实敲过 **4 次**，且 2026-06-27T14:28 当场抱怨「为什么好像没有找到这个 skills？没有同步吗？我明明推送」。**此次替代成功**——2026-07-10 他改用 `/dao-design sync` |

**⇒ 退役审查在本生态不是「没做过」，是「做过 4 轮、错了 2 次」，且两次都错在同一个判据上：用引用面（44 行、0-ref 孤岛）代替使用面。**

### 5.2 建议（三档）

#### 🗑 建议删（1 项）

- **`dao-doc`** —— 全生态唯一的三零孤岛（零使用 · 零曝光 · 零索引），功能被 `dao-dev` 文档段覆盖（`dao-dev.md` 里 2 处引用它）。
  **删前必做的一件事**：`gh`/git 侧不需要，但要 grep `_archive/` 之外的活引用（现测活引用只有 `dao-dev.md` 2 处 + `README.md` 1 处）。
  **诚实边界**：它的「零曝光」也可能只是因为**没人给过它曝光机会**——按 §2 的公式，它从未被 AI 递给过用户，所以「用户不需要它」这一句本审计**证不了**，只能说「用户没有任何途径需要它」。

#### 🔀 建议合并（2 组）

- **演化域四合一**：`dao-evolution`(skill) + `dao-evolve`(cmd) + `dao-distill`(cmd) + `dao-harvest`(workflow) → 保留 `dao-evolution` 为知识库、`dao-harvest` 为执行体，**退掉两个手动 command 入口**。
  依据：用户 2026-06-16 明说这类事要自动；三个手动入口合计用户实敲 **1 次**（`/dao-distill`，2026-06-16）。
  ⚠️ 但 `dao-distill` 用户是**知道**它的，删名字可能重演 `dao-remove` 事故 ⇒ **建议保留 `dao-distill` 这个名字作为 `dao-evolution` 的别名/薄壳**，只退 `dao-evolve`（用户从未提过它）。
- **五步链四合一**：`dao-plan` / `dao-review` / `dao-worktree` / `dao-brainstorm` → 降级为 `dao-superpowers` 与 `dao-loop` 的 supporting files。
  依据：它们的引用 100% 来自这两条流程；对应 subagent 人格已在 `agents/` 里独立存在。
  ⚠️ **诚实边界**：skill（给主会话读的透镜）与 agent（给 subagent 的人格）**内容不同、不是等价物**，这是重复不是冗余。降级会损失「主会话自己想按 plan 铁律办事」时的加载路径。本审计**没有验证过这个损失有多大**。

#### 📣 只需一次「让用户知道它存在」（2 项）

- **`dao-verify`** —— 用户 2026-07-08 亲口抱怨过「很多已完成但是未清理的 branch，可以从根源上解决吗？」（A 路原文），而 `dao-verify` 的孤儿分支回溯扫描**正是**为这件事建的（dao.md:247 明写它是这条的兜底）。**他遇到了问题，工具就在手边，没人告诉他。**
- **`dao-serve`** —— 不是让用户知道，是**把它从 dao.md 的用户命令表挪走**，标为 AI 内部工具。它现在占着一个用户入口的位置，而它的全部 11 次调用来自 subagent。

#### ⛔ 明确不动（4 项）

`dao-loop` · `dao-design` · `dao-remove` · `gs` —— 后两个是 §5.1 的误删受害者，**它们的低引用面正是它们简单好用的表现**。

---

## 6 · 「退役审查能不能形态化」—— 判断与理由

### 6.1 结论：**能形态化一半，另一半形态化不了，且强行形态化会造成实害**

### 6.2 能形态化的那一半：让「零调用」这个状态每次都被看见

**挂载点是现成的，且比条款库那一套更硬**：

- `~/.claude/history.jsonl` 是**机器可读、跨项目、跨会话、不依赖任何人记录**的用户键盘全史（本批的 A 路就是它）。
- 判据可机械求值：**「近 N 天零 `/name` 开头调用 + 最后一次调用日期」**，一条 `check-skill-usage` 观察线即可打印。
- 本仓已有**多条**同型观察线的现成范式（`verify-all.ps1` 里 `IsGate = $false` 的那些）。**刻意不写条数、不列名单**：2026-07-27 这一行原写「三条：`check-core-loc` / `check-version-tag-sync` / `check-harvest-due`」，此后新增 `check-worktree-strays` 与 `check-ledger-freeze`、又给第三个改了名 ⇒ **一句话三处同时过期**（本次改名批只改了名字、没改「三条」，由对抗验证官捞出）。当前名单一律以 verify-all 汇总表的闸位列打印为准。
- dao.md 反·归刚立的准则**原文就要求这件事**：「规则集只增不减是结构必然，须专门给退役造触发器……候选退役区的周期性打印，不自动删但强制可见」——**该准则当时只写给条款库，它对 skill 生态同样成立，而且 skill 侧连这个都还没有。**

**必须是观察线不是硬闸**，照 dao.md「代码错了用硬闸，人该判断一件事用观察线」——「这个 skill 该退役吗」是判断题，做成硬闸只会逼出为过闸而敷衍的删除（**而本仓已经有过一次为过「0-ref 孤岛」判据而误删的实证**，§5.1）。

### 6.3 形态化不了的那一半：判因

**机器能数出「零调用」，数不出「为什么零」。** 本批 11 个零痕迹项分属 5 种成因，其中两项完全健康：

| 项 | 机器看到 | 真相 |
|---|---|---|
| `dao-serve` | 用户零调用 | 每周被 subagent 真跑，11 次 |
| `dao-project-scaffold` | 用户零调用 | 它的逻辑天天由 SessionStart hook 执行 |
| `dao-doc` | 用户零调用 | 真的没人要 |

**⇒ 观察线只能产出候选清单，判因必须由一次调查（像本批这样）来做。**
而「判因」这个动作本身**没有触发器**——它正是 dao.md 说的「在无标记时刻主动问」的那一类，本仓实测携带率约 9%。

### 6.4 最关键的一点：观察线的输出会落进「没人看的第 15 个载体」

`check-*` 观察线打印进的是 verify-all 日志；SessionStart hook 注入的是 AI 上下文。
按 `user-facing-outlets-audit.md` 的结论，**这两处都不是用户出口**。
⇒ 如果只做到「打印一行」，这条观察线会精确地重演本报告批判的病。

**真正的形态必须是三段接力，缺一段就断**：

```
① 机器：一条观察线，从 history.jsonl 算出「近 N 天零用户调用 + 最后调用日期」清单
        （挂 verify-all IsGate=$false，或挂 SessionStart hook）
        ↓ 这一段能形态化
② 人（帅）：在长窗收官段的既有必经动作（dao-harvest 收割）里消费这份清单，逐条判因
        ↓ 这一段挂在已有必经动作上，但判因质量靠人
③ 用户：判因结论压成一次 AskUserQuestion（实证唯一的决策通道）
        ↓ 这一段是唯一能让删除决定真正落地的地方
```

**为什么③不能省**：§5.1 的两次误删，两次都是 AI 单方面判定「功能已被内置覆盖」后直接删的，而用户是在**删完之后**才发现的。

### 6.5 诚实边界（本节明确没解决的）

- **③ 那一步会不会烦到用户，未知。** 用户 2026-07-20 裁决过「不主动催验」。一个「这 11 个东西没人用，要删吗」的提问，是有用的减法，还是又一次打扰——**本审计不敢替他答**。
- **`n` 靠人手工维护的老问题在这里同样存在**：观察线能算出「零调用」，但「上次判过因、结论是保留」这个状态没有地方存 ⇒ 下次它还会出现在候选清单里，重复问同一个问题。这需要一个「已判因/豁免」字段（形如条款库的 `exempt`），本批**未设计**。

---

## 7 · 未尽处（诚实清单）

1. **`dao-loop` 的 skill/command 同名歧义未判定**。两份文件同名并存，用户敲 `/dao-loop` 时命中哪一份、另一份是不是死文件——**本批未做隔离实验**。这直接影响「10 个 command 里是不是有一个是幽灵」的结论。
2. **A 路的覆盖边界**：`history.jsonl` 从 2026-03-15 起，2651 条。但**它是否会被 `/clear`、`/dao-remove`、会话删除截断，本批未验证**。若会，则所有「实敲 N 次」都是**下界**而非精确值。会话日志（B 路）在 CC 项目侧最早只到 2026-06-24，早于此的调用只能靠 A 路。
3. **「AI 提及 N 次」的口径偏松**。我统计的是主会话 assistant 文本里出现该名的次数，其中相当一部分是**AI 自己在做体系审计时列清单**（如 TraceyU 2026-06-27 那条列了所有 skill 的文件大小）——那种出现对用户的「发现性」贡献接近零，但被我记进了「有机会知道」。**`dao-plan` 的 7 次里有 3 次是同一条消息的重复**，`dao-doc` 的 2 次全是这类。⇒ **真实曝光量比表里的数字更低**，两个方向里我选了对「有机会知道」有利的那一侧，结论因此偏保守。
4. **Codex 侧的使用量未取证**。我扫了 98 个 codex session 文件，但高频命中（如 `frontend` 83/98）几乎肯定是**技能清单被注入每次 prompt**，不是调用。我**无法用现有手段区分「被列出」与「被调用」** ⇒ `~/.cc-switch/skills` 那 20 个（含 2 个孤儿）的死活，本批**没有答案**。
5. **hook 只核到「已注册」，没核到「真生效」**。12 文件 ↔ 12 注册项已对上（零孤儿），但 `dao-codegraph-ensure` / `dao-playwright-cleanup` / `dao-config-guard` 是否真在触发、有没有静默失败，本批**没查**——`dao-rhythm` 是唯一一个我拿到了运行时证据的（`_tmp/rhythm-closing.log` 13 行）。
6. **`~/.codex/prompts/` 的 4 个 dao 提示词全部停留在 2026-06-03**，与 ccswitch 侧已脱节近两个月。这是一个**漂移面**，本批只发现未评估——它们是死副本还是仍在被 Codex 侧使用，未查。
7. **`~/.codex/skills/dao-design-taste` 是 dao 侧 2026-06-23 已删 skill 的遗留副本**，本批只记录未追查它是否仍被读取。
8. **没有做「删了会怎样」的实验**。所有减法建议都基于痕迹推断，没有一条经过「先禁用一周看有没有人喊疼」的验证。`dao-remove` 的误删回滚说明**这类实验的成本可能很低**（当天就有反馈），但本批没做。
9. **`dao-verify` 的「只需一次告知」建议未验证它真能解决用户 07-08 的抱怨**。我只核对了 dao.md:247 声称它是孤儿分支扫描的兜底，**没有读 `dao-verify/SKILL.md` 里那段扫描的实际判据**——按条款库「别把『检测器已覆盖』当兜底承诺，先读它的判据」，我这一条属于**未过该条款的推荐**，请勿据此向用户承诺。
10. **本报告的送达形态未落地**。按 §6.4 自己的结论，它现在躺在 `docs/ops/` = 断在第②段与第③段之间。真正需要用户回答的只有一个问题：
    > 「dao 生态 19 个入口里有 11 个你从来没用过。其中 2 个是 AI 内部在用的（健康）、1 个是三零孤岛（该删）、其余 8 个你**从来没机会知道它们存在**。你要：A 我按建议删/合并/改归属，B 只删那 1 个孤岛其余不动，C 先让我给你列一次『你可能想知道的 3 个』再定？」

---

## 8 · 落地记录：`~/.codex/skills` 里的 9 个 dao 链接（2026-07-27 一次**明确的破例**）

> **这一节不是待办，不带 `ONLY-USER` 标记**——它记的是一件**已经发生并已拍板**的事。
> 按条款「用户拍板落地时，撤标与写结论是同一个动作」，已拍板的项不该再占积压位。
> 它存在的唯一理由是：**下一个人看到那 9 个链接，若不知道这段，会判为漂移并「修复」掉它**。

### 8.1 谁、什么时候、被告知了什么、选了什么

- **时间**：2026-07-27（与本文件 §5.2 的生态减法是同一天）。
- **在此之前当天已经定过的事**（`windsurf-dao tests/link-codex.tests.ps1:8-13` 的契约头注，
  提交 `29e08cb`）：**`~/.codex/skills` 只有一个写入方——cc-switch store。`dao.ps1` 退出这项业务。**
  该契约的强形态由一条全量 before/after 快照断言钉住（name + 链接类型 + 目标 + 容器性全等），
  `link-codex` 一行都不许写。
- **用户被明确告知了上面这个冲突**，随后拍板：**「dao 自己建」**——即绕过 cc-switch，
  直接在 `~/.codex/skills/` 下手工建 9 个指向 windsurf-dao 的链接。
- **为什么用户选破例**（AI 侧记录的理由，非用户原话）：走 cc-switch 那条路要写它的数据库，
  而 `sync_to_app` 还可从 `sync_current_to_live` 到达、proxy 在本机是启用的
  ⇒ 写一行 DB 会在下次同步时**波及用户 Claude 侧已经在用的链接**。
  破例是两害相权：**手工链接的代价是「无人知晓即被当漂移清掉」，写 DB 的代价是「动到正在用的东西」**。
- **本批是一次性手工建链接，不是恢复自动化。** `link-codex` 的写入能力**没有**被恢复，
  上面那条契约与它的断言**一字未动**——双写入方竞态没有重建。

### 8.2 最终形态（2026-07-27 实测）

9 个 **Junction**（与 Claude 侧形态一致），全部指向 `D:\frank\windsurf-dao\ccswitch\skills\<name>`：

`dao-brainstorm` · `dao-design` · `dao-evolution` · `dao-loop` · `dao-plan` ·
`dao-project-scaffold` · `dao-review` · `dao-verify` · `dao-worktree`

**目标是承重属性，必须刻意保持指向 windsurf-dao**：cc-switch 的回收逻辑有两个删除分支——
①在它 DB 里但对该 app 未启用 ②链接目标落在 `~/.cc-switch/skills/` 内。
指向 windsurf-dao 的链接两条都不占。**「junction 不算 symlink 所以能活」是错的解释**
（实测 `is_symlink(junction)` 为真）——**能活是因为它指向哪，不是因为它是什么类型**。
改指向 store 就会被回收。

### 8.3 ⚠️ 这个坑用户哪天敲了就会中：`dao.ps1 unlink-codex`

`unlink-codex` 按**目标**分类（`dao.ps1` 的 `Get-CodexLinkClass`），会把其中一部分判为 `"dao"` 类删掉。
它是用户手敲的命令、无自动调用方，所以**不是静默风险**——但**敲了就会没**。

**2026-07-27 `-DryRun` 实测：会删 5 个，不是 9 个**（`summary: removed=5 skipped=40 error=0`）：

| 会被删（判为 `dao`） | 会留下（判为 `other`） |
|---|---|
| `dao-design` · `dao-evolution` · `dao-loop` · `dao-project-scaffold` · `dao-verify` | `dao-brainstorm` · `dao-plan` · `dao-review` · `dao-worktree` |

**为什么是这个 5/4 分界，以及为什么它靠不住**：判据是「目标是否等于 `~/.claude/skills` 某条目的解析目标」。
而本文件 §5.2 的减法当天已落地（`windsurf-dao 035508d` 的 `Get-InternalOnlySkills`），
把右栏那 4 个从 `~/.claude/skills` 收起来了 ⇒ 它们的目标不在比对集里，才侥幸躲过。
**这是副作用不是设计**：哪天那个决定被反转（4 个重新部署回 Claude 用户面），
`unlink-codex` 就会连它们一起删，变成 9/9。**别把当前的 5/4 当成稳定保证。**

### 8.4 与同日 §5.2 决定的一处张力（✅ 2026-07-27 已裁定）

§5.2 当天刚把 `dao-plan` / `dao-review` / `dao-worktree` / `dao-brainstorm` 四个
**从用户命令面收起**（判据：用户键盘全史零调用，摆在命令表上只是噪音）。
本批按派单令把**全部 9 个**都放进了 `~/.codex/skills` ⇒ **那 4 个在 Codex 侧又回到了可见面**。

两侧不完全等价（Claude 侧 `~/.claude/skills` 是 `/` 命令表，Codex 侧是模型可触发的技能表），
所以这不一定是矛盾；但它**确实是「刚收起来又放出去」**，本批不自行裁定。

**已裁定（帅，2026-07-27）——分两组，链接一个都不撤：**

| 组 | skill | Codex 侧 `agents/openai.yaml` | 理由 |
|---|---|---|---|
| **用户面 5 个** | `dao-design` `dao-evolution` `dao-loop` `dao-project-scaffold` `dao-verify` | **加**（`allow_implicit_invocation: false`） | 与 Claude 侧 `disable-model-invocation: true` 语义对齐：只许用户手敲 |
| **AI 内部件 4 个** | `dao-worktree` `dao-plan` `dao-review` `dao-brainstorm` | **不加** | §5.2 把它们定性为「用户不敲、AI 用」。加了等于改成「只有用户能敲」，与用户拍板相反 |

**关键判据**：`allow_implicit_invocation: false` 的效果是**禁 AI 自动调用、只留用户显式调用**，
恰好与「AI 内部件」的定位相反。所以张力的真正解不是撤链接，而是**只给用户面那 5 个加禁令**——
问题从来不是「那 4 个不该在 Codex 那边」，而是「不该给它们加那个禁令」。
**9 个链接全部保留**，§8.6 的第二档回滚命令（撤那 4 个）**不再是推荐动作**，仅作为应急保留。

落地状态：5 个 `agents/openai.yaml` 已随 windsurf-dao 提交；实测效果与两道前置的验证证据见 §8.8。

### 8.5 `~/.cc-switch/skills/` 里那 9 个同名链接：**保留**（本批判断）

store 里已有 9 个同名 symlink，同样指向 windsurf-dao。**结论：不动它们**，理由有二——

1. **它们不是本次破例的产物，删除属于超出授权的副作用**。本批的授权是「建 codex 侧的链接」。
2. **保留是更安全的失败模式**（承前一位官的判断，本批采纳）：若用户哪天真的从 cc-switch UI 导入 `dao-*`，
   `import_from_apps` 会看到 `dest.exists()` 而跳过深拷贝 ⇒ SSOT 里留下的是一个**活链接**，
   而不是一份**冻结副本**。冻结副本会与 windsurf-dao 永久脱节，且脱节是静默的。
   **诚实边界**：这条理由来自读上游源码，**本批没有跑过那条导入路径去证实**
   （跑它要启动 cc-switch，而本批被明确禁止启动它）。

### 8.6 回滚（三档，按需取用）

```powershell
# 全撤：删掉本批建的 9 个链接（只删链接本身，windsurf-dao 源目录不受影响）
'dao-brainstorm','dao-design','dao-evolution','dao-loop','dao-plan','dao-project-scaffold','dao-review','dao-verify','dao-worktree' |
  ForEach-Object { $p = Join-Path "$env:USERPROFILE\.codex\skills" $_; if (Test-Path -LiteralPath $p) { (Get-Item -LiteralPath $p -Force).Delete() } }

# 只撤 §8.4 那 4 个（与 Claude 用户面对齐，保留 5 个）
'dao-brainstorm','dao-plan','dao-review','dao-worktree' |
  ForEach-Object { $p = Join-Path "$env:USERPROFILE\.codex\skills" $_; if (Test-Path -LiteralPath $p) { (Get-Item -LiteralPath $p -Force).Delete() } }
```

> **为什么用 `.Delete()` 而不是 `Remove-Item -Recurse`**：对 junction 用 `Remove-Item -Recurse`
> 在部分 PowerShell 版本上会**穿透链接删掉目标里的真实文件**——目标是 windsurf-dao 的源目录。
> `DirectoryInfo.Delete()` 只摘链接。**本批只实跑过 `Test-Path` 分支，`.Delete()` 分支未实跑**
> （跑了就把交付物删了），形态取自与建链同一次会话里验证过的写法。

建链前的完整基线（三个目录 × 名称/类型/目标）落在
`_tmp/codex-skills-link-20260727/baseline-20260727.csv`，建链后为 `after-20260727.csv`。
`_tmp/` 不进 git ⇒ **这两份快照会随清理消失**，别把它们当长期凭据；长期凭据是本节。

### 8.7 一笔挂账：windsurf-dao 侧还没有留痕

- **账目 id**：`codex-dao-links-upstream-note`
- **欠什么**：这段破例记录**只落在 mousse-cli**。而会撞上它的人在 **windsurf-dao**
  （跑 `dao.ps1 status` / `link-codex`、或读 `tests/link-codex.tests.ps1:8-13` 那条
  「只有一个写入方」契约的人）。**那条契约现在与磁盘现状不符，而契约文件里没有任何一句提到这件事。**
- **owner**：帅（本批实现官被派单令明确要求 windsurf-dao 只读，且当时该仓有在途官正在写入）
- **解冻条件**：在途官 `a45eb3f9` 的生态减法批已落地（`035508d`，2026-07-27 15:21），
  windsurf-dao 工作树可写时即可补——在 `tests/link-codex.tests.ps1` 契约头注加一段指针，
  指回本节，说明「磁盘上另有 9 个手工链接，是用户 2026-07-27 的破例，不是漂移」。
- **为什么这笔必须有编号**：按同日收割的判据，「随后补」写在正文里 = 义务在转移那一刻蒸发——
  转移方拿到心理结算，接收方的责任面上从来没有这一项。

### 8.8 §8.4 落地的实测证据（2026-07-27，codex-cli 0.144.0-alpha.4 / Claude Code 2.1.220）

**量具**（两个，缺一不可——它们回答的是不同问题）：

| 量具 | 命令 | 回答什么 |
|---|---|---|
| 注入面 | `codex debug prompt-input`（本地、零网络、零 token） | 该 skill 在不在注入模型上下文的 "Available skills" 列表 ⇒ **AI 会不会自动调用** |
| 注册表 | app-server `skills/list`（JSON-RPC over stdio，只 initialize 不开 thread） | 该 skill 在不在 composer `$` 选择器的枚举源 ⇒ **用户还能不能显式调用** |

**为什么必须两个都看**：只看注入面时，「策略被遵守」与「yaml 解析失败导致整个 skill 掉了」
**观察结果完全相同**。三元探针（`bare` 无 yaml / `on` 写 true / `off` 写 false）做判别性翻转：
`off` 消失而 `on`、`bare` 都在 ⇒ 是策略被读到了，不是文件坏了。
另一重保险：解析失败会让 `allow_implicit_invocation` 落回默认值 `true` ⇒ 该 skill 会**出现**而非消失。

**实测数字**：

- 注入面 52（基线）→ **47**（加完 5 个），消失的恰是那 5 个；4 个 AI 内部件与 `dao-design-taste` 原样留在注入面。
- 注册表 52（基线）→ **52**（加完后不变），9 个 dao skill 全部 `enabled=true`，
  windsurf-dao 相关解析错误 **0** 条（总错误数 7 条恒定，全是 `.cc-switch` 侧既有的 frontmatter 缺失，与本批无关）。
- **另跑了「政策-only」形态的彩排探针**（只写 `policy:`、不带 `interface:` 块，即最终上线的形态）：
  注入面消失、注册表保留、零错误 ⇒ `interface:` 块不是必需项，不必为了合规复制一份会漂移的描述文案。

**前置① Claude Code 会不会读 `agents/openai.yaml`：不会，两个方向都验了。**
- 加了不出错：探针 skill 经 junction 挂进 `~/.claude/skills/` 后，Claude Code **会话中热重载**并列出它；
  用 Skill 工具实调 `zz-probe-off`（yaml 里写着 `false`）**成功加载正文**；`claude doctor` exit 0、无异常。
- 加了不改可见性：写 `false` 的探针在 Claude 侧**照常可见可调**（Codex 侧同一文件已让它消失）
  ⇒ Claude 完全忽略该字段，它只读 `SKILL.md`。
- 那 5 个真 skill 的 `disable-model-invocation: true` 本批一字未动 ⇒ Claude 侧行为不变。

**前置② `false` 之后 Codex 还能不能显式调用：能，但证据是三条间接证据的合取，不是看着它被调起来。**
1. 官方参考（随 Codex 分发）`~/.codex/skills/.system/skill-creator/references/openai_yaml.md`：
   「When false, the skill is not injected into the model context by default,
   but can still be invoked explicitly via `$skill`. Defaults to true.」
2. 注册表实测：`false` 之后该 skill 仍在 `skills/list` 里、`enabled=true`、
   `interface.defaultPrompt` 里的 `$name` 原样保留。
3. 协议 schema 实证：`TurnStartParams` 里 `SkillUserInput { type:"skill", name, path }`
   是与 `text`/`mention` 并列的**结构化输入项** ⇒ 显式调用走的是「客户端按 name+path 直投」这条路，
   与被 `false` 掐掉的注入块**不是同一条通道**。
4. **⚠️ 没做的那一半**：没有真起一个 Codex TUI 会话敲 `$dao-verify` 看正文被注入
   （派单明确排除 A 档）。所以严格说，上面证的是「显式调用的前置条件全部成立且通道独立」，
   不是「亲眼看见它被调起来」。要闭死这个缺口只需用户在 Codex 里敲一次 `$dao-verify`。

**顺带实跑掉一个 §8.6 的未验分支**：本批清理 8 个探针 junction 时用的就是 `.Delete()`，
8/8 只摘链接、目标目录完好 ⇒ §8.6 那句「`.Delete()` 分支未实跑」现已实跑（在探针上，不在真链接上）。

**`~/.codex/skills` 三个实体目录（非链接）的现状**（本批只报告不清理）：

| 目录 | 文件数 | 最后写入 | 上游 | 判断 |
|---|---|---|---|---|
| `dao-design-taste` | 1 | 2026-06-04 | **已被合并掉**：windsurf-dao `cb58882`（2026-06-27）把 taste+layout 合进 `dao-design/standards.md` | **孤儿冻结副本**，且它**每次 Codex 会话都在被注入**（仍出现在注入面）⇒ 一个已被取代的旧版设计判据在持续影响 Codex 行为 |
| `delegation-preflight` | 2 | 2026-05-31 | windsurf-dao 全史**无任何记录** | 非孤儿，本就是 Codex 独有的自持 skill |
| `reclaude-workers` | 11 | 2026-06-29 | 同上，无记录 | 同上 |

> **一处数字分歧，按判据记下不回填**：上一位官记的是「`dao-design-taste` 源已被删 53 天」，
> 本批实算得到**两个都对但口径不同**的数字——**53 天**是那份冻结副本自身 mtime（2026-06-04）到今天的年龄；
> **30 天**才是「上游真正被合并掉」到今天（`cb58882`，2026-06-27）。
> 「源已被删」这个说法对应的是后者。两个数都列出，不并成一个。

另：`~/.codex/skills` 下 18 条指向 `~/.cc-switch/skills/` 的链接**全部健康**
（源目录与 `SKILL.md` 均在），无孤儿。
