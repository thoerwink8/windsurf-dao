# 迁移指南 · 将 windsurf-dao 规则部署到目标项目

> 善行无辙迹。

> **⚠ 状态更新（2026-06-29）**：`.devin/` 目录已退役删除，`ccswitch/` 是唯一真相源。Windsurf 侧（Sidecar 模式、双栈共存描述）不再适用。以下内容保留为迁移历史记录，不反映当前架构。当前部署方式见本文件「Claude Code 部署」章节。

## Claude Code CLI 模式（2026.05.31+ · 双栈共存)

windsurf-dao 现在**同时支持 Windsurf 与 Claude Code CLI**,同源不同壳。`ccswitch/` 目录是 Claude Code 侧真相源,与 `.devin/` 并存,均由本仓库 git 管理。

```
windsurf-dao/                          ← 唯一真相源(git)
├── ccswitch/                            ← Claude Code 侧
│   ├── dao.md                         ← always_on 道德经场域(@import 注入)
│   ├── skills/dao-*/SKILL.md          ← 39 skills(渐进披露)
│   ├── commands/dao-*.md              ← 11 slash commands
│   ├── agents/dao-*.md                ← 8 subagents(金字塔调度)
│   └── stacks/                        ← 技术栈处方
├── .devin/                         ← Windsurf 侧(rules/skills/workflows/stacks)
├── global_rules.md                    ← Windsurf 元规则源
└── dao.ps1                            ← 链接管理(双栈)

~/.claude/                             ← Claude Code 用户级(全局生效)
├── CLAUDE.md                          ← 末尾 @import → windsurf-dao/ccswitch/dao.md
├── skills/dao-*    ── symlink ──▶ windsurf-dao/ccswitch/skills/dao-*
├── commands/dao-*  ── symlink ──▶ windsurf-dao/ccswitch/commands/
└── agents/dao-*    ── symlink ──▶ windsurf-dao/ccswitch/agents/
```

**部署(一步)**:
```powershell
.\dao.ps1 link-claude          # symlink skills/commands/agents + 幂等追加 dao.md @import
.\dao.ps1 link-claude -DryRun  # 预览
```
之后重启 Claude Code 会话(或 `/clear`)即生效。所有项目全局可用,无论在哪个目录工作。

**机制对照(Windsurf 4 trigger → Claude Code)**:

| Windsurf trigger | Claude Code 落点 |
|---|---|
| `always_on` | `ccswitch/dao.md` 经 `~/.claude/CLAUDE.md` @import(每条消息常驻) |
| `model_decision` | Skills(渐进披露,只读 name+description,相关才载全文) |
| `manual`(@) | Slash command / 加载对应 skill |
| `glob`(文件类型触发) | 转 skill(description 写明场景)+ 可选 PreToolUse hook 兜底 |

**迁移取舍(为道日损)**:与 Claude Code 内置能力(shell 沙箱 / git 安全 / 破坏性操作确认)重叠的规则已删,只留 dao 独有增量。道德经场域从 486 行精简到 126 行(砍 74%)。续力铁律「每条必问」降级为「路歧则问」,对齐 Claude Code 克制原则。

四种 trigger 的完整映射见下方「Claude Code 部署」章节的「四种 Windsurf trigger 的映射」表（原指向的 `dao-fa-mechanism` skill 已随重构合并，不再独立存在）。

---

## Sidecar 模式（推荐，2026.04.11+）

将 windsurf-dao 作为伴生 workspace 打开。Windsurf 自动跨 workspace 聚合 rules/skills/workflows，无需链接。

```
windsurf-dao (源仓库, sidecar workspace)
├── .devin/rules/        ← 9 个文件（1 always_on + 5 model_decision + 2 glob + 1 manual） · v2 架构
├── .devin/skills/       ← 24 个 dao-* skills（4 类）
├── .devin/stacks/       ← 技术栈处方（/dev 基建审计按需加载）
├── .devin/workflows/    ← 9 个 dao-* workflows
├── global_rules.md         ← 元规则源文件（31 行）
└── dao.ps1                 ← 链接管理工具（link-global）

~/.codeium/windsurf/memories/
└── global_rules.md         ← symlink → windsurf-dao/

项目X/.devin/
└── (仅项目自有文件)           ← git tracked，无 dao-* 链接
```

**优势**：
- 零配置：打开 workspace 即生效
- 零乘数：always_on 规则只注入一次（来自 windsurf-dao），不再按 workspace 数翻倍
- 零污染：项目仓库无 dao 文件，无需 `.git/info/exclude`

**步骤**：
1. `dao.ps1 link-global`（一次性，链接全局规则）
2. 在 IDE 中添加 windsurf-dao 为 workspace
3. 完成

---

## Claude Code 部署

> ⚠️ **本节是当前唯一有效的部署方式**（本文件其余章节均为迁移历史，见文首横幅）。

`ccswitch/` 是唯一真相源（Windsurf 侧 `.devin/` 已于 2026-06-29 退役删除）。Claude Code 已内置 shell 沙箱 / git 安全 / 破坏性操作确认，`ccswitch/dao.md` 只保留与之不重叠的 dao 独有增量。

