## 目标

`dao-nudge-stalled` 每 20 分钟对 `runState: incomplete` 的树调用 `startSession`（起新会话），不看单是否已关、PR 是否已合、树上是否还有人。文件头写的是「说一句继续，不是重派」，代码做的是重派。本单给推一把加三道闸，让已结束 / 人还在 / 错分支的树不再被推。

署名 issue #1097，关单交给 `scripts/close-issues.mjs`。

## 验收标准

1. 已关 issue / 已合 PR 的树，推一把必须跳过（故意构造：对已关单跑 `--go`，必须零起会话）。
2. 树上还有会话进程（租约 held）→ 记「人还在」退出，不许再起一条。
3. 树的分支对不上该单 PR head（如 #1063 停在 master）→ 跳过并报，不许在错误分支上「继续」。
4. 文件头与代码一致：做不到「往旧会话说话」就写明「人退了才起新的」；#1056 合并时本 timer 仍按原计划退役。

返工轮（PR #1102 审官红项）额外：

5. PR 列表查不全时返回 `unscanned`，不许把截断当成「没有该单 PR」去 `go`。
6. `startSession` 普通失败写入 `failed` 并以非零退出；busy 背压仍是 skip / exit 0。
7. 工人树含最新 `origin/master`，`handoff-check` 四项通过，正文贴真实输出。
8. 租约成功信封只认精确的 `verdict: 'free'` / `'held'`；缺失或未知值返回 `unscanned`，`runNudge` 零起会话并以 exit 2 收尾。
9. 完整 PR 扫描在真实数据量下成功返回（分页 / 明确上限缓冲）；ENOBUFS 不再把开放、未合并、free、分支匹配的树全部打成 `unscanned` / exit 2。修完后重跑真实 `node scripts/nudge-stalled.mjs`，证明该推的树能进入 `go`。
10. 审官树在 `dao-review-pr-<N>`（不是工人 PR head）必须能推；不许把审官工作树当成错分支整批跳过。

## 进展

闸装进 `scripts/lib/nudge-stalled.mjs`（纯函数，只吃入参），垫片 `scripts/nudge-stalled.mjs` 接线：查 issue / PR / 租约 / 分支，过闸才 `startSession`。没查成 exit 2，起会话失败 exit 1，跟「没有卡住的」分得开。

验收对照：

1. `tests/nudge-stalled.test.js`「对已关单跑 --go：startSession 一次都不调」+「今晚 6 棵一起 --go」：#1012/#1007 零起会话。
2. 同套「lease held → skip held」+「startSession 抛 busy 也记成 held」：人还在零起会话。
3. 同套「#1063 停在 master、PR head 是 fix-escalate-noise → skip wrong-branch」：错分支不推。
4. 垫片头、service 头都写「人退了才起新的」；#1056 退役路径仍在 install 脚本里。
5. 红项 1（上一轮）：`classifyPrListScan` 取满 limit 即没查全；截断走 unscanned。
6. 红项 2（上一轮）：`runNudge` 把非 busy 错误写入 `out.failed`；CLI 走 `nudgeExitCode`。
7. 合入当前 `origin/master`（含 #1057 `e3a3c66` 对账循环），`handoff-check` 真实输出见下。
8. 租约 `ok:true` 后只接受 `verdict === 'free'` 或 `'held'`；缺 verdict / `unknown` 返回 `unscanned`。
9. ENOBUFS：`loadAllPrs` 改 REST `/pulls` 分页（`PR_LIST_PAGE_SIZE=100`），`spawnGh` 默认 `maxBuffer=64MiB`（`GH_SPAWN_MAX_BUFFER`），超限仍是 error。
10. 本轮：审官分支闸认 `dao-review-pr-<N>`（或 PR head）。回归：「审官树在 dao-review-pr-N → go」+「--go 真起一次」。真实预览里 PR #1102 从「错分支跳过」改成「将推」。

`node --test tests/nudge-stalled.test.js tests/gh-as.test.js`：107 过 / 0 红（本套 47 + gh-as 60）。
`node --test tests/nudge-stalled.test.js`：47 过 / 0 红。

### 真实预览（本轮：审官树不再被错分支闸误伤）

