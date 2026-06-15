# config-sync

`config-sync` 是 `windsurf-dao` 的跨端配置备份 / 恢复 / 体检模块。

它不直接充当 Claude Code、Claude Desktop 或 Codex 的实时同步器；日常配置仍以 **cc-switch** 为主配置中心与下发引擎。这里负责把 cc-switch 的 SQLite 配置导出成可管理的文件，换机时再恢复回 cc-switch。

## 目录约定

```text
config-sync/
  common/       # 通用配置，进入 git
  providers/    # 供应商配置，含 token，不进入 git
  vendor/       # sqlite3 等本机工具安装包（进 git，免换机再下载）
  lib/          # Node.js 脚本（sync.mjs 编排器 + export/restore/doctor/inventory）
  setup-sqlite.ps1
  dao-sync.bat       # 统一入口：DB ↔ 仓库 ↔ origin 同步 + 体检 + 盘点
  同客端MCP.bat       # DB → 桌面端客户端 MCP 分发（独立）
  同Desktop MCP.bat   # 同上（兼容旧入口）
  检Goal任状.bat       # Goal 任务状态检查（独立，与配置同步无关）
```

> 旧的 `导配.bat` / `恢配.bat` / `体.bat` / `盘来.bat` 已融合进 `dao-sync.bat`，不再单独存在。

## 两类配置

- `common/`：通用配置，可进 git，例如 common settings、MCP、skills、prompts、proxy 相关配置。
- `providers/`：供应商配置，包含 token / API key，已被 `.gitignore` 忽略。换机时请手动复制整个目录。

## common 密钥脱敏（重要）

cc-switch 的 common 配置里有时会混入真实密钥（例如 `common_config_openclaw` 自带的 `apiKey` / `gateway.auth.token` / 飞书 `appSecret`）。这些字段如果原样进 git 会泄露。

导出时 config-sync 会自动处理：

- 把 common 配置里字段名命中 `apiKey / token / secret / password / appSecret / authToken / bearer` 的值，替换成占位符 `__CONFIG_SYNC_SECRET__` 后写入 `common/settings.json`（进 git）。
- 真实值单独写入 `providers/common-secrets.json`（被 `.gitignore` 忽略，不进 git）。
- 恢复时自动把真实值合并回 cc-switch；若缺少 `common-secrets.json`，恢复会报错并提示。

所以换机时，`providers/` 目录（含 `providers.json` 和 `common-secrets.json`）必须手动复制，缺一不可。

## 前置条件

脚本需要 `sqlite3` 命令行工具。项目已内置 Windows 64 位安装包，运行一次即可：

```powershell
.\setup-sqlite.ps1
```

它会优先使用系统已有的 `sqlite3`；找不到时自动从 `vendor/sqlite-tools-win-x64-*.zip` 解压到 `vendor/sqlite/`，并设置用户级 `SQLITE3_PATH`。`lib/sqlite.mjs` 也已把 `vendor/sqlite/sqlite3.exe` 加入 fallback 路径，解压后新终端无需额外配置即可运行 `node lib/*.mjs`。

## 使用方式

### 统一入口：dao-sync.bat

双击：

```text
dao-sync.bat
```

这是 DB ↔ 仓库快照 ↔ origin 三层同步的**唯一入口**，把旧的导出 / 恢复 / 体检 / 盘点融成一扇门，并加上 git 感知与三档护栏。流程：

1. **状态板**（永远先打印）：当前分支、与 origin 的领先/落后、工作区是否干净、DB 通用配置与仓库快照是否一致。先看清三方真相，再动手。
2. **选操作**：
   - `[1] 下行`（默认 / 安全）：`origin → 本机 cc-switch`。落后 origin 时先 `git pull --ff-only` 对齐，再 restore。
   - `[2] 上行`（慎重）：`本机 cc-switch → origin`。export → 展示 diff → 确认 → commit → push。
   - `[3] 体检`：只读 doctor。
   - `[4] 盘点`：只读 inventory。
