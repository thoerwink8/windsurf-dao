---
name: worker-brief
description: 被派工人的开工便签：收到任务书后先读。开工五步、卡备注人话、任务主应答、向任务分支发 PR、打校准标签。
---

# 工人便签

## 开工五步（进 git 的活，先做这个再干活）

1. 空提交撑分支并推送：`git commit --allow-empty -m "[宿主] chore: 起<任务>分支"`，然后 `git push -u origin HEAD`。
2. 开 draft PR：`gh pr create --draft`，标题带宿主前缀，正文必须含三段——**目标 / 验收标准 / 进展**——并回链相关 issue。
3. 改卡名：`orca worktree set --worktree active --display-name "#<PR号> - <动宾短语>" --json`，再 `orca worktree set --worktree active --workspace-status in-progress --json`。
4. 给 PR 打标签（不存在先 `gh label create`，幂等）：`gh pr edit <PR号> --add-label "model/<型号>" --add-label "type/<任务类>"`。这两个标签是校准闭环的数据源，漏打等于这单没有成绩。
5. 干活中在关键节点更新卡备注：`orca worktree set --worktree active --comment "<人话进度>" --json`。卡备注面向人读，禁黑话。完成后自查 + `node scripts/dao-check.mjs` 通过 → `gh pr ready` → 卡备注改「待终审」。

## 纪律

1. 回答对象是派你的人——不要调 AskUserQuestion（会挂死）。问协调者用 `orca orchestration ask`。
2. 作为任务主时，用户可直接点卡进终端下指令：如实响应，不装没看见。
3. 异步/后台任务必须亲手读到终态才停手：收不到通知就自己读输出文件，或前台重跑拿真退出码，禁止把「等不到通知」静默当「已通过」；等待超 15 分钟不就绪就换手段，把欠账写进交付。
4. 收账一律 `git add <具体路径>`，禁 `-A` 和 `.`（共享工作树会把别人半成品收走）。
5. 接手不是重来：前任最后一句是意图宣告不是进度报告，两个方向都只认盘上。
6. commit 前缀带宿主标识（`[cc]` / `[pi]` / `[codex]` / `[grok]`）。
7. PR 正文三段式：目标 / 验收标准 / 进展。
8. 多工人任务：向**任务分支**发 PR，不要直接打 master。自己的冲突自己解，头工人不代改内容。
9. 完工发 worker_done 后终端就不再收信（续活走新建任务注入）。
