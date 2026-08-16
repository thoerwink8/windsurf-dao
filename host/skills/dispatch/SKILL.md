---
name: dispatch
description: 派工手册：判断派不派、建任务卡、起工人、选型、盯进度、终审校准。含拓扑、主会话红线、头工人职责、启动序、开工判据与完成信号。
---

# 派工手册

## 拓扑

master 卡只住主会话，永远零工人。每个任务用 `node scripts/dao.mjs dispatch` 起（建工人卡+审官卡+起终端+注入任务书+记账；用法以 `node scripts/dao.mjs --help` 为准，本页不复制旗标）。卡名「#PR号 - 动宾短语」，十字上下一眼能扫。

多工人任务：改文件的工人子 worktree 挂任务卡下（`--parent-worktree`）。git 上工人分支从任务分支切出（`--base-branch` 用任务分支，不要用 master）。

审官卡走 `node scripts/dao.mjs reviewer-create --pr <N>`：base 从 PR 推导，建完自证 HEAD 与被审文件，对不上就拒绝起 agent。不要手填 `--base-branch`。任务归档整树收口，辅助卡不要飘成顶层。

## 主会话红线

凡开 branch/PR 必派。主会话手不碰 git，无例外——空提交开 PR 的文书也归工人。

不进 git 的活（调查、回答、评审意见）主会话可自己干。

## 主树常驻 master

主树（帅日常所在的那棵 worktree，见「拓扑」master 卡）只住 master，只做 master 态的活。帅在主树的 git 写操作（memory 例外等）前**先验分支，不是 master 就停手**——#518：主树被切到在途分支后，memory commit 连做两次落地，第三次 commit 落进另一位帅的在途分支、还推成了新远端分支，全程无一步报警（「看起来成功、实际落错地方」）。**在途分支的活一律在自己（或任务）的 worktree 做**，不在主树切分支、不 reset、不强推——主树上可能有另一位帅的未提交改动（#518 实测当时工作区 5 个文件未提交；「同一个 worktree 同时只让一个执行者改文件」同样管两位主帅共用主树）。

可复制写法（git 写操作前先跑，非 master 直接失败退出）：

```bash
test "$(git branch --show-current)" = master \
  || { echo "主树不在 master，停手（当前：$(git branch --show-current)）" >&2; exit 1; }
```

## 非阻塞

派完即回对话态，帅不前台长等。本机信箱台（`scripts/inbox-station.mjs relay`）已经守着同一个 run，**帅不要再挂 `check --wait` 门铃**——一个 run 只允许一个 actionable waiter，再挂会 `waiter_exists` 刷屏（#525）。完工信号经信箱台转发到帅对话（`You have N orchestration messages`），外加工位闲置监视、待办队列监视。要手查信箱用一次性 `orca orchestration check --json`（不带 `--wait`）；`--ack` 语义是「确认上一批」，有 `deliveryId` 才带。循环跑外部命令的监视脚本必须让「同一条错误连续出现」收敛（计数/退避/自杀），否则一个稳定失败就是刷屏机器。心跳只进信箱供怀疑时 peek，不唤醒——空转实测 ~650 token/轮。

完工信号：`worker_done` 是触发器、GitHub 是裁决器——帅收到 worker_done 后必查该分支 PR 存在才收卷（`gh pr view <headRefName>`；#459 工人闷头写码不开 PR 防线）；没有 PR 就当没做完，escalation / 补开 PR，不收卷。反向（GitHub 有完工信号但没 worker_done）照常流转、记校准。

向用户汇报工位状态前，先实刷 orca worktree ps 的 agents[].state 与 gh pr 状态——凭上次印象汇报会状态失真（2026-08-14 三次实测，issue #443）。

监听三分诊：收到「活动消失 / 疑似交卷」通知后，第一动作是读屏分诊终态，不得直接按交卷入队——交卷→收卷；报错→原地重试一次（输入框残留补回车）；卡死（错误指纹两连同）→换人不救（拍板 2026-08-14，issue #442）。

