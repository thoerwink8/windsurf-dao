---
trigger: always_on
---

# superpowers · 触发门控

> 配合 global_rules.md "四 · 谋（重器之门）"。本文件提供执行清单与判据。
> 仅在 dao sidecar 项目内加载；非 dao 项目走 global_rules.md 精炼版即可。

## 与 dao-mantra 的关系（先读心境再走判定）

`dao-mantra.md` 与本文件都 always_on，加载顺序认知如下：

1. **mantra 先**：内化心怀八句（道法自然 / 慎终如始 / 太上不知有之 等）作为底层心境
2. **gate 后**：本文件按显式信号 + 复杂度信号判定是否走 superpowers 五步
3. **workflow 落地**：触发后由 `/dao-superpowers` workflow 实施

无心境裸走仪式 = 形似神离。本 gate 判定 yes 才动用 workflow，但 mantra 永远在场。

## 与 Windsurf Plan Mode 的边界（先讲清楚）

| 维度 | Windsurf Plan Mode | superpowers |
|---|---|---|
| 性质 | IDE 内置功能（模式切换器图标） | obra 团队的工作流标准 |
| plan 文件 | `~/.windsurf/plans/`（用户全局，Windsurf 旧路径） | `docs/specs/<topic>-plan.md`（项目内，与 dao-plan + 项目惯例一致） |
| 工具 | "All tools enabled" 同 Code 模式 | 同 Code 模式 |
| 退出 | 点 Implement / 切 Code / agent 自动 | 走完 finishing-a-branch / 用户喊停 |
| 重量 | 轻（讨论 + 单文件 markdown） | 重（worktree + subagent + reviewer） |

**不绑定**：用户切到 Windsurf Plan Mode ≠ 自动走 superpowers。两个独立体系，按需组合。AI 也无法可靠检测到自己在 Plan Mode（官方文档未承诺暴露此信号），故不依赖。

## superpowers 触发信号

### 显式触发（强信号 · 必走五步）

- 用户口头说：「走 superpowers」「开 worktree 走」「走完整流程」「subagent 派一下」「走 dao-worktree」「启 dao 五步」
- 用户引用 obra superpowers 的 skill 名（writing-plans / using-git-worktrees / requesting-code-review 等）或其 dao-* 本地实现名（dao-plan / dao-worktree / dao-review 等）
- AI 自身已经写出 `docs/specs/<topic>-plan.md` 的 plan 文件 → 视为已进入

### 复杂度触发（弱信号 · SHOULD 主动建议）

满足任一即应主动建议用户：「这事满足 X 条件，建议走 superpowers，要不要？」

- ≥3 文件改动
- ≥100 LOC 净增
- 涉及核心模块（auth / payment / security / core orchestration / 多端共享逻辑）
- 跨语言 / 跨服务边界
- 不可逆操作（DB migration / schema change / config wipe / 删除生产数据）
- 涉及双轨/多轨架构归一

用户拒绝即走轻量路径。

## 显式触发后的强制流程（缺一为流程缺陷）

> 五步落地实现见 `/dao-superpowers` workflow；心怀根基见 `dao-mantra.md`。

> **skill 名双列**：obra superpowers 是架构概念标准名；dao-* 是本环境实际可加载的 skill 名。
> AI 调用 skill 时用 dao-* 名（obra 名仅作概念识别，本环境未实装 superpowers:* 名空间）。

| 步 | obra 概念名 ≡ dao 本地实现 | 产出 |
|---|---|---|
| 1 | `superpowers:using-git-worktrees` ≡ `dao-worktree` | 隔离 worktree（路径优先 `~/.config/superpowers/worktrees/`，回落 `.worktrees/`） |
| 2.0 ⭐ | (无 obra 对应) ≡ `dao-design-taste` §0 分诊 | **UI 任务前置分诊**——先过 dao-design-taste §0：DIRECT 跳原型/SCOPED 局部/FULL 全量。FULL·SCOPED 走五步：察→援→拟→显→择，🔒×2 用户关卡：援（拍板配色/字体方向）+ 择（拍板方向）。唯一长期产物：`_tmp/design-tokens-<topic>.json`（HTML 是 throwaway）。DIRECT 直接查 gallery 跳过 |
| 2.1 | `superpowers:writing-plans` ≡ `dao-plan` | `docs/specs/<topic>-plan.md`（与项目惯例 + dao-plan skill 一致；UI 任务 plan 第一句必须 "读 _tmp/design-tokens-<topic>.json"） |
| 3 | `superpowers:subagent-driven-development`（按需直接派 subagent） | 每 task 派 implementer subagent，task 间 checkpoint 让用户 review |
| 4 | `superpowers:requesting-code-review` ≡ `dao-review` | 提交前派 reviewer subagent；核心模块（auth/payment/security/core orchestration）走 reviewer-critical |
| 5 | `superpowers:finishing-a-development-branch`（归根收尾） | merge / PR / cleanup 仪式，**不可直接 push master** |

