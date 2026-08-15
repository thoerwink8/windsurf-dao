---
name: dispatch
description: 派工手册：判断派不派、建任务卡、起工人、选型、盯进度、终审校准。含拓扑、主会话红线、头工人职责、启动序、开工判据与完成信号。
---

# 派工手册

## 拓扑

master 卡只住主会话，永远零工人。每个任务用 `orca worktree create --no-parent --agent` 建顶层任务卡（一步到位起终端；默认模型场景，须指定模型 / Claude 族的两步走见「启动序」），与 master 平级。卡名「#PR号 - 动宾短语」，十字上下一眼能扫。

多工人任务：改文件的工人子 worktree 挂任务卡下（`--parent-worktree`）。git 上工人分支从任务分支切出（`--base-branch` 用任务分支，不要用 master）。

审官及一切辅助角色（临时诊断工等）的卡也挂在被审 / 被服务的任务卡下。已知显示名时建卡带 `--parent-worktree 'name:#<PR号> - <动宾短语>'`。不要写 `worktree:<显示名>`——`worktree:` 前缀只要完整 `repo-id::path`（从 `orca worktree list/show --json` 取），否则 `selector_not_found`。任务归档整树收口，辅助卡不要飘成顶层。

## 主会话红线

凡开 branch/PR 必派。主会话手不碰 git，无例外——空提交开 PR 的文书也归工人。

不进 git 的活（调查、回答、评审意见）主会话可自己干。

## 非阻塞

派完即回对话态。派工后必挂监视（机械步骤，见「一条完整命令链」第 5 步），盯工人用 Monitor 挂监视、等唤醒为主；20–30 分钟心跳扫为兜底。`check --wait` 式长阻塞列为禁手。

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

审官选型序与 Claude 族启动命令见 `docs/model-routing.toml`（[[rules]] 审官选型序 / [providers.claude]）——路由决策只存在那里，本页只留指针。

grok 单统一走 Grok Build（pi-grok 已退役，拍板 2026-08-14，issue #443）；Grok Build auto 模式会硬拦 git push（对外发布闸），授权词是往终端回一句「推」——假拦（网络抖动）重试即过，真拦（宿主策略）需授权词。

用户拍板换工具/通道/模型后立即对在途活生效（正在跑的当场切），协调者不得自行解释为「下一单起」；仅用户明说「跑完这单再切」才保留在途（拍板 2026-08-14，issue #443）。

点将台上线后由选型算法出三选项接替人肉版（拍板 2026-08-15，issue #455）。

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

## 通道判据

产出要进 git（commit / PR）⇒ 必走 Orca 编排，主会话不下场。只读不落盘的查证类 ⇒ 主会话可自己干，或会话内子代理。

## 启动序

两条路径，默认模型够用走一步到位，须指定模型走两步（`--agent` 一步到位只拿得到 agent 默认模型）：

- **一步到位（默认模型）**：`orca worktree create --no-parent --name "<卡名>" --agent <agent> --json`。实测（2026-08-14）`--agent pi` 默认模型 = **deepseek-v4-pro**。够用就不两步走。**Claude 族除外**：`--agent` 起不了 reclaude 链（已知 agent 枚举以 `orca worktree create --help` 为准，会漂），Claude 族一律走下面两步。
- **两步走（须指定模型）**：`worker-start` 的 `--model` 实测不支持 pi（报 `Agent pi does not support launch-time model selection`）；正解 = 裸建卡（`--setup skip` 免 Setup 页签）→ `orca terminal create --command "<agent> --model <model>"` 起带模型终端 → `worker-start --terminal` 复用（实测 `--command "pi --model deepseek-v4-flash"` 生效，session 实证 modelId=deepseek-v4-flash）。验开工后确认裸建的 fallback shell 未用即关掉。

裸建卡再两步开终端（不 `--setup skip` 也不关 fallback shell）会多出 Terminal / Setup 两个死页签（用户实测截图）。

批量起灶（多臂同时起）先做全员就绪清单：循环读每一臂，人人达 ready 或弹窗被处理才注题，禁止处理完一臂就走；弹窗会连环（信任框→沙箱框→登录框），过一道不等于就绪，每处理一道后重读；判「未开工」不能只看状态栏（会陈旧渲染），要看思考行 / 活动迹象。

注入四步：

1. 注入前先证终端就绪：终端活着、能收输入。Claude 族还要等 reclaude 配置同步完。
2. `orca terminal send --terminal <handle> --text "<长提示词>" --enter --json` 直写 TUI，不经 shell；普通长提示词不落文件。仅含逐字 payload 的单才把定案文本放到短路径，提示词里指过去。
3. 注入后回读，确认长提示词完整显示在屏上，不是被吞。
4. 补一记回车（manual 态先切 auto 再回车）。

## 开工判据

token 计数在增长才算开工——启动返回成功不等于已开工。见输入框残留就补一记回车。

## 判断工人是否完成的四个信号