### 一键部署

```powershell
# 部署 dao 到 Claude Code（全局生效）
.\dao.ps1 link-claude

# 预览不写入
.\dao.ps1 link-claude -DryRun
```

`link-claude` 做两件事，幂等可重复跑：

1. **symlink** `ccswitch/{skills,commands,agents}` 到 `~/.claude/{skills,commands,agents}`（skills 链目录，commands/agents 链文件）。skills 是单层清单制：全部 skills 减 `Get-InternalOnlySkills` 排除清单（不看名字前缀，issue #340）；commands/agents 仍按各自 Filter。
2. **幂等追加** `ccswitch/dao.md` 的 `@import` 到 `~/.claude/CLAUDE.md`——已存在则跳过，不重复写。

跑完**重启 Claude Code 会话**（或 `/clear`）才能让新的 skills/commands/agents 被识别。

前提与 Windsurf 侧一致：Windows Developer Mode（symlink 权限）。

### @import 机制

Claude Code 没有 Windsurf 的 always_on trigger，但支持在 `~/.claude/CLAUDE.md` 中用 `@<path>` 语法导入外部文件。`link-claude` 写入的那行：

```
@D:/frank/windsurf-dao/ccswitch/dao.md
```

让 `dao.md`（道德经场域根基）成为**每条消息常驻**的全局上下文——等价于 Windsurf 侧 always_on 规则的角色。因为是 symlink 之外的 `@import` 引用，编辑 `ccswitch/dao.md` 即时生效，无需重新部署。

### 四种 Windsurf trigger 的映射

Windsurf 用 frontmatter 的 4 种 trigger 控制规则加载时机。Claude Code 机制不同，dao 把它们映射为：

| Windsurf trigger | 语义 | Claude Code 对应 | 落地 |
|---|---|---|---|
| `always_on` | 每条消息常驻 | `CLAUDE.md` 的 `@import` | `ccswitch/dao.md` 全局注入 |
| `model_decision` | 模型判断相关才加载 | **skills 渐进披露** | `ccswitch/skills/*/`（全部 skills 减内部件，单层清单制），按 `description` 自动调度全文 |
| `manual` | 用户显式调用 | **slash command** | `ccswitch/commands/dao-*.md`，`/dao-dev` 等 |
| `glob` | 匹配文件路径时触发 | skill + 可选 hook | 做成 skill 按需加载；需路径硬触发时配 hook |

核心差异：Windsurf 的 model_decision/glob 由 IDE 按规则元数据决定注入；Claude Code 的 skill 走**渐进披露**——平时只读 `description`，模型判断相关才加载 skill 全文，更省上下文。

### 当前目录结构

```
windsurf-dao/
├── ccswitch/                 ← 唯一真相源
│   ├── dao.md              ← always_on 根基（经 @import 全局注入）
│   ├── skills/*/           ← 全部 skills 减内部件部署（绝大多数 disable-model-invocation 用户 /name 触发，grill-me 例外）
│   ├── commands/dao-*.md   ← slash commands（随目录变）
│   ├── agents/dao-*.md     ← subagents（随目录变，服务 dao-pyramid 金字塔调度）
│   └── stacks/             ← 技术栈处方
└── dao.ps1                 ← link-claude（Codex skills 由 cc-switch store 写，dao 不参与）
```

（`global_rules.md`、`.devin/`、`link-global` 均已退役，仅作历史参考。）

### 迁移的四个决策（历史记录）

1. **symlink 真相源**：`ccswitch/` 是唯一真相，`~/.claude/` 下全是 symlink，编辑源文件即时生效，零副本。
2. **借机精简**：删掉与 Claude Code 内置能力（shell 沙箱 / git 安全 / 破坏性操作确认）重叠的规则，为道日损。
3. ~~双栈共存：不删 `.devin/`，两套外壳并存~~（2026-06-29 已单栈化，`.devin/` 删除）。
4. **续力铁律降级**：从 Windsurf 的"每条回复必问下一步"降为"路歧则问"——对齐 Claude Code 回合制的克制原则，路明则静默推进，只在方向不明 / 多方案待拍板 / 不可逆决策时才问。


---

## Legacy: 链接模式（已废弃）

> Sidecar 模式是推荐方案。链接模式仅在无法打开多 workspace 时备用。

<details>
<summary>展开查看旧链接模式文档</summary>

### 核心思路

同步问题根因是文件有副本。消除副本（symlink），问题消失。

```powershell
.\dao.ps1 link-rules <project>      # 链接 dao 到目标项目
.\dao.ps1 link-rules-all            # 批量链接
```

### 命名空间

- `dao-` 前缀 = 来自 windsurf-dao（通过 `.git/info/exclude` 本地忽略）
- 项目文件不加 `dao-` 前缀
- 用 `.git/info/exclude`（本地）而非 `.gitignore`（共享）

### 复制模式（备用）

当 symlink 不可用时（无 Developer Mode），手动复制 `dao-*` 文件。代价：变更不自动传播。

</details>
