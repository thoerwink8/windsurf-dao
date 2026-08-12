# config-sync

`config-sync` 是 `windsurf-dao` 的跨端配置备份 / 恢复 / 体检模块。

它不直接充当 Claude Code、Claude Desktop 或 Codex 的实时同步器；日常配置仍以 **cc-switch** 为主配置中心与下发引擎。这里负责把 cc-switch 的 SQLite 配置导出成可管理的文件，换机时再恢复回 cc-switch。

## 目录约定

```text
config-sync/
  common/       # 通用配置，进入 git
  providers/    # 🔴 历史遗留，不进 git、不是恢复源 —— 见下方「providers/ 是历史遗留」一节
  vendor/       # 首次用时下载的安装包与解压产物（都不进 git）
  lib/          # Node.js 脚本（sync.mjs 编排器 + export/restore/doctor/inventory）
  同客端MCP.bat       # DB → 桌面端客户端 MCP 分发（独立）
  同Desktop MCP.bat   # 同上（兼容旧入口）
  检Goal任状.bat       # Goal 任务状态检查（独立，与配置同步无关）
```

> 统一入口 `dao.bat` 已移至仓库根目录，与 `dao.ps1` 并列。

## 配置存储

- `common/`：通用配置快照，可进 git，例如 common settings、MCP、skills、prompts、proxy 相关配置。
- `common-secrets.json`：settings 脱敏占位符对应的真实值，已被 `.gitignore` 忽略，换机时需手动复制。
- 供应商配置不再同步：新机器应直接通过 cc-switch 配置自己的供应商，避免旧配置污染。**那条政策留下的残留物已于 2026-08-04 清除 —— 详见下一节。**

## ✅ providers/ 的陈旧快照已删除（2026-08-04，用户拍板）

**已删**：`providers/providers.json`（50,728 B，2026-06-15 的一次性导出）· 同名 `.bak`（48,360 B，06-07）· 那份写给人看的 `请勿用于恢复-DO-NOT-RESTORE.md`。

