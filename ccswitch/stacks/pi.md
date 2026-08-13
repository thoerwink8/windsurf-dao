---
name: dao-stack-pi
description: pi 编码代理从零装机唯一处方——有网/离线双安装路径 + 每机网关地址与 key 差异 + 扩展四件套 + MCP + skills。换机照此文独立完成安装/配置/验证。
---

# pi 编码代理部署处方（从零装机 · 唯一处方）

> 千里之行，始于足下。换一台机器，照此文走完安装 → 配置 → 验证，不用再回来问人。

出处：issue #302（2026-08-10 本机实装）+ issue #404（2026-08-13 双机实战：本机 Windows 有网直装 + 黄云 web-09 纯内网 Ubuntu 20.04 全程离线）。本文是换机/新机的**唯一处方**，真实 API key 不在此文（也不在任何进 git 的文件里），只在各机器本地 `~/.pi/agent/models.json`。范围按 #346 已拍形态 A（pi 全接管、codex cli 退役）写——本处方服务的对象是「默认工兵启动器 pi」。

## 0. 与 config-sync 的分工（先读，防重复配置）

| 事 | 归谁 | 说明 |
|---|---|---|
| 从零装机（含离线） | **本文** | 一台新机器第一次把 pi 配到能用，照本文走完 |
| 配好之后的持续同步 | config-sync（issue #344） | `dao.bat` 下行/上行同步 `~/.pi/agent/settings.json` + `themes/` + `auth.json`（脱敏进 common-secrets.json）；`lastChangelogVersion` 被 pi 自己更新属预期 |
| 不同步、按本文逐机手工 | — | `models.json`（网关地址/key **每机不同**，见 §4）· `mcp.json` · `extensions/` · `sessions/` · `models-store.json` · `bin/` |

**只留这一份**：NEW-MACHINE.md 对 pi 只写指针（指到本文），不写副本。

## 1. 版本对齐（先核对再动手）

| 项 | 已知值 | 含义 |
|---|---|---|
| pi | 0.73.0 | 本机与离线包同版（2026-08-13 双机） |
| node（本机） | v22.22.0 | 有网直装无版本约束 |
| node（离线包按它打的） | 20.15.0 | node-gyp headers 缓存绑定 node 版本，换大版本要重做 §3.3 |

## 2. 安装路径 A · 有网机器

```sh
npm install -g @mariozechner/pi-coding-agent
```

⚠️ npm 包名与 CLI 名不同：包是 `@mariozechner/pi-coding-agent`，命令是 `pi`。**`@mariozechner/pi` 是另一个 vLLM 管理工具，别装错。**

## 3. 安装路径 B · 纯内网离线机器（黄云 web-09 实装）

> 单内只有「有网机打包」这一半的一手记录；黄云侧的落位与接线命令不在单里，以「待补」标注，见 §12。

### 3.1 离线包从哪来：复用，不重打

预打包产物在 pess-requirements 仓 `_tmp/orca-offline/`（git 不追踪，约 109M，旁附 `SHASUMS256.txt`）：

| 文件 | 内容 | 版本绑定 |
|---|---|---|
| `pi-linux-x64.tar.gz` | pi 完整 Linux x64 依赖树（`node_modules/`，由 `npm install --os=linux --cpu=x64 --force --ignore-scripts` 产出） | pi 0.73.0 |
| `mariozechner-clipboard-linux-x64-gnu-0.3.2.tgz` | libc 平台子包**补传**（Windows 打 Linux 依赖树不会自动进树，见坑） | clipboard 0.3.2 |
| `node-v20.15.0-headers.tar.gz` | node-gyp 编译用 Node headers | node 20.15.0 |
| `pi-mcp-extension-1.5.0-offline.tar.gz` | MCP 扩展离线包（含依赖） | pi-mcp-extension 1.5.0 |
| `pi-ui-bundle-offline.tar.gz` | pi-claude-code-tui + pi-cc-status 离线包 | 见 §6 |
| `claude-skills.zip` | Claude Code skills 打包（供 §8 接线） | — |

**版本对齐策略**：目标机 node 版本 ≠ 包内 headers 版本时，只重做「headers 预填」一格（§3.3）；主体包在 pi 版本不变时**不重打**，pi 版本升级才按 §11 重打配方重打。

