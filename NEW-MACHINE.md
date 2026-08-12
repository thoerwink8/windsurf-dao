# 换机部署指南 · 从零搭建 windsurf-dao 完整环境

> 各复归其根。一台新机器，把 dao 的全部环境（Claude Code 主栈 + Codex 镜像 + cc-switch 配置 + 插件）恢复到与旧机一致。
>
> ⚠️ Windsurf 栈已于 2026-06-29 退役——本文涉及 Windsurf 的步骤仅为历史保留，新机不需要执行。

本文档与 [MIGRATION.md](MIGRATION.md) 分工：
- **MIGRATION.md** = 把 dao 规则部署进「某个目标项目」。
- **本文档（NEW-MACHINE.md）** = 整台新机器「从零」搭好全部环境的总流程。

不确定先看哪个 → 新机器看本文，接项目看 MIGRATION.md。

---

## 0. 总览：换机要恢复哪几样

| # | 组件 | 真相源 | 是否进 git |
|---|---|---|---|
| 1 | dao 规则体系（skills/commands/dao.md） | 本仓库 `ccswitch/` | ✅ 是 |
| 2 | cc-switch 通用配置（env/hooks/model/permissions） | 本仓库 `config-sync/common/` | ✅ 是 |
| 3 | settings 脱敏真实值 | `config-sync/common-secrets.json` | ❌ **手动复制** |
| 4 | MCP servers / skills / prompts / proxy | cc-switch DB（经 config-sync 快照） | ✅ 是（脱敏） |
| 5 | pi 编码代理（处方 + 4 模型配置模板） | 本仓库 `ccswitch/stacks/pi.md` | ✅ 处方进 git；**真实 API key 不进 git**，新机从 new-api 面板生成后只填本地 `~/.pi/agent/models.json` 一格 |

**核心原则**：能进 git 的都进 git，换机靠 `git clone` + 一条恢复命令带回；只有 `common-secrets.json`（含 settings 脱敏真实值）需手动拷贝；供应商配置在新机器直接配置。

---

## ★ AI 自助安装 / 自检（一段读完即可执行）

> 给未来接手的 AI：在一台新机器上完整复刻本套配置，按下面顺序执行即可，每步可自检。
> 详细解释见后续各节；只想快速跑通，照这一段。

**前置**：已装 `git` / `node` / `cc-switch`（启动过一次，DB 已建）；已把旧机的 `config-sync/common-secrets.json`（含 settings 真实值，不进 git）手动拷到本仓库同位置。

```powershell
# 1. 取仓库（路径不强制，dao 用占位符/动态根适配；建议 D:\frank\windsurf-dao）
git clone <windsurf-dao 仓库地址> D:\frank\windsurf-dao
cd D:\frank\windsurf-dao

# 2. 一键恢复：双击 dao.bat → 选 1（下行）
#    自动完成：git pull + 恢复 cc-switch DB + 部署 skills/hooks 到 ~/.claude
#    （悬空 Junction 也会自动清理，无需手动处理）
#    AI 直接调：node config-sync\lib\sync.mjs --direction=down --yes
dao.bat

# 3. 让 cc-switch 下发到各端：重启 cc-switch 并切换一次 provider（GUI 一步，下发 env/hooks/model 等）

# 4. 自检（问题 0 项为准）
node config-sync\lib\doctor.mjs
```

**自检判读**：`问题 0 项` = 复刻成功。其中「settings.json.env.CLAUDE_CODE_* 缺失」三项，需第 3 步 cc-switch 下发后才会变绿（restore 只写进 DB，下发由 cc-switch 负责）。`提醒` 项（Codex node_repl 等）属正常机器差异，非问题。**「MCP 健康态」一节例外**（issue #92 新增，2026-08-08）：它报的是 `claude mcp list` 实测能不能连上，与「本机是否复刻成功」无关——新机器缺某个 MCP 依赖（如 `uvx`/`npx` 拉不到包、外部服务本身挂了）会在这里显式报 ✗，这是它的职责（不让"注册了但连不上"再次悄悄溜走），不代表换机步骤有问题；照这条 ✗ 的原因去修对应 server 或换机器网络，不要去重跑 `dao.bat`。

