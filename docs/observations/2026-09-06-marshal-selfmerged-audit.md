---
title: 事后复审：帅位自写自合的 5 个派工闸 PR
status: open
issue: 1092
date: 2026-09-06
---

# 事后复审：帅位自写自合的 5 个派工闸 PR（#1092）

署名 issue #1092。本页是只读判定落盘，**不改**那五段代码。完整论证在 issue 评论；这里只钉结论、文件指针和「这样输入就会错」。

判定者：grok-4.6（跨厂）。被审代码 author=dao-marshal。读法：`git show` 五个 squash，不 checkout 已删分支。

## 总表

| 提交 | PR | 结论 | 一句话 |
|---|---|---|---|
| `afd3941a` | #1085 | **红** | `/proc` 把 server 的 stat 读失败当成没有 server |
| `928dbc1e` | #1086 | **红** | `busy: true` 被 `runCmd` 吞掉；被拦的单下一轮也捡不回来 |
| `f64d8a50` | #1088 | **绿** | 同步脊成功证据钉住了 |
| `24f07b27` | #1089 | **绿** | 返工豁免不靠自称；真没消歧的新单仍被拒 |
| `49d124b9` | #1090 | **红** | 堆积闸只挂 `--full`，值班检查面 skip |

## 红项指针

- #1085：`scripts/lib/dispatch/lease.mjs`（server `stat` 读失败 `continue` → `ok:true, noServer:true`）。cwd 全读不出那头由 `tests/lease.test.js` 钉成 `unscanned`，stat 这头没有。
- #1086：`scripts/commander.mjs` 的 `runCmd`（exit 1 丢掉 JSON 对象）。纯函数层 `tests/lease-backpressure.test.js` 喂的已经是带 `busy:true` 的对象，从不经过 `runCmd`。
- #1090：`scripts/dao-check.mjs` 里 `checkPendingBoardBacklog` 包在 `if (FULL)`；`scripts/server-check.mjs` 默认档也不加 `--full`。仓内 `tests/` 对这条函数 0 覆盖。

## 判绿依据

- #1088：`tests/sync-dispatch.test.js` 钉 `judgeSyncDispatch` 要非空 `sessionKey`。
- #1089：`scripts/lib/dispatch/card.mjs` 的豁免复用 `scripts/lib/close-issue.mjs` 的 `attributedIssueNumber`；`tests/rework-gate.test.js` 钉无署名拒、待消歧仍拒、列表没查成不豁免。

## 机制判定

会再犯。五段都是现役派工闸。修复另开单，本观察按 #1092 硬边界不改代码。