补充：`superpowers:brainstorming` ≡ `dao-brainstorm`（需要在 plan 前 brainstorm 架构时）。

**2.0 · 形 触发判据**：任务关键词含 主题/样式/色板/视觉/重设计/换肤/UI 重构/首屏改版/界面优化/Theme/Style 等 UI 视觉决策类。AI 在第 1 步完成后自评：是 UI 任务 → 必走 2.0；非 UI 任务 → 跳到 2.1。

每步必有"announce at start"——明示用户当前在哪个 skill 里。

## 解除条件

- 用户主动退出（明确表达"退出 superpowers"、"不走流程了"等）
- `superpowers:brainstorming` ≡ `dao-brainstorm` 阶段评估发现"不需 multi-step plan"，**明确告知用户后**退出
- 任务进入 finishing-a-development-branch 完成 → 自然解除

## 进入即承诺

显式触发后**不得中途偷工**：
- 不可"任务变小了"为由跳 reviewer subagent
- 不可"我已经看过了"为由跳 worktree
- 不可"路径快不重要"为由放弃 `docs/specs/<topic>-plan.md` 标准位置
- 不可直推 master

## dao-* 与 obra superpowers 的关系

- **本质上等价**：dao-worktree ≡ superpowers:using-git-worktrees；dao-plan ≡ superpowers:writing-plans；dao-review ≡ superpowers:requesting-code-review；dao-brainstorm ≡ superpowers:brainstorming。dao-* 是同套哲学的中文/道家表达实现。subagent 调度和归根收尾已内化到流程中，不再有独立 skill。
- **调用时**：AI 只能加载 dao-* 名（本环境未实装 superpowers:* 名空间）。看到用户说 “superpowers:writing-plans” 时，加载 `dao-plan`。
- **以外的 dao-* skill**（dao-verify 等）不是 superpowers 五步的成员，是辅助能力，可在五步中任何阶段加载。调试/重构/优化/测试等领域知识已内化到 dao.md。

## 反模式

| 病 | 症状 | 对治 |
|---|---|---|
| 把 Plan Mode 当 superpowers | 切 Plan Mode 图标就以为要 worktree | 两个独立体系，必须显式触发 superpowers |
| 任务太小论 | "改 3 行不需要 worktree" | 显式触发 = 流程承诺，与代码量无关 |
| 直觉跳 skill | "我已经懂了所以不 brainstorm" | 用户已显式触发 = 声明"希望走流程"，不是"AI 决定走流程" |
| 错认 dao-* 是另一套 | “走 superpowers 不能用 dao-plan” | dao-* 是 superpowers 的本地实现，调用名不同但哲学同一 |
| 路径偷懒 | 把 plan 随手写到个别位置 | 必须 `docs/specs/<topic>-plan.md`（不是 docs/plan/ 或 docs/superpowers/plans/） |
| 跳 reviewer | 自己 git diff 一眼就 push | reviewer subagent 是质量门；自检不算 |
| 直推 master | finishing-a-branch 跳过 | merge / PR 二选一，仪式必须 |
| 离心境裸走仪式 | 机械走五步无神 | 先内化 `dao-mantra` 八句心怀，再走本 gate 判定；无心境的仪式是形似 |

## 触发"补救协议"

若已动笔但发现满足复杂度阈值且没建议走 superpowers：

1. 立即停手（不再继续改代码）
2. 告知用户："此任务满足 X 条件，建议走 superpowers。已改的 N 行需要决定：(a) 撤回到 worktree 重做 (b) 接受当前结果但补 reviewer"
3. 由用户决策回滚程度

## 实战见证

**2026-05-13 无感切号**（CPU 54%→5.1%）：reviewer-critical 抓到 backfill SQL 缺索引——AI 自检难发现，生产数据放大才暴露。跳过 reviewer-critical = 上线后启动卡顿且难归因。核心模块走完整五步不是仪式，是让隐性 bug 在 review 阶段被抓住。详见 README.md + T183。
