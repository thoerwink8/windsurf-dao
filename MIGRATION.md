# 迁移指南 · 将 windsurf-dao 规则部署到目标项目

> 善行无辙迹。

## Claude Code CLI 模式（2026.05.31+ · 双栈共存)

windsurf-dao 现在**同时支持 Windsurf 与 Claude Code CLI**,同源不同壳。`claude/` 目录是 Claude Code 侧真相源,与 `.windsurf/` 并存,均由本仓库 git 管理。

```
windsurf-dao/                          ← 唯一真相源(git)
├── claude/                            ← Claude Code 侧
│   ├── dao.md                         ← always_on 道德经场域(@import 注入)
│   ├── skills/dao-*/SKILL.md          ← 39 skills(渐进披露)
│   ├── commands/dao-*.md              ← 11 slash commands
│   ├── agents/dao-*.md                ← 8 subagents(金字塔调度)
│   └── stacks/                        ← 技术栈处方
├── .windsurf/                         ← Windsurf 侧(rules/skills/workflows/stacks)
├── global_rules.md                    ← Windsurf 元规则源
└── dao.ps1                            ← 链接管理(双栈)

~/.claude/                             ← Claude Code 用户级(全局生效)
├── CLAUDE.md                          ← 末尾 @import → windsurf-dao/claude/dao.md
├── skills/dao-*    ── symlink ──▶ windsurf-dao/claude/skills/dao-*
├── commands/dao-*  ── symlink ──▶ windsurf-dao/claude/commands/
└── agents/dao-*    ── symlink ──▶ windsurf-dao/claude/agents/
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
| `always_on` | `claude/dao.md` 经 `~/.claude/CLAUDE.md` @import(每条消息常驻) |
| `model_decision` | Skills(渐进披露,只读 name+description,相关才载全文) |
| `manual`(@) | Slash command / 加载对应 skill |
| `glob`(文件类型触发) | 转 skill(description 写明场景)+ 可选 PreToolUse hook 兜底 |

**迁移取舍(为道日损)**:与 Claude Code 内置能力(shell 沙箱 / git 安全 / 破坏性操作确认)重叠的规则已删,只留 dao 独有增量。道德经场域从 486 行精简到 126 行(砍 74%)。续力铁律「每条必问」降级为「路歧则问」,对齐 Claude Code 克制原则。

详见 `claude/skills/dao-fa-mechanism/SKILL.md`(Claude Code 机制全解)。

---

## Sidecar 模式（推荐，2026.04.11+）

将 windsurf-dao 作为伴生 workspace 打开。Windsurf 自动跨 workspace 聚合 rules/skills/workflows，无需链接。

```
windsurf-dao (源仓库, sidecar workspace)
├── .windsurf/rules/        ← 9 个文件（1 always_on + 5 model_decision + 2 glob + 1 manual） · v2 架构
├── .windsurf/skills/       ← 24 个 dao-* skills（4 类）
├── .windsurf/stacks/       ← 技术栈处方（/dev 基建审计按需加载）
├── .windsurf/workflows/    ← 9 个 dao-* workflows
├── global_rules.md         ← 元规则源文件（31 行）
└── dao.ps1                 ← 链接管理工具（link-global）

~/.codeium/windsurf/memories/
└── global_rules.md         ← symlink → windsurf-dao/

项目X/.windsurf/
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

## Claude Code 部署（双栈共存）

> 同源不同壳。`claude/` 与 `.windsurf/` 是同一套 dao 的两副外壳，各自适配宿主的加载机制。

windsurf-dao 自 2026.05 起从 Windsurf 单栈扩展为 **Windsurf + Claude Code 双栈**。新增 `claude/` 目录作为 Claude Code 侧真相源，与 `.windsurf/` 并列共存，规则内核同源，只是按各自宿主的能力裁剪外壳（Claude Code 已内置 shell 沙箱 / git 安全 / 破坏性操作确认，`claude/dao.md` 只保留与之不重叠的 dao 独有增量）。

### 一键部署

```powershell
# 部署 dao 到 Claude Code（全局生效）
.\dao.ps1 link-claude

# 预览不写入
.\dao.ps1 link-claude -DryRun
```

