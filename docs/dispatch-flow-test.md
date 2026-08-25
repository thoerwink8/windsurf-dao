2026-08-26 —— #771 派单链路实战验证（#762 修复后从干净 master 重走完整流程，工人跳由 dao.mjs dispatch 真实派出，宿主 pi / deepseek-v4-flash）

本卡走通的链路环节清单：

1. 派工：帅用 `dao.mjs dispatch` 建 worker 卡，写好 worktree 级 git 身份（dao-worker[bot]）与派工 spec
2. 开工五步：空提交撑分支并推送 → 开 draft PR（三段式正文，回链 #771）→ 卡切 `in-progress` → 打 `model/deepseek-v4-flash` + `type/写码` 标签
3. 写码：新增本文档 `docs/dispatch-flow-test.md`
4. 自检：`node scripts/dao-check.mjs` 通过
5. 交付：`gh pr ready` + 卡切 `in-review`
6. 原子完工：`node scripts/dao.mjs worker-done --pr 773` 发「完工」comment 并起审官（gpt-5.6-sol）
7. 终审与结算：审官判定绿后工人 `notify --type worker_done` 结算身份，合并归档归帅