**自助排查**：任何"某能力没生效"，先跑 `node config-sync\lib\doctor.mjs` 看哪条 ✗；命令/skill 没出现 → 重跑 `dao.bat` 选 3（部署）或 `dao.bat --deploy`；hook/env 没生效 → 确认第 3 步切过号。

---

## 1. 前置依赖（先装好这些）

| 依赖 | 用途 | 检查命令 |
|---|---|---|
| **Git** | 克隆仓库 | `git --version` |
| **Node.js** | config-sync 脚本、dao hooks | `node --version` |
| **sqlite3** | 读写 cc-switch DB | `sqlite3 -version`；找不到时手动安装或设 `SQLITE3_PATH` 指向它（见下方说明） |
| **cc-switch** 桌面端 | 配置中心与下发引擎 | 已安装并能启动 |
| **Windows Developer Mode** | symlink 权限（dao.ps1 链接） | 设置 → 系统 → 开发者选项 → 开 |
| **NTFS 8.3 短名 + junction 建得起来** | **只影响跑回归网，不影响部署**：`tests/hard-gates.tests.js` 的 G2 那几组要造「8.3 短名家目录」与「`.claude` 是 junction」两种 fixture（issue #133/#134） | `node tests/hard-gates.tests.js` —— 造不出来时它的**前置断言会自己红**并写明「只是**没测到**，不是通过」；别把那几条红读成代码坏了。`mklink /J` 在 NTFS 上一般不需要管理员（本机实测不需要），8.3 短名的查询命令 `fsutil 8dot3name query C:` **要管理员**（非管理员 exit 1），所以别拿它当检查手段，以那几条前置断言为准 |

可选（按需用哪栈装哪个）：
- **Claude Code**（CLI / 桌面端）——用 dao + Claude（主栈）
- **Codex / Codex++**——用 dao + Codex（镜像）
- **pi 编码代理**——`npm install -g @mariozechner/pi-coding-agent`，配置处方见 `ccswitch/stacks/pi.md`（安装/4 模型模板/压缩参数/实测坑/验证命令全在里面）
- ~~**Windsurf**~~（已退役，无需安装）

> sqlite3 找不到时手动安装，然后设环境变量 `SQLITE3_PATH` 指向 sqlite3 可执行文件（或放进 PATH）；
> `config-sync/lib/sqlite.mjs` 也认 `vendor/sqlite/sqlite3.exe`（首次使用时不再自动下载，2026-08-12 下载器已退役）。

<!-- APPEND-MARKER-1 -->

## 2. 部署步骤

### 步骤 1 · 克隆仓库

```powershell
git clone <你的 windsurf-dao 仓库地址> D:\frank\windsurf-dao
cd D:\frank\windsurf-dao
```

> **路径不强制**：克隆到哪个目录都行。dao 的 `@import` 和 hooks 路径都用占位符/动态根，恢复时自动适配新位置（见 §4 路径机制）。但若想和旧机完全一致、少踩坑，建议仍用 `D:\frank\windsurf-dao`。

### 步骤 2 · 手动补回 common-secrets.json（含脱敏真实值，不在 git）

从旧机器把 `config-sync/common-secrets.json` 复制到新机器同一位置。

> 没有这一步，恢复 settings 时会因占位符无法还原而报错。用 U 盘 / 私密渠道传，**不要进 git**（已被 `.gitignore` 忽略）。

供应商配置（token/API key）不再随仓库同步，在新机器上通过 cc-switch 直接配置即可。

### 步骤 3 · 恢复 cc-switch 配置

```powershell
# 推荐：双击 dao.bat → 选 1（下行）
# 自动完成：git pull + 恢复 DB + 部署 skills/hooks + 清理悬空 Junction
dao.bat

# 或 AI 直接调：
node config-sync\lib\sync.mjs --direction=down --yes
```

