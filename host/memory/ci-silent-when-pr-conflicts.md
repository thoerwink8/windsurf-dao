---
name: ci-silent-when-pr-conflicts
description: PR 有冲突时 on:pull_request 的 workflow 根本不触发，看起来像「Actions 坏了」；报 CI 问题前先查 mergeable
metadata: 
  node_type: memory
  type: reference
  originSessionId: d702bd60-19b9-4036-9ffc-973a75a4c0c8
  modified: 2026-08-15T14:27:34.850Z
---

2026-08-15 PR #490：工人报「GitHub Actions 自 13:27 起全仓没再触发过任何新 run」，并据此判定 Actions 停摆。实测推翻——同期别的分支有 run 成功；真因是 `gh pr view 490 --json mergeable` 返回 **CONFLICTING**。

机制：`on: pull_request` 的 workflow 跑在 merge ref（`refs/pull/N/merge`）上。PR 与 base 冲突时这个 ref 建不出来，**GitHub 干脆不触发 workflow**——不是失败，是压根没有 run。所以 `gh pr checks` 显示 "no checks reported"，head sha 的 check-runs 数为 0，整个现象和「CI 服务挂了」一模一样。

**How to apply:** 遇到「CI 没跑 / 没有 checks / Actions 好像停了」，诊断顺序是：①`gh pr view <N> --json mergeable,mergeStateStatus` —— CONFLICTING 就到此为止，去解冲突，解完 CI 自己会跑 ②`gh run list --limit 5` 看别的分支有没有 run（能区分「全局停摆」和「这条 PR 的问题」）③再查 workflow 的 `on:` 触发条件。别一上来查配额或权限。附带教训：这条是工人给出的错误归因，帅位没采信而是自己实测才挖到真因——归因要由独立方复现，见 [[report-requires-fresh-state]]。
