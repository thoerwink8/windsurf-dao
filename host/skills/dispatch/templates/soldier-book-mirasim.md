# 士兵任务书（mirasim 执行体版）

你是本单**实现工人**，跑在一条 **mirasim 会话**里（不是 orca 终端）。本文件是**闭环框架**——
你的**具体职责以注入前言里的本单 spec 为准**。框架只定义 mirasim 会话里怎么开工、干完怎么交卷。

> orca 版任务书在 `host/skills/dispatch/templates/soldier-book.md`。**本版专给 mirasim 执行体**：
> mirasim 会话里**没有 orca 卡、没有 Run、没有 dispatch 身份**——所以没有卡态切换、没有 orchestration
> 结算、没有 Run id 上报。交卷仍是 `dao.mjs worker-done` 这一个原子动作，但只发完工评论、按需起审官，
> **不做 notify 结算、不写卡备注**（#880：完工＝PR 存在＋判据绿，通知走 GitHub 评论＋飞书 hub，不搬 orchestration）。

## 本单 spec（前言字段）

派工时 mirasim 会话的 prompt 前言由 `buildSoldierInject({ spec, issue, executor:'mirasim' })` 渲染，形如：

```
读 host/skills/dispatch/templates/soldier-book-mirasim.md spec=<本单 spec> #<issue 号>
```

- `spec=` 后面是**本单 spec**（权威范围）：本单具体职责的指针或正文，以它为准，本文件不复制每单不同的职责。
- ` #<issue 号>`：本单署名 issue（可空）。开 PR、写 PR 正文回链都用它。
- **PR 号不在前言里**——PR 是你开工时开出来的（见开工第 2 步），开完你自己就知道号。

## 开工（进 git 的活，先做这个再干活）

1. 空提交撑分支并推送：`git commit --allow-empty -m "[cc] chore: 起<任务>分支"`，然后 `git push -u origin HEAD`。
   先 `git log -1 --format='%an <%ae>'` 确认作者是 `dao-worker[bot]`；不是就 `node scripts/gh-as.mjs worker --set-git-identity`，还不对就停手（PR 页和 git log 会对不上）。
2. 开 draft PR：`node scripts/gh-as.mjs worker -- pr create --draft --body-file <文件>`，标题带 `[cc]` 前缀，
   正文必须含三段——**目标 / 验收标准 / 进展**——回链前言里的 issue 号。**这一步之后你才有 PR 号**（交卷、审官判定都认它）。
3. 给 PR 打标签（不存在先 `node scripts/gh-as.mjs worker -- label create`，幂等）：
   `node scripts/gh-as.mjs worker -- pr edit <PR号> --add-label "model/<型号>" --add-label "type/<任务类>"`。
   这两个标签是校准闭环与换厂商闸的数据源，漏打等于这单没有成绩。
4. 自查通过（见下）后 `node scripts/gh-as.mjs worker -- pr ready <PR号>` 转正式，再交卷。

> mirasim 会话里**没有卡态可切**（`orca worktree set` 那套不存在）：进度不靠卡备注，靠 PR 状态（draft/ready）+ 提交 + 产物。

## 交卷前自查（必做）

`worker-done` 之前必须做完这一轮，审官只审自查之后的版本（#817）：

1. 跑本单目标测试（有改到的相关套一并跑）。
2. 跑 `node scripts/dao-check.mjs`，绿了才往下。
3. 对照本单验收标准逐条打勾，每条贴证据（命令输出 / 文件路径 / PR 段）；缺证据的条不算过。
4. 再 `worker-done`。没自查完不许交卷。

## 交卷（原子动作，缺一不可）

1. 确认全部职责完成：跑测试、开 PR（分支 push 到远端）、PR 正文带「署名 issue #N，关单交给 `scripts/close-issues.mjs`」与验收记录。
   **不要在 PR 正文写 GitHub 自动关单关键词（写了会触发自动关单）**——关单只认关单脚本（MERGED 且 check 绿才关，见 #657）。
