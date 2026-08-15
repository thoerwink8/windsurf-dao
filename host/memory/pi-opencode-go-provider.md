---
name: pi-opencode-go-provider
description: pi 内置 opencode-go provider，key 必须落 opencode-go 键不是 opencode；gpt-5.6-luna 本区 403
metadata: 
  node_type: memory
  type: project
  originSessionId: 2168fe79-54c9-4d63-98dc-919a30ddef72
  modified: 2026-08-15T19:39:16.388Z
---

2026-08-16 接入：opencode Go 订阅（$10/月，20 模型）已配到本机 pi，凭据在 `~/.pi/agent/auth.json` 的 `opencode-go` 键。

**Why:** Zen 和 Go 是 pi 里两个独立 provider（`opencode` / `opencode-go`），共用 `OPENCODE_API_KEY` 环境变量但 auth.json 键不同——填错键会路由到 Zen，Go 额度用不上。

**How to apply:**
- 派工写法 `pi --provider opencode-go --model <id>`，可用模型跑 `pi --list-models opencode` 看。
- 实测通：glm-5.2（openai-completions）、minimax-m3（anthropic-messages）、grok-4.5 与 kimi-k3（responses）。
- **gpt-5.6-luna 在本区被上游 403 拒（"not available in your region"）**，不是 key 问题，别浪费时间查凭据；grok-4.5 走同一端点却正常，说明是模型级区域限制。
- provider 表和 auth.json 写法见 pi 自带文档的 `docs/providers.md`（pi 安装目录下，**不是本仓的 docs/**），别去网上找。
- **额度是账户级共享硬顶**（美元额度制，按各模型单价折算），撞顶 pi 当场报错、工人挂掉；并发派多个工人前先掂量。自动降级见 issue #520。
- 已接进派工路由（PR #519）：ds-flash/pro 主通道换成 Go，模型条目仍是单一 id，见 [[model-channel-is-not-identity]]。
- `deepseek-v4-flash-free` 属 Zen 侧且已被服务端禁用（`Model is disabled`），别再试。

相关：[[pi-universal-harness]]、[[claude-workers-use-opus]]
