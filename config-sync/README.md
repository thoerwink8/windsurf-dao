# config-sync

`config-sync` 是 `windsurf-dao` 的跨端配置备份 / 恢复 / 体检模块。

它不直接充当 Claude Code、Claude Desktop 或 Codex 的实时同步器；日常配置仍以 **cc-switch** 为主配置中心与下发引擎。这里负责把 cc-switch 的 SQLite 配置导出成可管理的文件，换机时再恢复回 cc-switch。

## 目录约定

```text
config-sync/
  common/       # 通用配置，进入 git
  providers/    # 供应商配置，含 token，不进入 git
  lib/          # Node.js 脚本
  导出配置.bat
  恢复配置.bat
  体检.bat
  检查Goal任务状态.bat
  同步客户端 MCP.bat
  同步Desktop MCP.bat
  盘点来源.bat
```

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

## 使用方式

### 导出

双击：

```text
导出配置.bat
```

效果：从 `~/.cc-switch/cc-switch.db` 导出配置快照到：

- `common/settings.json`
- `common/mcp_servers.json`
- `common/skills.json`
- `common/prompts.json`
- `common/proxy.json`
- `providers/providers.json`
- `providers/common-secrets.json`（common 配置里被脱敏字段的真实值）

### 恢复

双击：

```text
恢复配置.bat
```

效果：读取 `common/` 与 `providers/` 快照，写回 `~/.cc-switch/cc-switch.db`。恢复前会先备份数据库到：

```text
~/.cc-switch/backups/
```

恢复后请重启 cc-switch，并切换一次 provider，让 cc-switch 重新下发配置。

### 同步客户端 MCP

双击：

```text
同步客户端 MCP.bat
```

效果：从 cc-switch 的 `mcp_servers` 表读取已启用 MCP，并写入本机客户端配置：

- `enabled_claude=1` 写入 `~/.claude.json`
- `%APPDATA%\Claude\claude_desktop_config.json`
- `enabled_codex=1` 写入 `~/.codex/config.toml`

Claude-3p / CloudCode Desktop 不把 `%LOCALAPPDATA%\Claude-3p\claude_desktop_config.json` 作为 MCP 真相源；运行时会通过 `Local\Claude-3p\claude-code\<version>\claude.exe --mcp-config ...` 注入 MCP，因此体检只检查运行态 `--mcp-config`，不硬写这个会被应用重写的文件。

JSON 配置只替换生成的 `mcpServers` 字段，TOML 配置只替换 `[mcp_servers]` 区块，保留其他配置字段；写入前会生成 `*.before-*-YYYYMMDD_HHMMSS.bak` 备份。当前策略是所有 MCP 先注册到 cc-switch，能用的启用，死配置保留但不启用。

`同步Desktop MCP.bat` 是兼容旧入口，调用同一个脚本，也会同步 Claude Code CLI / Claude Desktop / Claude-3p / Codex。

### 体检

双击：

```text
体检.bat
```

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
检查Goal任务状态.bat
```

用途：在 Claude Code Desktop 的 goal 模式卡住、异常中断或疑似空转后，扫描 `~/.claude/tasks` 与 `~/.claude/projects`，确认是否存在会让 goal 误判“目标未完成”的任务状态残留。

检查项：

- task JSON 是否能正常解析（兼容 UTF-8 BOM）；
- 是否存在超过 15 分钟未更新的 `in_progress` 任务；
- transcript 里是否出现“文字声称 `TaskUpdate #N completed`，但没有真实 TaskUpdate 工具调用，且任务文件仍未 completed”的风险。

检查脚本只读，不自动修改。出现问题时，应先核对对应 transcript 是否真的完成，再决定补标 completed 或保留未完成状态；不要批量盲标。

### 盘点来源

双击：

```text
盘点来源.bat
```

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
