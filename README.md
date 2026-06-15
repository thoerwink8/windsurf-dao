# Windsurf Dao — AI 配对编程方法论

> 道法自然。人为一，AI为二，冲气以为和。

一套基于道德经哲学的 AI 配对编程方法论体系，最初为 [Windsurf](https://codeium.com/windsurf) IDE 设计，现已扩展为 **Windsurf + Claude Code 双栈共存**（同源不同壳，见[Claude Code 侧](#claude-code-侧双栈共存)）。

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

### 规则文件（`.devin/rules/`）

> 数量以目录为准：`ls .devin/rules/`。trigger 全分配见 `.devin/rules/README.md`。

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

### 工作流（`.devin/workflows/`）

> Claude Code 侧等价物在 `ccswitch/commands/dao-*.md`。

| 工作流 | 功能 |
|---|---|
| `/dao-autopilot` | 自主驾驶：探测 TODO/AGENT_GUIDE → 执行 → 回写 |
| `/dao-dev` | 一句话需求 → 完整交付（三阶九步） |
| `/dao-superpowers` | 五步工程仪式：worktree→plan→exec→review→finish |
| `/dao-cycle` | 五相迭代（观→行→验→省→改升） |
| `/dao-distill` | 会话级知识沉淀 |
| `/dao-evolve` | 系统自我进化 + 体检 + 减法 |
| `/dao-commit` | 自动 commit message + 内聚拆分 |
| `/dao-doc` | 文档生成与更新 |
| `/dao-thread-tree` | 处理 Open Threads |
| `/dao-session-sync` | 多会话协作（git 共享状态） |

### 技能（`.devin/skills/`）

> 共 27+ 个 skill，按场景自动加载。完整清单见 `ls .devin/skills/`。

| 类别 | 代表 skill | 一句话 |
|---|---|---|
| 元层调度 | `dao-pyramid` · `dao-fa-mechanism` | 金字塔 subagent / 机制参考 |
| 开发镜头 | `dao-debug` · `dao-refactor` · `dao-test` · `dao-optimize` | cycle 内按需加载 |
| 工程方法 | `dao-brainstorm` → `dao-plan` → `dao-execute` → `dao-review` → `dao-finish` | superpowers 五步 |
| 领域专项 | `dao-research` · `dao-deploy` · `dao-cloud` · `dao-user-simulation` 等 | 按场景触发 |

### 配置同步（`config-sync/`）

跨端配置备份 / 恢复 / 体检模块。以 cc-switch 为运行态真相源，把配置导出为可版本化的文件，换机时再恢复。

**统一入口**：`dao-sync.bat`（四合一：下行恢复 / 上行导出 / 体检 / 盘点）

```text
config-sync/
  dao-sync.bat           # 唯一入口（DB ↔ 仓库 ↔ origin 三层同步）
  lib/sync.mjs           # 编排器（也可 node lib/sync.mjs --doctor 直接调用）
  common/                # 通用配置快照（进 git）
  providers/             # 供应商 token（不进 git，换机手动复制）
```

详见 [`config-sync/README.md`](config-sync/README.md)。

### MCP 配置（`mcp/`）

预配置的 MCP 启动脚本（绕过 npx 超时）：chrome-devtools / context7 / github / playwright / tavily 等。

### 元规则（`global_rules.md`）

31 行跨项目元规则。部署：`dao.ps1 link-global` → symlink 到 `~/.codeium/windsurf/memories/`，所有项目全局生效。

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

## Claude Code 侧（双栈共存）

> 同源不同壳。`ccswitch/` 与 `.devin/` 是同一套 dao 的两副外壳，各自适配宿主的加载机制。

迁移到 Claude Code CLI 后新增 `ccswitch/` 目录作为 Claude Code 侧真相源，与上面的 `.devin/` 并列。规则内核同源，外壳按宿主能力裁剪（Claude Code 已内置 shell 沙箱 / git 安全 / 破坏性操作确认，dao 只保留不重叠的独有增量）。部署见 [MIGRATION.md · Claude Code 部署](MIGRATION.md#claude-code-部署双栈共存)。

| 对象 | 路径 | 数量 | 角色（对应 Windsurf 侧） |
|---|---|---|---|
| 场域根基 | `ccswitch/dao.md` | 1 | 道德经场域根基 · 经 `~/.ccswitch/CLAUDE.md` 的 `@import` 全局注入，每条消息常驻（≈ always_on 规则） |
| 技能 | `ccswitch/skills/dao-*/` | 38 | 渐进披露，模型按 `description` 自动加载（≈ model_decision；含原 dao + 部分 rule 转 skill + 自检 skill） |
| 命令 | `ccswitch/commands/dao-*.md` | 10 | slash command，`/dao-dev` `/dao-cycle` `/dao-commit` 等（≈ manual + 由 workflow 平移） |
| 子代理 | `ccswitch/agents/dao-*.md` | 8 | subagent，服务 `dao-pyramid` 金字塔调度（由 `.devin/agents` 平移） |
| 技术栈处方 | `ccswitch/stacks/` | — | 技术栈处方（`/dev` 基建审计按需加载） |

部署入口：`dao.ps1 link-claude` 一键 symlink 上述对象到 `~/.ccswitch/`，并幂等追加 `dao.md` 的 `@import`。

## 快速开始

> [USAGE.md](USAGE.md) · 3 分钟入门，不需要懂道德经。

```bash
git clone <repo-url>
cd windsurf-dao
```

**按宿主选部署命令**：

```powershell
# Windsurf（Sidecar 模式：打开 workspace 即生效）
.\dao.ps1 link-global            # 一次性，链接元规则

# Claude Code（全局生效）
.\dao.ps1 link-claude            # symlink skills/commands/agents + @import dao.md

# Codex
.\dao.ps1 link-codex             # mirror skills → ~/.codex/skills
.\dao.ps1 link-codex-prompts     # 高频 dao prompts → ~/.codex/prompts

# 验证
.\dao.ps1 status                 # 链接健康矩阵
```

## dao.ps1 命令一览

| 命令 | 作用 |
|---|---|
| `status` | 查看 dao 链接健康状态 |
| `link-global` | 链接 `global_rules.md` → Windsurf 全局配置 |
| `link-rules <project>` | symlink dao rules 到指定项目 |
| `link-rules-all [-Root <dir>]` | 批量扫描并 symlink 所有项目 |
| `link-claude [-DryRun]` | 部署 dao 到 Claude Code（skills/commands/agents + @import） |
| `unlink-claude [-DryRun]` | 反向移除 Claude Code 中的 dao 链接 |
| `link-codex [-DryRun]` | mirror Claude skills → Codex |
| `unlink-codex [-DryRun]` | 移除 Codex skill 链接 |
| `link-codex-prompts [-DryRun]` | 高频 dao 命令写入 Codex prompts |
| `unlink-codex-prompts [-DryRun]` | 移除 Codex prompts |

通用选项：`-AlwaysOnOnly`（仅 link always_on 类）、`-DryRun`（预览不写入）。

## 部署结构

```
windsurf-dao/                  # Sidecar / 真相源
├── .devin/rules|skills|workflows  # Windsurf 侧
├── ccswitch/skills|commands|agents  # Claude Code 侧
├── config-sync/               # 配置同步（dao-sync.bat 四合一入口）
├── dao.ps1                    # 链接管理
└── global_rules.md            # 元规则

target-project/                # 你的工作项目（无 dao 文件）
└── .devin/                    # 仅项目自有内容
```

**变更流**：编辑 windsurf-dao → 所有 workspace 即时可见 → `/dao-commit` 提交。

## 自定义

体系可进化。`/dao-evolve` 审查改进。为道日损——删 > 改 > 增。

添加 skill：`.devin/skills/your-skill/skill.md`（frontmatter: name + description）。
添加 workflow：`.devin/workflows/your-workflow.md`（YAML frontmatter + Markdown）。

## 哲学基础

> 为学日益，为道日损。损之又损，以至于无为。无为而无不为。

1. **AI 配对编程是关系** — 人+AI=AGI，冲气以为和
2. **进化是减法** — 规则越少越好，能力越内化越好
3. **规则终态是忘掉规则** — 含德之厚，比于赤子
4. **身教重于言教** — 推广的范式，自身先实践

## 许可

私人使用。
