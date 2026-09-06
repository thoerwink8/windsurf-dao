---
name: mirasim-vs-reclaude-linux
description: Linux 侧实测——mirasim 与 reclaude 都要当代理，结构互斥；「reclaude 是例外」这条不是没试过，是试不了
status: done
---

# mirasim × reclaude：Linux 侧同样冲突，而且比「env 打架」更硬

2026-09-05。用户要求在 Linux 侧复测本机那条判例（memory `mirasim-overrides-reclaude-upstream`）。

处置：本条即结论，无需开单——「reclaude 走 mirasim 之外」这条例外维持原状，
它是结构决定的，不是配置没调对。

## 一、mirasim 在 Linux 上确实改写 upstream（实测）

起一个 mirasim claude 会话，让它打印自己的环境：

```
ANTHROPIC_BASE_URL     = http://127.0.0.1:36307/K506    ← mirasim 自己的本地代理
ANTHROPIC_AUTH_TOKEN   = <mirasim 自己的>
ANTHROPIC_API_KEY      =                                 ← 被清空
ANTHROPIC_MODEL        = claude-5-fable-medium
ANTHROPIC_SMALL_FAST_MODEL = claude-opus-5[1m]
CLAUDE_CODE_ENTRYPOINT = mirasim
CLAUDE_CODE_EXECPATH   = /usr/lib/node_modules/@an…      ← 指向它自己那份 claude
```

**订正本机判例的一半**：本机记的是「把三个模型别名钉成一个值」。Linux 上
`ANTHROPIC_MODEL` 与 `ANTHROPIC_SMALL_FAST_MODEL` 是两个不同的值，没有钉成同一个。
改写 BASE_URL / TOKEN 这一半成立，钉别名那一半在 Linux 上不成立。

## 二、真正的阻塞不是 env，是没有这个 agent 类型

mirasim server.cjs（0.0.282）里 agent 类型是写死的 8 种：

```
antigravity  claude  codex  dsh  gui  kimi  qwen  zcode
```

`reclaude` 在整个 server.cjs 里出现 **0 次**。运行时 `agentRoutes` 同样只有
`claude / codex / gui / dsh / kimi`。所以「让 mirasim 起 reclaude」当前没有入口。

## 三、为什么不可能靠配置绕过

`claudeBin` 是 server.cjs 里唯一看似能指到 reclaude 的钩子，但它的用法是：

```
<claudeBin> auth login --claudeai
```

即 mirasim 拿它去**收账号的 OAuth token 进自己的池**，收完之后所有会话仍然走
mirasim 自己的代理。它不是运行时 wrapper。

两边的定位因此正面撞车：

| | mirasim | reclaude |
|---|---|---|
| 自我定位 | 我是代理，把账号 token 交给我 | 我是代理，凭据挂在我这条链上 |
| 对 claude 子进程 | 注入自己的 BASE_URL/TOKEN，清空 API_KEY | 同样要注入自己的 |

**两个都要当代理，谁也不肯当上游。**

## 四、没做完的一格（说清边界）

`reclaude` v1.3.0 已装在服务器 `/home/orca/.local/bin/reclaude`，PATH 已通。
但它启动即走设备授权（浏览器流），用户当时无可用设备，授权未完成。

所以这一格没有实测：**在 mirasim 已注入 env 的会话里跑 reclaude，reclaude 能不能
盖过那组变量**。那是比「mirasim 起 reclaude」更弱的用法，不影响上面的结论
（上面的结论只依赖 agent 白名单和 claudeBin 用法，两者都已查实）。

补这一格只需一次设备授权，路已铺好。
