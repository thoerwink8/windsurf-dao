## 目标

修 `attach-reviewer` 写死的归因：复审票有两个生产者（工人 `worker-done` 起审官失败、指挥官自己的 `rereview`），现在一律说成「工人已交卷、worker-done 起审官失败入队」，冤枉工人、误导值守去查不存在的故障。署名 issue #1014，关单交给 `scripts/close-issues.mjs`。

## 验收标准

1. 造一张 `worker-done` 失败写的票 ⇒ `why` 说工人起审官失败，且带上 error 原文。
2. 造一张指挥官 `rereview` 写的票 ⇒ `why` 说「交卷可合但没人审，按设计叫审官」，不许出现「失败」二字。
3. 造一张没有来源字段的旧票 ⇒ `why` 说「来源没查成」，不许倒向任一种。
4. 全流程 grep 不到写死的归因字符串。

硬边界：不许靠猜补来源；两个生产者都要改；旧票按「来源没查成」处理。

## 进展

- 票结构加 `source: 'worker-done-fail' | 'commander-rereview'`；`buildReviewPendingTicket` 新票必填，不认识的值拒写。
- 两个生产者各自填自己的：`writeReviewPendingOnFail` → `worker-done-fail`；`requestRereview` 改走 `buildReviewPendingTicket` → `commander-rereview`。
- `scanReviewPending` 把 `source`/`error` 带进态势；`attachReviewerWhy` 按来源分支，缺/不认识说「来源没查成」。
- 工人失败那支把票上的 `error` 原文拼进 `why`。
- 测试：`tests/commander.test.js` 三条 why；`tests/five-holes-815.test.js` 写侧拒漏/拒猜 + 两生产者都填。

## 验收记录

1. `node --test tests/commander.test.js`：`worker-done 失败写的票 → why 说工人起审官失败，且带 error 原文` 绿。
2. 同套：`指挥官 rereview 写的票 → why 说按设计叫审官，不许出现「失败」` 绿。
3. 同套：`没有来源字段的旧票 → why 说来源没查成，不许倒向任一种` 绿。
4. `tests/five-holes-815.test.js`：`两个生产者都填自己的 source，全流程 grep 不到写死归因` 绿；热路 `scripts/dao.mjs` / `scripts/commander.mjs` / `scripts/lib/commander-core.mjs` 已无 `工人已交卷、worker-done 起审官失败入队`。

相关套 `tests/commander.test.js` + `tests/five-holes-815.test.js` + `tests/commander-verbs.test.js`：168 pass / 0 fail。

## 机制判定

这错在制度生效前还会再犯。病不在某一个调用点写错字，而在「两个生产者、一个消费动作」却把 why 写成其中一种。下次指挥官再按设计写 rereview 票，值守仍会当成工人起审官失败去查。

机制改在三处，不是改一句文案：

- 写票时记下 `source`（`scripts/lib/dispatch/review-pending.mjs`）；新票缺/不认识拒写，不许读侧猜。
- 两个生产者都填（`dao.mjs` 的 `writeReviewPendingOnFail`、`commander.mjs` 的 `requestRereview`），对应 memory `fix-landed-at-one-call-site-only`。
- 消费侧 `attachReviewerWhy` 只认写下的事实；旧票缺字段说「来源没查成」，默认哪一种都是在猜。

## 回流

- 产物：`reviewPendingSourceOf` + `attachReviewerWhy`（来源只认写时记下的闭集，缺/不认识返回「没查成」）。
- 为什么通用：凡盘面上一种产物有 ≥2 条生产路（本仓 `two-producers-one-resource`），journal/why 都不能写死成其中一条。场景①复审待办；场景②其它队列动作（retry-drain / reap）若再共用一句归因，同一对函数能接。
- 建议落点：留原仓 `scripts/lib/dispatch/review-pending.mjs` + `scripts/lib/commander-core.mjs`（已经是消费侧唯一入口）。
