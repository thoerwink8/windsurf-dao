# 审官全灭：裸 `pi` 落到一个没有凭据的 provider

2026-09-05。起点是「九张 PR 的当前 HEAD 一条审官判定都没有」，
终点是 pi 自己的 `settings.json` 里一个指向空气的默认值。

## 症状（从外往里）

- 10 张 MERGEABLE 的 PR，**`APPROVED` review 数全是 0**。其中 3 张从开单到现在审官一次没起过
  （静默 2h48m / 4h21m / 8h12m），另外 6 张是返工交卷后复审没起来，红票停在旧 commit、
  新 HEAD 无人看，静默 5.5～17.5 小时。
- 服务器 59 个终端里 **58 个屏面 5 分钟一字未动**，而 `orphaned` 全是 `false`、
  `status` 全是 `running`。
- 看门狗 17:15/17:18 刚把 #947/#952 的审官从 luna 换成 sol——**替身几秒内同样死**。
  换人链路本身是通的（当天早些时候刚修好），换过去的人一样活不了。

## 真因

pi 的 `~/.pi/agent/settings.json` 写着 `defaultProvider: "mirasim"`，
而同目录 `auth.json` 里**根本没有 mirasim 这一条**——有
`deepseek / opencode-go / xai / gw / gw-dspool / gw-windsurf / gw-cmdcode / gw-opencode / gw-sub / gw-cursor / ag`，
唯独没有它。

于是**不带模型起的 pi**（`orca ... --agent pi`、automations 的 `agentId: pi`）
每次模型调用回 `401 invalid x-api-key`，agent 当场死在屏上——
**而终端仍然是 `status: running`、`orphaned: false`**。

排掉的两个猜测（都查了才排掉）：

- 「orca daemon 喂陈旧环境块」（memory `orca-daemon-stale-env`）→ 证伪：
  `ANTHROPIC_BASE_URL` / `AUTH_TOKEN` 在 pi 进程的 environ 里都在。
- 「网关 key 过期」→ 证伪：拿 env 里的凭据打**真正消耗额度**的 `/v1/messages`
  （memory `verify-credential-on-real-endpoint`），网关回
  `503 No available channel for model ... under group windsurf`，不是 401。
  **凭据是好的，是 pi 根本没走网关。**

判据很干净：干活成功的工人屏面底部是 `grok-4.6`（显式带了模型），
死掉的那些屏面底部是 `claude-opus-4-8`（没带模型，落默认）。
顺带——那个默认值还撞了 memory `reviewer-no-claude-use-codex`（审官位 Claude 禁用）。

## 处置

`defaultProvider: mirasim → gw`（`defaultModel` 本来就是 `grok-4.6`，
合起来正是 `docs/model-routing.json` 里写码工人那条通道）。
原文件备份在 `~/.pi/agent/settings.json.bak-20260905`。

改之前先核了「新值在 auth.json 里有凭据」，不是换个名字了事——
**一个默认值指向没有凭据的 provider，这本身就是坏配置**，换成任何一个活的都严格更好。

验活：起一个 pi 终端发一句话，回话正常、无 401。

## 走错的一条路，记下来免得后人再走

我一度认定真因在 `scripts/lib/dispatch/launch.mjs` 的 `agentStartSpec`：

```js
const model = (id === 'cursor' || id === 'codex') ? cliModel : null;
```

看起来像个「白名单漏了 pi」的典型 bug，我改成黑名单、配了闸、跑了突变测试，全绿。
**然后才去读 orca 的 help**：

```
--model supports Claude, Codex, and Cursor opaque provider model ids
```

也就是说 orca 的 `worker-start --model` **本来就只认这三家**，pi 传过去会被拒。
那个白名单不是 bug，它精确地照着 orca 的契约写的。改动已撤回。

教训不是「先读文档」这种废话——是**测试全绿证明不了前提对**。
那五条闸测的是「函数是否按我以为的契约返回」，而错的正是我以为的契约。
判据性实验应该是「orca 到底收不收」，一条 `--help` 就能一锤定音，
而我先写了代码、写了测试、跑了突变，做完这一整套才去问最该先问的那一句。
相关 memory：`verify-credential-on-real-endpoint`（同一形状：拿便宜的代理指标当证据）。

## 尚未处理，另开

- **pi 那条审官降级腿仍然拿不到指定模型**。按 memory `reviewer-fallback-luna-via-pi`，
  审官主位走 codex（orca 认 `--model`，没问题），pqapi 429 时降级到
  `pi gw-windsurf/gpt-5.6-luna`——而 pi 走 `--agent` 起、orca 又不给 pi 传模型，
  这条腿只能落默认（现在是 `gw/grok-4.6`）。至少是活的，且换错了座位会被
  `assertReviewerSeat` 当场判出来；但「降级到指定模型」这件事目前做不到。
  出路只有两条（都要拍板）：让 pi 走 `--command`（但 #815 第 6 洞明写审官不许逼成 command），
  或给每个审官模型在 orca 侧注册一个独立 agent id。
