## 目标

按决策域拆 scripts/lib/dao-cmd.mjs（4672 行）剩余 6 域到 scripts/lib/dispatch/*.mjs，照 #768 正文与 repo 域已验证模式（搬函数原样 + re-export 聚合 + 每域测试），对外 API 不变：

1. `dispatch/args.mjs`：全部 args* 命令构造 + 配套解析（terminal/worktree/task/worker/run/gate/orchestration）
2. `dispatch/inject.mjs`：注入/开工验证（verifyInjection/verifyStartedPolling/waitAndVerify/expect 指纹/粘贴判据）
3. `dispatch/launch.mjs`：选型/启动（resolveLaunch/materializeLaunch/agentStartSpec/orcaKnownAgentId + 能力探针）
4. `dispatch/worktree.mjs`：worktree 生命周期（planWorktreeRm/applyWorktreeRmPlan/prepareWorktreeRm）
5. `dispatch/reviewer.mjs`：审官闭环（gateReviewerCreate/resolveReviewerReuse/reviewerSpawnFailComment + label 选型读取）
6. `dispatch/worker-done.mjs`：完工结算（planWorkerDone/completeWorkerDoneNotify/pickWorkerDoneDispatchId）

署名 issue #768，关单交给 `scripts/close-issues.mjs`。

## 验收标准

- 6 个域文件各 <500 行
- dao-cmd.mjs 只剩编排 + re-export（行数如实记录，见进展）
- 全量 `node --test tests/*.test.js` + `node scripts/dao-check.mjs` 0 红
- 每域一 commit，PR 正文记录每域迁移的测试证据

## 进展

（逐域迁移后填写）