**归宿（待拍板）**：该目录在 `_tmp/` 下、git 忽略，机器清理会丢——这正是 issue #404「删除」那一步要回答的：109M 二进制不进 dao 仓（规则仓不装二进制），GitHub release 对纯内网机器不可达（挂了也没用）。当前实用做法 = 从这**唯一一份**拷走分发；稳定归宿（内网盘 / NAS / 换机清单挂账）未定，见 §12。

### 3.2 传输与校验

拷对应文件到目标机后，先对 `SHASUMS256.txt` 列出的条目做 sha256 校验再解包。

### 3.3 node-gyp headers 预填（一次预填终身受益，换 node 版本需重做）

node-gyp（Node 原生模块编译工具）无外网时下载 headers 必失败。目标机上执行：

```sh
node-gyp install --tarball=/path/to/node-v20.15.0-headers.tar.gz
```

预填 `~/.cache/node-gyp`。**坑**：libc 平台子包（如 `@mariozechner/clipboard-linux-x64-gnu`）在 Windows 上打依赖树时不会自动进树（已实测：主包内 0 命中），需单独 `npm pack` 补传——离线包里那份 tgz 就是干这个的。

### 3.4 装 pi 本体与接线

解包 `pi-linux-x64.tar.gz` 到目标位置，补解 clipboard 子包进树，让 `pi` 可执行入口进 PATH。

【待补：需该机实操回填——黄云上实际的落位路径与 PATH 接线命令，单内无一手记录。上述为按常规推的形态，未在黄云验证。】

## 4. `~/.pi/agent/models.json`（自定义 provider · 每机网关/key 不同）

```json
{
  "providers": {
    "new-api": {
      "baseUrl": "http://<本机可达网关>/v1",
      "api": "openai-completions",
      "apiKey": "<见下方取法，绝不写真实值>",
      "compat": {
        "supportsDeveloperRole": false,
        "supportsReasoningEffort": false
      },
      "models": [
        { "id": "deepseek-v4-flash", "name": "DeepSeek V4 Flash", "reasoning": true, "input": ["text"], "contextWindow": 300000, "maxTokens": 32768 },
        { "id": "glm-5.2", "name": "GLM 5.2", "reasoning": true, "input": ["text"], "contextWindow": 800000, "maxTokens": 32768 },
        { "id": "gpt-5.6-luna", "name": "GPT 5.6 Luna", "reasoning": true, "input": ["text", "image"], "contextWindow": 800000, "maxTokens": 32768 },
        { "id": "kimi-k3", "name": "Kimi K3", "reasoning": true, "input": ["text", "image"], "contextWindow": 300000, "maxTokens": 32768 }
      ]
    }
  }
}
```

🔴 **API key 绝不写真实值**——真实 key 只存在于各机器本地 `~/.pi/agent/models.json`，不进仓、不进 issue、不进任何进 git 的文件。

**每机网关地址与 key 都不同**，标准取法（不用去面板重新生成）：
- 从该机**已配好的 Claude Code `settings.json`** 借：`ANTHROPIC_BASE_URL`（→ `baseUrl`，记得带 `/v1`）与 `ANTHROPIC_AUTH_TOKEN`（→ `apiKey`）。key 也随机器走，各机不同。
- 两个已知实例（**只是实例，不是写死值**）：本机 `10.213.196.114:3000`，黄云 `10.213.170.214:3000`。2026-08-13 实测：本机网关从本机可达（401=需鉴权，正常），黄云网关从本机不可达（不同网段）——**别把别的机器的地址抄到本机，配完直接用 §10 冒烟验证兜底**。

### 设计决策（写下来让后人不误改）

