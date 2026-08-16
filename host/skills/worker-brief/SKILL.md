---
name: worker-brief
description: 被派工人的开工便签：收到任务书后先读。开工五步、卡片状态、卡备注人话、任务主应答、向任务分支发 PR、打校准标签。
---

# 工人便签

## 开工五步（进 git 的活，先做这个再干活）

1. 空提交撑分支并推送：`git commit --allow-empty -m "[宿主] chore: 起<任务>分支"`，然后 `git push -u origin HEAD`。先 `git log -1 --format='%an <%ae>'` 确认作者是 `dao-worker[bot]`（dispatch 会写 worktree 级身份；已有树补一句 `node scripts/gh-as.mjs worker --set-git-identity`）。不是 bot 就停手——PR 页和 git log 会对不上。
2. 开 draft PR：`node scripts/gh-as.mjs worker -- pr create --draft`，标题带宿主前缀，正文必须含三段——**目标 / 验收标准 / 进展**——并回链相关 issue。多行正文用 `--body-file`，不要把换行塞进 `--body`。
3. 改卡名：`orca worktree set --worktree active --display-name "#<PR号> - <动宾短语>" --json`，再 `orca worktree set --worktree active --workspace-status in-progress --json`。
4. 给 PR 打标签（不存在先 `node scripts/gh-as.mjs worker -- label create`，幂等）：`node scripts/gh-as.mjs worker -- pr edit <PR号> --add-label "model/<型号>" --add-label "type/<任务类>"`。这两个标签是校准闭环的数据源，漏打等于这单没有成绩。
5. 干活中在关键节点更新卡备注：`orca worktree set --worktree active --comment "<人话进度>" --json`。卡备注面向人读，禁黑话。完成后自查 + `node scripts/dao-check.mjs` 通过 → `node scripts/gh-as.mjs worker -- pr ready` → 同步 `--workspace-status in-review` → 卡备注改「待终审」。

## 卡片状态

卡片状态全生命周期由工人维护。漏切等于面板撒谎，用户看不出谁在等审。

- 开工：`--workspace-status in-progress`（开工五步第 3 步）
- `gh pr ready` 同一轮同步 `--workspace-status in-review`
- 被打回返工：切回 `in-progress`
- 合并归档：协调者设 `completed` 并当场 `orca worktree rm` 该卡（合并即归档，拍板 2026-08-14），工人不要自己标完结

判例：2026-08-14 只有一个工人自觉切了 in-review，其余卡状态失真。

## 纪律

1. 回答对象是派你的人——不要调 AskUserQuestion（会挂死）。问协调者用 `orca orchestration ask`。
2. 作为任务主时，用户可直接点卡进终端下指令：如实响应，不装没看见。
3. 异步/后台任务必须亲手读到终态才停手：收不到通知就自己读输出文件，或前台重跑拿真退出码，禁止把「等不到通知」静默当「已通过」；等待超 15 分钟不就绪就换手段，把欠账写进交付。
4. 收账一律 `git add <具体路径>`，禁 `-A` 和 `.`（共享工作树会把别人半成品收走）。
5. 接手不是重来：前任最后一句是意图宣告不是进度报告，两个方向都只认盘上。
6. commit 前缀带宿主标识（`[cc]` / `[pi]` / `[codex]` / `[grok]`）。
7. PR 正文三段式：目标 / 验收标准 / 进展。
8. 多工人任务：向**任务分支**发 PR，不要直接打 master。自己的冲突自己解（项化路径见 `dao-project` skill，冲突由收口官统筹）。
9. 完工发 worker_done 后终端就不再收信（续活走新建任务注入）。
10. 长产出（盲考 / 大文档 / 多文件重构）边写边存：先建目标文件逐节追加，不最后一次性写盘——中途死亡不留整份产出给看门狗（2026-08-14 拍板，issue #442）。