`link-claude` 做两件事，幂等可重复跑：

1. **symlink** `claude/{skills,commands,agents}` 下的 `dao-*` 项到 `~/.claude/{skills,commands,agents}`（skills 链目录，commands/agents 链文件）。
2. **幂等追加** `claude/dao.md` 的 `@import` 到 `~/.claude/CLAUDE.md`——已存在则跳过，不重复写。

跑完**重启 Claude Code 会话**（或 `/clear`）才能让新的 skills/commands/agents 被识别。

前提与 Windsurf 侧一致：Windows Developer Mode（symlink 权限）。

### @import 机制

Claude Code 没有 Windsurf 的 always_on trigger，但支持在 `~/.claude/CLAUDE.md` 中用 `@<path>` 语法导入外部文件。`link-claude` 写入的那行：

```
@D:/frank/windsurf-dao/claude/dao.md
```

让 `dao.md`（道德经场域根基）成为**每条消息常驻**的全局上下文——等价于 Windsurf 侧 always_on 规则的角色。因为是 symlink 之外的 `@import` 引用，编辑 `claude/dao.md` 即时生效，无需重新部署。

### 四种 Windsurf trigger 的映射

Windsurf 用 frontmatter 的 4 种 trigger 控制规则加载时机。Claude Code 机制不同，dao 把它们映射为：

| Windsurf trigger | 语义 | Claude Code 对应 | 落地 |
|---|---|---|---|
| `always_on` | 每条消息常驻 | `CLAUDE.md` 的 `@import` | `claude/dao.md` 全局注入 |
| `model_decision` | 模型判断相关才加载 | **skills 渐进披露** | `claude/skills/dao-*/`，按 `description` 自动调度全文 |
| `manual` | 用户显式调用 | **slash command** | `claude/commands/dao-*.md`，`/dao-dev` 等 |
| `glob` | 匹配文件路径时触发 | skill + 可选 hook | 做成 skill 按需加载；需路径硬触发时配 hook |

核心差异：Windsurf 的 model_decision/glob 由 IDE 按规则元数据决定注入；Claude Code 的 skill 走**渐进披露**——平时只读 `description`，模型判断相关才加载 skill 全文，更省上下文。

### 双栈共存关系

```
windsurf-dao/
├── .windsurf/              ← Windsurf 侧外壳
│   ├── rules/              ← 11 文件 4 trigger（always_on/model_decision/glob/manual）
│   ├── skills/dao-*/       ← 28 skills
│   ├── workflows/dao-*.md  ← 10 workflows
│   └── stacks/             ← 技术栈处方
├── claude/                 ← Claude Code 侧外壳（同源不同壳）
│   ├── dao.md              ← always_on 根基（经 @import 全局注入）
│   ├── skills/dao-*/       ← 37 skills（28 原 dao + 部分 rule 转 skill + 自检 skill）
│   ├── commands/dao-*.md   ← 11 slash commands（由 10 workflow 平移）
│   ├── agents/dao-*.md     ← 8 subagents（服务 dao-pyramid 金字塔调度）
│   └── stacks/             ← 技术栈处方
├── global_rules.md         ← Windsurf 元规则（link-global 部署）
└── dao.ps1                 ← link-global / link-rules-all / link-claude
```

两栈各自部署、互不干扰：用 Windsurf 跑 `link-global` + sidecar workspace；用 Claude Code 跑 `link-claude`。同一套 dao 哲学内核，两边都保留。

### 迁移的四个决策

1. **symlink 真相源**：`claude/` 是唯一真相，`~/.claude/` 下全是 symlink，编辑源文件即时生效，零副本。
2. **借机精简**：删掉与 Claude Code 内置能力（shell 沙箱 / git 安全 / 破坏性操作确认）重叠的规则，为道日损。
3. **双栈共存**：不删 `.windsurf/`，两套外壳并存，按宿主选用。
4. **续力铁律降级**：从 Windsurf 的"每条回复必问下一步"降为"路歧则问"——对齐 Claude Code 回合制的克制原则，路明则静默推进，只在方向不明 / 多方案待拍板 / 不可逆决策时才问。

