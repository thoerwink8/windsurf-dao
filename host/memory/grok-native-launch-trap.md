---
name: grok-native-launch-trap
description: orca worker-start --agent grok 裸起必卡死（无代理前缀+模型落默认 4.5），正确姿势是带前缀手动起终端再 worker-start --terminal 收口
metadata: 
  node_type: memory
  type: reference
  originSessionId: 6d32fb06-c548-4268-83cc-fc1c15654662
  modified: 2026-08-15T05:20:33.167Z
---

2026-08-15 实测：`orca orchestration worker-start --agent grok` 用 Orca 内置启动器裸起 grok——不带 `HTTPS_PROXY=http://127.0.0.1:7890`（凭据端点 DNS 污染，连不上，凭据过期时"Waiting for response"永久卡死且屏面计时器动画会骗过整屏哈希停摆判据），模型也落回默认 grok-4.5 而非选型册的 grok-4.6。

正确姿势：`orca terminal create --command "$env:HTTPS_PROXY='http://127.0.0.1:7890'; grok -m grok-4.6"` → Esc 关横幅（见 [[grok-tui-optin-banner-trap]]，横幅叠屏不一定吃 worker-start 的注入，以心跳/token 增长为准）→ `worker-start --task <id> --terminal <handle> --worktree <树>` 收口接管（task 被上次 stopped 挡住时加 `--retry-of <旧dispatch>`）。收口后 preamble 注入、heartbeat、worker_done、worker-release 全套编排能力可用。

同理 Claude 族走 reclaude 也属此"特殊启动、编排收口"例外分支；pi 可直接 `--agent pi` 裸起（默认模型由 ~/.pi/agent/settings.json 控制）。
