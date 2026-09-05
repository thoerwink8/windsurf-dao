# Pi/Grok 流式收尾协议观察

证据来自用户截图与三仓路由代码：Pi 会话显示 `Pi Grok 4.6 · high`，随后报 `Anthropic stream ended before message_stop`。

当前服务器设计里，`ai-gateway-stack/deploy/pi-gateway.ts` 对 provider id 为 `gw` 的 Grok 组应注册 `openai-completions`，base URL 为网关 `/v1`，由 Grok OpenAI 渠道（shim `:3404`）把 `reasoning_effort` 传给 xAI。其它 provider 仍走 `anthropic-messages`。`ai-gateway-stack/docs/DECISIONS.md` §33 已记录 Anthropic 转换流缺 `content_block_stop/message_delta/message_stop` 的历史故障，§60 又记录 Pi/Grok 为档位改走 OpenAI 口。

因此目前的机制风险是：模型名和界面档位显示正确，但实际请求可能落到旧 `pi-gateway.json`、旧 provider 注册、Anthropic/type14 fallback 或错误渠道；客户端只看到 `message_stop` 缺失，无法显示真实落线路径。服务器端现有探活主要验证 HTTP/非空内容，不能证明 Pi 真实 agent 收到了完整的 Anthropic/OpenAI 收尾事件。

建议帅位把它作为工具箱问题核查：

1. 在服务器上核对实际 Pi 注册的 provider/api/baseUrl，以及最近请求的 `logs.other` 路由字段，确认 Grok 走 `gw` + `openai-completions` + `:3404`，不是旧 `anthropic-messages` 或 fallback。
2. 增加真实 Pi agent 端到端 smoke：固定带工具描述和 `--thinking high`，要求流正常结束并记录 finish reason；不能只测裸 HTTP 200/非空 delta。
3. 当出现 `stream ended before message_stop` 时，收件箱记录实际 channel、协议、上游和 retry/fallback 结果；若路由身份无法回读，标 `route_unconfirmed`，不要按“模型正常”收口。

当前结论：服务器 Pi **具备同类风险，截图尚不足以证明服务器正在复现**；需要按上述真实 agent 路径核验。


---

## 处置（帅位 2026-09-05 核查）

**① 服务器没在复现。** `/home/orca/.pi/agent/sessions` 与家目录下近 3 天所有 json/log
全盘搜 `message_stop`，命中 **0**。截图来自别的机器，不是服务器这条链。

**② 建议 1（核对 provider/api/baseUrl）当前查不了，因为那个字段不存在。**
服务器实际的 `~/.pi/agent/pi-gateway.json` 里 `gw` 这条只有三个字段：

    { "id": "gw", "name": "网关·grok", "keyFile": "/home/orca/.mirasim/keys/grok.key" }

没有 `api`，也没有 `baseUrl`——协议与落点由 pi 自己按 provider id 解析，不在这份文件里。
所以「旧 pi-gateway.json 落到 anthropic-messages」这个具体机制，在服务器这份配置上
**既证不了也证伪不了**，不能按它去改。要查落线只能查网关侧 `logs.other`，
而 `ai-gateway-stack` 没有 clone 到服务器（本条另见落地清单第 4 条）。

**③ 建议 2 成立，是真缺口，已立单。** `scripts/lib/provider-probe.mjs` 文件头写得很直白：
「2xx 且至少收到一段非空 content/reasoning/text = green」。也就是说**收到第一个 delta 就判绿**，
流有没有正常收尾根本不看。`stream ended before message_stop` 这类故障对现有探活完全隐形——
这正是本仓「区分『扫完 0 条』和『没扫到』」那条规矩的同一种病：把「开了个头」当成「跑完了」。

处置：#953
