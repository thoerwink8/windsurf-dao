---
title: 事后复审：帅位自写自合的 5 个派工闸 PR
status: open
issue: 1092
date: 2026-09-06
---

# 事后复审：帅位自写自合的 5 个派工闸 PR（#1092）

署名 issue #1092。本页是只读判定落盘，**不改**那五段代码。完整论证在 issue 评论；这里只钉结论、文件指针和「这样输入就会错」。

判定者：grok-4.6（跨厂）。被审代码 author=dao-marshal。读法：`git show` 五个 squash，不 checkout 已删分支。行号一律取被审 squash 提交里的真实行，不取当前 HEAD（master 后续提交会把行号挤歪）。

返工（PR #1112 审官 CHANGES_REQUESTED）：#1085/#1086 行号按 squash 改正；#1089 由绿改红（标题 `#N` 绕过已复现）；交卷闸输出改写进 PR 正文。

## 总表

| 提交 | PR | 结论 | 一句话 |
|---|---|---|---|
| `afd3941a` | #1085 | **红** | `/proc` 把 server 的 stat 读失败当成没有 server |
| `928dbc1e` | #1086 | **红** | `busy: true` 被 `runCmd` 吞掉；被拦的单下一轮也捡不回来 |
| `f64d8a50` | #1088 | **绿** | 同步脊成功证据钉住了 |
| `24f07b27` | #1089 | **红** | 标题随手 `#N` 就会把没消歧的新单当返工放行 |
| `49d124b9` | #1090 | **红** | 堆积闸只挂 `--full`，值班检查面 skip |

## 红项指针

- #1085：`afd3941a` `scripts/lib/dispatch/lease.mjs:60-62`（server `stat` 读失败 `continue`）→ `:71-73`（`!servers.size` 走 `ok:true, noServer:true`）。cwd 全读不出那头由 `tests/lease.test.js` 钉成 `unscanned`（源码 `:100-102`），stat 这头没有。
- #1086：`928dbc1e` `scripts/commander.mjs:631-635`（`runCmd` 在 exit 1 丢掉 JSON 对象）；dispatch 调用链 `:397-410`（`if (!r.ok) return r` 时 `busy` 字段已不在）。纯函数层 `tests/lease-backpressure.test.js` 喂的已经是带 `busy:true` 的对象，从不经过 `runCmd`。`runActions` 认 `r.busy === true` 在 `:685`。
- #1089：`24f07b27` `scripts/lib/dispatch/card.mjs:77-88`（`reworkExemption` 用 `attributedIssueNumber`，标题 `#N` 优先）+ `:127-132`（缺「已消歧」就走豁免）。输入：issue `#999` 无已消歧/待消歧；开放 PR `#777` 标题 `fix: cleanup (#999)`、正文与该 issue 无关 → `ok:true, reworkExempt:true`。修法：豁免不要复用关单的标题优先解析器；只认正文「署名 issue #N」，或标题与正文双证。本单硬边界不改闸。
- #1090：`scripts/dao-check.mjs` 里 `checkPendingBoardBacklog` 包在 `if (FULL)`（`49d124b9` `:2033-2041` vs `:2013`）；`scripts/server-check.mjs` 默认档也不加 `--full`（`:269`）。仓内 `tests/` 对这条函数 0 覆盖。

## 判绿依据

- #1088：`tests/sync-dispatch.test.js` 钉 `judgeSyncDispatch` 要非空 `sessionKey`。

## 机制判定

会再犯。五段都是现役派工闸。#1085 的 `/proc` 三态缺口会放行重复会话；#1086 的 busy 接线会把「树里有人」再变成待拍板单；#1089 把关单用的标题优先解析器接到了所有缺标签的消歧门路径上，标题随手 `#N` 就会让没消歧的新单过门；#1090 的闸在值班检查面上是 skip，堆积还是要靠人截图。修复另开单，本观察按 #1092 硬边界不改代码。
