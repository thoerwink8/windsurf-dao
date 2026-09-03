# CLI 踩坑教学：pi / opencode-go（模型 deepseek-v4-flash / pro，写码通道）

> 提炼自 `docs/model-routing.toml [providers.gw]` + `[providers.opencode-go]` + `[providers.deepseek]`。

## 一句话特性

agent 型（`start = "agent"`），ds-flash 写码日常通道走 **gw-dspool**（`pi --model gw-dspool/deepseek-v4-flash`，2026-09-03 拍板）。`opencode-go` 是顺位 2（服务器 403 RegionError）。写码模型顺位 3（顺位 1 = grok-4.6，#817）。

## 坑

- **额度顶 402 不许自切直连**：og 撞顶报 402，必须报用户，由用户决定「等恢复 / 充值 / 换模型 / 停单 / 手动切直连」。AI 自行切换的代价样本：#558 从 ¥0.05 级跃到 $10 级。`[[routes]]` fallback 只在选型时主选被门闩剔除才生效，救不了运行时额度耗尽。
- **Zen 与 Go 是两个独立 provider**：共用 OPENCODE_API_KEY，键填成 `opencode` 会路由到 Zen，Go 额度用不上。
- **ds-flash/pro 是同一模型两条通道**：模型条目只有一条，战绩记一处。
- **直连（-direct 后缀）只在用户拍板时启用**：`deepseek-v4-flash-direct` / `deepseek-v4-pro-direct`，防 pi 静默 fallback 换 provider。
- **无头 Linux 上 `--agent pi` 起在另一张终端**（#802 帅 2026-09-03 订正）：agent 真起来了（`terminal list` 的 `agentIdentity=pi`，标题 `π - …`），但记账 handle 指向 worktree 空壳，任务书打进 bash（`读: command not found`）。dispatch 按 `agentIdentity` 校准 handle 再注入。title 不可靠（Linux bash 标题是 `user@host:path`）。不要改 toml `start=command`。

## 正确起法

`pi --model {model}`（launch 模板），agent 型走 `worker-start --agent pi`；无头 Linux 若落成裸 shell，派工自动回退 `--command`。