它会：
1. `git pull --ff-only` 对齐 origin
2. 备份当前 cc-switch DB → 把 `common/` 快照写回 DB（占位符自动还原）
3. 自动调 `dao.ps1 link-claude`（部署 skills/commands/agents/hooks 到 `~/.claude/`，含悬空 Junction 自愈清理）

完成后**重启 cc-switch**，并切换一次 provider，让它重新下发配置到各端。

### 步骤 4 · 部署其他栈（按需，Claude Code 已由步骤 3 自动完成）

```powershell
# Codex skills：无需任何 dao 命令。
# 该目录的写入方是 cc-switch store（2026-07-27 拍板）——步骤 3 的下行同步已把 store 铺好，
# dao.ps1 已退出这块的写入业务。下面两条都不是部署动作：
.\dao.ps1 link-codex             # 只读报告：现状 + store 缺哪些名字（不建链，跑不跑都不影响部署）
.\dao.ps1 unlink-codex           # 换机一般用不上；老机器上用它清 dao 早年自建的链和悬空坟

# Codex prompts（这个仍由 dao 写，与 skills 不是一回事）
.\dao.ps1 link-codex-prompts

# ~~Windsurf~~（已退役，勿执行——link-global 落地的 global_rules.md 已 DEPRECATED）
# .\dao.ps1 link-global
# .\dao.ps1 link-rules-all

# IDE 终端（cmd → Git Bash）
.\dao.ps1 set-terminal

# pi 编码代理（按需）：不由 dao 部署，照处方手动配——
# npm 全局装包 + 写 ~/.pi/agent/{models.json,settings.json}（模板与坑见 ccswitch/stacks/pi.md），
# 真实 API key 从 new-api 面板生成后只填本地 models.json 一格，然后跑处方 §6 的两条验证命令

# 任意命令加 -DryRun 先预览不写入
```

跑完**重启对应客户端会话**（Claude Code `/clear`）才识别新的 skills/commands/agents。

### 步骤 5 · 验证

```powershell
dao.bat --status                  # dao 链接健康矩阵
dao.bat --doctor                  # 配置一致性体检（0 问题为准）
node config-sync\lib\goal-task-health.mjs   # （Codex 用户）goal 任务状态体检
```

doctor 报「问题 0 项」即环境恢复成功。提醒项（如 Codex node_repl）属正常差异。

<!-- APPEND-MARKER-2 -->

## 3. 换机会变的东西（踩坑预警）

| 项 | 旧机 | 新机会变吗 | 处理 |
|---|---|---|---|
| 仓库根路径 | `D:/frank/windsurf-dao` | 可能不同 | 占位符/动态根自动适配，无需手改 |
| 用户名 | `Administrator` | 可能不同 | `${HOME}` 占位，恢复时还原 |
| 供应商配置 | cc-switch DB | 需重配 | 新机器在 cc-switch 中重新配置供应商 |
| Codex 登录态 | cc-switch DB | — | 切号后按需在 Codex 重新登录/MFA |
| hook 本机状态目录 | `~/.claude/dao-state/`（rate-limit-sentinel/fired.log、glob-gate 缓存等） | **不随换机走** | 无需处理：目录由 hook 首次触发时自建、不进 git、不由 config-sync 恢复。**代价照直写**：它攒的是「这台机器被限流过几次」的实战样本（issue #190 的观测面），换机即从零重新攒 —— 那是有意的（样本本就是按机器算的），不是漏配 |

## 4. 路径占位机制（为什么换机不怕路径变）

config-sync 在导出时把两类本机路径替换成占位符，恢复时还原成新机实际路径：

- `${PROJECT_ROOT}` → windsurf-dao 仓库根（如 hooks 命令 `node "${PROJECT_ROOT}/ccswitch/hooks/dao-glob-gate.js"`）
- `${HOME}` → 用户主目录

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

