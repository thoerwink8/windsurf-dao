目标

堵 #815 复审轮余洞（#799 夜班实咬）：工人终端 depth 2 不许再派、审官终端已有在途派单时，`worker-done` 不再把这两种已知拒派报成「没查成」然后非零退出。改为写入 `_flow/queue/review-pending/<pr>.json` 并成功交卷；指挥官轮转 `review-pending-drain` 消费。复用审官时终端已有活 dispatch 则不 `worker-start`。署名 issue #815，关单交给 `scripts/close-issues.mjs`。

验收标准

- depth 2 / 在途派单：`classifyReviewerSpawnError` 不是 `unscanned`，是可入队种类；评论不写「没查成」
- 这两种错误：写 `_flow/queue/review-pending/<pr>.json` 后 `worker-done` 退出 0（`queued:true`），不是 fail
- 指挥官 `attach-reviewer` 走 `review-pending-drain`；drain 成功后待办删除且 `reviewer-attach` 只调一次
- 审官终端已有活 dispatch：复用路径跳过 `worker-start`，收回已有 dispatch id
- `node --test tests/five-holes-815.test.js` 过；`node scripts/dao-check.mjs` 绿

进展

- [x] 开工：空提交撑分支 + draft PR #947
- [x] 分类 depth-limit / active-dispatch，入队成功交卷（`planWorkerDoneAfterSpawnFail` + `finishWorkerDoneSpawnFail`）
- [x] 复用审官跳过在途派单的 worker-start（`planReuseExistingLiveDispatch`）
- [x] 判别测试 tests/five-holes-815.test.js 13/13；reviewer-book 写成功交卷 queued
- [x] `node scripts/dao-check.mjs` 绿（118 项 / 7 跳过）