---

## Legacy: 链接模式

> 以下为旧架构文档，保留供需要独立自足时参考。Sidecar 模式是推荐方案。

### 设计原理

同步问题的根因是**文件有副本**。消除副本，问题就消失。

```
windsurf-dao (源仓库)            ← git repo，唯一真相
├── .windsurf/dao-*              ← 真实文件
├── global_rules.md              ← 全局规则真实文件
└── dao.ps1                      ← 链接管理工具

~/.codeium/windsurf/memories/
└── global_rules.md              ← symlink → windsurf-dao/

项目X/.windsurf/
├── rules/dao-*.md               ← symlink → windsurf-dao/
├── skills/dao-*/                ← junction → windsurf-dao/
├── workflows/dao-*.md           ← symlink → windsurf-dao/
└── (项目自有文件)                ← git tracked
```

**变更流**：在任意项目中编辑 dao-* 文件 → 物理修改的是 windsurf-dao → 所有项目即时可见 → 在 windsurf-dao 中 git commit。

### 核心架构

```
.windsurf/                      # 统一 AI 配置目录
├── rules/
│   ├── dao-*.md               # dao 元层（symlink，本地忽略）
│   └── *.md                   # 项目操作层（git 追踪）
├── skills/
│   ├── dao-*/                 # dao skills（junction，本地忽略）
│   └── */                     # 项目 skills（git 追踪）
└── workflows/
    ├── dao-*.md               # dao workflows（symlink，本地忽略）
    └── *.md                   # 项目 workflows（git 追踪）
```

**区分机制**：`dao-` 前缀 = 来自 windsurf-dao，通过 `.git/info/exclude` 本地忽略，不污染项目 git。

### 前提

- **Windows Developer Mode**：Settings → System → For developers → Developer Mode
- 文件符号链接需要 Developer Mode；目录联接（Junction）不需要

### 步骤

```powershell
# 1. 链接 dao 文件到目标项目（自动创建目录、配置 .git/info/exclude）
.\dao.ps1 link D:\your\project

# 2. 链接全局规则到 Windsurf 配置（一次性）
.\dao.ps1 link-global

# 3. 查看状态
.\dao.ps1 status D:\your\project
```

**完成。** 无需手动复制、无需同步、无需维护。

### dao.ps1 命令

| 命令 | 作用 |
|------|------|
| `link <path>` | 创建 symlink/junction 从目标项目指向 windsurf-dao |
| `unlink <path>` | 移除链接（不影响源文件） |
| `status [path]` | 显示链接/复制状态；无 path 时显示所有注册项目的健康状态矩阵 |
| `link-global` | 链接 `global_rules.md` 到 `~/.codeium/windsurf/memories/` |

### 工作流

```
新项目接入：
  dao.ps1 link <project>  →  完成

在任意项目中改进 dao 规则：
  直接编辑  →  所有项目即时生效  →  去 windsurf-dao 仓库 git commit

从项目 A 回补到源仓库：
  无需操作（symlink，物理上就是同一文件）

从源仓库同步到所有项目：
  无需操作（symlink，已经是最新）
```

## 从复制升级到链接

已有复制副本的项目，直接运行 `dao.ps1 link` 即可升级：

```powershell
.\dao.ps1 link D:\your\existing-project
```

**自动处理流程**：

1. 检测每个 dao-* 文件是副本还是链接
2. 副本与源 SHA256 比对
3. **相同** → 删除副本，创建链接
4. **不同** → 备份到 `_dao_backup/` → 删除副本 → 创建链接
5. 输出报告，提示 review 备份

```
  [link]   rules/dao-layer.md
  [backup] rules/dao-de-layer.md (modified copy saved)
  [link]   rules/dao-de-layer.md
  [link]   skills/dao-boundary-probe/
  ...
  Done: 20 linked, 0 unchanged
  Backup: 1 modified copies saved to _dao_backup/
  Review backups, merge improvements back to windsurf-dao, then delete _dao_backup/
```

