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

- [x] 6 个域文件各 <500 行（launch 379 / args 461 / inject 395 / worktree 315 / reviewer 472 / worker-done 200）
- [ ] dao-cmd.mjs <1000 行 —— 实际落 2736 行，见「进展」的缺口说明（数学上 6 域拆不完）
- [x] 全量 `node --test tests/*.test.js` 2988 过 0 红 + `node scripts/dao-check.mjs` 48 ok / 0 红
- [x] 每域一 commit，PR 正文记录每域迁移的测试证据

## 进展

- [x] `33bccdb` 共享常量移 `dispatch/constants.mjs`（ROOT 三层路径与 repo 域同款；dao-cmd 改 import + re-export）
  - 测试证据：dao.test.js + dispatch-launch.test.js 687 过 0 红；dao-check 48 ok
- [x] `ab96218` launch 域移 `dispatch/launch.mjs`（379 行）：选型/启动/终端复用规划/能力探针 27 个符号
  - 测试证据：dao + dispatch-launch + orca-agent-cmds 720 过 0 红；dao-check 48 ok
- [x] `03962ed` args 域移 `dispatch/args.mjs`（461 行）：50 个 args*/extract*/classify* 符号
  - 测试证据：全量 2988 过 0 红；dao-check 48 ok（orca 真语料 13/13）
  - 同提交：extract* 拆散后，dao-check ⑩ 与 master-title.test.js 的语料检查扫描面扩到 dao-cmd.mjs + dispatch/*.mjs（自发现，不手写名单）
- [x] `b2b435d` inject 域移 `dispatch/inject.mjs`（395 行）：注入/开工验证 + 指纹/粘贴判据 25 个符号
  - 测试证据：全量 2988 过 0 红；dao-check 48 ok
- [x] `2a91349` worktree 域移 `dispatch/worktree.mjs`（315 行）：worktree 生命周期 14 个符号
  - 测试证据：全量 2988 过 0 红；dao-check 48 ok
- [x] `7075d90` reviewer 域移 `dispatch/reviewer.mjs`（472 行）：审官闭环 + label 选型读取 24 个符号
  - 测试证据：全量 2988 过 0 红；dao-check 48 ok
- [x] `f1a3ed3` worker-done 域移 `dispatch/worker-done.mjs`（200 行）：完工结算 6 个符号
  - 测试证据：全量 2988 过 0 红；dao-check 48 ok

### 迁移完整性

- 每域迁移后都用「修好的花括号扫描器」从父提交重提取同批符号做逐块 diff：launch/args/inject/worktree 全部原样一致（args 仅 flagsOf 按计划留在 dao-cmd、inject 仅 verifyWorkerStarted 内部 orcaErrText 改直调 orcaErrorText，均已记录）
- dao-cmd.mjs 对外 API 不变：所有原导出符号仍从 dao-cmd.mjs re-export；内部助手（worktreeKey/flagsOf 等）不导出
- 域间依赖单向：worktree←reviewer←worker-done←dao-cmd 无环（constants.mjs 承载共享常量避免循环）

### dao-cmd.mjs <1000 行的缺口说明

拆完 6 域后 dao-cmd.mjs 为 2736 行（原 4672，移走 1936 行）。<1000 行在数学上不可达：6 个域文件各 <500 行上限 = 最多移走 3000 行，4672−3000 = 1672 > 1000。剩余未拆内容为 batch/回滚/约束与 split/labels 写入/任务书模板与注入构建/评论/投递结算/help 自检/git 助手/活性扫描/CLI 参数表等，需后续按同模式再拆（约 6–8 个域）才能到 <1000。已问帅确认范围（ASK_TIMEOUT 未答，按任务书 6 域执行，差额如实记录）。
