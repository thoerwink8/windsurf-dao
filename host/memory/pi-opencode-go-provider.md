---
name: pi-opencode-go-provider
description: pi 内置 opencode-go provider，key 必须落 opencode-go 键不是 opencode；gpt-5.6-luna 本区 403
metadata: 
  node_type: memory
  type: project
  originSessionId: 2168fe79-54c9-4d63-98dc-919a30ddef72
  modified: 2026-08-15T19:02:30.291Z
---

2026-08-16 接入：opencode Go 订阅（$10/月，20 模型）已配到本机 pi，凭据在 `~/.pi/agent/auth.json` 的 `opencode-go` 键。

**Why:** Zen 和 Go 是 pi 里两个独立 provider（`opencode` / `opencode-go`），共用 `OPENCODE_API_KEY` 环境变量但 auth.json 键不同——填错键会路由到 Zen，Go 额度用不上。

**How to apply:**
- 派工写法 `pi --provider opencode-go --model <id>`，可用模型跑 `pi --list-models opencode` 看。
- 实测通：glm-5.2（openai-completions）、minimax-m3（anthropic-messages）、grok-4.5 与 kimi-k3（responses）。
- **gpt-5.6-luna 在本区被上游 403 拒（"not available in your region"）**，不是 key 问题，别浪费时间查凭据；grok-4.5 走同一端点却正常，说明是模型级区域限制。
- provider 表和 auth.json 写法见本机 pi 文档 `docs/providers.md`，别去网上找。

相关：[[pi-universal-harness]]、[[claude-workers-use-opus]]