- **4 个模型真实上下文都是 1M**（网关 `/api/pricing` description 字段 + GLM-5.2 官方文档），但 `contextWindow` **故意声明得更小**：pi 无百分比压缩阈值，触发公式是 `已用 > contextWindow − reserveTokens`（源码 `compaction.js:152` 核实）。worker 常用的两个模型（deepseek-v4-flash / kimi-k3）声明 **300000**——压缩早触发，单请求峰值受控（长会话实测过 428k/请求的账单曲线后收窄）；worker 的状态都在盘上（提交/任务书），丢会话旧细节无伤。另两个模型保持 800000。想用满 1M 改回 1000000。
- `supportsDeveloperRole: false` + `supportsReasoningEffort: false`：网关代理场景的兼容设置（pi 官方文档对 OpenAI 兼容代理的建议）。
- gpt-5.6-luna 计费分层：输入超 272K 后单价翻倍，长上下文任务留意。

## 5. `~/.pi/agent/settings.json`

```json
{
  "defaultProvider": "new-api",
  "defaultModel": "deepseek-v4-flash",
  "compaction": {
    "enabled": true,
    "reserveTokens": 32768,
    "keepRecentTokens": 32768
  }
}
```

⚠️ **config-sync 会覆盖此文件**（`dao.bat` 下行时）：快照里 `defaultProvider` 必须与 models.json 的 provider 名一致，否则下行后 pi 找不到默认 provider（本仓快照现状的对账见 §12 待补④）。扩展包条目由 `pi install` 自动追加到这里（见 §6）。

## 6. 扩展四件套（补齐 Claude Code 同款体验）

| 扩展 | 作用 | 版本（2026-08-13 双机） |
|---|---|---|
| `pi-mcp-extension` | MCP 桥（读 `~/.pi/agent/mcp.json`，见 §7） | 1.5.0 |
| `pi-claude-code-tui` | Claude Code 同款界面 | 0.1.12 |
| `pi-cc-status` | 状态栏 | 0.1.4 |
| `@tintinweb/pi-subagents` | 子代理 | 0.15.0 |

**有网机器**：

```sh
pi install npm:pi-mcp-extension
pi install npm:pi-claude-code-tui
pi install npm:pi-cc-status
pi install npm:@tintinweb/pi-subagents
```

（`pi install npm:X` = 全局 npm 安装 + 把 `npm:X` 写进 settings.json 的 `packages` 数组。）

**离线机器**：`npm pack` 打出 tgz → 在包目录内 `npm install` 装齐依赖 → 打 tar 传输 → 目标机上 `pi install /绝对路径`（pi 支持本地路径包源）。

**实测坑（2026-08-13 本机）**：
- 四件套全装后**启动明显变慢**：`pi --list-models` 无扩展约 5s，四件套约 20-30s，最差采样 >120s（超时误判过「挂起」）。大头是 `pi-mcp-extension` 在启动时拉起 `mcp.json` 里 `lifecycle: eager` 的 server（本机 codegraph 首跑 liftoff 更慢）。工兵每调一次 `pi -p` 都付这笔成本。
- `@tintinweb/pi-subagents` 的 peerDependencies 声明 `>= 0.80.0`，而当前 pi 是 0.73.0——**能加载、能回复，但真实运行从未验证**（treelord 侦察 2026-08-13 确认：只装过、没跑过一次），待补。
- 不需要扩展的场合（如纯 `--list-models` 查模型）可用 `--no-extensions` 绕开启动成本。

## 7. MCP 接入 `~/.pi/agent/mcp.json`

由 `pi-mcp-extension` 读取（**pi 本体不读它**）：全局 `~/.pi/agent/mcp.json` + 项目级 `.pi/mcp.json`（项目级按 server 覆盖全局）。格式与 Claude Code 的 `.mcp.json` 几乎同构（`mcpServers` + `command`/`args`/`env`），多两个字段：

| 字段 | 取值 | 含义 |
|---|---|---|
| `transport` | `stdio` / `streamable-http` / `sse` | stdio 用 `command`+`args`；http 系用 `url` |
| `lifecycle` | `eager` / `lazy` | eager=启动即连（贵，慎用），lazy=首次调用才连 |

**照抄该机 Claude Code 的 MCP 配置做转换即可**：每条 server 补 `transport: "stdio"`（stdio 型）与 `lifecycle`。本机实例（2026-08-13 实机形态）：chrome-devtools / playwright / context7 / fetch 全 `lazy`，codegraph `eager`。装好后 `/mcp` 查 server 状态。

