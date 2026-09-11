## 目标

健康表 3/15 红：`direct:codex@pqapi/responses`、`leg:pqapi-free`、`leg:mirasim-bridge`。按 #1184 拍板：验证三条通道的实际请求，修故障或纠正错误探测；可用才启用，不清空错误记录假装恢复。

署名 issue #1184，关单交给 `scripts/close-issues.mjs`。

## 验收标准

1. 三条通道都有「实际请求」证据（HTTP 码 / 是否收到真内容 / 用的是哪条请求形状），不是只读健康表。
2. 探针假红（请求形状与 agent 不一致）必须改探针；上游真挂必须保持红，不手改健康表/熔断表装绿。
3. 可用才启用：真通的下一轮探针自然变绿；不通的保持红，不重新打开熔断。
4. 相关测试 + `node scripts/dao-check.mjs` 绿；`node scripts/handoff-check.mjs` 交卷档过。
5. PR 正文有「机制判定」：这错在制度生效前还会再犯吗。

## 进展

### 实际请求（2026-09-11，不落 key）

| 通道 | 请求 | 结果 | 判定 |
|---|---|---|---|
| `direct:codex@pqapi/responses` | 周期探针旧体：裸字符串 `input: "reply with the single word ok"` → 本机桥 `127.0.0.1:4317/v1/responses` | **500** `field messages is required`（851ms，无内容） | **探针假红** |
| 同上 | 结构化 `input: [{type:message, content:[{type:input_text}]}]` 同一口 | **200 + 真内容**（4065ms） | 通道可用 |
| 同上 | 修完后 `gw-remote-probe.mjs --only` 写临时健康表（`GW_HEALTH_FILE` 不碰 `~/.dao`） | **green 200 / 2156ms** | 周期探针跟上 |
| `leg:pqapi-free` | 官方 `api.pqapi.shop/v1/models` | 200，清单仍列 luna | 账号活着 |
| 同上 | 官方 chat `gpt-5.6-luna` | **503** `No available channel for model gpt-5.6-luna (distributor)` | **上游真挂** |
| 同上 | 网关 `pqapi` 组同一模型 | 同一 503 | HK 腿探针没错 |
| `leg:mirasim-bridge` | 本机 `127.0.0.1:4315/v1/models` | 200 | 进程在 |
| 同上 | 本机 chat `gpt-5.6-luna` | **502** `没找到 Mirasim 会话口`（要有在跑会话才有令牌） | **现在不可用** |
| 对照 | 网关 gptpool 别名 `gpt-5.6` | 200 + 真内容（2429ms，落到 luna） | 池靠 Windsurf 仍通 |

相邻（不在本单三 key 里、不扩修）：`leg:pqapi-sol` 官方 `/v1/responses` 结构化也是 200 空内容 + `upstream_accounts_unavailable`，上游真挂。

生产 `~/.dao/provider-health.json` / `provider-breaker.json` **未手改**。direct 仍红 strikes=167；两条腿仍红。熔断 open 等冷却后 half-open，绿只在 half-open 合闸。

### 代码

- 抽出 `codexResponsesProbeBody`（`scripts/lib/provider-probe.mjs`），派前探针与周期探针共用。
- `scripts/gw-remote-probe.mjs` 不再手写裸字符串 input。
- 测试锁：helper 形状 + `planProbe(gpt).body.input` 是数组 + 周期探针源码必须 import helper、不得再写 `input: "reply …"`。

## 机制判定

会再犯。2026-09-10 修了派前探针 `provider-probe.mjs` 的裸字符串，周期探针 `gw-remote-probe.mjs` 是另一份请求体，没一起改，健康表继续记 500（本轮 167 次）。两条腿是上游真挂，探针没错。

机制：responses 请求体只许有这一份 helper；测试锁周期探针必须用它。不手改健康表/熔断表装绿。
