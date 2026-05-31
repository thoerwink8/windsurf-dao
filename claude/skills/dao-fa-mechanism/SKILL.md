---
name: dao-fa-mechanism
description: Claude Code 运行机制参考——CLAUDE.md 注入与 @import、Skills 渐进披露、Slash Commands、Subagents、Hooks、settings.json、四类触发机制对照。健康检查、元分析、部署、或讨论"dao 配置怎么在 Claude Code 生效"时加载。
---

# Claude Code 天层机制感知

> 知人者智，自知者明。

dao 体系迁移自 Windsurf,本 skill 记录 Claude Code 的运行机制,以及 dao 各对象的落点。

## CLAUDE.md / Memory 文件

- **加载时机**:会话启动时一次性读入上下文,整个会话常驻——效果等同"每条消息可见"。这是 Windsurf `always_on` 的对应物。
- **层级**(全部合并,越具体越优先):企业级 → 用户级 `~/.claude/CLAUDE.md` → 项目根 `./CLAUDE.md` → 子目录 `CLAUDE.md`(读取该子树文件时按需带入)。
- **`@import`**:CLAUDE.md 里 `@路径` 可导入其它文件(相对/绝对/`~`),最大深度约 5 层;代码块内的 `@路径` 不触发导入。
- **dao 落点**:`claude/dao.md`(道德经场域)经 `~/.claude/CLAUDE.md` 的 `@import` 全局注入——单一真相源 + git 管理 + 每条消息常驻。

## Skills 渐进披露

- Skills 只向模型预载 `name` + `description`;模型判断任务相关时才读完整 `SKILL.md`;正文引用的其它文件再按需加载(三级递进)。
- 这正是 Windsurf `model_decision` 的对应物——dao 的 4 个 model_decision rules(cli/workflow-system/project-structure/design-assets)都转成了 skill。
- frontmatter:`name` + `description` 必填,`allowed-tools` 可选(限制工具)。**无 Windsurf 的 `trigger`/`globs` 字段**。
- skill 目录可带辅助脚本/模板(如 `dao-evolution/scripts/*.py`、`dao-ui-mockup/templates/`),调用时按需读取或执行。
- 位置:项目级 `.claude/skills/` 或用户级 `~/.claude/skills/`。dao 用 symlink 把 `claude/skills/dao-*` 链到 `~/.claude/skills/`。

## Slash Commands

- `.claude/commands/` 或 `~/.claude/commands/` 下的 `.md`,文件名即命令名(`dao-dev.md` → `/dao-dev`)。子目录构成命名空间。
- frontmatter:`description` / `argument-hint` / `allowed-tools` / `model` / `disable-model-invocation`。
- 正文占位符:`$ARGUMENTS`(全部参数)、`$1` `$2`(位置参数);`!` 前缀执行 bash;`@` 引用文件。
- 用户 `/命令` 显式触发;除非 `disable-model-invocation: true`,也可能被模型自动调用。
- 这是 Windsurf `workflows/` + `manual` trigger 的对应物——dao 的 10 个 workflow 都转成了 command。

## Subagents

- `.claude/agents/`(项目)/ `~/.claude/agents/`(用户),带 frontmatter 的 markdown。
- frontmatter:`name` / `description`(必填);`tools`(逗号分隔,省略则继承全部);`model`(sonnet/opus/haiku/inherit)。
- 调用:主 agent 按 `description` 自动委派(写明 "use proactively" 提高命中),或用户显式"用 X subagent"。
- dao 落点:`.devin/agents/` 8 个 → `claude/agents/dao-*.md`,服务于 `dao-pyramid` 金字塔调度。

## Hooks

- 配在 `settings.json` 的 `hooks` 字段。事件:`PreToolUse` / `PostToolUse` / `UserPromptSubmit` / `SessionStart` / `Stop` / `SubagentStop` / `PreCompact` / `Notification` / `SessionEnd` 等。
- 结构:`matcher`(匹配工具名如 `Edit|Write`)+ `hooks` 数组(`type: command` + `command`)。
- PreToolUse 可阻断工具(exit code 2);UserPromptSubmit / SessionStart 可向上下文注入文本。
- **用途**:这是补 Windsurf `glob` trigger 的关键——见下"glob 缺口"。

## settings.json

- `~/.claude/settings.json`(用户级) / `.claude/settings.json`(项目共享) / `.claude/settings.local.json`(项目本地,不入 git)。
- 优先级(高→低):企业策略 > 命令行 > 项目 local > 项目 > 用户。
- 关键项:`permissions`(allow/deny/ask) / `hooks` / `model` / `env` / `statusLine` 等。

## 四类触发机制对照(Windsurf → Claude Code)

| Windsurf trigger | 行为 | Claude Code 对应 |
|---|---|---|
| `always_on` | 每条消息注入完整内容 | **CLAUDE.md** / `@import`(`claude/dao.md`) |
| `model_decision` | 仅注入 description,模型决定读全文 | **Skills**(渐进披露,语义最贴) |
| `manual` | `@rule-name` 显式触发 | **Slash command** / 加载对应 skill |
| `glob` | 匹配文件类型时注入 | **无原生对应**(见下) |

## glob 缺口(唯一无 1:1 对应)

Claude Code 没有"编辑 `*.ts` 时自动注入规则"的声明式机制。dao 的 `quality.md`(代码质量门)/ `dao-meta.md`(dao 元层守卫)按以下方式落地:

1. **转 skill**(已用):`quality` → skill,description 写明"编写/审查代码时加载",靠模型判断。软触发,无强保证。
2. **子目录 CLAUDE.md**:把某类代码放特定目录 + 该目录 CLAUDE.md。按目录路径触发,非扩展名。
3. **PreToolUse hook**(强保证,可选):matcher `Edit|Write`,hook 脚本检查目标路径是否匹配 glob,匹配则注入规则文本。能真正复现"编辑 .tsx 时才注入 X"。dao-meta 这类"编辑 dao 文件时守卫"可用此法,或直接靠 `claude/` 目录的项目级 CLAUDE.md。

## dao 项目目录结构(Claude Code 侧)

```
windsurf-dao/
├── claude/                      # Claude Code 侧真相源(git 管理)
│   ├── dao.md                   # always_on 道德经场域(@import 注入)
│   ├── skills/dao-*/            # 30+ skills(model_decision 渐进披露)
│   ├── commands/dao-*.md        # 10 workflows → slash commands
│   └── agents/dao-*.md          # subagents(金字塔调度)
├── .windsurf/                   # Windsurf 侧(双栈共存,同源不同壳)
├── global_rules.md              # Windsurf 元规则源
└── dao.ps1                      # link-claude(Claude 侧) / link-global·link-rules(Windsurf 侧)
references/道德经.md             # 推导源头,不可修改
```
