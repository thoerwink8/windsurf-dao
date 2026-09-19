闭环框架：工人读 `host/skills/dispatch/templates/soldier-book-mirasim.md`，审官读 `host/skills/dispatch/templates/reviewer-book-mirasim.md`。注入只给一行指针。orca 版任务书已退役。

# windsurf-dao 协作约定

这个仓库是 AI 协作约定的家。**当前处于编排态**（2026-09-06 拍板，见 `docs/decisions/2026-09-06-orchestration-mode-restored.md`）：编排、派工、审官跑在 Linux 服务器上，执行体是 mirasim，Orca 已退役。流程类规矩收在 dispatch skill（`host/skills/dispatch/SKILL.md`），派单前按需读，不常驻本页。

**本文件是所有执行体（Claude / Codex / Cursor…）的唯一真相源**：`CLAUDE.md` 只是一行 `@AGENTS.md` 桥。Claude Code 要到 **2.1.277** 才「项目里没有 CLAUDE.md 时回退读 AGENTS.md」（`/config` → Project instructions），更早的版本只读 CLAUDE.md——VPS 上 reclaude 自带的那份是 2.1.260/2.1.274，所以**桥暂时删不得**。改约定改这里，别去改桥。

## 怎么工作

- 改动在 git worktree 里做，做完再提交推 master——主树是两个帅位共用的，谁跑一次 `git add -A` 就会把对方的在途改动卷进自己的提交（2026-09-06 咬了两次，第二次连 commit message 都没提被卷走的三个文件）。
- **开工前先 `git pull`**（用户 2026-09-19 立为公约）：别的机器也在跑同一个仓，很容易忘。机械版已落：fleet 的 `prepare` **起树前先 `git fetch origin --prune`**，fetch 失败按可重试处理（宁可不做，不做过期的）；`repo-hygiene` 会把「落后 N 笔」判红（周期闸，兜底）。
- 改完跑 `node scripts/dao-check.mjs`，绿了才算完，红了当场处理或如实报告。它默认跑全部测试、不出网（不采覆盖率、不裁剪）；`--full` 另外打开要出网的那几项。兜底不靠这一次：`land.mjs` 与 CI 各自还会跑。**Issue 写动作只走 `node scripts/issue-gateway.mjs`（#792）**，不许裸 `gh issue create|comment|close|edit`，不许自选 token；身份由网关固定 `dao-marshal[bot]`，幂等账与审计落 `~/.dao/issue-gateway`（不进 git）。
- 出问题优先 revert 到最近一个能用的提交，再另开改动处理——先回到能跑的状态，再慢慢补。
- commit 标题以**执行档的 agent** 开头（单一真相源 `docs/execution-profiles.json`）：`[cursor]`/`[codex]`/`[grok]`/`[devin]`/`[claude]`/`[pi]`…；fleet 任务由系统在 push 前强制对齐（模型写错也改回来）。旧表按宿主写死（`[cc]`/`[pi]`）已退役。版本号规则按需读 dao-commit skill（`host/skills/dao-commit/SKILL.md`），不常驻注入。
- 验收/通过记录必须与被测代码同基线：记录「X 修好 / 测验通过」的提交必须包含被测代码本身（#766 教训：通过记录挂在旧基线会误导后人）。
- 改动影响新机安装时，同一次提交里更新 NEW-MACHINE.md；拿不准就更新——漏更比多更代价大。换机 = `git clone` + `node scripts/onboard.mjs`（幂等，坏了重跑即修）。
- 派工链上的规矩（draft PR 起步、PR 正文写验收、审官判绿、开新单三问）已回岗——全文在 dispatch skill「编排态工作法」节。提问标推荐位：`host/skills/ask-gate/SKILL.md`；怎么跑测试：`README.md`。

## 体系类改动

**先查归属，别先想做法**：家目录落点看 `host/machine/INDEX.md`（A 类归本仓、E 类归他仓且本仓不写装法），**概念/任务类型看 `docs/ownership.json`**（渠道、腿、Mirasim、网关…先读它指的那份，别只在本仓 grep——本仓 grep 不到时分不清「真没有」和「答案在别仓」），其余先 `grep -rn "<关键词>" <目标仓>`——边界多半已经拍过板（判例 memory `ownership-before-design`）。

**开单也算动手：先查起因，别先开单**（2026-09-06 用户拍板立规）。新开 issue 前必须查这个**起因**是不是已有单在管：`git log --all --grep="chain:"` + 搜已有统领单。判据是**起因能不能写成同一句话**，不是症状像不像；统领单哪怕已 CLOSED、落地 PR 还在 draft，也是挂回去，不另开。落法：机器与帅位开的单，正文首行写 `起因：<slug>`（复用补丁链 slug），**同一 slug 只许有一张 OPEN 单**——闸见「自动检查」节，判例 memory `six-issues-are-one-layer`。

改变协作方式、增加规则、新增流程，或新造长驻机制（跨会话留进程或状态文件的东西）的改动，必须回答：

1. 谁提的，发生在什么场景？
2. 删哪一层能让这个问题不存在？
3. 如果从零重做，今天还会造它吗？

## 自动检查

**落后要有机制清退，不靠人肉眼扫**（用户 2026-09-19，判例 #1503）：issue 闲置两段式（`issue-retire`）、
PR 积压与机器漂移（`repo-hygiene`）、清单/计划挂单全关（`dao-check` 清单退场闸）。

新建或修改自动检查（hook、CI、检查脚本）时：

- 检查逻辑不得复用被检查对象自己的解析逻辑——自己查自己查不出错。
- 输出必须能区分「扫完查出 0 条」和「这次没扫到任何样本」：两者分不开，就会把「没查成」当成「查过没事」。
- 上线前先故意构造一次违规样本，被拦住才算生效；合并证据是「故意违规被当场拦下」的记录，不是「已安装」。
- Claude Code 的命令型 hook 只有 exit 2 拦得住动作；崩溃、exit 1、超时在宿主眼里全是放行——「守卫崩了」和「守卫判通过」看起来一模一样。
- 检查器的输出不能落在它自己会读取的文件范围内，否则报告成为下一轮输入，命中数每跑一次涨一截，看起来像「问题在恶化」。
- **反馈时间正比于改动，不是仓库规模**：新检查/新测试默认要快，不许出网（`tests/helpers/no-network.mjs`），能按需跑就别全量跑。加检查只算收益不算耗时，是 144 项跑 100 秒的由来。
- 闸只拦**确定性的量**（如 spawn 数）。墙钟耗时在有负载的机器上两次能差一倍，拿它当闸只会随机误报，而随机误报的闸最后一定被关掉——耗时只报趋势。
- 派生数据不进 git（账本、健康表都落 `~/.dao/`）：提交它就多一个没法人工合并的并发冲突点。
- 断言拆到最简：一条 `assert.ok(a && b)` 失败时看不出哪半坏了，改用 `equal/deepEqual` 让失败自带 diff——手拼失败消息是症状不是优点。一个测试写几条断言不限（「一测一断言」不是行业共识，「一测一行为」才是）。

> 本页是所有执行体的常驻注入面，总量控制在 2000 token 以内；加行前先问删哪行。
