2026-08-26 派单链路实战验证（issue #771，master 合入 #762 修复后首走）

本次由 `dao.mjs dispatch` 真实链路派出的工人（pi / deepseek-v4-flash）执行，链路环节清单：

- [x] ① 帅建 issue #771 并消歧（验证 #762 修复在真实链路的效果）
- [x] ② `dao.mjs dispatch` 派工：建 worker 卡、起 worktree、写 worktree 级 git 身份（dao-worker[bot]）
- [x] ③ 工人读 `soldier-book.md` + `docs/cli-notes/pi.md` 开工
- [x] ④ 开工五步：空提交撑分支推送 / draft PR #772 / 卡切 in-progress / 打 model+type 标签
- [x] ⑤ 写码：新增本文件 docs/dispatch-flow-test.md
- [x] ⑥ 自检：`node scripts/dao-check.mjs` 全绿（89 项 ok，2 项环境 SKIP）
- [x] ⑦ `pr ready` + 卡切 in-review
- [ ] ⑧ `dao.mjs worker-done` 起审官（gpt-5.6-sol）
- [ ] ⑨ 审官判定绿 → 合并 → 帅归档