**为什么删而不是留着标注**：普查结论确定 —— 2026-08-02 全树 1174 个文件（含被 gitignore 忽略的）实测**零个脚本 / 文档 / hook 读它**，做过放诱饵/拿走诱饵的正负控。
且它**不是「漏了没同步」，是被删过一次的残留**：`7644d85`(06-07) 建 providers scope 时**同一提交的 `.gitignore` 就忽略了它** ⇒ 快照从第一天起就进不了 origin；`0dde09c`(06-15 PR #18) 摘掉全部代码路径而盘上目录没删；`5c7f61d`(06-15 PR #20) 残留目录以 untracked 冒出来 → **被加回 `.gitignore` 藏起来而不是清掉**。

⚠️ **删除不可恢复，且刻意没有备份**：这些文件不在 git（整个目录被忽略），而 `providers.json` 本身含各 provider 的 `settings_config`（内有真实 token）—— **备份一个含凭据的陈旧快照，等于把凭据挪个地方**，那正是 issue #101 在治的事。

🔴 **目录没有清空，还剩一份 `common-secrets.json`（603 B，2026-06-15）**：它与 `config-sync/common-secrets.json`（517 B）**内容不同**（MD5 各异），不是同一份的副本。它含真实凭据，**AI 不动凭据文件**，处置交用户 —— 见 issue #96。

### 拿它恢复本来会发生什么（留档，解释为什么非删不可）

### 拿它恢复会发生什么（这才是它危险的地方）

cc-switch 真正下发到 `~/.claude/settings.json` 的，是 `providers` 表里**当前 provider 那一行**的
`settings_config`，而且是**整体覆盖**（出处：`ccswitch/lib/settings-drift.js` 头注第三面 · issue #49）。
2026-08-02 实测那份快照与 DB 的差距：

| | `providers/providers.json` | cc-switch DB `providers` 表 |
|---|---|---|
| 行数 / 唯一 id | 17 行 / **15 个**（两个 id 重复） | 13 行 / 13 个 |
| `claude-official` 的 `settings_config` | **46 字节**，无 `permissions`、无 `hooks` | 3925 字节，`permissions.deny` **5 条** + 7 个挂载点的 hooks |
| `dulays-1784385029046` | **整行缺失** | 有，同样带 deny 5 条 + 7 个挂载点 |
| `nowcoding全球加速-1782696928716` | **整行缺失** | 有 |
| 只在快照里、DB 已无的 id | **4 个** | — |

⇒ 用这份快照覆盖之后，`permissions` 连同**全部 deny 规则**被静默抹掉 —— Grep-first 铁律
（`Bash(grep:*)` / `Bash(find:*)` / `PowerShell(Select-String:*)` …）的落地面就住在那里。
**没有告警、没有 diff**，恢复完看起来一切正常，而护栏已经没了。少一条 deny 与少一个 hook 的后果不同、更糟：
hook 没了会有人察觉行为变了，deny 少一条只是**护栏悄悄回退**。

若照 `lib/restore.mjs` 既有的「先 `DELETE FROM` 整表、再 `INSERT OR REPLACE`」写法把它接进来，
还要多两条：DB 里那两行快照没有的 provider **被删掉不再回来**；重复 id **静默塌成**最后一次出现的那一份。

### 现在该怎么做

- **要 providers 的真相** → 查 cc-switch DB 的 `providers` 表，不要查这份快照。
- **看到那个文件** → 它开头有一个 `_WARNING` 键写着同样的事；同目录还有一份
  `请勿用于恢复-DO-NOT-RESTORE.md`（同样不进 git）。
- **处置未定**：纳入同步 scope / 保留为历史快照 / 删除，三条路的代价与风险已备齐，**待用户拍板**
  —— 见 issue #96。在拍板之前**不要删、也不要拿它恢复**。

## common 密钥脱敏（重要）

cc-switch 的 common 配置里有时会混入真实密钥（例如 `common_config_openclaw` 自带的 `apiKey` / `gateway.auth.token` / 飞书 `appSecret`）。这些字段如果原样进 git 会泄露。

导出时 config-sync 会自动处理：

- 把 common 配置里字段名命中 `apiKey / token / secret / password / appSecret / authToken / bearer` 的值，替换成占位符 `__CONFIG_SYNC_SECRET__` 后写入 `common/settings.json`（进 git）。
- 真实值单独写入 `config-sync/common-secrets.json`（被 `.gitignore` 忽略，不进 git）。
- 恢复时自动把真实值合并回 cc-switch；若缺少 `common-secrets.json`，恢复会报错并提示。

换机时，`common-secrets.json` 需手动复制到新机器的 `config-sync/` 目录下。

## 前置条件

脚本需要 `sqlite3` 命令行工具（查找顺序：环境变量 `SQLITE3_PATH` → `PATH` → `vendor/sqlite/sqlite3.exe`）。
缺了会报错并提示手动安装：装好 sqlite3 后设 `SQLITE3_PATH` 指向它，或放进 PATH 即可。
`lib/sqlite.mjs` 已把 `vendor/sqlite/sqlite3.exe` 加入 fallback 路径。

### 安装包为什么不进 git

sqlite3 是随处能装的开源命令行工具，不再内置下载器（2026-08-12 与 `setup-sqlite.ps1` / `vendor/sqlite-tools.json` 同批退役）：
新机器装好 sqlite3（或设 `SQLITE3_PATH`）即可，首次不用联网下载 6.4 MB 安装包。
`vendor/sqlite/` 下若已有解压好的 `sqlite3.exe`，`lib/sqlite.mjs` 的 fallback 路径直接命中。

## 使用方式

### 统一入口：dao.bat

双击：

```text
dao.bat
```

这是 DB ↔ 仓库快照 ↔ origin 三层同步的**唯一入口**，把旧的导出 / 恢复 / 体检 / 盘点融成一扇门，并加上 git 感知与三档护栏。流程：

1. **状态板**（永远先打印）：当前分支、与 origin 的领先/落后、工作区是否干净、DB 通用配置与仓库快照是否一致。先看清三方真相，再动手。
2. **选操作**：
   - `[1] 下行`（默认 / 安全）：`origin → 本机 cc-switch`。落后 origin 时先 `git pull --ff-only` 对齐，再 restore。
   - `[2] 上行`（慎重）：`本机 cc-switch → origin`。export → 展示 diff → 确认 → commit → push。
   - `[3] 体检`：只读 doctor。
   - `[4] 盘点`：只读 inventory。
3. **选范围**（下行/上行时）：`全部` 或逗号多选 `settings / mcp / skills / prompts / proxy / terminal / pi`。

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

选项：`--scope=settings,mcp,skills,prompts,proxy,terminal,pi`（默认 all）、`--yes`（非交互跳过 🟡 确认）、`--dry-run`（只演练不落地）、`--no-fetch`（离线跳过 fetch）。

#### 导出 / 恢复落点

- **下行（恢复）**：读取 `common/` 快照写回 `~/.cc-switch/cc-switch.db`，写前自动备份到 `~/.cc-switch/backups/`。
- **上行（导出）**：从 `~/.cc-switch/cc-switch.db` 导出快照到 `common/settings.json`、`common/mcp_servers.json`、`common/skills.json`、`common/prompts.json`、`common/proxy.json`（脱敏真实值写入 `common-secrets.json`，被 `.gitignore` 忽略）。
- **terminal**（文件型，不走 DB）：从 Windows Terminal `settings.json` 提取配色/字体子集到 `common/terminal.json`；恢复时字段级合并回本机，不覆盖 GUID/commandline/actions 等本机特定信息。写前自动备份原文件（`settings.before-dao-sync-*.bak`）。支持商店版与 Preview 版路径自动发现。
- **pi**（文件型，不走 DB，issue #344）：把 `~/.pi/agent/` 的 `settings.json` 与 `themes/` 原样快照到 `common/pi/`（进 git），`auth.json` 脱敏为占位符快照（真实值进 `config-sync/common-secrets.json`，键形如 `pi_auth :: deepseek.key`，不进 git）；恢复时 settings/themes 原样落位，auth 先用 common-secrets.json 还原真值，缺真实值则跳过 auth 不写坏文件。`sessions/ · models-store.json · bin/ · extensions/` 属本机产物，刻意不同步。

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

在 `dao.bat` 菜单选 `[3] 体检`，或跑 `dao.bat --doctor` / `node lib/sync.mjs --doctor`。

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
- pi 的 `common/pi/` 快照与 `~/.pi/agent/` 是否一致（settings 结构化比对 / themes 三向缺改多 / auth 占位符与 common-secrets.json 配套，且快照无明文敏感字段）；
`claude_desktop_gateway_token` 是本机运行态密钥，只存在于当前 cc-switch db 中，不进入 `common/`，也不由恢复脚本覆盖。恢复脚本只 upsert `common_config_` 开头的 settings key，避免把 Desktop Gateway 认证 token 清空后导致 401。

`common/mcp_servers.json` 里的 `server_config` 会把项目路径与 home 路径分别写成 `${PROJECT_ROOT}` / `${HOME}`，恢复时再还原成本机路径，避免把 `D:/frank/windsurf-dao` 或用户 home 直接提交到 git。Pencil 这类安装在 `D:/Program Files/...` 的本机特定路径无法自动泛化，体检只会提醒；换机后需要按新机器安装路径重配。

`common/pi/auth.json`（进 git）只允许脱敏占位符，真实值在 `config-sync/common-secrets.json`（不进 git，换机手动复制）；体检会把快照脱敏还原后与本机 `~/.pi/agent/auth.json` 做结构化比对。漂移判定一律结构化比对 / 文件哈希，不做文案正则。

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

在 `dao.bat` 菜单选 `[4] 盘点`，或跑 `dao.bat --inventory` / `node lib/sync.mjs --inventory`。

只读盘点 skills / MCP 的多来源分布，标出重复 / 冲突 / 孤儿 / 悬空链，不改任何下发链。用于看清碎片化现状：

- Skills 四来源：windsurf-dao(git) 软链 / cc-switch DB 通用 skill / 旧 `.agents/skills`(已废,留悬空链) / 真实拷贝。
- MCP 三处：cc-switch DB / `windsurf-dao/mcp` / `~/.claude.json` global。同名工具多处定义会标 `[重复]`，cc-switch 未纳管的标 `[孤儿]`。

判定符号链接有效性用 readlink 目标存在性，不用 `existsSync(链路径)`——跨盘符号链接在普通进程下解引用会 EPERM 假性报错。

## 第三方 hook 写入方（Coffee CLI 等）

`~/.claude/settings.json` 的 `hooks` 段除 dao 自有脚本外，还可能被**第三方工具自行注册**。2026-07-27 清掉了 Coffee CLI 写入的 5 条 hook（`Notification` / `PostToolUse(*)` / `PreToolUse(*)` / `Stop` / `UserPromptSubmit` 各一条，命令串均为 `"…/Coffee CLI/coffee-cli.exe" __hook`）。

删除判据三条：

- **场景不匹配**：用户运行竞品是为走查其形态，不需要它跟踪自己的 Claude 会话；删除这些 hook 不影响启动 Coffee CLI 本身。
- **数据面**：`PreToolUse` / `PostToolUse` 的 `*` matcher 意味着载荷是**全部开发活动流水**（每次工具调用的输入输出）。
- **成本**：每次工具调用都要拉起一次竞品 exe 进程。

⚠️ **复发不会被 settings-drift 自动报出**。`ccswitch/lib/settings-drift.js` 的 `daoScriptOf()` 对不含 `.js/.mjs/.cjs/.ps1` 的命令串返回 `null`，`hookIndex()` 随即跳过该条目；`tests/settings-drift.tests.js` 还有一条负例断言（「负例·第三方 exe 命令不误伤」）**明确钉住**第三方 exe 命令不得进入硬发现——这是刻意设计（避免把用户自装工具当漂移），不是缺陷。刀F 补的命令串全等判据只作用于 dao 自有脚本，覆盖不到本类。

因此：Coffee CLI 下次启动**有可能**自动重新注册（未实测其是否每次启动都写），届时需**手动**发现。复查一行：

```bash
node -e "const s=require('fs').readFileSync(process.env.USERPROFILE+'/.claude/settings.json','utf8');console.log('coffee hook 条数 =',(s.match(/coffee-cli/gi)||[]).length)"
```

若要让检测器自动覆盖此类，需另立「live 侧非 dao hook 白名单」判据面——尚未实现，属显式挂账。

## 安全约束

- 不要把 `common-secrets.json` 提交到 git。
- 脚本不会在控制台打印完整 token / API key。
- 恢复脚本只写 cc-switch 配置表，不写运行日志、健康检查日志、usage 统计等运行态表。
- 第一版不创建 cc-switch schema；如果 db 不存在，请先安装并启动一次 cc-switch。

## 换机流程

1. 在旧机器运行 `dao.bat` 选上行导出。
2. 提交 `common/` 到 git。
3. 手动复制 `config-sync/common-secrets.json` 到新机器同一位置。
4. 新机器先安装并启动一次 cc-switch，让它创建基础 db。
5. 运行 `dao.bat` 选下行恢复。
6. 在新机器的 cc-switch 中配置供应商（token/API key）。
7. 重启 cc-switch，并切换一次 provider。
8. `dao.bat --doctor` 确认状态。