看门狗双通道：快乐路径（工人自报 worker_done）之外，事故路径的轮询侦测由 `scripts/watchdog.mjs` 承担（检测矩阵见 issue #442 + #500/#492/#471/#476，勿在此复制细节，只留指针）。**活性判据只用「该发生的事有没有发生」**：非 spinner 真实内容是否在增长（spinner 重绘不算——#500 实证转圈挂死 27 分钟）、工作树 git 证据（空转）、还有没有活跃执行者（孤儿树）、flow 心跳是否在更新。看门狗还执行处置矩阵（指纹→动作）与任务卡命名校验。工人/审官的 git 环境已由仓库级 `core.editor true` + `core.pager cat` 兜底（NEW-MACHINE §8b），git 不会再拉起 vim/less 挂死。

## 头工人（树帅）

同一任务分支上，改文件的手 ≥2 个时，必须指定头工人为任务主。审官不计入这条判据——只数改文件的手。单工人 + 审官不需要树帅。

头工人自己也领一块活，兼分派、审队友发到任务分支的 PR、对外答话。

冲突打回冲突方工人自己解，头工人不亲手改内容。专职不干活的树帅只在超大任务实测顾不过来时升格。

头工人选型看判断浓度：机械并行走快档，含分解裁决走判断档。按返工率实测校准，不当公理。

## 任务官（#511 落盘）

判断密度高、规模大到帅盯不住的单才派任务官——不是所有单都要。任务官替帅执行本单全部决策，帅退到感知层。

**权限**（本单内的，任务官自己定，不停下来问）：
- 技术判断：方案选型、实现取舍
- 修法选择：返工怎么修（用「本单造成的缺陷 ⇒ 本单修」判据划范围）
- 范围判断：单内/单外由本判据定，不预设清单
- 开新单：单内派生任务直接开
- 派自己的工人与审官：走 `dao.mjs dispatch` / `dao.mjs reviewer-create --pr <N>`（见「启动序」）
- **按合并门自己合**：`merge-policy: auto` 是本单默认（#511 拍板），审官 approve 即合，不再等帅点头

**仍须知会帅的**（报了继续做，不等回话）：
- 事故与损失
- 合并完成

**仍须停下来等的**（三类，不可再加）：
1. 不可逆且跨出本单的动作
2. 需要用户本人拍板的
3. 它判断帅给的前提可能是错的——先问，别照做后发现（#511 当天两次错误前提都是照做后才发现的代价样本）

派单给任务官时，`--merge-policy` 默认 auto；例外（改协作约定 / 改 model-routing.toml 决策字段 / 花钱）走 manual 且必须 `--merge-reason` 留痕。任务官合并后的通知走流转器门铃（`worker_done` / 结构化消息，见「非阻塞」）；帅没收到时靠看门狗兜底（`scripts/watchdog.mjs` 检测矩阵第 9 项已在 master）。

## 设计注记

设计拓扑时把盘面全部角色过一遍（执行者、头工人、审官、临时诊断工），防止只想到主角。

## 选型

派工前读 `docs/model-routing.toml`。新工位派单前出三选项问用户（AskUserQuestion：推荐+备选，含工人数/做法/模型）；已批闭环内的返工/复核流转不重复问。选型上面板可见：终端名带角色·模型。用户可随时改派。全新任务类型或高危选型走「重大决策一事一问」。

审官选型序与 Claude 族启动命令见 `docs/model-routing.toml`（[[rules]] 审官选型序 / [providers.claude]）——路由决策只存在那里，本页只留指针。pi 派单默认 deepseek-v4-flash（拍板 issue #462，model-routing.toml [providers.deepseek].default_model 固化），ds-pro 仅限重型任务。

grok 单统一走 Grok Build（pi-grok 已退役，拍板 2026-08-14，issue #443）；2026-08-15 起经 regrok shim（~/.local/bin，内置 HTTPS_PROXY + 默认 -m grok-4.6）已是普通 agent，`--agent grok` 直接可用，装机见 NEW-MACHINE.md「grok 怎么配」；Grok Build auto 模式会硬拦 git push（对外发布闸），授权词是往终端回一句「推」——假拦（网络抖动）重试即过，真拦（宿主策略）需授权词。

用户拍板换工具/通道/模型后立即对在途活生效（正在跑的当场切），协调者不得自行解释为「下一单起」；仅用户明说「跑完这单再切」才保留在途（拍板 2026-08-14，issue #443）。

新工位三选项由 `node scripts/dianjiangtai-select.mjs` 产出，帅只负责转述与收拍板（拍板 2026-08-15，issue #455）。

## 小活打包

多个编辑级小活打包成一单，派一个工人。不因活小而主会话下场。

## 续单通道

