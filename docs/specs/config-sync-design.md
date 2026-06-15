# Plan · config-sync 跨端配置治理模块

> 各复归其根，归根曰静。
> cc-switch 是配置主中心，windsurf-dao 做版本化备份 + 跨机重建。
> 通用配置进 git（方法论），供应商配置含 token 不进 git（换机手拷）。

## 元信息

| 项 | 值 |
|---|---|
| 创建 | 2026-06-07 |
| 触发 | 切换中转后流式开关丢失 → 用户提出"统一治理三端配置"想法 |
| 状态 | **待用户审批** |
| 模式 | 乙：cc-switch 为真相主中心，config-sync 做 db ⇄ 文件 + 体检 |
| 位置 | `windsurf-dao/config-sync/`（与 ccswitch/、.devin/ 平级的中性模块） |
| 交互 | 双击 .bat 入口，脚本 `__dirname` 自动定位，跨机零硬编码路径 |

## 一、背景与根因（已实测）

- cc-switch 是常驻代理（端口 15721），同时是**多端配置中心**：维护 `common_config_ccswitch/codex/...`，切换 provider 时自动把 common 合并进各端配置文件。
- cc-switch 已原生管理：`mcp_servers`（带 enabled_ccswitch/codex/gemini/opencode/hermes 各端开关）、`skills` + `skill_repos`、各端 common。
- **痛点**：cc-switch 配置全在本地 SQLite（`~/.cc-switch/cc-switch.db`），不进 git、不可版本化、换机器丢失。
- **流式开关丢失根因**：开关原只写在单个 provider 的 env，切到别的 provider 就丢。已修复——写进 `common_config_claude.env`（公共层，所有 provider 自动继承）。

## 二、核心设计：两类配置

| 类别 | 内容 | 进 git | 跨机方式 |
|---|---|---|---|
| **通用配置** | common(env/permissions/theme/model/hooks...) + mcp + skills | ✓ | git clone 自动带来 |
| **供应商配置** | 各 provider 的 base_url/模型映射 + token(合一) | ✗(.gitignore) | 手动拷 providers/ 文件夹 |

token 位置已锁定：每个 provider 的 `settings_config.env.ANTHROPIC_AUTH_TOKEN` 一个字段。

## 三、目录结构

```
windsurf-dao/config-sync/
  common/                      # 进 git：通用配置（方法论）
    claude.common.json         #   ← cc-switch settings.common_config_claude
    codex.common.toml          #   ← cc-switch settings.common_config_codex
    mcp.json                   #   ← mcp_servers 表（命令+各端 enabled，无密钥）
    skills.json                #   ← skills + skill_repos 表
  providers/                   # 不进 git（.gitignore）：供应商配置含 token
    <provider>.json            #   一个 provider 一个文件，含 token
  .gitignore                   #   忽略 providers/
  lib/
    db.js                      #   安全读写 cc-switch.db：增量、自动备份、无 BOM
    paths.js                   #   动态求路径：homedir() 求 db，__dirname 求项目
  export.js                    #   db → common/ + providers/
  restore.js                   #   common/ + providers/ → db（注入前校验）
  doctor.js                    #   体检：三端实际配置 vs cc-switch 登记
  导出.bat / 恢复.bat / 体检.bat
  README.md
```
<!-- REST -->
