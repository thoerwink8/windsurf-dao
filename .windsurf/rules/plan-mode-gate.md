---
trigger: always_on
---

# Plan Mode · 硬门控

> 配合 global_rules.md "四 · 谋（重器之门）"。本文件提供执行清单与判据。
> 仅在 dao sidecar 项目内加载；非 dao 项目走 global_rules.md 精炼版即可。

## 触发信号（任一命中即激活）

- Windsurf Plan Mode 系统提示信号（system prompt 中包含 plan mode 标识）
- 用户口头宣告："plan 模式下"、"开始规划"、"做 plan"、"先 plan"、"进入 planning"
- Cascade 自身写出 plan 文档到 `docs/superpowers/plans/` 时即视为已进入

## 强制流程（缺一为流程缺陷）

| 步 | Skill | 产出 |
|---|---|---|
| 1 | `superpowers:using-git-worktrees` | 隔离 worktree（路径优先 `~/.config/superpowers/worktrees/`，回落 `.worktrees/`） |
| 2 | `superpowers:writing-plans` | `docs/superpowers/plans/YYYY-MM-DD-<topic>.md`（标准路径，**不要**写到 `docs/specs/`） |
| 3 | `superpowers:subagent-driven-development` | 每 task 派 implementer subagent，task 间 checkpoint 让用户 review |
| 4 | `superpowers:requesting-code-review` | 提交前派 reviewer subagent；核心模块（auth/payment/security/core orchestration）走 reviewer-critical |
| 5 | `superpowers:finishing-a-development-branch` | merge / PR / cleanup 仪式，**不可直接 push master** |

每步必有"announce at start"——明示用户当前在哪个 skill 里。

## 解除条件

- 用户主动退出 Plan Mode（明确表达"退出 plan"、"不走 plan 了"等）
- `superpowers:brainstorming` 阶段评估发现"不需 multi-step plan"，**明确告知用户后**退出
- 任务进入 finishing-a-development-branch 完成 → 自然解除

## 进入即承诺

进入 Plan Mode 后**不得中途偷工**：
- 不可"任务变小了"为由跳 reviewer subagent
- 不可"我已经看过了"为由跳 worktree
- 不可"路径快不重要"为由放弃 `docs/superpowers/plans/` 标准位置

## 非 Plan Mode 行为

AI 凭复杂度判断走何流程，但满足以下任一 SHOULD **主动建议**用户进入 Plan Mode：

- ≥3 文件改动
- ≥100 LOC 净增
- 涉及核心模块（auth / payment / security / core orchestration / 多端共享逻辑）
- 跨语言 / 跨服务边界
- 不可逆操作（DB migration / schema change / config wipe / 删除生产数据）
- 涉及双轨/多轨架构归一

建议格式：「这事满足 X 条件，建议进入 Plan Mode 走完整 superpowers，要不要？」

## 与 dao-* skill 的边界

- dao-* 是道家镜头/方法论体系，注重哲学思辨与流程意识
- superpowers 是 obra 标准化流程体系，注重 subagent 派遣与 checkpoint
- **进入 Plan Mode 后以 superpowers 为骨**，dao-* 可作为镜头加载（如 dao-debug 在 brainstorming 阶段帮助根因分析）
- 不混用——不要把 dao-plan 当 superpowers:writing-plans 的替代

## 反模式

| 病 | 症状 | 对治 |
|---|---|---|
| 任务太小论 | "改 3 行不需要 worktree" | 进入 Plan Mode = 流程承诺，与代码量无关 |
| 直觉跳 skill | "我已经懂了所以不 brainstorm" | 用户进 Plan Mode 已声明"我希望走流程"，不是"AI 决定走流程" |
| 体系混用 | 用 dao-plan skill 替代 writing-plans | 两套体系并行，不互相替代 |
| 路径偷懒 | 把 plan 写到 `docs/specs/` 或 `docs/plan/` | 必须 `docs/superpowers/plans/` |
| 跳 reviewer | 自己 git diff 一眼就 push | reviewer subagent 是质量门；自检不算 |
| 直推 master | finishing-a-branch 跳过 | merge / PR 二选一，仪式必须 |

## 触发"补救协议"

若已动笔但发现该走 Plan Mode 没走：

1. 立即停手（不再继续改代码）
2. 告知用户："此任务满足 X 条件，应走 Plan Mode。已改的 N 行需要决定：(a) 撤回到 worktree 重做 (b) 接受当前结果但补流程"
3. 由用户决策回滚程度