在途任务：用户可直接点卡进终端下指令，工人如实响应。

已完工的工人续活：走新任务注入（工人发完完工报告后终端不再收信箱消息，直接发等于扔进真空）。

## 终审即校准

每单合并时主会话跑 `scripts/calibrate.mjs`，把本单成绩（返工轮数 / 红项）+ 该模型在该任务类的累计战绩原样呈现给用户。校准更新永远可见，不落暗账。

累计数据触发定位调整信号时，以策略 PR 提案形式摆给用户拍板。一个任务只做一次，不为测评搞对跑或重复实验——校准数据全部来自真实任务流。

合并即归档：PR 合并后当场 `orca worktree rm` 该任务卡（分支已进 master，副本无保留价值）——归档是帅终审动作的一部分，不等用户发现滞留（拍板 2026-08-14，issue #443）。

收卷即清树：无合并事件的树（实验/盲考/探针类），产出收走的同一动作里 `orca worktree rm`，不留稍后清；有 PR 的照旧合并即归档（拍板 2026-08-15，issue #465）。

issue 卫生（拍板 2026-08-14，issue #443）：对策进了 merged PR 的 issue，合并时当场关闭并引用落点 PR（落地即关）；拍板写进真正对应的 issue/PR，禁止把不相干拍板塞进同一张 issue，没有对应载体宁可开小 issue（拍板归位）；「落点 PR 已 merged 但 issue 未关」的自动闸在 #442 看门狗审计清单。

终审核对垫片退役：PR 正文登记的垫片（临时 Monitor / 手动流程）合并时当场退役换正式版，防影子制度（拍板 2026-08-15）。

## 审读闭环

审官审完有红项，直接让工人改掉，内部解决完再报结果；实在解决不了才上帅（2026-08-14 拍板，issue #447）。

**已接成机器闭环（#546 追加第五件，用户拍板）**：`dao.mjs dispatch` 内部把两个 handle 互相写进对方任务书——

- 士兵任务书（`host/skills/dispatch/templates/soldier-book.md`）写进**审官 handle**：完工后士兵**自己** `orchestration send` 通知审官，不发给帅。
- 审官任务书（`host/skills/dispatch/templates/reviewer-book.md`）写进**士兵 handle**：红 → 直接发回士兵改；乒乓两轮仍红才上帅；绿 → 按 merge-policy 自己合并 → 通知帅「可归档」。
- 归档（`worktree rm`）由帅做——审官不能 rm 自己所在的树，它只负责把「可归档」通知到帅。
- 模板是原则 + 「以当时的任务书为准」，不复制会随 #530 过时的具体职责（#507 教训）。

边界三条：

1. 通道：士兵完工通知审官是**直连**（handle 已互相写进任务书），不做帅的手工转发；审官不自造旁路。
2. 必须上帅：① 审官质疑拍板/规格本身；② 乒乓两轮仍有红项（换人信号）；③ 归档动作——归档由帅执行，审官只发「可归档」通知。
3. 记录不减：内部返工轮数与原因照落 PR comment（点将台返工特征的数据源），闭环不变黑箱。

人工补起审官（给已有 PR 补审官）走 `dao.mjs reviewer-create --pr <N>`，不抄闭环模板。

## 命名规矩

- 任务卡：`#<PR号> - <动宾短语>`（PR 开出来立刻改名）。
- 终端 / 工人副本：角色·模型（如「审官·GPT」）。默认名不上面板。
- 任务卡 / 工人 / 审官归属：卡 comment 末尾定界区 `｜[#N #M]`。`dao.mjs dispatch` 成功后只往**这张任务卡**的 comment 追加单号，人写的叙述原样保留，写完必回读。不要用 `orca terminal rename` 写这类归属（对 grok 等由宿主持续改标题的终端，rename 回 ok 但 list/show 不变）。
- Claude 主帅终端自己改自己：用 CC 内置 `/rename`（每帅私有，不互相覆盖）。给终端发以 `/` 开头的斜杠命令必须走 PowerShell，或设 `MSYS_NO_PATHCONV=1`——Git Bash/MSYS2 会把 `/rename` 转成 `C:/Program Files/Git/rename`，命令送不到、标题不变，看起来像无效。

## 通道判据

产出要进 git（commit / PR）⇒ 必走 Orca 编排，主会话不下场。只读不落盘的查证类 ⇒ 主会话可自己干，或会话内子代理。

