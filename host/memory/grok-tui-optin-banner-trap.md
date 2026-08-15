---
name: grok-tui-optin-banner-trap
description: grok TUI 首启的 opt-in 横幅会吃掉首次注入文本，先 Esc 关横幅再直给；等授权词屏面无专属指纹易被当停摆
metadata:
  type: reference
  originSessionId: 6d32fb06-c548-4268-83cc-fc1c15654662
  modified: 2026-08-14T20:59:32.185Z
---

2026-08-15 实测两例：grok TUI 首次启动显示「Help improve Grok [Opt out][Opt in]」横幅期间，`orca terminal send` 的文本被吞（Sent 成功但输入框空）。正解：先发一个 Esc 关横幅，再 send 全文+enter；发完读屏找「Thinking…」计时确认开工（输入框显示为空可能已提交，别急着重发）。

Grok auto 模式 push 被拦等授权词「推」时屏面静止，与完工待收同貌——分诊时读屏尾 Recap 找「等授权词」字样。相关流转器需求见 issue #455 comment（授权等待检测）。