3. **选范围**（下行/上行时）：`全部` 或逗号多选 `settings / mcp / skills / prompts / proxy / providers`。

#### 三档护栏

- 🔴 **硬拦（直接拒绝）**：上行时若本机**落后 origin**，直接拒绝执行——这正是「用旧 DB 盖掉 origin 新配置」这类分叉 bug 的命门。无 upstream、push 被拒同样硬拦。
- 🟡 **确认（摊开 diff 再动）**：任何写操作（写 DB / commit+push）前展示差异，交互需点 `y`、非交互需 `--yes` 才继续。工作区脏时下行也会先确认。
- 🟢 **提示（只告知）**：还原完成后提醒「重启 cc-switch，并切换一次 provider」。

#### 真相源

**origin = 共享配置唯一真相，cc-switch DB = 本地缓存。** 所以「下行」是默认安全路径，「上行」是少数、慎重、必须先对齐 origin 的发布路径。

#### 命令行用法（可选，给脚本/自动化）

```text
node lib/sync.mjs                                  交互式（推荐）
node lib/sync.mjs --direction=down [--scope=all]    下行
node lib/sync.mjs --direction=up   [--scope=settings,mcp] [--message="..."]  上行
node lib/sync.mjs --doctor                          只读体检
node lib/sync.mjs --inventory                       只读盘点
```

选项：`--scope=settings,mcp,skills,prompts,proxy,providers`（默认 all）、`--yes`（非交互跳过 🟡 确认）、`--dry-run`（只演练不落地）、`--no-fetch`（离线跳过 fetch）。

#### 导出 / 恢复落点

- **下行（恢复）**：读取 `common/` 与 `providers/` 快照写回 `~/.cc-switch/cc-switch.db`，写前自动备份到 `~/.cc-switch/backups/`。全量恢复时还会把仓库 `local-marketplaces/` 铺回 `~/.codex/local-marketplaces/`（部分 scope 恢复时跳过，避免误动）。
- **上行（导出）**：从 `~/.cc-switch/cc-switch.db` 导出快照到 `common/settings.json`、`common/mcp_servers.json`、`common/skills.json`、`common/prompts.json`、`common/proxy.json`、`providers/providers.json`、`providers/common-secrets.json`（后两者在 `providers/`，被 `.gitignore` 忽略，不会进 commit）。

### 同步客户端 MCP

双击：

```text
同客端MCP.bat
```

效果：从 cc-switch 的 `mcp_servers` 表读取已启用 MCP，并写入本机客户端配置：

- `enabled_claude=1` 写入 `~/.claude.json`
- `%APPDATA%\Claude\claude_desktop_config.json`
- `enabled_codex=1` 写入 `~/.codex/config.toml`

Claude-3p / CloudCode Desktop 不把 `%LOCALAPPDATA%\Claude-3p\claude_desktop_config.json` 作为 MCP 真相源；运行时会通过 `Local\Claude-3p\claude-code\<version>\claude.exe --mcp-config ...` 注入 MCP，因此体检只检查运行态 `--mcp-config`，不硬写这个会被应用重写的文件。

JSON 配置只替换生成的 `mcpServers` 字段，TOML 配置只替换 `[mcp_servers]` 区块，保留其他配置字段；写入前会生成 `*.before-*-YYYYMMDD_HHMMSS.bak` 备份。当前策略是所有 MCP 先注册到 cc-switch，能用的启用，死配置保留但不启用。

`同Desktop MCP.bat` 是兼容旧入口，调用同一个脚本，也会同步 Claude Code CLI / Claude Desktop / Claude-3p / Codex。

### 体检

在 `dao-sync.bat` 菜单选 `[3] 体检`，或跑 `dao-sync.bat --doctor` / `node lib/sync.mjs --doctor`。

体检只读，不自动修改。它会检查：

