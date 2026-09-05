---
name: mirasim-over-reclaude-accidental
description: mirasim 能叠在 reclaude 上（本机实证），但那是进程继承环境的偶然结果，没有任何配置声明它——Linux 上不会自己复现
status: new
---

# mirasim + reclaude：物理上成立，但现在靠的是运气

2026-09-05。用户问「怎么做到 mirasim+reclaude，可以不把 mirasim 塞 reclaude，但要能积木组合」。

## 一、先否掉一个错方案（我提过，用户当场质疑，查证后撤回）

我一度提议：reclaude 是 `anthropic-messages` 网关，把它注册成 pi 的一个 provider，
让 mirasim 起 pi 会话 → pi 用 reclaude provider。

**这个方案违规**。官方 FAQ 原文：

> 当前支持 **Claude Code 官方 CLI** 和官方 Claude Code IDE 插件。
> 其他客户端（如 Cursor、Cline 等**兼容 Anthropic API 的工具**）暂不支持。

pi 正是这一类。实证旁证：拿 curl 打 reclaude 本地 daemon 回 **HTTP 400**（认客户端指纹）。
而 FAQ 另一条写着「**违规使用导致的损失不退**」。

**为什么 reclaude 这层不能被抽象掉**（官方原理页）：它分配的是真实 Anthropic 官方账号的
**OAuth 订阅额度**（不是 API key），所以 Pro/Max 资源才用得上、才不加价；账号被风控时自动换号。
代价是请求必须长得像真的 Claude Code。**抽成通用网关 = 把它存在的理由删掉。**

## 二、正确的分层：冲突只在一层

```
会话管理 / 互联 / 可观测   ← mirasim 要这层
        ↓
     claude 官方 CLI
        ↓
上游代理 / 额度 / 换号      ← reclaude 要这层（mirasim 也想要 → 唯一的冲突点）
        ↓
   Anthropic 官方 API
```

## 三、本机实证：它已经叠上了

1. mirasim 起的 claude 会话（`start_session`）死于
   `API Error: 400 当前绑定账号暂不可用，系统将自动处理…`
   这句话在 mirasim 全量代码里 **0 处**，在 `~/.reclaude/state.json` 的 `last_error` 里**一字不差**
   （`account_banned` 403）。mirasim 自己的额度错是英文 `Cloud quota is exhausted`。
2. 本会话（`CLAUDE_CODE_ENTRYPOINT=mirasim`）的
   `NODE_EXTRA_CA_CERTS = ~/.reclaude/ca.pem`——而**机器级**那个变量指的是
   `~/.mirasim/certs/gateway-ca.crt`。信任链在会话启动那一刻被换成了 reclaude 的。
3. 机器级 `NO_PROXY` 明确放行 `asia.route.reclaude.ai` / `.reclaude.ai`。

⟹ mirasim 站在 reclaude 上面，请求穿过 reclaude 出去。**架构成立，挡路的只有账号被封。**

## 四、但它是偶然的，不是声明的

`grep -rl reclaude ~/.mirasim/app` → **0 个文件**。整个 `~/.mirasim` 里的命中全是文本内容
（笔记、消息、搜索索引），**没有一处配置**。

所以它能跑是因为进程继承了环境——谁先起、谁的 env 传给谁。
**这种依赖在 Linux 上不会自己复现**，而且本机哪天换个启动顺序也会静默失效。

## 五、要做的三件（都在环境层，不碰 reclaude 也不改 mirasim）

1. Linux 装 reclaude + 设备授权 → daemon 起在 `127.0.0.1:57614`（正向代理）
   + `57615`（透明代理）。**已装 v1.3.0 在 `/home/orca/.local/bin/reclaude`，差一次授权。**
2. 起 mirasim claude 会话时**显式**带 `NODE_EXTRA_CA_CERTS=~/.reclaude/ca.pem`。
   Node/Electron 不读操作系统证书库（判例 `node-clients-ignore-os-cert-store`），
   不显式给就是死路，不是「点一次继续」。
3. 那个会话不能走 mirasim relay——relay 会把 `ANTHROPIC_BASE_URL` 指向 mirasim 云端代理，
   reclaude 根本看不到流量。

## 六、还没查清的一格

mirasim 有 `mode: 'local'`（对应 `cloud`）和模型级 `ownOnly` 标记，
错误码 `local_relay_only_model` / `local_no_account`——看起来就是第 5 节第 3 条那个开关。
**但没实测过切到 local 之后它到底还注不注入 `ANTHROPIC_BASE_URL`。**
这一格不需要能出流量就能验（看 env 即可），封号不妨碍。

## 七、顺带订正一条 memory

`mirasim-overrides-reclaude-upstream` 记的「三个模型别名被钉成一个值」——
Windows 上成立，但钉的是**显示名**不是 id：
`ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL_NAME` 三个全是 `Grok 4.6`，
而 `..._MODEL` 三个 id 各不相同（opus-5[1m] / sonnet-5[1m] / haiku-4-5）。
Linux 侧那次探针没打印 `_NAME` 变量，所以当时判「Linux 上不成立」，那个判断证据不足。
