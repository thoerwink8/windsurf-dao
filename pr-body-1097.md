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

## 进展

闸装进 `scripts/lib/nudge-stalled.mjs`（纯函数，只吃入参），垫片 `scripts/nudge-stalled.mjs` 接线：查 issue / PR / 租约 / 分支，过闸才 `startSession`。没查成 exit 2，起会话失败 exit 1，跟「没有卡住的」分得开。

验收对照：

1. `tests/nudge-stalled.test.js`「对已关单跑 --go：startSession 一次都不调」+「今晚 6 棵一起 --go」：#1012/#1007 零起会话。
2. 同套「lease held → skip held」+「startSession 抛 busy 也记成 held」：人还在零起会话。
3. 同套「#1063 停在 master、PR head 是 fix-escalate-noise → skip wrong-branch」：错分支不推。
4. 垫片头、service 头都写「人退了才起新的」；#1056 退役路径仍在 install 脚本里。
5. 红项 1：`classifyPrListScan` 取满 limit 即没查全；`loadAllPrs` 用 `PR_LIST_LIMIT`（10000）且截断走 unscanned。回归：「取满 limit 条 → 没查全」+「截断的 PR 面进 runNudge：非 master 工人 unscanned，零起会话」。审官实验 `prs: {ok:true, items:[]}` 仍是完整空列表（允许未开 PR），截断是 `ok:false`。
6. 红项 2：`runNudge` 把非 busy 错误写入 `out.failed`；CLI 走 `nudgeExitCode`（unscanned→2，failed→1，busy/成功→0）。回归：「startSession 抛 mirasim unavailable → failed + exit 1」+「busy 仍 skip + exit 0」。
7. 本轮唯一红项：已 merge 当前 `origin/master`（含 #1112 `7e1e5ef`、#1103 `ae19999`），`handoff-check` 真实输出见下。仓内计数跟到本轮：`dao-check` 188 项、本套 35 条。

`node --test tests/nudge-stalled.test.js`：35 过 / 0 红。
`node scripts/dao-check.mjs`：退出码 0（188 项，含本套 35 条）。

### handoff-check 真实输出（工人树 dao-1097，HEAD `f01c464`）

合入 master 并 push 后、更新本文件之前跑的闸。本文件提交会再挪一次 HEAD；GitHub PR 正文以 push 之后、与审官所见同点的那一份为准。

```
交卷闸：dao-1097 vs origin/master（已拉远端）
  ✓  ① 基底含最新 master —— 基底含最新 origin/master
  ✓  ② 相对 master 零删除 —— 相对 origin/master 零删除
  ✓  ④ 本分支新写的仓内指针都存在 —— 新增 1095 行里的 6 条仓内路径指针都真实存在
  ✓  ⑤ 自证基线＝审官所见 —— 工作区干净，本地与 origin/dao-1097 同点（f01c464）

判定：通（4 通 / 0 红 / 0 没查成）——可以交卷
```

## 机制判定

这错在制度生效前还会再犯吗？会。根因是 timer 只看 mirasim 的 `runState: incomplete`，不问盘面（issue/PR 终态、租约、分支）。本单把这三道闸装进推一把本身。

返工轮两条也是制度洞：① `gh pr list --limit 100` 在 856 个 PR 的仓上截断，分支闸被假阴性绕过；② 起会话失败只打日志、exit 0，systemd 看不见。截断当没查成、失败非零退出，这两条闸现在就在正门上。#1056 对账循环落地时本垫片整套退役，在那之前这些闸就是正门。

本轮（交卷闸落后 master）还会再犯：会。master 在审的窗口里继续合单，工人树不跟上就会把旧时点的 handoff 输出当证据。处置是合入当前 `origin/master` 再跑闸，正文只贴与 HEAD 同点的输出。

## 回流

- 产物：`judgeNudge` / `runNudge` / `classifyPrListScan` / `nudgeExitCode`——「这棵 incomplete 的树该不该起新会话」三态（go / skip / unscanned），加上失败可机器识别。
- 为什么通用：① 本垫片每 20 分钟推一把；② #1056 对账循环若把「30 分钟 stalled」写进「该在却不在」，必须过同一把尺，否则今晚这环路会写进正门。
- 建议落点：留原仓；#1056 合入时闸文件跟垫片一起退役或收进对账循环，不要另造一份。