**备份处理**：`_dao_backup/` 保留了与源不同的副本。Review 后：
- 有价值的改进 → 合并回 windsurf-dao 源文件（链接模式下直接编辑即可）
- 无价值的差异 → 忽略
- 处理完毕 → 删除 `_dao_backup/`

## 复制模式（备用）

当 symlink 不可用时（无 Developer Mode、跨磁盘、网络共享），退化为手动复制：

```powershell
# 复制
Copy-Item "windsurf-dao\.windsurf\rules\dao-*.md" -Destination "target\.windsurf\rules\"
Copy-Item "windsurf-dao\.windsurf\skills\dao-*" -Destination "target\.windsurf\skills\" -Recurse
Copy-Item "windsurf-dao\.windsurf\workflows\dao-*.md" -Destination "target\.windsurf\workflows\"

# 配置本地忽略
@"

# windsurf-dao files (local only)
.windsurf/rules/dao-*
.windsurf/skills/dao-*
.windsurf/workflows/dao-*
"@ | Add-Content "target\.git\info\exclude"
```

**复制模式的代价**：变更不会自动传播，需手动重新复制。

**已知陷阱**：PowerShell `Copy-Item -Recurse` 对只含一个文件的目录可能扁平化。复制后验证 `skills/dao-*/skill.md` 目录结构。

## 命名空间

**所有 dao 来源的文件统一使用 `dao-` 前缀**：

| 类型 | dao 元层 | 项目操作层 |
|------|---------|------------|
| Rules | `execution.md` / `shell.md` 等 | `ask-next-step.md` 等 |
| Skills | `dao-debug/` / `dao-review/` 等 | `frontend-design/` 等 |
| Workflows | `dao-cycle.md` / `dao-dev.md` 等 | `commit.md`、`review.md` 等 |

**三原则**：dao skills 和 workflows 使用 `dao-` 前缀（rules 除外，v2 后按职责命名）/ 项目文件不加 `dao-` 前缀 / `SKILL.md` 的 `name` 字段与目录名一致。

## 本地忽略

**用 `.git/info/exclude`，不用 `.gitignore`**：

- `.gitignore` 是项目共享的，影响所有开发者
- `.git/info/exclude` 是本地的，只影响当前开发者
- dao 配置是个人的 AI 工作方式，不应强加给团队

`dao.ps1 link` 会自动配置此项。

## 项目规则归位

目标项目的项目特定规则应独立管理：

- `AGENT.md`（tracked）= 项目完整规范文档
- `.windsurf/rules/ask-next-step.md`（tracked）= AI 交互行为规则
- `.windsurf/rules/dao-*.md`（locally ignored）= dao 元层规则

## 迁移后的目录结构

```
target-project/
├── AGENT.md                         # (tracked) 项目完整规范
├── .git/info/exclude                # dao-* 本地忽略规则
└── .windsurf/
    ├── rules/
    │   ├── (dao rules via sidecar)  # Sidecar 模式无需链接
    │   └── ask-next-step.md         # ← 项目 (tracked)
    ├── skills/
    │   ├── dao-boundary-probe/      # → junction (locally ignored)
    │   ├── dao-frontend-aesthetics/ # → junction (locally ignored)
    │   ├── dao-reverse-engineering/ # → junction (locally ignored)
    │   ├── dao-terminal-resilience/ # → junction (locally ignored)
    │   ├── dao-windsurf-extension/  # → junction (locally ignored)
    │   └── project-skill/           # ← 项目 (tracked)
    └── workflows/
        ├── dao-cycle.md             # → symlink (locally ignored)
        ├── dao-dev.md               # → symlink (locally ignored)
        ├── ...                      # → symlink (locally ignored)
        └── project-workflow.md      # ← 项目 (tracked)
```

## 经验总结

1. **链接 > 复制**：symlink 消除同步问题，复制只是备用方案
2. **`dao-` 前缀**：唯一的命名空间策略，一眼分清来源
3. **本地忽略**：`.git/info/exclude` 不影响团队
4. **项目版优先**：同名冲突时保留项目版（元层规则的具体落地）
5. **版本控制在源仓库**：所有 dao 变更在 windsurf-dao 仓库 commit，通过链接传播
