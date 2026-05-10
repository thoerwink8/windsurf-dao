---
trigger: always_on
---

# superpowers · 触发门控

> 配合 global_rules.md "四 · 谋（重器之门）"。本文件提供执行清单与判据。
> 仅在 dao sidecar 项目内加载；非 dao 项目走 global_rules.md 精炼版即可。

## 与 Windsurf Plan Mode 的边界（先讲清楚）

| 维度 | Windsurf Plan Mode | superpowers |
|---|---|---|
| 性质 | IDE 内置功能（模式切换器图标） | obra 团队的工作流标准 |
| plan 文件 | `~/.windsurf/plans/`（用户全局） | `docs/superpowers/plans/`（项目内） |
| 工具 | "All tools enabled" 同 Code 模式 | 同 Code 模式 |
| 退出 | 点 Implement / 切 Code / agent 自动 | 走完 finishing-a-branch / 用户喊停 |
| 重量 | 轻（讨论 + 单文件 markdown） | 重（worktree + subagent + reviewer） |

**不绑定**：用户切到 Windsurf Plan Mode ≠ 自动走 superpowers。两个独立体系，按需组合。AI 也无法可靠检测到自己在 Plan Mode（官方文档未承诺暴露此信号），故不依赖。

## superpowers 触发信号

### 显式触发（强信号 · 必走五步）

- 用户口头说：「走 superpowers」「开 worktree 走」「走完整流程」「subagent 派一下」
- 用户引用 superpowers 的 skill 名（writing-plans / using-git-worktrees / requesting-code-review 等）
- AI 自身已经写出 `docs/superpowers/plans/` 下的 plan 文件 → 视为已进入

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

| 步 | Skill | 产出 |
|---|---|---|
| 1 | `superpowers:using-git-worktrees` | 隔离 worktree（路径优先 `~/.config/superpowers/worktrees/`，回落 `.worktrees/`） |
| 2 | `superpowers:writing-plans` | `docs/superpowers/plans/YYYY-MM-DD-<topic>.md`（标准路径，**不要**写到 `docs/specs/`） |
| 3 | `superpowers:subagent-driven-development` | 每 task 派 implementer subagent，task 间 checkpoint 让用户 review |
| 4 | `superpowers:requesting-code-review` | 提交前派 reviewer subagent；核心模块（auth/payment/security/core orchestration）走 reviewer-critical |
| 5 | `superpowers:finishing-a-development-branch` | merge / PR / cleanup 仪式，**不可直接 push master** |

每步必有"announce at start"——明示用户当前在哪个 skill 里。

## 解除条件

- 用户主动退出（明确表达"退出 superpowers"、"不走流程了"等）
- `superpowers:brainstorming` 阶段评估发现"不需 multi-step plan"，**明确告知用户后**退出
- 任务进入 finishing-a-development-branch 完成 → 自然解除

## 进入即承诺

显式触发后**不得中途偷工**：
- 不可"任务变小了"为由跳 reviewer subagent
- 不可"我已经看过了"为由跳 worktree
- 不可"路径快不重要"为由放弃 `docs/superpowers/plans/` 标准位置
- 不可直推 master

## 与 dao-* skill 的边界

- dao-* 是道家镜头/方法论体系，注重哲学思辨与流程意识
- superpowers 是 obra 标准化流程体系，注重 subagent 派遣与 checkpoint
- **显式触发 superpowers 后以 superpowers 为骨**，dao-* 可作为镜头加载（如 dao-debug 在 brainstorming 阶段帮助根因分析）
- 不混用——不要把 dao-plan 当 superpowers:writing-plans 的替代

## 反模式

| 病 | 症状 | 对治 |
|---|---|---|
| 把 Plan Mode 当 superpowers | 切 Plan Mode 图标就以为要 worktree | 两个独立体系，必须显式触发 superpowers |
| 任务太小论 | "改 3 行不需要 worktree" | 显式触发 = 流程承诺，与代码量无关 |
| 直觉跳 skill | "我已经懂了所以不 brainstorm" | 用户已显式触发 = 声明"希望走流程"，不是"AI 决定走流程" |
| 体系混用 | 用 dao-plan skill 替代 writing-plans | 两套体系并行，不互相替代 |
| 路径偷懒 | 把 plan 写到 `docs/specs/` 或 `docs/plan/` | 必须 `docs/superpowers/plans/` |
| 跳 reviewer | 自己 git diff 一眼就 push | reviewer subagent 是质量门；自检不算 |
| 直推 master | finishing-a-branch 跳过 | merge / PR 二选一，仪式必须 |

## 触发"补救协议"

若已动笔但发现满足复杂度阈值且没建议走 superpowers：

1. 立即停手（不再继续改代码）
2. 告知用户："此任务满足 X 条件，建议走 superpowers。已改的 N 行需要决定：(a) 撤回到 worktree 重做 (b) 接受当前结果但补 reviewer"
3. 由用户决策回滚程度
