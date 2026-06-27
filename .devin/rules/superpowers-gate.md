---
trigger: always_on
---

# superpowers · 触发门控

> 配合 global_rules.md "四 · 谋（重器之门）"。本文件提供执行清单与判据。
> 仅在 dao sidecar 项目内加载；非 dao 项目走 global_rules.md 精炼版即可。

## 与 dao-mantra / Plan Mode 的关系

**mantra 先 → gate 后 → workflow 落地**：`dao-mantra.md` 内化心境（always_on），本文件判定是否走五步，`/dao-superpowers` 实施。无心境裸走仪式 = 形似神离。

**Plan Mode ≠ superpowers**：Windsurf Plan Mode 是 IDE 内置功能（轻，plan 在 `~/.windsurf/plans/`），superpowers 是工作流标准（重，plan 在 `docs/specs/`，含 worktree + subagent + reviewer）。两个独立体系，不绑定，AI 也无法检测 Plan Mode 状态。

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

> AI 调用 skill 时用 dao-* 名（obra 名仅作概念识别）。

**五步**：① `dao-worktree`（隔离 worktree）→ ②⭐ UI 任务先过 `dao-design-standards` §0 分诊（DIRECT/SCOPED/FULL，🔒×2 用户关卡）→ ②.1 `dao-plan`（`docs/specs/<topic>-plan.md`，UI 任务首句读 `_tmp/design-tokens-<topic>.json`）→ ③ 派 implementer subagent（task 间 checkpoint）→ ④ `dao-review`（核心模块走 reviewer-critical）→ ⑤ merge/PR/cleanup（**不可直推 master**）。补充：`dao-brainstorm` 在 plan 前按需。

**2.0 触发判据**：任务含 主题/样式/色板/视觉/换肤/UI 重构等关键词 → 必走；非 UI → 跳到 2.1。每步必 announce。

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

dao-* 与 obra superpowers 本质等价（dao-worktree ≡ using-git-worktrees，dao-plan ≡ writing-plans，dao-review ≡ requesting-code-review，dao-brainstorm ≡ brainstorming）。AI 只能加载 dao-* 名。五步外的 dao-* skill（dao-verify 等）是辅助能力，可在任意阶段加载。

## 反模式

Plan Mode 当 superpowers（两套独立）| 任务太小论跳 worktree（显式触发=承诺）| 直觉跳 skill（用户触发≠AI 决定）| 路径偷懒（plan 必须在 `docs/specs/`）| 跳 reviewer（自检不算）| 直推 master（merge/PR 必须）| 无心境裸走仪式（先 mantra 后 gate）。

## 补救协议

已动笔但发现满足复杂度阈值 → 立即停手 → 告知用户"满足 X 条件，建议走 superpowers，已改 N 行需决定：(a) 撤回 worktree 重做 (b) 补 reviewer" → 用户决策。

## 实战见证

**2026-05-13**：reviewer-critical 抓到 backfill SQL 缺索引（CPU 54%→5.1%），AI 自检难发现。核心模块走完整五步不是仪式，是让隐性 bug 在 review 阶段被抓住。
