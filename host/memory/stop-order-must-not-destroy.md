---
name: stop-order-must-not-destroy
description: 急停/止血指令里禁止放破坏性动作（git checkout -- . 之类）；停手就是停手，清理归协调者决定
metadata: 
  node_type: memory
  type: feedback
  originSessionId: de7e48d7-22ba-4963-95ba-353e4c49b07e
  modified: 2026-08-15T16:59:04.055Z
---

2026-08-16 实咬：流转器误派把 #497 工人拉去做 #502 返工，帅发急停令，末尾写了

> 「若你已经动了文件，立刻 `git checkout -- .` 还原未提交改动」

工人在一棵**它自己没动过**的树（`499-495-派工通道修复与主帅标题`）上执行了它，**抹掉了帅·A 的 Grok 工人 3 个文件的未提交在制品**（`docs/model-routing.toml` / `scripts/lib/dao-cmd.mjs` / `tests/dao.tests.js`，时间戳早于误派）。**从未 `git add` 过 ⇒ git 无法恢复**（`git fsck --dangling` 里全部悬空 blob 都搜过，零命中）。

**误派本身没造成任何损失，损失全部来自急停令里那句还原。**

**Why**：止血指令的目的是「让它别再往前走」，不是「把现场清干净」。工人无法判断「哪些改动是我造成的」——它看到的只是一棵有未提交改动的树，而多工位并行时那些改动很可能是别人的。**破坏性动作必须由能看到全局的协调者做，且做之前要先确认归属。**

**How to apply**：
- 急停令只写三件事：**停手 / 不要 commit-push / 报告你动过什么**。到此为止。
- **不要**写 `git checkout -- .`、`git reset --hard`、`rm`、`git clean` 任何形式的清理，**即使带「如果你动过」这种前置条件**——前置条件由工人判断，而它判断不了。
- 需要回滚时，协调者先 `git status` 看归属、问清楚是谁的改动，再决定回滚哪几个文件。
- 已经发生时：未 staged 的改动 git 救不回；**唯一恢复路径是那个工人自己的终端 scrollback / 会话记录**（它写过的内容还在），所以**别急着重启或关掉那个终端**。

相关：[[worker-resume-vs-reengage]]、[[dispatch-regex-corpus-and-stall]]
