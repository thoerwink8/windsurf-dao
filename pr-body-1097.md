## 目标

`dao-nudge-stalled` 每 20 分钟对 `runState: incomplete` 的树调用 `startSession`（起新会话），不看单是否已关、PR 是否已合、树上是否还有人。文件头写的是「说一句继续，不是重派」，代码做的是重派。本单给推一把加三道闸，让已结束 / 人还在 / 错分支的树不再被推。

署名 issue #1097，关单交给 `scripts/close-issues.mjs`。

## 验收标准

1. 已关 issue / 已合 PR 的树，推一把必须跳过（故意构造：对已关单跑 `--go`，必须零起会话）。
2. 树上还有会话进程（租约 held）→ 记「人还在」退出，不许再起一条。
3. 树的分支对不上该单 PR head（如 #1063 停在 master）→ 跳过并报，不许在错误分支上「继续」。
4. 文件头与代码一致：做不到「往旧会话说话」就写明「人退了才起新的」；#1056 合并时本 timer 仍按原计划退役。

## 进展

闸装进 `scripts/lib/nudge-stalled.mjs`（纯函数，只吃入参），垫片 `scripts/nudge-stalled.mjs` 接线：查 issue / PR / 租约 / 分支，过闸才 `startSession`。没查成 exit 2，跟「没有卡住的」分得开。

验收对照：

1. `tests/nudge-stalled.test.js`「对已关单跑 --go：startSession 一次都不调」+「今晚 6 棵一起 --go」：#1012/#1007 零起会话。证据：`node --test tests/nudge-stalled.test.js` 27 过。
2. 同套「lease held → skip held」+「startSession 抛 busy 也记成 held」：人还在零起会话。
3. 同套「#1063 停在 master、PR head 是 fix-escalate-noise → skip wrong-branch」：错分支不推。
4. 垫片头、service 头、NEW-MACHINE 都改成「人退了才起新的」；#1056 退役路径仍在 install 脚本里（含新闸文件）。

`node scripts/dao-check.mjs` 退出码 0（182 项，含本套 27 条）。

## 机制判定

这错在制度生效前还会再犯吗？会。根因是 timer 只看 mirasim 的 `runState: incomplete`，不问盘面（issue/PR 终态、租约、分支）。本单把这三道闸装进推一把本身；#1056 对账循环落地时本垫片整套退役，在那之前这三道闸就是正门。

## 回流

- 产物：`judgeNudge` / `runNudge`——「这棵 incomplete 的树该不该起新会话」三态（go / skip / unscanned）。
- 为什么通用：① 本垫片每 20 分钟推一把；② #1056 对账循环若把「30 分钟 stalled」写进「该在却不在」，必须过同一把尺，否则今晚这环路会写进正门。
- 建议落点：留原仓；#1056 合入时闸文件跟垫片一起退役或收进对账循环，不要另造一份。

