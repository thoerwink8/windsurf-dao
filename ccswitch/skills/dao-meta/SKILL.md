---
name: dao-meta
description: dao 元层变更守卫——编辑 dao 体系自身文件(ccswitch/dao.md、ccswitch/skills/dao-*、ccswitch/commands/dao-*、ccswitch/agents/dao-*)前过三关:通用性/内容边界/影响评估。判断"这条该进 dao 元层还是项目 AGENT.md"时加载。
---

# Dao 元层 · 变更守卫

> 道文件是元层（怎么思考 / 工作），不是操作层（用什么技术栈）。两层正交，不可混淆。

> 注:Windsurf 下本规则靠 glob(匹配 `.windsurf/**/dao-*`)自动注入。Claude Code 无原生 glob trigger——编辑 `ccswitch/` 下 dao 文件时,本 skill 靠模型判断加载;也可在 `ccswitch/` 放项目级 CLAUDE.md 或用 PreToolUse hook 强保证(见 dao-fa-mechanism)。

## dao 命名空间

所有 dao 来源的 skills / commands / agents 统一 `dao-` 前缀，一眼分清来源。

| 类型 | dao 元层 | 项目操作层 |
|---|---|---|
| 场域根基 | `ccswitch/dao.md`(@import 注入) | 项目 `CLAUDE.md` / `AGENT.md` |
| Skills | `ccswitch/skills/dao-*/` | 项目特定 skill |
| Commands | `ccswitch/commands/dao-*.md` | 项目特定 command |
| Agents | `ccswitch/agents/dao-*.md` | 项目特定 subagent |

## 编辑 dao 元层文件前过三关

1. **通用性**：换到完全不同的项目还成立吗？不成立 → 写项目的 `AGENT.md`/`CLAUDE.md`
2. **内容边界**：只允许思维方式 / 工作流程 / 行为准则。**禁止**：技术选型 / 框架 / API / 配置
3. **影响评估**：会让使用 dao 的其他项目行为变差吗？不确定 → 不改

**不通过 → 路由到项目的 `AGENT.md` / `CLAUDE.md`。**

> 双栈提醒:dao 元层文件在 `ccswitch/` 与 `.windsurf/` 双栈共存,同源不同壳。改 dao 体系本质时,两侧需保持哲学一致(`/dao-evolve` 时一并审视)。

法不违德，德不违道，道法自然。