- cc-switch db 是否存在；
- Claude common env 是否包含流式关键开关；
- 当前 `~/.claude/settings.json` 是否无 BOM 且包含通用开关；
- `common/` 快照与 cc-switch db 中 MCP / skills 是否一致；
- `common/settings.json` 是否已脱敏（无明文密钥）、占位符与 `common-secrets.json` 是否配套；
- `settings.claude_desktop_gateway_token` 是否存在，且未进入 `common/settings.json`；
- `common/mcp_servers.json` 是否已把项目路径 / home 路径占位符化；
- Claude Code CLI / Claude Desktop 的 `mcpServers` 是否与 cc-switch 中 `enabled_claude=1` 的 MCP 一致；
- Claude-3p / CloudCode Desktop 运行态 `--mcp-config` 是否与 cc-switch 中 `enabled_claude=1` 的 MCP 一致；
- Codex 的 `[mcp_servers]` 是否与 cc-switch 中 `enabled_codex=1` 的 MCP 一致；
- `providers/providers.json` 是否存在且非空。

`claude_desktop_gateway_token` 是本机运行态密钥，只存在于当前 cc-switch db 中，不进入 `common/`，也不由恢复脚本覆盖。恢复脚本只 upsert `common_config_` 开头的 settings key，避免把 Desktop Gateway 认证 token 清空后导致 401。

`common/mcp_servers.json` 里的 `server_config` 会把项目路径与 home 路径分别写成 `${PROJECT_ROOT}` / `${HOME}`，恢复时再还原成本机路径，避免把 `D:/frank/windsurf-dao` 或用户 home 直接提交到 git。Pencil 这类安装在 `D:/Program Files/...` 的本机特定路径无法自动泛化，体检只会提醒；换机后需要按新机器安装路径重配。

### Goal 任务状态检查

双击：

```text
检Goal任状.bat
```

用途：在 Claude Code Desktop 的 goal 模式卡住、异常中断或疑似空转后，扫描 `~/.claude/tasks` 与 `~/.claude/projects`，确认是否存在会让 goal 误判“目标未完成”的任务状态残留。

检查项：

- task JSON 是否能正常解析（兼容 UTF-8 BOM）；
- 是否存在超过 15 分钟未更新的 `in_progress` 任务；
- transcript 里是否出现“文字声称 `TaskUpdate #N completed`，但没有真实 TaskUpdate 工具调用，且任务文件仍未 completed”的风险。

检查脚本只读，不自动修改。出现问题时，应先核对对应 transcript 是否真的完成，再决定补标 completed 或保留未完成状态；不要批量盲标。

### 盘点来源

在 `dao-sync.bat` 菜单选 `[4] 盘点`，或跑 `dao-sync.bat --inventory` / `node lib/sync.mjs --inventory`。

只读盘点 skills / MCP 的多来源分布，标出重复 / 冲突 / 孤儿 / 悬空链，不改任何下发链。用于看清碎片化现状：

- Skills 四来源：windsurf-dao(git) 软链 / cc-switch DB 通用 skill / 旧 `.agents/skills`(已废,留悬空链) / 真实拷贝。
- MCP 三处：cc-switch DB / `windsurf-dao/mcp` / `~/.claude.json` global。同名工具多处定义会标 `[重复]`，cc-switch 未纳管的标 `[孤儿]`。

判定符号链接有效性用 readlink 目标存在性，不用 `existsSync(链路径)`——跨盘符号链接在普通进程下解引用会 EPERM 假性报错。

## 安全约束

- 不要把 `providers/` 提交到 git。
- 脚本不会在控制台打印完整 token / API key。
- 恢复脚本只写 cc-switch 配置表，不写运行日志、健康检查日志、usage 统计等运行态表。
- 第一版不创建 cc-switch schema；如果 db 不存在，请先安装并启动一次 cc-switch。

## 换机流程

1. 在旧机器双击 `导出配置.bat`。
2. 提交 `common/` 和脚本到 git。
3. 手动复制 `providers/` 到新机器同一模块目录（含 `providers.json` 与 `common-secrets.json`）。
4. 新机器先安装并启动一次 cc-switch，让它创建基础 db。
5. 双击 `恢复配置.bat`。
6. 重启 cc-switch，并切换一次 provider。
7. 双击 `体检.bat` 确认状态。
