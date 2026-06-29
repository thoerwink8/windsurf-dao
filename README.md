# Windsurf Dao — AI 配对编程方法论

> 道法自然。人为一，AI为二，冲气以为和。

一套基于道德经哲学的 AI 配对编程方法论体系，以 **Claude Code** 为主宿主，同时支持 **Codex** 镜像部署。真相源在 `ccswitch/` 目录。

> 📖 **新用户从这里开始**：[使用手册 USAGE.md](USAGE.md) · 3 分钟入门，不需要懂道德经

## 文档导航（按读者视角）

| 文件 | 读者 | 何时读 |
|---|---|---|
| **[USAGE.md](USAGE.md)** | 普通用户 | 想知道怎么用 dao 时（3 分钟入门）⭐ |
| [README.md](README.md)（本文） | 开发者 / 贡献者 | 想了解架构和文件清单 |
| [NEW-MACHINE.md](NEW-MACHINE.md) | 换机部署者 | 新机器从零搭建完整环境时 🖥️ |
| [MIGRATION.md](MIGRATION.md) | 部署者 | 把 dao 规则部署进某个项目时 |
| [AGENT_GUIDE.md](AGENT_GUIDE.md) | AI 自身 | AI 加载时自动读（人也可看） |
| [docs/specs/](docs/specs/) | 开发者 | 查历史 plan 归档 |

不确定该看哪个→ 先看 USAGE.md。

## 这是什么

这不是一个代码库，而是一套 **AI 行为规则系统**——定义 AI 如何思考、如何行动、如何与人协作。

核心理念：让 AI 从"工具"变成"搭档"。通过道德经的哲学框架，建立一套可复用、可迁移、可进化的 AI 行为准则。

## 体系架构（v2 · 2026-04-26 重构）

```
元规则（global_rules.md · 31 行 · 跨项目 symlink）
        ↓
项目铁律（execution.md · always_on）
        ↓
领域决策（shell/cli/skills/workflow-system/knowledge-routing · model_decision）
        ↓
精准触发（quality · dao-meta · glob）
        ↓
深度哲学（dao-philosophy · manual @ 调用）
```

## 包含什么

### 规则文件（`ccswitch/`）

> Claude Code 侧规则内嵌于 `ccswitch/dao.md`（场域根基，always_on）及各 skill/command 中，不再有独立 rules 目录。

| 文件 | trigger | 内容 |
|---|---|---|
| `dao-mantra.md` | always_on | 道德经八句根基 + 场景速查 |
| `execution.md` | always_on | 项目铁律（感知/执行/涅槃门/续力） |
| `superpowers-gate.md` | always_on | superpowers 五步触发门控 |
| `shell.md` | always_on | 命令安全（超时/防卡/PowerShell/SSH） |
| `knowledge-routing.md` | always_on | 知识归位路由 |
| `cli.md` | model_decision | 工具选择（CLI-first/MCP） |
| `workflow-system.md` | model_decision | 工作流协作 |
| `quality.md` | glob | 代码质量门 |
| `dao-meta.md` | glob | dao 元层守卫 |
| `dao-philosophy.md` | manual | 八条不变原则 |

### 命令（`ccswitch/commands/`）

> slash command，用户通过 `/dao-*` 手动触发。

| 工作流 | 功能 |
|---|---|
| `/dao-dev` | 一句话需求 → 完整交付（三阶九步） |
| `/dao-superpowers` | 五步工程仪式：worktree→plan→exec→review→finish |
| `/dao-distill` | 会话级知识沉淀 |
| `/dao-evolve` | 系统自我进化 + 体检 + 减法 |
| `/dao-commit` | 自动 commit message + 内聚拆分 |
| `/dao-doc` | 文档生成与更新 |
| `/dao-goal` | 目标导向持续推进 |

### 技能（`ccswitch/skills/`）

> 按场景自动加载。完整清单见 `ls ccswitch/skills/`。

| 类别 | 代表 skill | 一句话 |
|---|---|---|
| 工程方法 | `dao-brainstorm` → `dao-plan` → `dao-review` → `dao-verify` | superpowers 五步核心 |
| 设计流水线 | `dao-design-system` → `dao-design-open` → `dao-design-fidelity` | 设计系统→翻译→验证 |
| 设计辅助 | `dao-design-standards` · `dao-design-asset` · `dao-component-radar` | 判据/布局/资产/组件健康 |
| 领域专项 | `dao-cloud` · `dao-evolution` · `dao-worktree` · `dao-goal` | 按场景触发 |

### 配置同步（`config-sync/`）

跨端配置备份 / 恢复 / 体检模块。以 cc-switch 为运行态真相源，把配置导出为可版本化的文件，换机时再恢复。

**统一入口**：`dao.bat`（四合一：下行恢复 / 上行导出 / 体检 / 盘点）

```text
config-sync/
  dao.bat           # 唯一入口（DB ↔ 仓库 ↔ origin 三层同步）
  lib/sync.mjs           # 编排器（也可 node lib/sync.mjs --doctor 直接调用）
  common/                # 通用配置快照（进 git）
  common-secrets.json    # settings 脱敏真实值（不进 git，换机手动复制）
```

详见 [`config-sync/README.md`](config-sync/README.md)。

### MCP 配置（`ccswitch/mcp/`）

