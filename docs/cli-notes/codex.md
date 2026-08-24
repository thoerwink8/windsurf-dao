# CLI 踩坑教学：Codex（`codex` CLI，模型 gpt-5.6-sol，审官默认）

> 每条都是实测踩出来的，不是推理。改代码/派工前先读本页 + `docs/model-routing.toml [providers.gpt]`。

## 一句话特性

Codex 是 **agent 型**（`start = "agent"`）：必须走 `worker-start --agent codex`，由 orca 官方协议发送任务书（自动提交）。**不要 `terminal create --command` 再粘贴——Codex 把粘贴显示成 `[Pasted Content]` 永不发送**（#680 实证，2026-08-25 再踩）。

## 正确起法（#680 拍板）

```
worker-start --agent codex --model gpt-5.6-sol   # orca 管就绪 + 协议发送，自动提交
```

## 踩过的坑

### 坑 1：terminal create --command 再粘贴 → `[Pasted Content]` 永不发送

- **现象**：codex 屏面显示 `[Pasted Content 4704 chars]` 停在输入框，审官永远不开始干活；dispatch 12 秒后 `agent_prompt_stalled`。
- **原因**：command 型粘贴只把任务书"贴进输入框"，codex 不会自动 enter。orca 的 `--agent codex` 才会协议发送（自动提交）。
- **正解**：必须走 agent 型（`launchAgentInWorktree` 对 start=agent 返回 deferred，worker-start 用 `--agent codex`）。实测 agent 型由 orca 管就绪，不需要手动 wait tui-idle。
- **识别**：屏面见 `[Pasted Content N chars]` = 粘贴没发送，不是开工证据（#661）。

### 坑 2：冷启动慢（MCP 初始化 ~84s）

- **现象**：`probe_wait_ms = 120000`（2026-08-16 实测：第一项写探针 84s，MCP 还在初始化）。
- **正解**：agent 型由 orca 管就绪；送字窗口要 ≥ probe_wait_ms（dispatch_input 窗口不够会 stalled，quick-fix 放宽到 180s）。

### 坑 3：`-a never` 单用比不给还严

- **现象**：手打 `codex -a never` 把 gh/node/组合命令全拦死；orca 原生 `--agent codex` 三条全过。
- **原因**：`-a never` 的真实语义 = 不在白名单就直接拒（因为不能问）。approval 与 sandbox 是正交两维。
- **正解**：派工一律 `--agent codex`，不要手动拼 codex 参数。

## 判活

- 开工证明：worker-read transcript（agent 型有官方 hook 上报）；屏面见 `[Pasted Content]` = 未提交，继续等或 fail-close。
- 完工：worker-done 发 comment + 开 PR。

## 相关

- 启动模板唯一真源：`docs/model-routing.toml [providers.gpt]`
- #680：Codex 粘贴不发送实证
- #682：微通道 Codex 冷启动放宽窗口
