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

## 体系架构（v3 · 单栈 ccswitch，2026-07-07 对齐现状）

```
场域根基（ccswitch/dao.md · always_on，经 @import 每条消息常驻）
        ↓
按需知识（ccswitch/skills/ · 9 个 skill，全部 disable-model-invocation，用户 /命令 触发）
        ↓
入口命令（ccswitch/commands/ · 10 个 slash command）
        ↓
精准注入（hooks：dao-quality 质量门 / dao-meta 守卫 / dao 同步提醒等，按文件类型触发）
        ↓
技术栈处方（ccswitch/stacks/ · desktop-tauri / remote-ops / frontend / backend）
```

> Windsurf 时代的「9 文件 5 层规则架构」（global_rules/execution/shell/quality…）已随双栈退役归入历史，
> `global_rules.md` 留档但带 DEPRECATED 标记。

## 包含什么

### 场域根基（`ccswitch/dao.md`）

always_on 唯一入口：八句根基、三才之机、续力、知识归位、三管线门控、GUI 决策树、Shell 血泪增量、路由铁律。

### 命令（`ccswitch/commands/` · 10 个）

> slash command，用户通过 `/dao-*` 手动触发。

| 命令 | 功能 |
|---|---|
| `/dao-dev` | 一句话需求 → 完整交付（三阶九步） |
| `/dao-loop` | 文档驱动多轮迭代（spec/开工包续跑） |
| `/dao-superpowers` | 五步工程仪式：worktree→plan→exec→review→finish |
| `/dao-serve` | 在 worktree 一键启动 dev server |
| `/dao-distill` | 会话级知识沉淀 |
| `/dao-evolve` | 系统自我进化 + 体检 + 减法 |
| `/dao-commit` | 自动 commit message + 内聚拆分 |
| `/dao-doc` | 文档生成与更新 |
| `/dao-remove` | 减法专用：安全移除 |
| `/gs` | git status 速查 |

### 技能（`ccswitch/skills/` · 9 个）

> 全部 `disable-model-invocation: true`，用户 `/name` 手动触发；跨 skill 靠交接信息路由。

| skill | 一句话 |
|---|---|
| `dao-brainstorm` | 苏格拉底式挖需求 → design 文档 |
| `dao-plan` | design → 2-5 分钟粒度实施任务清单 |
| `dao-loop` | 谋线/造线双阶段循环开发 |
| `dao-review` | two-stage 评审（spec 合规 + 代码质量） |
| `dao-verify` | 全面体检 / 涅槃门 |
| `dao-design` | 设计统一入口（原 7 个设计 skill 合并为 supporting files） |
| `dao-worktree` | 隔离工作区 |
| `dao-evolution` | 教训 / 演化沉淀 |
| `dao-project-scaffold` | 项目标准结构脚手架 |

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
| 技能 | `ccswitch/skills/dao-*/` | 9 | 渐进披露；全部 `disable-model-invocation`，用户 `/name` 手动触发 |
| 命令 | `ccswitch/commands/` | 10 | slash command，`/dao-dev` `/dao-loop` `/dao-serve` 等 |
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
# 注意：~/.codex/skills 的写入方是 cc-switch store（2026-07-27 拍板）。
# link-codex 只补 store 没有的名字；store 已占的名字一律让行，不再覆盖。
.\dao.ps1 link-codex             # 补 store 未覆盖的 skills → ~/.codex/skills
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
| `link-codex [-DryRun]` | 补 Claude skills → Codex（**只填 cc-switch store 未占的名字**，store 已占则让行） |
| `unlink-codex [-DryRun]` | 移除 Codex skill 链接（只删 dao 管理的链 + 悬空链，不碰 cc-switch store 的链） |
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
