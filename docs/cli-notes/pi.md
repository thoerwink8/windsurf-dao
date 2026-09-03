# CLI 踩坑教学：pi / gw（#822 起非 GPT 工人默认宿主）

> 提炼自 `docs/model-routing.toml [providers.gw]`。选型只认 `docs/model-routing.json`。

## 一句话特性

agent 型（`start = "agent"`）。#822：除 GPT（Codex）外一律本 CLI。cli_model 带组前缀：`gw/grok-4.6`、`gw-dspool/deepseek-v4-flash`、`gw-windsurf/glm-5-2`、`gw-sub/kimi-k3-high`。写码顺位 1 仍是 grok-4.6，只是通道从 Grok Build CLI 改成 pi gw。

## 坑

- **额度顶不许自切直连**：撞顶必须报用户（等恢复 / 充值 / 换模型 / 停单）。AI 自行切通道的代价样本：#558。#822 起日常通道是网关池，og / 直连不在选型里。
- **ds-flash/pro 是同一模型两条通道**：模型条目只有一条，战绩记一处。
- **无头 Linux 上 `--agent pi` 起在另一张终端**（#802 帅 2026-09-03 订正）：agent 真起来了（`terminal list` 的 `agentIdentity=pi`，标题 `π - …`），但记账 handle 指向 worktree 空壳，任务书打进 bash（`读: command not found`）。dispatch 按 `agentIdentity` 校准 handle 再注入。title 不可靠（Linux bash 标题是 `user@host:path`）。不要改 toml `start=command`。

## 正确起法

`pi --model {cli_model}`（launch 模板，cli_model 含 `gw` / `gw-dspool` / `gw-windsurf` / `gw-sub` 前缀），agent 型走 `worker-start --agent pi`；无头 Linux 若落成裸 shell，派工自动回退 `--command`。
