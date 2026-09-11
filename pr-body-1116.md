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

本单相关测试：`node --test tests/pr-label-truth.test.js tests/worker-model-host-prefix.test.js tests/reviewer-vendor-gate.test.js tests/dao-reviewer.test.js tests/five-holes-815.test.js tests/ready-queue.test.js tests/ledger.test.js tests/dao-dispatch-gate.test.js tests/mirasim-dispatch-labels.test.js tests/close-issue.test.js tests/commander.test.js tests/commander-verbs.test.js tests/exhausted.test.js tests/shared-slots.test.js tests/inbox.test.js tests/escalation-key.test.js tests/escalate-group.test.js tests/spawn-budget.test.js tests/dispatch-repo.test.js tests/branch-protection-io.test.js tests/commander-merge-gate.test.js tests/harvest.test.js tests/approved-merge.test.js` → 核 317 + 指挥官 185 + 其余相关 204 绿；合入 #1191 后把「署名单标齐就能叫审官」改钉成只认 PR 自己的 reviewer/*。

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
- [x] 本轮跟上 origin/master（patrol 盘点探针观察：orca 读不了 journal）；冲突 0
- [x] 本轮：收件箱 5 条 patrol 观察落成 #1164–#1168，观察文件加「处置：#N」（CI check 被 inbox 闸打红，不是本单实现回归）
- [x] 本轮：指挥官选型也只读 PR label（`reviewerLabelFor` / 返工 / 复审补标打到 PR）。原先 decide 仍从署名 issue 反推审官——正是 #1096「不猜审官」那个出口。帮助文案「自读署名 issue」一并改掉。
- [x] 本轮跟上 origin/master（inbox 6 条巡检观测补处置行，收件箱闸转绿）；冲突 0
- [x] 本轮跟上 origin/master（patrol：#1015 凭据闸把额度采样 git 推送掐死）；观察文件加「处置：#1172」（指挥官方已开单，空处置行会把 inbox 闸打红）
- [x] 本轮跟上 origin/master（#1147 搁置单收口泵 + #1125 审官入队）。合入后 `resolvePumpDraftDispatch` 仍从署名单反推 model/reviewer——正是本单要删的那一层。改成只读 PR 自己的标签；没标就拒，不猜。
- [x] 本轮跟上 origin/master（v2.2.0 / 建树 realpath / 钉版本跟随在役 / 报帅 key 规范化）。合入后观察 `2026-09-10-指挥官timer停了自检仍绿.md` 落成 #1177，文件加「处置：#1177」（空处置行会把 inbox 闸打红）。
- [x] 本轮跟上 origin/master（#1110 合并闸检查器 + #1169 渠道并发三件套）。合入的是 master 新机制，本单选型路仍只读 PR label。
- [x] 本轮跟上 origin/master（报帅 key 闸对齐网关真闸 ASCII；巡检观察已有「处置：2af1fba9」）。合入的是 master 已修，本单选型路仍只读 PR label。
- [x] 本轮跟上 origin/master（#1174/#1175 统一执行改造：ACP 无人值守 + 会话目录清理 + 补丁链闸 + grok 原生腿证据）。冲突 0；选型路仍只读 PR label。相关测试 773 绿。合入后 spawn 预算 147 被本单 CLI 夹具顶到 148（`pr-label-truth` 真走 `dao.mjs` 才能断言 gh 序列没有 issue view）。
- [x] 本轮跟上 origin/master（#1129 满载换厂 + #1108 看板 v0 + 余量闸改量真 CPU）。冲突 0。换厂腿 `planReviewerOnCapacityDeath` 接在 `resolveReviewerFromPr` 之后：点名来自 PR 自己的 reviewer/*，不读 issue。注释里「issue 标签」改成「PR 标签」。相关测试 1073 绿。
- [x] 本轮跟上 origin/master（v2.4.0 / #1188 已停工人不再占位）。冲突四处：`worker-done` 留 `--repo` 射程并先账本打标；`reviewer-create` 帮助文案自读 PR label；指挥官缺标补 PR 自己的标签、补不上报帅不产死动作。合入后 master 把报帅话面写回「署名 issue 上取不到 reviewer/」——改成指 PR，并钉断言不许再教从 issue 反推。相关测试 880 绿。
- [x] 本轮再跟上 origin/master（#1146 skills 装载面自愈 + #1155 .git 属主闸）。冲突只在 spawn-budget：本单 CLI 夹具 +1 与 #1146 +3 叠成 151。
- [x] 本轮跟上 origin/master（#1199 分支保护读应用凭据）。冲突 0；选型路仍只读 PR label。相关测试 897 绿。
- [x] 本轮跟上 origin/master（#1189 回流提示层改指现役士兵书 + #1200/#1201 watchdog 已批准任务交付）。冲突 0；选型路仍只读 PR label。`labelValue` 注释不再写「issue 标签取值」（函数已给 PR 用）。相关测试 953 绿。
- [x] 本轮跟上 origin/master（#1177/#1193 指挥官 timer enabled 但停摆必须红）。冲突 0；选型路仍只读 PR label。
- [x] 本轮跟上 origin/master（#1205 派工前核实 type/ + #1190 凭据闸扫指挥官单元 + #1194 探针真请求 + #1191 正文署名压过标题随手引用）。冲突 0。#1205 是往 issue 写 type（给人看盘面），不是选型反推。#1191 合入后指挥官测试仍断言「署名单标齐就能叫审官」——按本单改成：署名认正文 #1152，审官只认 PR 自己的 reviewer/*；署名单标齐、PR 没标仍报缺失。
- [x] 本轮跟上 origin/master（#1203 已交卷工人不再反复重派 + #1198 acp-runtime 并行误红）。冲突 0；选型路仍只读 PR label。#1203 合入后差集重派带 openPrs，不从 issue 反推审官。相关测试 317+185+204 绿；dao-check 241 项绿。

## 机制判定

四个症状（#1096 读不到署名单、#1103 同值标签算歧义、#1070 手开 PR 无标签、`--force` 收不进参数表）不是四个 bug，是「每个消费者各自从 issue 标签重建派工决定」这一层的四个出口。

制度生效前还会再犯吗？**会**——只要还从 issue 反推，每个重建点都会再出一次「这是个新 bug」。本单删掉这一层：决定写一次、消费方读同一处、读不到就拒。不留「PR 上没有就回退去读 issue」的兼容回退。

过渡：现有 open PR 需补打一次标签，用现成的 `dao pr-sync-labels` 批量跑一遍即可，不写迁移代码。
