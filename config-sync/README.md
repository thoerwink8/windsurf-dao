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
- `providers/providers.json` 是否存在且非空。

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
