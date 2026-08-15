---
name: dispatch
description: 派工手册：判断派不派、建任务卡、起工人、选型、盯进度、终审校准。含拓扑、主会话红线、头工人职责、启动序、开工判据与完成信号。
---

# 派工手册

## 拓扑

master 卡只住主会话，永远零工人。每个任务用 `orca orchestration worker-start --worktree new-top-level --agent` 起（建顶层任务卡+起终端+记账一步到位，与 master 平级；默认模型场景一步到位，须指定模型 / Claude 族的两步走见「启动序」）。卡名「#PR号 - 动宾短语」，十字上下一眼能扫。

多工人任务：改文件的工人子 worktree 挂任务卡下（`--parent-worktree`）。git 上工人分支从任务分支切出（`--base-branch` 用任务分支，不要用 master）。

审官及一切辅助角色（临时诊断工等）的卡也挂在被审 / 被服务的任务卡下。已知显示名时建卡带 `--parent-worktree 'name:#<PR号> - <动宾短语>'`。不要写 `worktree:<显示名>`——`worktree:` 前缀只要完整 `repo-id::path`（从 `orca worktree list/show --json` 取），否则 `selector_not_found`。任务归档整树收口，辅助卡不要飘成顶层。

## 主会话红线

凡开 branch/PR 必派。主会话手不碰 git，无例外——空提交开 PR 的文书也归工人。

不进 git 的活（调查、回答、评审意见）主会话可自己干。

## 非阻塞

派完即回对话态，帅不前台长等。门铃：派工后挂 Monitor 后台跑 `orca orchestration check --wait --types worker_done,escalation,question`（阻塞 CLI、等待期间零 token、消息到即返回），收 `worker_done`/`escalation`/`question` 才唤醒；不等 heartbeat——心跳空转实测 ~650 token/轮，只进信箱供怀疑时 peek，不唤醒。旧「check --wait 禁手」改写为「禁帅前台长等」：wait 由 Monitor 进程跑，不是帅的对话阻塞。

完工信号：`worker_done` 是触发器、GitHub 是裁决器——帅收到 worker_done 后必查该分支 PR 存在才收卷（`gh pr view <headRefName>`；#459 工人闷头写码不开 PR 防线）；没有 PR 就当没做完，escalation / 补开 PR，不收卷。反向（GitHub 有完工信号但没 worker_done）照常流转、记校准。

向用户汇报工位状态前，先实刷 orca worktree ps 的 agents[].state 与 gh pr 状态——凭上次印象汇报会状态失真（2026-08-14 三次实测，issue #443）。

监听三分诊：收到「活动消失 / 疑似交卷」通知后，第一动作是读屏分诊终态，不得直接按交卷入队——交卷→收卷；报错→原地重试一次（输入框残留补回车）；卡死（错误指纹两连同）→换人不救（拍板 2026-08-14，issue #442）。

看门狗双通道：快乐路径（工人自报 worker_done）之外，事故路径的轮询侦测由 `scripts/watchdog.mjs` 承担（检测矩阵与指纹清单见 issue #442，勿在此复制细节，只留指针）。

## 头工人（树帅）

同一任务分支上，改文件的手 ≥2 个时，必须指定头工人为任务主。审官不计入这条判据——只数改文件的手。单工人 + 审官不需要树帅。

头工人自己也领一块活，兼分派、审队友发到任务分支的 PR、对外答话。

冲突打回冲突方工人自己解，头工人不亲手改内容。专职不干活的树帅只在超大任务实测顾不过来时升格。

头工人选型看判断浓度：机械并行走快档，含分解裁决走判断档。按返工率实测校准，不当公理。

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

审官审完有红项，直接让工人改掉，内部解决完再报结果；实在解决不了才上帅（2026-08-14 拍板，issue #447）。边界三条：

1. 通道：工人完工后不收信箱，「通知士兵」由协调者机械转发（不判断纯管道）；后续由 scripts/flow.mjs 流转器自动化（监听 review 判定行 / 完工 comment → 注入下一环，见 issue #455 分工定论：看门狗管事故、流转器管完工）。审官不自造旁路。
2. 必须上帅：① 审官质疑拍板/规格本身；② 乒乓两轮仍有红项（换人信号）；③ 合并动作——终审 + 校准入口仍归帅，内部闭环止于审官 approve。
3. 记录不减：内部返工轮数与原因照落 PR comment（点将台返工特征的数据源），闭环不变黑箱。

## 命名规矩

- 任务卡：`#<PR号> - <动宾短语>`（PR 开出来立刻改名）。
- 终端 / 工人副本：角色·模型（如「审官·GPT」）。默认名不上面板。
- 任务卡 comment：叙述 + 末尾定界区 `｜[#N #M]`。`dao.mjs dispatch` 成功后只往**这张任务卡**的 comment 追加单号，人写的叙述原样保留。写完必回读。不要用终端 rename（带 agent 的终端 rename 回 ok 但标题不变，#502 证伪）。合并侧调 `applyRemoveTicket({ id, worktreeId, runOrca })`。