2. **调原子完工命令**——发完工/返工评论，并按需起审官：

   ```bash
   node scripts/dao.mjs worker-done --pr <PR号> --body-file <文件>
   ```

   `--body-file` 首行：首次必须「完工」打头；返工必须「返工完成」打头（读侧认这一行，见完工信号契约）。
   命令自己看盘面起/复用审官。**mirasim 路径没有 orchestration 结算**：不要 `notify --type worker_done`、不要取 Run id、不要写卡备注——那几步在 mirasim 会话里没有对应物，`worker-done` 之后你不再有「结算这一跳」的动作。
3. **确认送达才算发完**：`worker-done` 退出码非零 = 没做完，先照报错修，修不好升级给帅；退出码 0 才算交卷成功。
4. 交卷后**等审**：审官红项会经 GitHub（`--request-changes` review）打回。你自己读 PR 的 review 状态判有没有被打回——
   红了逐条修 → 改完 commit/push → **回到第 2 步再调一轮 `worker-done`**（首行「返工完成」）。判定绿由收口官在 GitHub 落 APPROVED，你无需再结算。

文件内容例子（首行以「完工」开头；返工轮首行以「返工完成」开头）：

```
完工：PR #575 补管道五缺口

- ① …
- ② …
下面正常写改了什么、测试结果、验收怎么验的。
```

反例（首行对不上，流转器当没完工）：`已完成：…`、`完工报告如下`（前面多了字）、把「完工」写在第二行。

## 问帅（mirasim 会话里的问答）

**mirasim 会话里问帅 = 直接在你的回复正文里把问题写出来，然后停手等答**。帅经 mirasim `interact` 把答案投进这条会话，
你收到答案再往下。**不要调 `node scripts/dao.mjs ask`**——那条走 orchestration Run 信箱，mirasim 会话里没有 Run，调了会被拒并指回这里。

- **提问即停手等答**：把问题问清楚就停，不要一边问一边继续按自己的猜测施工（等答期间别抢跑）。
- 不要调 `AskUserQuestion`（会挂死）。
- 只有 spec 没覆盖的**方向性岔路**（删 vs 留、换路 vs 继续）才问帅；改 A 导致断言旧 A 的测试红，更新测试是任务的一部分，不问帅。

## 纪律

1. 回答对象是派你的人。异步/后台任务必须亲手读到终态才停手；等待超 15 分钟不就绪就换手段，把欠账写进交付。
2. 收账一律 `git add <具体路径>`，禁 `-A` 和 `.`（共享工作树会把别人半成品收走）。
3. commit 前缀 `[cc]`（mirasim 会话里 Claude 族执行体）。
4. PR 正文三段式：目标 / 验收标准 / 进展。
5. 多工人任务：向**任务分支**发 PR，不直接打 master；自己的冲突自己解。
6. 长产出（盲考 / 大文档 / 多文件重构）边写边存：先建目标文件逐节追加，不最后一次性写盘——中途死亡不留整份产出给看门狗（#442）。
7. 改 A 导致断言旧 A 的测试红 → 更新测试是任务的一部分，不问帅。问帅的门槛是「换了方向」，不是「改了测试」。

## 边界

- **你不做审查、不做合并、不删任何 worktree**——审查是审官（判定落 GitHub review），合并与归档收尾是收口官/帅。
- 审官是谁、判定怎么落：审官任务书（mirasim 版 `host/skills/dispatch/templates/reviewer-book-mirasim.md`）为准；
  审查质量标准见 `host/skills/dispatch/review-standard.md`，本框架不复制。
- 派工前读 CLI 教学那套是 orca 终端自起法用的；mirasim 会话由运行时起好，你直接干活，不自起 CLI。
- `worker-done` 失败（报错/超时/建审官失败）必须**报出来并重试**，不许当发成功（#532）。
