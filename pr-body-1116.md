## 目标

删掉「从 issue 标签反推派工决定」这一层（用户 2026-09-07 拍板 ①）。

派工决定（谁写码、谁来审）在 `dispatch` 那一刻完整落一次：`job.dispatch` 补 `reviewer` + `branch`，再用 PR head 分支当直接键把 `model/*` `reviewer/*` 打到 PR。之后 `reviewer-create` / `worker-done` 只读 PR label。

署名 issue #1116，关单交给 `scripts/close-issues.mjs`。

## 验收标准

- [x] 派工 → 工人交卷 → 起审官全程，`reviewer-create` 一次 issue label 都不读（夹具断言 gh 调用序列里没有 `issue view`）
  - 证据：`tests/pr-label-truth.test.js`「CLI reviewer-create / worker-done --pr 42：成功且 gh 序列没有 issue view」（假 gh 拒 issue view + 写调用日志）；库函数侧同套「按 head 分支打标，gh 序列没有 issue view」
- [x] PR 上没有 `model/*` 或 `reviewer/*` ⇒ 拒绝起审官，话面明确说「需人工打标」，不回退读 issue、不猜家族
  - 证据：`resolveWorkerFromPr` / `resolveReviewerFromPr` / `planWorkerDone` 手开 PR 没标就拒
- [x] 一张 PR 署两张单不再产生任何歧义（PR 上只有一组标签）
  - 证据：单一来源不再去重；同名 label 出现两次现在是 `many`（`tests/reviewer-vendor-gate.test.js`）
- [x] 帅位手开的 PR：没打标就拒，打了标就正常起审官
  - 证据：`planWorkerDone 手开 PR 没标就拒` + 有标则首审过
- [x] 删掉的四处在仓内 grep 零残留（`collectIssueLabelsFromPr` / `vendorFamilyFromHostPrefix` / `uniqueNames`；两份 `linkedIssueNumbers` 收成一份）
  - 证据：`tests/pr-label-truth.test.js`「四处删除在仓内 grep 零命中」+ ready-queue-check 是 re-export
- [x] 判别力自证：把新打标动作去掉，起审官必须当场红
  - 证据：`stampPrLabelsFromDispatch`「判别力：把打标事件拿掉，起审官当场红」

本单相关测试：`node --test tests/pr-label-truth.test.js tests/worker-model-host-prefix.test.js tests/reviewer-vendor-gate.test.js tests/dao-reviewer.test.js tests/five-holes-815.test.js tests/ready-queue.test.js tests/ledger.test.js tests/dao-dispatch-gate.test.js tests/gw-remote-probe.test.js tests/open-issue-count.test.js` → 510 绿。

`node scripts/dao-check.mjs`：1 项红是云 VM `~/.claude/skills` 不是目录（AGENTS.md 写明的环境项，不是本单回归）。

## 进展

- [x] 开工：空提交撑分支 + draft PR #1118
- [x] `job.dispatch` 补 `reviewer` + `branch`（schema + mirasim/orca 写口）
- [x] PR head 分支 → 账本 dispatch → 打标（幂等；查不到不猜）
- [x] `reviewer-create` / `worker-done` 先打标，再只读 PR label
- [x] 删四处反推层（`collectIssueLabelsFromPr` / 宿主前缀兜底 / `uniqueNames` / 第二份 `linkedIssueNumbers`）
- [x] 文档不再教「从 issue 抄 label」
- [x] 测试 + dao-check + handoff-check
- [x] 跟上 origin/master（#1109/#1106/#1015/#1107 + 两笔巡检观察）；合入后探针单元补 #792 凭据隔离
- [x] 本轮解冲突：ready-queue-check 保留本单 re-export `linkedIssueNumbers`，吃下 #966 「将来某版」跳过
- [x] 本轮跟上 origin/master（#1144 快马返工建树 + gpt 族 direct 路由 + 西瓜清单 2026-09-08 拍板）；共享 objects 属主混 root/orca，走 GIT_OBJECT_DIRECTORY + pack 迁回
- [x] 本轮跟上 origin/master（#1157 无人值守生命周期 + 探活观察 + v2.1.0）；冲突 0
- [x] 本轮跟上 origin/master（#1163 体系重派不回落 auto + #1099 human_holds 派 manual）；冲突 0

## 机制判定

四个症状（#1096 读不到署名单、#1103 同值标签算歧义、#1070 手开 PR 无标签、`--force` 收不进参数表）不是四个 bug，是「每个消费者各自从 issue 标签重建派工决定」这一层的四个出口。

制度生效前还会再犯吗？**会**——只要还从 issue 反推，每个重建点都会再出一次「这是个新 bug」。本单删掉这一层：决定写一次、消费方读同一处、读不到就拒。不留「PR 上没有就回退去读 issue」的兼容回退。

过渡：现有 open PR 需补打一次标签，用现成的 `dao pr-sync-labels` 批量跑一遍即可，不写迁移代码。
