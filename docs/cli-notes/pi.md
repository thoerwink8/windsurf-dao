# CLI 踩坑教学：pi / opencode-go（模型 deepseek-v4-flash / pro，写码通道）

> 提炼自 `docs/model-routing.toml [providers.opencode-go]` + `[providers.deepseek]`。

## 一句话特性

agent 型（`start = "agent"`），日常通道走 **opencode-go**（`pi --model opencode-go/deepseek-v4-flash`）。写码顺位 2（顺位 1 = devin）。

## 坑

- **额度顶 402 不许自切直连**：og 撞顶报 402，必须报用户，由用户决定「等恢复 / 充值 / 换模型 / 停单 / 手动切直连」。AI 自行切换的代价样本：#558 从 ¥0.05 级跃到 $10 级。`[[routes]]` fallback 只在选型时主选被门闩剔除才生效，救不了运行时额度耗尽。
- **Zen 与 Go 是两个独立 provider**：共用 OPENCODE_API_KEY，键填成 `opencode` 会路由到 Zen，Go 额度用不上。
- **ds-flash/pro 是同一模型两条通道**：模型条目只有一条，战绩记一处。
- **直连（-direct 后缀）只在用户拍板时启用**：`deepseek-v4-flash-direct` / `deepseek-v4-pro-direct`，防 pi 静默 fallback 换 provider。

## 正确起法

`pi --model {model}`（launch 模板），agent 型走 `worker-start --agent pi`。