## 通道判据

产出要进 git（commit / PR）⇒ 必走 Orca 编排，主会话不下场。只读不落盘的查证类 ⇒ 主会话可自己干，或会话内子代理。

## 启动序

默认一条命令走 Orca 原生编排（B 路实测 90 秒闭环），须特殊 argv 的才走两步收口；两条路径都以 `worker-start` 记账，release 才认得到：

- **一步到位（默认）**：`orca orchestration worker-start --task <task_id> --worktree new-top-level --agent <agent> --setup run --json`——建树、起 agent、注任务书、记账一次完成；`worker_done` 有效即自动结账。任务书承运：中等长度、无裸反引号的走 `--spec`（短摘要+要点），长文/逐字大材料按「材料三去处」处置（要留存的进 GitHub，用完即弃的进 scratchpad），提示词里只给编号/指针；`worker_done` 后帅必做 PR 核对（见「非阻塞」）。
- **两步走（须特殊 argv：reclaude 链路、pi 指定非默认模型）**：`worker-start` 的 `--model` 实测不支持 pi（报 `Agent pi does not support launch-time model selection`），`--agent claude` 起不了 reclaude 链——这两类 = 建卡（`--setup skip` 免 Setup 页签）→ `orca terminal create --command "<agent> --model <model>"` 起带模型终端（实测 `--command "pi --model deepseek-v4-flash"` 生效）→ `worker-start --task <id> --worktree <wt> --terminal <handle>` 复用收口。验开工后确认裸建的 fallback shell 未用即关掉。

**禁手：裸 `terminal create + dispatch --inject` 旁路**（不起 worker-start）——release 认不到这种工位（返回 dispatch_not_found），收尾会回到误关工人终端的旧事故；例外通道必须先挂上 `worker-start --terminal`。

**受控例外（自动起审官，随 #480 退役）**：`scripts/flow.mjs` 闭环内起审官仍走 `worktree create --parent-worktree`（oneShot 带 `--prompt`，Claude 两步走），不经 `worker-start`。原因：flow 自建注入/验开工/存量反查，整段将随 #480 换成原生 orchestration（结构化 worker_done / escalation / check --wait）。人工派工（含多工人/辅助卡）禁止抄这条例外——必须 `worker-start` 记账。

裸建卡再两步开终端（不 `--setup skip` 也不关 fallback shell）会多出 Terminal / Setup 两个死页签（用户实测截图）。

grok：经 regrok shim（~/.local/bin，内置 HTTPS_PROXY + 默认 -m grok-4.6）已是普通 agent，`--agent grok` 直接可用，无需两步（2026-08-15 三证验收：shim 命中第一位、服务端确认默认 4.6、裸起探针 13 秒闭环）。

批量起灶（多臂同时起）先做全员就绪清单：循环读每一臂，人人达 ready 或弹窗被处理才注题，禁止处理完一臂就走；弹窗会连环（信任框→沙箱框→登录框），过一道不等于就绪，每处理一道后重读；判「未开工」不能只看状态栏（会陈旧渲染），要看思考行 / 活动迹象。

吞注入补救四步（`terminal send` 不再是默认注入器，只在吞注入时补救）：

1. 注入前先证终端就绪：终端活着、能收输入。Claude 族还要等 reclaude 配置同步完。
2. `orca terminal send --terminal <handle> --text "<长提示词>" --enter --json` 直写 TUI，不经 shell；指令不落文件。逐字大材料按「材料三去处」处置。
3. 注入后回读，确认长提示词完整显示在屏上，不是被吞。
4. 补一记回车（manual 态先切 auto 再回车）。

## 开工判据

token 计数在增长才算开工——启动返回成功不等于已开工。worker-start 后 `orca orchestration worker-read --dispatch <id> --json` 读回，token/cursor 在涨才算开工；见输入框残留就补一记回车（吞注入补救见「启动序」）。

## 判断工人是否完成的四个信号

（例外分支/排查用；主路径的完工信号 = worker_done + GitHub PR 核对，见「非阻塞」）

1. 产物出现（该出现的文件 / 输出出现）。
2. 屏上失败信号：选不会命中正常提示的短错误码——正例 `econnect`（真断线），反例 `Reconnecting`（正常的重连提示，会误报成失败）。
3. 去掉数字后的终端文字连续静止（数字总在变，先剔掉再比静止）。
4. 兜底超时。

## 任务书口径

任务书承运 = worker-start 注入：中等长度、无裸反引号的走 `--spec`（短摘要+要点）；逐字大材料按「材料三去处」分流（见下节）；永久本在 PR body（拍板 2026-08-15）。`terminal send` 降为吞注入时的补救，不再是默认注入器。

## 材料三去处（2026-08-15 拍板：临时树材料绑架树生命周期，pilot-B 实证）

指令与逐字大材料（必须一字不差落盘的定案文本）按三个去处分流，**任务树/本机临时目录不是去处**：