## 启动序

派工只有一条命令。旗标以 `node scripts/dao.mjs --help` / `node scripts/dao.mjs check-help` 为准，本页不复制。

```bash
node scripts/inbox-station.mjs ensure
node scripts/dao.mjs dispatch --name "<卡名>" --reviewer <模型id> --spec "短摘要：<目标 + 全部职责类别>" --model <id>
```

`dispatch` 内部已经做完：选型闸、建工人卡、建审官卡（base 跟工人分支、建完核对 HEAD）、起终端、等 TUI 就绪、**注入任务书后再验开工**（屏上还挂着 `[Pasted Content N chars]` 就当没派出去）、失败回滚。环境自检在建 worktree 时用 shell 跑一次，不经 agent。

**闭环接线（#546 追加第五件）**：`dispatch` 把两个 handle 互相写进对方任务书——士兵任务书里写审官 handle（完工后士兵自己 `orchestration send` 通知审官，不发给帅）；审官也起自己的 task + worker-start（红→发回士兵；乒乓两轮仍红才上帅；绿→合并→`worker_done` 通知帅可归档）。模板在 `host/skills/dispatch/templates/`，不硬编码进代码。

多工人 / 给已有 PR 补审官，仍在约束载体内：

```bash
node scripts/dao.mjs worktree-create --name "<卡名>" --no-parent --setup skip
node scripts/dao.mjs reviewer-create --pr <N> --name "审官·<模型>" --parent-worktree <任务卡>
node scripts/dao.mjs worker-start --task <id> --worktree <sel> --terminal <handle> --model <id> --reviewer <id>
```

裸敲 `orca orchestration worker-start` / `task-create` / `dispatch --inject` 会被 PreToolUse 闸门 exit 2 拦住（#546 #517）。逃生口（必须留痕）：`node scripts/dao.mjs raw -- <命令>`。只在闸门误伤、或库还没覆盖的场景用。

**受控例外（自动起审官，随 #480 退役）**：`scripts/flow.mjs` 闭环内起审官仍走 `worktree create --parent-worktree`，不经 `worker-start`。人工派工禁止抄那条。

command-code 不能承载需进 git 的 Orca 工人（#514：旁路产出，worker-list 命中 0）。非交互查证另说，启动模板只读 `docs/model-routing.toml`。

吞注入只在 `dispatch` 的开工验证报红之后补救：先证终端就绪，再 `dao.mjs send`，回读确认不是 `[Pasted Content]`。

## 开工判据

token 计数在增长才算开工——启动返回成功不等于已开工。worker-start 后 `orca orchestration worker-read --dispatch <id> --json` 读回，token/cursor 在涨才算开工；见输入框残留就补一记回车（吞注入补救见「启动序」）。

## 判断工人是否完成的四个信号

（例外分支/排查用；主路径的完工信号 = worker_done + GitHub PR 核对，见「非阻塞」）

1. 产物出现（该出现的文件 / 输出出现）。
2. 屏上失败信号：选不会命中正常提示的短错误码——正例 `econnect`（真断线），反例 `Reconnecting`（正常的重连提示，会误报成失败）。
3. **非 spinner 的真实输出在增长**（#500 换代）：spinner 重绘、cursor 前进、token 计数增长都不算活性——转圈挂死 45 秒涨 21 行看着像活的。真判据是「该发生的事有没有发生」：新 commit / 新 push / 产物文件 mtime 在动；这几样都停了才考虑停摆。
4. 兜底超时。

## 任务书口径

`--spec` 必须枚举**全部职责类别**，不能只写技术目标（#507：#505 审官把只含技术目标的 spec 当任务边界，任务书里超出 spec 的 PR 侧四条职责整段跳过、直接发 worker_done，PR 上零落痕）。任务书再长也压不过 spec——工人侧把编排系统里那句正式任务描述当权威范围。判断职责有没有被执行，不看完工报告，看外部可验证落点（那次是 `gh pr view --json reviews` 为空）。逐字大材料按「材料三去处」分流（见下节）；永久本在 PR body（拍板 2026-08-15）。`terminal send` 降为吞注入时的补救，不再是默认注入器。

spec 样例（正反例；具体职责清单以**当时的审官任务书为准**——#530 换路后审官动作会变，勿硬编码会过时的清单）：

