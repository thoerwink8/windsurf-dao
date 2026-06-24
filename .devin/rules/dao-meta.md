---
trigger: glob
globs: .devin/rules/**/*.md, .devin/skills/dao-**/*.md, .devin/workflows/dao-*.md
---

# Dao 元层 · 变更守卫

> 道文件是元层（怎么思考 / 工作），不是操作层（用什么技术栈）。两层正交，不可混淆。

## 项目集成

windsurf-dao 作为 **Sidecar workspace** 与目标项目同时打开，rules/skills/workflows 自动跨 workspace 可见。

**dao 命名空间**：所有 dao 来源的 skills / workflows 统一 `dao-` 前缀，一眼分清来源。

| 类型 | dao 元层 | 项目操作层 |
|---|---|---|
| Rules | 本目录所有 `.md` | 项目特定 rules |
| Skills | `dao-verify/` 等 | `frontend-design/` 等 |
| Workflows | `dao-dev.md` 等 | `commit.md`、`review.md` 等 |

## 编辑 dao 元层文件前过三关

1. **通用性**：换到完全不同的项目还成立吗？不成立 → 写项目的 `AGENT.md`
2. **内容边界**：只允许思维方式 / 工作流程 / 行为准则。**禁止**：技术选型 / 框架 / API / 配置
3. **影响评估**：会让使用 dao 的其他项目行为变差吗？不确定 → 不改

**不通过 → 路由到项目的 `AGENT.md`。**

法不违德，德不违道，道法自然。
