# 换机部署指南 · 从零搭建 windsurf-dao 完整环境

> 各复归其根。一台新机器，把 dao 的全部环境（Claude Code / Codex / Windsurf 三栈 + cc-switch 配置 + 插件）恢复到与旧机一致。

本文档与 [MIGRATION.md](MIGRATION.md) 分工：
- **MIGRATION.md** = 把 dao 规则部署进「某个目标项目」。
- **本文档（NEW-MACHINE.md）** = 整台新机器「从零」搭好全部环境的总流程。

不确定先看哪个 → 新机器看本文，接项目看 MIGRATION.md。

---

## 0. 总览：换机要恢复哪几样

| # | 组件 | 真相源 | 是否进 git |
|---|---|---|---|
| 1 | dao 规则体系（skills/commands/agents/dao.md） | 本仓库 `claude/` `.devin/` | ✅ 是 |
| 2 | cc-switch 通用配置（env/hooks/model/permissions） | 本仓库 `config-sync/common/` | ✅ 是 |
| 3 | cc-switch 供应商（含 token/API key） | `config-sync/providers/` | ❌ **手动复制** |
| 4 | Codex 本地插件市场（如 product-design） | 本仓库 `config-sync/local-marketplaces/` | ✅ 是 |
| 5 | MCP servers / skills / prompts / proxy | cc-switch DB（经 config-sync 快照） | ✅ 是（脱敏） |

**核心原则**：能进 git 的都进 git，换机靠 `git clone` + 一条恢复命令带回；只有 `providers/`（含真实密钥）必须手动拷贝，缺它恢复会报错提示。

---

## ★ AI 自助安装 / 自检（一段读完即可执行）

> 给未来接手的 AI：在一台新机器上完整复刻本套配置，按下面顺序执行即可，每步可自检。
> 详细解释见后续各节；只想快速跑通，照这一段。

**前置**：已装 `git` / `node` / `cc-switch`（启动过一次，DB 已建）；已把旧机的 `config-sync/providers/`（含密钥，不进 git）手动拷到本仓库同位置。

```powershell
# 1. 取仓库（路径不强制，dao 用占位符/动态根适配；建议 D:\frank\windsurf-dao）
git clone <windsurf-dao 仓库地址> D:\frank\windsurf-dao
cd D:\frank\windsurf-dao

# 2. 恢复 cc-switch 全部配置（settings/hooks/MCP/skills/providers）→ cc-switch DB
#    （双击 config-sync\恢复配置.bat 等价；AI 直接调 lib 跳过 pause）
node config-sync\lib\restore.mjs

# 3. 软链 dao 规则到 ~/.claude（skills / commands[含 /dao-remove] / agents + dao.md @import）
.\dao.ps1 link-claude

# 4. 让 cc-switch 下发到各端：重启 cc-switch 并切换一次 provider（GUI 一步，下发 env/hooks/model 等）

# 5. 自检（问题 0 项为准）
node config-sync\lib\doctor.mjs
```

**自检判读**：`问题 0 项` = 复刻成功。其中「settings.json.env.CLAUDE_CODE_* 缺失」三项，需第 4 步 cc-switch 下发后才会变绿（restore 只写进 DB，下发由 cc-switch 负责）。`提醒` 项（Pencil 本机安装路径、Codex node_repl 等）属正常机器差异，非问题。

**自助排查**：任何"某能力没生效"，先跑 `node config-sync\lib\doctor.mjs` 看哪条 ✗；命令/skill 没出现 → 重跑 `.\dao.ps1 link-claude`；hook/env 没生效 → 确认第 4 步切过号；连本机相关见 `.devin/skills/dao-cloud/SKILL.md` 故障排查。

---

## 1. 前置依赖（先装好这些）

| 依赖 | 用途 | 检查命令 |
|---|---|---|
| **Git** | 克隆仓库 | `git --version` |
| **Node.js** | config-sync 脚本、dao hooks | `node --version` |
| **sqlite3** | 读写 cc-switch DB | `sqlite3 -version`，或运行 `config-sync/setup-sqlite.ps1`（项目已内置安装包） |
| **cc-switch** 桌面端 | 配置中心与下发引擎 | 已安装并能启动 |
| **Windows Developer Mode** | symlink 权限（dao.ps1 链接） | 设置 → 系统 → 开发者选项 → 开 |

可选（按需用哪栈装哪个）：
- **Claude Code**（CLI / 桌面端）——用 dao + Claude
- **Codex / Codex++**——用 dao + Codex
- **Windsurf**——用 dao + Windsurf

> sqlite3 找不到时，运行 `config-sync/setup-sqlite.ps1` 即可从项目内置安装包自动解压并设置 `SQLITE3_PATH`；也可手动安装后设环境变量 `SQLITE3_PATH` 指定。

<!-- APPEND-MARKER-1 -->

## 2. 部署步骤

### 步骤 1 · 克隆仓库

```powershell
git clone <你的 windsurf-dao 仓库地址> D:\frank\windsurf-dao
cd D:\frank\windsurf-dao
```