1. **指令**：一律直给提示词（worker-start 注入；吞注入才走 terminal send 补救），不落文件。
2. **用完即弃的逐字大材料**：放 scratchpad（临时工作区），用完即弃，不进任务树、不进 git。
3. **要留存的逐字大材料**（规格/裁定书/拍板）：一律进 GitHub——issue/PR 正文或仓内 docs/；任务书只给编号/指针，不复制全文。

禁止放进临时树或本机临时目录：临时树材料会绑架树生命周期（树删不得、留不得，pilot-B 实证）——要留存的材料进了 GitHub，临时树才能随时 rm。

## 一条完整命令链

任务书承运 = worker-start 注入（`--spec` 短摘要+要点；逐字大材料按「材料三去处」分流）；`terminal send` 只在吞注入时补救（见「启动序」）。须读 GitHub 上的材料用 `gh` 取，不靠本机文件：

```bash
# 0) 信箱台：派工前/后都跑，保证横幅归属信箱台（帅 run-use 派工后必须再 ensure 归还）
node scripts/inbox-station.mjs ensure

# 0) 建编排任务：--spec 只放短摘要+要点（任务书承运；要留存的逐字大材料进 GitHub——issue/PR 正文或 docs/，提示词只给编号）
orca orchestration task-create --spec "短摘要：<一句话目标>" --json

# 1) 起工人一步到位：--worktree new-top-level 建顶层任务卡 + 起 agent + 注入任务书 + 记账一次完成
#    pi 默认模型 = deepseek-v4-flash（拍板 issue #462）；task id 取第 0 步 JSON 里的 id
orca orchestration worker-start --task <task_id> --worktree new-top-level --agent <agent> --setup run --json

# 2) 须指定模型 / reclaude 链路（worker-start --model 不支持 pi、--agent claude 起不了 reclaude 链）：
#    建卡（--setup skip）→ terminal create --command 起带模型终端 → worker-start --terminal 复用收口
#    禁裸 terminal create + dispatch --inject 旁路（release 认不到 → 误关终端旧事故）
orca worktree create --no-parent --name "<卡名>" --setup skip --json
orca terminal create --worktree <repo-id::path> --command "<agent> --model <model_id>" --json
orca orchestration worker-start --task <task_id> --worktree <repo-id::path> --terminal <handle> --json
#   验开工后确认裸建的 fallback shell 未用即关掉

# 3) 验开工（保留）：读回输出，token/cursor 在涨才算开工；见输入框残留补一记回车
orca orchestration worker-read --dispatch <dispatch_id> --json

# 4) 挂门铃（机械步骤，派完必做）：Monitor 后台 check --wait（零 token），收 worker_done/escalation/question
#    才唤醒；收到 worker_done 后必查该分支 PR 存在（gh pr view <headRefName>）才收卷

# 5) 收尾：worker-start 起的工位，worker_done 后一律 orca orchestration worker-release --dispatch <id>；
#    复用同一终端接下单用 worker-start --task <next> --terminal <handle>（所有权转走后再等）；
#    合并后 orca worktree rm 整棵任务树仍归帅终审

# 多工人 / 辅助卡（审官、临时诊断工）：子卡挂任务卡下，git 从任务分支切。
#   worker-start 无 --parent-worktree（--worktree new-child 挂的是当前卡，帅在 master 上会挂错），
#   所以先 create 子卡，再 worker-start --terminal 收口记账——禁裸 create --agent 起完就走。
#   --parent-worktree 用 branch:<任务分支>（name: 不是合法 selector；勿加 worktree: 前缀）。
#   flow.mjs 自动起审官是受控例外（见「启动序」），不要把那条抄回这里。
orca worktree create --parent-worktree branch:<任务分支> --base-branch <任务分支> --name "角色·模型" --agent <agent> --json
orca orchestration worker-start --task <task_id> --worktree <新建子卡 id> --terminal <agentTerminalHandle> --json
#   审官若是 Claude Opus（审官选型序 UI 类 GPT 禁入时顶位）走两步收口——--agent 起不了 reclaude 链：
#   建卡 --setup skip → terminal create --command → worker-start --terminal
```

## 命令级铁律

- 任务书承运 = worker-start 注入：`--spec` 只放短摘要+要点；逐字大材料按「材料三去处」分流（要留存的进 GitHub，用完即弃的进 scratchpad，禁止临时树/本机临时目录）。禁把普通长提示词落文件再 cat 进 `--spec`、禁双引号裸拼长文（反引号裸拼吞字符 2 例）。
- `terminal send` 只在吞注入时补救（见「启动序」）；默认注入器是 worker-start，不手工 send 进就绪竞态。
- 禁裸 `terminal create + dispatch --inject` 旁路（release 认不到 → 误关终端旧事故）；例外通道必须先挂 `worker-start --terminal`。
- 命令只信 `--json` 出口：例：`orca orchestration dispatch-show --task <task_id> --json`——字段一律从 JSON 取，不解析人读文本。
- 路径从 PR 反查，禁手抄：例：`gh pr view <PR号> --json headRefName -q .headRefName`——分支名从 PR 的 JSON 取，不手抄。
