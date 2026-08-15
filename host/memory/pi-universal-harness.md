---
name: pi-universal-harness
description: 工人载具默认 pi 换 --model；例外：grok 单走 Grok Build（2026-08-14 拍板，pi-grok 退役）
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 6d32fb06-c548-4268-83cc-fc1c15654662
  modified: 2026-08-14T14:25:55.682Z
---

2026-08-14 用户明确：工人统一走 pi 载具，按模型只换 `--model`（pi-ds / pi-grok），不默认使用各厂商原生 CLI（Grok Build 只是备灶）。协调者曾自作主张把 Grok Build 当默认通道，被用户纠正。

**Why:** 统一载具=统一工具面/提示面/账本口径，跨模型成绩才可比；这是用户点将台设计的地基（微信原话「pi 支持配各种模型，只需要 /model 切换」）。

**How to apply:** 派工默认 pi 换 `--model`。**例外（2026-08-14 用户拍板）：grok 单走 Grok Build，pi-grok 退役**——pi 的 xai provider 走公网 api.x.ai+auth.x.ai 整链依赖 clash，盲考中两次断线死亡；Grok Build 走专用端点 cli-chat-proxy.grok.com 且给免费额度。Grok Build 授权词「推」、终端带 HTTPS_PROXY=127.0.0.1:7890。pi TUI /login 菜单模糊匹配撞 Xiaomi、候选列表在过滤行下方的坑仍适用其他供应商。
