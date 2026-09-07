---
name: mirasim-over-reclaude
description: mirasim 叠在 reclaude 上是 mirasim 的一等公民设置（agentLaunch.claude.command），本机已实证跑通；Linux 只差一次设备授权 + 写同一个键
status: done
---

# mirasim + reclaude：怎么积木组合（本机已跑通，可复制到 Linux）

2026-09-05。用户问「不把 mirasim 塞进 reclaude，但要能积木组合，有方案吗」。
结论：**有，而且本机已经在跑，是 mirasim 自带的设置，不需要造任何东西。**

## 一句话记法

**mirasim 站在 reclaude 上面**：mirasim 管会话/互联/可观测，reclaude 管上游/额度/换号，
中间的 claude 官方 CLI 一个字节都不用改。

## 开关在哪（可复制的那一行）

界面：**设置 → 智能体 → Claude Code → 启动方式 → 命令 = `reclaude`**

落盘：`~/.mirasim/setting.json`

```json
"agentLaunch": { "claude": { "command": "reclaude" } }
```

界面上那段说明文字正好点明了代价，抄在这里当判据：

> 替换此智能体启动时运行的程序（绝对路径，或 PATH 上的命令名），对此后的启动生效；
> 参数仅追加到我们的终端形态。**若替换后的程序自行改写模型地址，mirasim 的路由与用量
> 统计会被绕过，用量显示为未知。**

reclaude 正是「自行改写模型地址」的那种程序。**所以这条路要接受一个已知代价：
这些会话在 mirasim 的用量统计里显示为未知**——会话追踪/互联/录制都还在，只有用量数字没有。
这不是 bug，是官方写明的取舍。

## 分层图：冲突只在一层

```
会话管理 / 互联 / 可观测        ← mirasim 要这层
        ↓   agentLaunch 把启动程序换成 reclaude
     claude 官方 CLI            ← 不改动
        ↓
上游代理 / 额度 / 自动换号       ← reclaude 要这层（原本是唯一冲突点）
        ↓
   Anthropic 官方 API
```

## 本机实证（三条硬证据）

1. mirasim 起的 claude 会话死于
   `API Error: 400 当前绑定账号暂不可用，系统将自动处理…`
   这句话在 mirasim 全量代码里 **0 处**，在 `~/.reclaude/state.json` 的 `last_error` 里
   **一字不差**（`account_banned` 403）。mirasim 自己的额度错是英文 `Cloud quota is exhausted`。
   ⟹ 请求确实穿过 reclaude 出去了。
2. 本会话（`CLAUDE_CODE_ENTRYPOINT=mirasim`）的 `NODE_EXTRA_CA_CERTS = ~/.reclaude/ca.pem`，
   而**机器级**那个变量指的是 `~/.mirasim/certs/gateway-ca.crt`——启动时换成了 reclaude 的信任链。
3. 机器级 `NO_PROXY` 放行 `asia.route.reclaude.ai` / `.reclaude.ai`。

唯一挡路的是**账号被封**（`healthy: false`），不是架构。

## Linux 侧要做的两件

服务器 `~/.mirasim/setting.json` 现在**没有 `agentLaunch` 键**（顶层只有 12 个键，本机有 34 个）。

1. **reclaude 设备授权**。已装 v1.3.0 在 `/home/orca/.local/bin/reclaude`，PATH 已通，
   `reclaude version` 正常；启动即走浏览器设备流，缺一次点击。
2. 授权后写入同一个键：`"agentLaunch": {"claude": {"command": "reclaude"}}`。
   PATH 上有 `reclaude` 就够，不必写绝对路径。

## 走过的两条弯路（免得后人再走）

**弯路一：把 reclaude 抽象成网关，注册成 pi 的 provider。**
官方 FAQ 明确否掉：

> 当前支持 **Claude Code 官方 CLI** 和官方 Claude Code IDE 插件。
> 其他客户端（如 Cursor、Cline 等**兼容 Anthropic API 的工具**）暂不支持。

pi 正是这一类。实证旁证：curl 打 reclaude 本地 daemon 回 **HTTP 400**（认客户端指纹）。
FAQ 另一条：「**违规使用导致的损失不退**」。

**为什么 reclaude 这层删不得**（官方原理页）：它分配真实 Anthropic 官方账号的
**OAuth 订阅额度**（不是 API key），所以 Pro/Max 资源用得上、不加价；账号被风控自动换号。
代价是请求必须长得像真的 Claude Code。**抽成通用网关 = 把它存在的理由删掉。**
（这条是用户当场质疑我提的方案时点破的，我查证后撤回。）

**弯路二：判成「偶然的，没有配置声明」。**
我 grep 过 `~/.mirasim/app`（代码目录）得 0 命中，就下了「靠进程继承环境」的结论。
**错在扫描面没盖到 `setting.json`。** 代码里没有 ≠ 配置里没有——
查一个「有没有配过」的问题，要扫配置面，不是代码面。

## 顺带订正一条 memory

`mirasim-overrides-reclaude-upstream` 记的「三个模型别名被钉成一个值」——
钉的是**显示名**不是 id：`ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL_NAME` 三个全是
`Grok 4.6`，而 `..._MODEL` 三个 id 各不相同（opus-5[1m] / sonnet-5[1m] / haiku-4-5）。
Linux 侧那次探针没打印 `_NAME` 变量，据此判「Linux 上不成立」证据不足。

## 附：别拿两台机器的 setting.json 做整体对齐

服务器 `setting.json` 顶层 12 个键，本机 34 个——**差的 23 个里只有 `agentLaunch` 是真缺口**，
其余大多是「服务器本来就不该有」。照 diff 一把梭会坏三类东西：

| 类 | 键 | 为什么不能搬 |
|---|---|---|
| 本机绝对路径 | `browserIdentitySourceDir`（Windows Chrome）、`guiBrowserBinary`（Edge） | 服务器上不存在 |
| 本机网络 | `networkProxy` = `http://127.0.0.1:7890` | 那是本机的 clash，服务器没有，写了全断 |
| **profile 引用** | `piModel` / `dshModel` / `guiModel` / `piGuiModel`，值形如 `profile:<uuid>` | **uuid 指的是本机 `models` 表里的条目**；服务器没有那张表，搬过去指向空气 |
| 无显示面 | `guiAgentEnabled` / `guiBrowserMode` / `antigravity*` | 服务器无 DISPLAY（靠 orca 自起 Xvfb） |

判据：服务器上 mirasim 今天跑完 12 个 codex 审官会话，**默认值本来就够用**。
「缺了 22 个键」是错觉，不是配漏了——先查它是不是本来就不该有。

## 附：上线顺序不能反

**先授权，后写键。** 反过来 = 服务器每个 mirasim claude 会话都去跑一个未登录的 reclaude，
启动即走设备授权流、当场全死，而卡面上仍显示 running（今天已经被这种「死了看起来像活着」
咬过一次，见 `2026-09-05-审官全灭-裸pi落错provider.md`）。