> **路径不强制**：克隆到哪个目录都行。dao 的 `@import` 和 hooks 路径都用占位符/动态根，恢复时自动适配新位置（见 §4 路径机制）。但若想和旧机完全一致、少踩坑，建议仍用 `D:\frank\windsurf-dao`。

### 步骤 2 · 手动补回 providers/（含密钥，不在 git）

从旧机器把整个 `config-sync/providers/` 目录复制到新机器同一位置：

```
config-sync/providers/
├── providers.json          ← 各供应商配置（含 token）
└── common-secrets.json     ← 通用配置里被脱敏字段的真实值
```

> 没有这一步，下一步恢复会报错并提示缺 `common-secrets.json`。用 U 盘 / 私密渠道传，**不要进 git**（已被 `.gitignore` 忽略）。

### 步骤 3 · 恢复 cc-switch 配置 + 本地插件市场

```
双击 config-sync/恢复配置.bat
```

它会：
1. 备份当前 cc-switch DB 到 `~/.cc-switch/backups/`
2. 把 `common/` + `providers/` 快照写回 `~/.cc-switch/cc-switch.db`（hooks/env 等路径占位符自动还原成本机仓库路径）
3. 把 `local-marketplaces/`（如 product-design 插件市场）铺回 `~/.codex/local-marketplaces/`

完成后**重启 cc-switch**，并切换一次 provider，让它重新下发配置到各端。

### 步骤 4 · 部署 dao 规则到各栈（按需）

```powershell
# Claude Code（全局生效）
.\dao.ps1 link-claude

# Codex（把 skills 链入 ~/.codex/skills）
.\dao.ps1 link-codex
.\dao.ps1 link-codex-prompts

# Windsurf（元规则 + 全项目 rules）
.\dao.ps1 link-global
.\dao.ps1 link-rules-all

# 任意命令加 -DryRun 先预览不写入
```

跑完**重启对应客户端会话**（Claude Code `/clear`）才识别新的 skills/commands/agents。

### 步骤 5 · 验证

```powershell
.\dao.ps1 status                       # dao 链接健康矩阵
node config-sync\lib\doctor.mjs        # 配置一致性体检（0 问题为准）
node config-sync\lib\goal-task-health.mjs   # （Codex 用户）goal 任务状态体检
```

doctor 报「问题 0 项」即环境恢复成功。提醒项（如 Pencil 本机路径、Codex node_repl）属正常差异。

<!-- APPEND-MARKER-2 -->

## 3. 换机会变的东西（踩坑预警）

| 项 | 旧机 | 新机会变吗 | 处理 |
|---|---|---|---|
| 仓库根路径 | `D:/frank/windsurf-dao` | 可能不同 | 占位符/动态根自动适配，无需手改 |
| 用户名 | `Administrator` | 可能不同 | `${HOME}` 占位，恢复时还原 |
| Pencil MCP 路径 | `D:/Program Files/Pencil/...` | 必不同 | 本机特定，换机后按新安装位置在 cc-switch 重配 |
| 供应商 token | providers/ 内 | — | 手动复制 providers/（§2 步骤 2） |
| Codex 插件登录态 | cc-switch DB | — | 切号后按需在 Codex 重新登录/MFA |

## 4. 路径占位机制（为什么换机不怕路径变）

config-sync 在导出时把两类本机路径替换成占位符，恢复时还原成新机实际路径：

- `${PROJECT_ROOT}` → windsurf-dao 仓库根（如 hooks 命令 `node "${PROJECT_ROOT}/claude/hooks/dao-glob-gate.js"`）
- `${HOME}` → 用户主目录（如 Codex 本地市场源 `${HOME}/.codex/local-marketplaces/...`）

所以 `common/settings.json`、`mcp_servers.json` 进 git 的都是占位符形态，`恢复配置.bat` 在新机自动解回真实路径。**这是换机不强制同路径的根本保障。**

---

## 5. 文档维护机制（改动即同步 · 强制）

> 慎终如始。配置/流程改了，文档不同步 = 下次换机踩坑。

**铁律**：凡是改动了下列任一处，**必须在同一次提交里同步更新本文档（NEW-MACHINE.md）**，否则视为未完成：

| 改动了什么 | 要同步更新本文的哪节 |
|---|---|
| 新增/删除前置依赖（工具、运行时） | §1 前置依赖 |
| 改了部署命令、dao.ps1 加/删 action | §2 步骤 4 |
| 新增进 git 的配置类别 / 新真相源 | §0 总览 + §2 对应步骤 |
| 改了 config-sync 导出/恢复行为、占位符规则 | §3 §4 |
| 新增「必须手动复制」的本机资产 | §0 总览 + §2 步骤 2 |

**给 AI 的执行约定**（写给未来接手的 AI）：
- 每次被要求「更新 X 配置 / 加 Y 工具 / 改部署方式」，完成后**自检**：这条改动会影响新机器搭建吗？会 → 同步改本文对应节，一起 commit。
- commit message 里注明文档已同步，并使用当前宿主前缀（如 `[codex] feat(config-sync): 加 X + 同步 NEW-MACHINE.md`）。
- 不确定要不要更新 → 默认更新。漏更比多更代价大。

> 这条机制本身也写进了仓库 `AGENT_GUIDE.md`（AI 加载时自读），形成闭环。