预配置的 MCP 启动脚本（绕过 npx 超时）：chrome-devtools / context7 / github / playwright / tavily 等。

### 元规则（`global_rules.md`）

31 行跨项目元规则。Claude Code 侧已整合进 `ccswitch/dao.md`，此文件保留为历史参考。

### 项目知识文件

每个接入 dao 的项目推荐维护：

| 文件 | 作用 |
|---|---|
| `USAGE.md` | 用户使用手册 ⭐ |
| `TODO.md` | 任务图唯一载体 |
| `AGENT_GUIDE.md` | 活体知识库 |
| `docs/evolution/evolution-*.csv` | 演化条目 + 教训 |

### 源文本（`docs/classics/道德经.md`）

老子《道德经》全文——一切规则的推导源头，不可修改。

## Claude Code 侧（唯一真相源）

> `ccswitch/` 是 dao 体系的唯一真相源。规则按宿主能力裁剪（Claude Code 已内置 shell 沙箱 / git 安全 / 破坏性操作确认，dao 只保留不重叠的独有增量）。部署见 [MIGRATION.md · Claude Code 部署](MIGRATION.md#claude-code-部署双栈共存)。

| 对象 | 路径 | 数量 | 角色 |
|---|---|---|---|
| 场域根基 | `ccswitch/dao.md` | 1 | 道德经场域根基 · 经 `~/.claude/CLAUDE.md` 的 `@import` 全局注入，每条消息常驻 |
| 技能 | `ccswitch/skills/dao-*/` | 17 | 渐进披露，模型按 `description` 自动加载 |
| 命令 | `ccswitch/commands/dao-*.md` | 8 | slash command，`/dao-dev` `/dao-commit` 等 |
| 子代理 | `ccswitch/agents/dao-*.md` | 8 | subagent，服务 dao-loop 金字塔调度 |
| 技术栈处方 | `ccswitch/stacks/` | — | 技术栈处方（`/dev` 基建审计按需加载） |

部署入口：`dao.ps1 link-claude` 一键 symlink 上述对象到 `~/.claude/`，并幂等追加 `dao.md` 的 `@import`。

## 快速开始

> [USAGE.md](USAGE.md) · 3 分钟入门，不需要懂道德经。

```bash
git clone <repo-url>
cd windsurf-dao
```

**按宿主选部署命令**：

```powershell
# Claude Code（主宿主，全局生效）
.\dao.ps1 link-claude            # symlink skills/commands/agents + @import dao.md

# Codex（镜像部署）
.\dao.ps1 link-codex             # mirror skills → ~/.codex/skills
.\dao.ps1 link-codex-prompts     # 高频 dao prompts → ~/.codex/prompts

# IDE 终端
.\dao.ps1 set-terminal           # 默认终端 cmd → Git Bash

# 验证
.\dao.ps1 status                 # 链接健康矩阵
```

## dao.ps1 命令一览

| 命令 | 作用 |
|---|---|
| `status` | 查看 dao 链接健康状态 |
| `link-claude [-DryRun]` | 部署 dao 到 Claude Code（skills/commands/agents + @import） |
| `unlink-claude [-DryRun]` | 反向移除 Claude Code 中的 dao 链接 |
| `link-codex [-DryRun]` | mirror Claude skills → Codex |
| `unlink-codex [-DryRun]` | 移除 Codex skill 链接 |
| `link-codex-prompts [-DryRun]` | 高频 dao 命令写入 Codex prompts |
| `unlink-codex-prompts [-DryRun]` | 移除 Codex prompts |
| `set-terminal` | IDE 默认终端 cmd.exe → Git Bash（Windsurf/Code/Cursor） |

通用选项：`-AlwaysOnOnly`（仅 link always_on 类）、`-DryRun`（预览不写入）。

## 部署结构

```
windsurf-dao/                  # 真相源
├── ccswitch/                  # dao 体系唯一真相源
│   ├── dao.md                 # 场域根基（always_on）
│   ├── skills/                # 技能（按场景自动加载）
│   ├── commands/              # 命令（/dao-* slash command）
│   └── agents/                # 子代理（dao-loop 金字塔调度）
├── config-sync/               # 配置同步（dao.bat 四合一入口）
├── dao.ps1                    # 链接管理
└── global_rules.md            # 元规则
```

**变更流**：编辑 windsurf-dao → 所有 workspace 即时可见 → `/dao-commit` 提交。

## 自定义

体系可进化。`/dao-evolve` 审查改进。为道日损——删 > 改 > 增。

添加 skill：`ccswitch/skills/your-skill/SKILL.md`（frontmatter: name + description）。
添加 command：`ccswitch/commands/your-command.md`（YAML frontmatter + Markdown）。

## 哲学基础

> 为学日益，为道日损。损之又损，以至于无为。无为而无不为。

1. **AI 配对编程是关系** — 人+AI=AGI，冲气以为和
2. **进化是减法** — 规则越少越好，能力越内化越好
3. **规则终态是忘掉规则** — 含德之厚，比于赤子
4. **身教重于言教** — 推广的范式，自身先实践

## 历史备注

`.devin/` 目录（Windsurf 侧外壳）已于 2026-06-29 退役删除。`ccswitch/` 为唯一真相源。如需查阅历史 Windsurf 配置，可从 git 历史恢复。

## 许可

私人使用。