`node scripts/nudge-stalled.mjs`（预览、不带 `--go`），exit 0。#1063 仍 skip 错分支；审官 PR #1102 进入将推：

```
[推一把·预览] 工人 #1012 的 issue #1012 已关，不推
[推一把·预览] 工人 #1007 的 issue #1007 已关，不推
[推一把·预览] 工人 #1063 树在 dao-1063，该单 PR #1070 head 是 fix-escalate-noise，不在错误分支上继续
[推一把·预览] 工人 #1094 pi 将推（pi turn stalled past 30 minutes）
[推一把·预览] 工人 #1029 的 issue #1029 已关，不推
[推一把·预览] 工人 #818 pi 将推（pi turn stalled past 30 minutes）
[推一把·预览] 工人 #948 pi 将推（pi turn stalled past 30 minutes）
[推一把·预览] 工人 #967 pi 将推（pi turn stalled past 30 minutes）
[推一把·预览] 工人 #999 pi 将推（pi turn stalled past 30 minutes）
[推一把·预览] 工人 #1029 的 issue #1029 已关，不推
[推一把·预览] 工人 #1065 的 issue #1065 已关，不推
[推一把·预览] 工人 #1024 pi 将推（Internal error during token generation）
[推一把·预览] 工人 #792 树在 dao-792，该单 PR #1015 head 是 thoerwink8/ISSUE-792-工人-grok-4.6-收口跨宿主-GitHub-写权限-AI-只经-Bot-网关操作-Issue，不在错误分支上继续
[推一把·预览] 审官 PR #1102 codex 将推（Selected model is at capacity. Please try a different model.）
[推一把·预览] 工人 #1052 的 issue #1052 已关，不推
[推一把·预览] 工人 #1024 树在 dao-1024，该单 PR #1028 head 是 thoerwink8/ISSUE-1024-工人-grok-4.6-派单只有一个仓的射程-dispatch-没有-repo-推广到全部仓-在能力上就做不到，不在错误分支上继续
EXIT:0
```

### handoff-check 真实输出

提交并推送后重跑，贴与 HEAD 同点的完整输出（见本 PR 最新正文修订）。

## 机制判定

这错在制度生效前还会再犯吗？会。根因是 timer 只看 mirasim 的 `runState: incomplete`，不问盘面（issue/PR 终态、租约、分支）。本单把这三道闸装进推一把本身。

返工轮两条也是制度洞：① `gh pr list --limit 100` 在 856 个 PR 的仓上截断，分支闸被假阴性绕过；② 起会话失败只打日志、exit 0，systemd 看不见。截断当没查成、失败非零退出，这两条闸现在就在正门上。

租约形状损坏还会再犯：会。`ok:true` 被当成「观测完整」，缺 verdict / `unknown` 仍 `go`。处置是成功信封只认精确的 `free`/`held`。

ENOBUFS 还会再犯：会。`spawnSync` 默认 1MiB，本仓带 body 的全量 `pr list` 实测 3.1MiB 就打成 ENOBUFS。处置两层：① REST `/pulls` 分页；② `spawnGh` 明确 64MiB 上限，超限仍是 error。

本轮（审官树被错分支闸误伤）还会再犯：会。`reviewer-create` 把审官树建在 `dao-review-pr-<N>`，不能复用工人 PR head（会撞）。闸却拿 PR head 去对树分支，真实预览把卡住的审官 PR #1102 判成 skip。处置：审官分支闸认审官树名或 PR head；回归锁住「树在 dao-review-pr-N → go」。

## 回流

- 产物：`judgeNudge` / `runNudge` / `classifyPrListScan` / `collectPrListPages` / `nudgeExitCode` / `GH_SPAWN_MAX_BUFFER`——「这棵 incomplete 的树该不该起新会话」三态（go / skip / unscanned），加上大输出分页与明确缓冲上限；审官树名与工人 PR head 分开认。
- 为什么通用：① 本垫片每 20 分钟推一把；② 仓内其它 `ghAs` 大输出路径同样会撞默认 1MiB（board-gc / close-issues / dao-check 的 pr list）。
- 建议落点：`GH_SPAWN_MAX_BUFFER` 已落在 `scripts/lib/gh.mjs` 统一入口；分页收口与审官树名闸留在本垫片，#1056 退役时一起收或删。