- **`_flow/queue/review-pending/` 一个票都没有**，而四个工人的交卷屏面都写着
  「票已写入 review-pending/894.json（899/905 同）等帅 drain」。主树和各工人树都 `find` 过，
  两边都没有。看代码，`buildReviewPendingTicket` 要求 `reviewer` 非空——
  而这几张恰恰是「署名 issue 上没有 `reviewer/` 标签，不猜审官」。
  **深度限制的兜底队列，要求的正是撞上深度限制时最可能没有的那个值。**
- **`land` automation 在漏会话**：`reuseSession: false` + 每小时一跑，自 9/3 16:59 起
  它的 pi 腿一次没跑成（全 401），每次泄一个 pi 会话，累计 11 个（已清）。
  401 的根因随本次修复消除，泄漏本身（`reuseSession: false`）没动。
  另外 `orca automations create` **没有 `--model` 参数**，automations 只能指定 agent id——
  所以 automations 里的 pi 永远是裸 pi，它的模型只能由 pi 自己的默认值决定。

## 这件事真正的教训

**`droppedFlags` 早就算出来了，只是没有人读。**

`applyOrcaAgentCmds` 会把「路由表里的命令」和「orca 自己那个 agent 的命令」逐个 flag 比对，
把 orca 会丢掉的 flag 记进 `launch.droppedFlags`。全仓 `grep droppedFlags`：
**除了产生它的那个文件，没有任何一处读它。**

「orca 把 `--model` 丢了」这个事实，机器早就算出来并放在手边，
而没有任何一条路会让它变成一句话。这比「没想到」严重——是**想到了、算出来了、然后扔掉**。
丢 flag 有时是对的（orca 侧配置就该赢），所以不能一律判红；
但至少要能说出「这一次丢了什么」。另开。

---

## 订正（同日，用户当面纠正两次）

上面把根因写成「默认值指着一条自己已经停用的腿」，**不够准，且把因果说反了**。

**① mirasim 腿没有全灭，它活着。** 服务器上 `mirasim-server.service` 从 2026-09-04 14:36 跑到现在，
`127.0.0.1:4316` HTTP 200，当天 18:24 还有真的 relay 设备会话接进来。
路由表里那条腿标「停用」，原因原文是**「卡 A 五动词已真烧验证，等 #880 卡 B 派工接线」**——
是「验过了、还没接上」，不是「坏了」。

**② pi 根本够不着 mirasim，这是结构性的，不是缺凭据。**
用户原话：「mirasim 腿必须用 mirasim 的载体才行，**不能反代**，这是官方规定」。
pi 的 `pi-gateway.json` 里 7 个 provider 全是 `gw-*` 网关腿（各自一个 keyFile），
**没有也不可能有 mirasim**——往 auth.json 里补一条也不会让它通。

**③ 所以那个默认值不是「配错了」，是为迁移提前设的。** 而它造成的后果是：
**为了给 mirasim 接线而设的值，把做接线的人自己憋死了**——
卡 B（#884）等着返工，而返工的工人起不来，因为工人是裸 pi、落 mirasim、401。一个干净的自锁。

**④ 方向：除 reclaude 外所有腿走 mirasim 的 Linux 载体，orca 验收后退役。**
落点是 issue #880 的标题「项·mirasim运行时重写：执行体一步到位换 mirasim，orca 验收后退役（§72）」，
**进度表在那个已关闭 issue 的正文里**，卡 A–F 逐项勾选，是这条线唯一的实时状态面。
`docs/decisions/` 下没有对应文档——我先前只 grep 了那个目录，据此答过「没有任何拍板说 orca 要退役」，
是错的。

**所以本次把 `defaultProvider` 改成 `gw` 是止血，不是方向**：它让工人在**要退役的那条路**上重新活过来，
好把迁移剩下的卡推完。等卡 E 切流量，pi 这条路整个不再用。

关键路径也随之明确：**卡 C（#886 审官流 mirasim 化）是钥匙**——
卡 B 的合并明写「orca 审官起不来，改由卡 C 的 mirasim 审官路径审」，卡 C 不通，整条链都卡着。
而卡 C 自己也没人审，存在先有鸡还是先有蛋；破局点正是本次修复：401 修掉后旧 orca 审官路径
**可能**已经能用，能用就先用它审出卡 C。（正在验，别当结论。）