```bash
# ❌ 反例（#505 实证）：只写技术目标，PR 侧职责被当背景略过
# --spec "短摘要：#505 链C活性判据换真证据 审读"

# ✅ 审官单：职责类别逐条列全，动作内容指当时的审官任务书
# --spec "短摘要：审读 #505 + 按审官任务书落判定/收尾动作"
```

## 材料三去处（2026-08-15 拍板：临时树材料绑架树生命周期，pilot-B 实证）

指令与逐字大材料（必须一字不差落盘的定案文本）按三个去处分流，**任务树/本机临时目录不是去处**：

1. **指令**：一律直给提示词（worker-start 注入；吞注入才走 terminal send 补救），不落文件。
2. **用完即弃的逐字大材料**：放 scratchpad（临时工作区），用完即弃，不进任务树、不进 git。
3. **要留存的逐字大材料**（规格/裁定书/拍板）：一律进 GitHub——issue/PR 正文或仓内 docs/；任务书只给编号/指针，不复制全文。

禁止放进临时树或本机临时目录：临时树材料会绑架树生命周期（树删不得、留不得，pilot-B 实证）——要留存的材料进了 GitHub，临时树才能随时 rm。

## 一条完整命令链

见「启动序」。不要在本页维护第二份裸 orca 派工清单——那份拷贝会和 CLI 销叉（#546）。

多工人 / 辅助卡仍在约束载体内：

```bash
node scripts/dao.mjs reviewer-create --pr <N> --name "审官·<模型>" --parent-worktree <任务卡>
node scripts/dao.mjs worker-start --task <task_id> --worktree <新建子卡 id> --terminal <handle> --model <id> --reviewer <id>
```

## 命令级铁律

- 任务书承运 = `dao.mjs dispatch` 的 `--spec`：必须枚举全部职责类别（短摘要含要点，见「任务书口径」，禁只写技术目标）；逐字大材料按「材料三去处」分流。禁把普通长提示词落文件再 cat 进 `--spec`、禁双引号裸拼长文。
- 派工走 `dao.mjs dispatch`。裸 `orca orchestration worker-start` / `task-create` 会被闸门拦住；逃生口 `dao.mjs raw --` 必须留痕。
- 命令只信 `--json` 出口：例：`orca orchestration dispatch-show --task <task_id> --json`——字段一律从 JSON 取，不解析人读文本。
- 路径从 PR 反查，禁手抄：例：`gh pr view <PR号> --json headRefName -q .headRefName`——分支名从 PR 的 JSON 取，不手抄。
- **拿不到就报出来**（#532 升格为通用原则）：凡是拿不到东西——gh 输出失败、文件读不到、查不到、超时——必须报出来，**不许编、不许当成 0**。「没查成」当「查过没事」不报警，是会出事故的那类错（#532 次级限流让 `gh api` 全线失败拿到空列表；#538 第一轮审官编造执行证据、整轮作废）。两个落点，审官/工人/临时脚本一视同仁：
  - **gh 输出**：命令失败与查到 0 条分开，失败分支单独报错退出，命令成功返回的空数组才算真 0：

    ```bash
    review_list=$(gh pr view <PR号> --json reviews -q '.reviews') \
      || { echo "gh 读 <PR号> reviews 失败（$?）——不是没有 review，是没查成" >&2; exit 1; }
    state=$(gh pr view <PR号> --json state -q '.state') \
      || { echo "gh 读 <PR号> state 失败（$?）——不是查过没事" >&2; exit 1; }
    ```
  - **文件读取 / 审官自证**：审官开工第一步贴出 `git log --oneline -1` 与被审文件存在性检查的**真实输出**（PowerShell `'路径1','路径2' | ForEach-Object { '{0} -> {1}' -f $_, (Test-Path $_) }`；bash `ls 路径1 路径2`——给错 shell 是这次实咬的现场）。任何一个要审的文件读不到 → **停手 escalation**，禁止用 `gh pr diff` 代替本地文件、禁止推测。
- PR 正文关多张 issue：**每个编号前面都要有自己的关键词**，连写只认第一个（#527 实证：`Closes #500 #492 #471 #476` 合并后只自动关 #500，其余手工补关——「看起来成功、实际只做了四分之一」，没有任何东西提示漏关）。正例：`Closes #500, closes #492, closes #471, closes #476`。多 issue 单选一个主 issue 写全，其余关单评论留「已并入 #X」（#487 拍板）。