1. 产物出现（该出现的文件 / 输出出现）。
2. 屏上失败信号：选不会命中正常提示的短错误码——正例 `econnect`（真断线），反例 `Reconnecting`（正常的重连提示，会误报成失败）。
3. 去掉数字后的终端文字连续静止（数字总在变，先剔掉再比静止）。
4. 兜底超时。

## 任务书口径

任务指令一律直给长提示词（terminal send 直写 TUI 不经 shell，特殊字符无碍）；仅含逐字 payload（必须一字不差落盘的定案文本）的单才配文件且用短路径；永久本在 PR body（拍板 2026-08-15）。

## 一条完整命令链

任务指令 `terminal send` 直写 TUI；仅逐字 payload 才落短路径文件。`task-create --spec` 只用短编排摘要，不是任务指令载体。若须读短路径文件，PowerShell 用 `Get-Content -Raw` 而不是 `cat`：

```bash
# 0) 信箱台：派工前/后都跑，保证横幅归属信箱台（帅 run-use 派工后必须再 ensure 归还）
node scripts/inbox-station.mjs ensure

# 1) 建任务卡 + 起终端一步到位：与 master 平级；--agent 默认模型（pi=deepseek-v4-pro，2026-08-14 实测）够用就不两步走
#    agent 句柄：从返回 JSON 的 result.agentTerminalHandle 取（旧运行时回退 result.startupTerminal.handle）
orca worktree create --no-parent --name "<临时名>" --agent <agent> --json

# 1) 建编排任务：--spec 只用短摘要（一句话目标，不是任务指令，不落任务书文件）
orca orchestration task-create --spec "短摘要：<一句话目标>" --json

# 2) 起工人：task 用上一步 JSON 里的 id；worktree 用第 0 步 JSON 的完整 id（repo-id::path，与 id:<repo-id>::<path> 等价；勿加 worktree: 前缀——实测 selector_not_found）
#    --agent 已在第 0 步起过，这里用 --terminal 复用那个终端，勿再 --agent 起第二个
orca orchestration worker-start --task <task_id> --worktree <repo-id::path> --terminal <agentTerminalHandle> --json

# 2b) 注入任务指令：terminal send 直写 TUI，不经 shell。普通长提示词不落文件。
orca terminal send --terminal <agentTerminalHandle> --text "<长提示词>" --enter --json
#    仅当本单含逐字 payload（必须一字不差落盘的定案文本）时，才把 payload 放到短路径文件，提示词里指过去；任务指令本身仍走 terminal send

# 须指定模型时（如写码谷时 deepseek-v4-flash、审官 opus、Claude 族一律）：不走第 0 步 --agent，改两条——
#   裸建卡（--setup skip 免 Setup 页签）→ terminal create --command 起带模型终端（实测生效；worker-start 的 --model 不支持 pi，Claude 族 --agent 起不了 reclaude 链）
#   起完的 --terminal 句柄取 terminal create 返回 JSON 的 handle（不是第 0 步的 agentTerminalHandle）
orca worktree create --no-parent --name "<临时名>" --setup skip --json
orca terminal create --worktree <repo-id::path> --command "<agent> --model <model_id>" --json
#   验开工后确认裸建的 fallback shell 未用即关掉

# 多工人时：改文件的子卡挂任务卡下，git 从任务分支切；同样 --agent 一步到位
orca worktree create --parent-worktree 'name:#<PR号> - <动宾短语>' --base-branch <任务分支> --name "角色·模型" --agent <agent> --json

# 审官 / 临时诊断工等辅助卡：挂被服务的任务卡下，归档整树收口；同样 --agent 一步到位
#   （审官若是 Claude Opus——按审官选型序 UI 类 GPT 禁入时顶位——走上面两步走那条，--agent 起不了 reclaude 链）
orca worktree create --parent-worktree 'name:#<PR号> - <动宾短语>' --name "审官·<型号>" --agent <agent> --json

# 3) 取 dispatch id：从 JSON 里取，不解析人读文本
orca orchestration dispatch-show --task <task_id> --json

# 4) 验开工：读回输出，token 计数在涨才算开工
orca orchestration worker-read --dispatch <dispatch_id> --json

# 5) 挂监视（机械步骤，派完必做）：Monitor 挂监视为主 + 20–30 分钟心跳扫兜底（三分诊与看门狗见「非阻塞」节）
```

## 命令级铁律

- 任务指令走 `terminal send` 直写 TUI，不经 shell、不落文件；仅含逐字 payload 的单才把定案文本落到短路径文件。
- 编排 `task-create --spec` 只用短摘要（不是任务指令载体）；禁把任务书当 spec、禁把普通长提示词落文件再 cat 进 `--spec`。含反引号的长文不塞进 `--spec`——走 terminal send。禁双引号裸拼长文（反引号裸拼吞字符 2 例）。
- 命令只信 `--json` 出口：例：`orca orchestration dispatch-show --task <task_id> --json`——字段一律从 JSON 取，不解析人读文本。
- 路径从 PR 反查，禁手抄：例：`gh pr view <PR号> --json headRefName -q .headRefName`——分支名从 PR 的 JSON 取，不手抄。