## 8. skills（pi 侧自动发现，Claude Code skills 需显式接线）

> 更正：issue #404 原文写「pi 自动发现 `~/.claude/skills/*/SKILL.md`，零配置」——**实测不成立**（pi 0.73.0 `dist/core/skills.js` + 官方 docs/skills.md）：pi 默认扫 `~/.pi/agent/skills/` 与 `~/.agents/skills/`（另有项目级 `.pi/skills/` 等），**不含** `~/.claude/skills`。

两法选一：
1. **默认路径法**：把 skills 放进 `~/.pi/agent/skills/`（或 `~/.agents/skills/`），零配置自动发现。
2. **复用 Claude Code skills**：在 `~/.pi/agent/settings.json` 显式接线：

```json
{
  "skills": ["~/.claude/skills"]
}
```

（项目级加进 `.pi/settings.json`，路径写 `"../.claude/skills"`。）

## 9. 已知坑（实测定位）

- **deepseek-v4-flash 勿用 `--tools` 裁掉 bash**：裁掉后模型仍幻觉调用 bash，上游 DSML 解析器匹配不到未声明工具，把 `<｜｜DSML｜｜tool_calls>` 原文当纯文本吐出（非网关流式 bug，curl 流式+声明工具实测正常）。agent 任务用默认工具集。
- **网关地址别写死**：每机可达地址不同（本机 `10.213.196.114:3000` / 黄云 `10.213.170.214:3000`，2026-08-13 双机实例），key 也各机不同。标准取法见 §4，抄别的机器的值必挂。
- **扩展四件套全装启动慢**：见 §6 实测数据，`--no-extensions` 可绕。
- **config-sync 下行会覆盖 settings.json**：`defaultProvider` 与 models.json 的 provider 名必须一致（§5）。

## 10. 验证（新机器配完自检）

```sh
pi --list-models new-api        # 应列出 4 个模型（四件套全装时约 20-30s，属正常）
pi --no-tools --no-session -p "只回复：OK"   # 端到端冒烟
```

两条全过 = 部署完成。第一条不过 → 查 `models.json` 路径与 JSON 合法性；第二条不过 → 查 apiKey 与网关连通性。扩展状态另查 `/mcp`。

## 11. 离线包账本与重打配方

**重打配方**（pi 版本升级时，在有网 Linux 机器或 Windows 上 `npm install` 带平台参数）：

```sh
npm install --os=linux --cpu=x64 --force --ignore-scripts   # 产出完整 Linux x64 依赖树 → tar
# 另补：libc 平台子包（clipboard 系）单独 npm pack，不打进主树
# 另取：与目标机 node 同版的 node-vXX-headers.tar.gz（官方 nodejs.org 发布物）
```

打完后更新 `SHASUMS256.txt` 与 §3.1 的版本绑定行，并把新包放进同一目录。

**归宿现状**：pess-requirements `_tmp/orca-offline/`（含 `.zip` 副本，只含 3 个文件是残缺快照，以目录为准）。git 不追踪，机器清理会丢——稳定归宿待拍板（§12）。

## 12. 待补清单（缺口显式标注，勿当已回填）

1. **黄云侧一手操作命令序**（§3.4）：解包落位路径、`pi` 入口进 PATH 的接线、离线扩展 `pi install` 的实际命令——单内无一手记录，需该机实操回填。
2. **离线包稳定归宿**（§3.1/§11）：现居 git 忽略的 `_tmp/`，机器清理即丢；109M 二进制不进 dao 仓、GitHub release 对纯内网不可达——归宿（内网盘/NAS/挂账换机清单）待拍板。
3. **`@tintinweb/pi-subagents` 真实运行验证**（§6）：0.73.0 下 peerDeps 声明不满足（要求 ≥0.80.0），能加载未实测运行。
4. **本仓 config-sync pi settings 快照对账**（§5）：快照 `config-sync/common/pi/settings.json` 的 `defaultProvider` 是 `deepseek`，与 §4 models.json 的 `new-api` 不一致（快照 `lastChangelogVersion 0.84.1` 也高于本机 pi 0.73.0）——下行到新机后默认 provider 会指空。出本文边界未动，需单独对账（上行重导或改快照）。
