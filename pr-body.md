## 目标

士兵交卷先把 GitHub「完工」落盘、审官拉起来，但 Orca 身份先别关。红项打进这个还活着的 Dispatch，判定绿（或本单结束）才 `notify --type worker_done`。删掉「代码一交就结算、再靠下一跳救人」。署名 issue #677（关单交给 `scripts/close-issues.mjs`）。

## 验收标准

- [x] `dao.mjs worker-done` 退出 0 之后，`worker-show` 不得是 completed；此时 issue/PR 已有首行「完工」
- [x] 审官红项 `notify --to dispatch:<这个还活着的 id>` 能送达；已完工身份 fail-visible，不开下一跳
- [x] 判定绿之后才允许 `notify --type worker_done`，之后才是 completed
- [x] 有 OPEN PR、等审 / 等红项 → 看门狗不报空转
- [x] flow：士兵还活着时红项打进这个身份，不因「已有完工评论」去开下一跳；0 和没查成分开
- [x] `dao-check` 本单相关绿（全仓两项红：open 未在做超阈、账本断流 #671/#672/#674，本单未动）。PR 正文不写 GitHub 自动关单词

## 进展

- [x] 士兵任务书：交卷后身份继续活，判定绿才结算
- [x] `worker-done` 只负责 GitHub 评论和起审官，成功路径不绑 Orca 结算
- [x] notify 红项打进活身份；已完工不开下一跳救人
- [x] flow / 看门狗按新下班时机改观察与空转豁免
- [x] 测试：交卷后 Dispatch 仍 ready/waiting；红项能送达；等审/等红项不算空转

## 体系类改动

1. 谁提的，发生在什么场景？2026-08-20 用户：没真正结束就 done 没必要；GitHub 评论然后等待。现场：#676 交卷后身份已死，起审官/attach/红项全在救死人。

2. 删哪一层能让这个问题不存在？删掉「代码一交就结算 Dispatch」。GitHub 交卷账本留下，真结算后移到判定绿。

3. 如果从零重做，今天还会造它吗？会造 GitHub 交卷账本和真结算。不会造「先死人再开下一跳」这一层。
