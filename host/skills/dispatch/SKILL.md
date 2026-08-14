---
name: dispatch
description: 派工手册：判断派不派、建任务卡、起工人、选型、盯进度、终审校准。含拓扑、主会话红线、头工人职责、启动序、开工判据与完成信号。
---

# 派工手册

## 拓扑

master 卡只住主会话，永远零工人。每个任务用 `orca worktree create --no-parent` 建顶层任务卡，与 master 平级。卡名「#PR号 - 动宾短语」，十字上下一眼能扫。

多工人任务：改文件的工人子 worktree 挂任务卡下（`--parent-worktree`）。git 上工人分支从任务分支切出（`--base-branch` 用任务分支，不要用 master）。

审官及一切辅助角色（临时诊断工等）的卡也挂在被审 / 被服务的任务卡下。已知显示名时建卡带 `--parent-worktree 'name:#<PR号> - <动宾短语>'`。不要写 `worktree:<显示名>`——`worktree:` 前缀只要完整 `repo-id::path`（从 `orca worktree list/show --json` 取），否则 `selector_not_found`。任务归档整树收口，辅助卡不要飘成顶层。

## 主会话红线

凡开 branch/PR 必派。主会话手不碰 git，无例外——空提交开 PR 的文书也归工人。

不进 git 的活（调查、回答、评审意见）主会话可自己干。

## 非阻塞

派完即回对话态。盯工人用 Monitor 挂监视、等唤醒为主；20–30 分钟心跳扫为兜底。`check --wait` 式长阻塞列为禁手。

向用户汇报工位状态前，先实刷 orca worktree ps 的 agents[].state 与 gh pr 状态——凭上次印象汇报会状态失真（2026-08-14 三次实测，issue #443）。

## 头工人（树帅）

同一任务分支上，改文件的手 ≥2 个时，必须指定头工人为任务主。审官不计入这条判据——只数改文件的手。单工人 + 审官不需要树帅。

头工人自己也领一块活，兼分派、审队友发到任务分支的 PR、对外答话。

冲突打回冲突方工人自己解，头工人不亲手改内容。专职不干活的树帅只在超大任务实测顾不过来时升格。

头工人选型看判断浓度：机械并行走快档，含分解裁决走判断档。按返工率实测校准，不当公理。

## 设计注记

设计拓扑时把盘面全部角色过一遍（执行者、头工人、审官、临时诊断工），防止只想到主角。

## 选型

派工前读 `docs/model-routing.toml`（该文件由策略 PR 交付；未合入前不要手写一份顶替）。例行选型不问用户。选型上面板可见：终端名带角色·模型。用户可随时改派。全新任务类型或高危选型走「重大决策一事一问」。

Claude 族终端一律经 reclaude 链路起；启动多一段配置同步期，抢跑注入必被吞。

grok 单统一走 Grok Build（pi-grok 已退役，拍板 2026-08-14，issue #443）；Grok Build auto 模式会硬拦 git push（对外发布闸），授权词是往终端回一句「推」——假拦（网络抖动）重试即过，真拦（宿主策略）需授权词。

用户拍板换工具/通道/模型后立即对在途活生效（正在跑的当场切），协调者不得自行解释为「下一单起」；仅用户明说「跑完这单再切」才保留在途（拍板 2026-08-14，issue #443）。

## 小活打包

多个编辑级小活打包成一单，派一个工人。不因活小而主会话下场。

## 续单通道

在途任务：用户可直接点卡进终端下指令，工人如实响应。

已完工的工人续活：走新任务注入（工人发完完工报告后终端不再收信箱消息，直接发等于扔进真空）。

## 终审即校准

每单合并时主会话跑 `scripts/calibrate.mjs`（由校准 PR 交付），把本单成绩（返工轮数 / 红项）+ 该模型在该任务类的累计战绩原样呈现给用户。校准更新永远可见，不落暗账。

累计数据触发定位调整信号时，以策略 PR 提案形式摆给用户拍板。一个任务只做一次，不为测评搞对跑或重复实验——校准数据全部来自真实任务流。

## 命名规矩

- 任务卡：`#<PR号> - <动宾短语>`（PR 开出来立刻改名）。
- 终端 / 工人副本：角色·模型（如「审官·GPT」）。默认名不上面板。

## 通道判据

产出要进 git（commit / PR）⇒ 必走 Orca 编排，主会话不下场。只读不落盘的查证类 ⇒ 主会话可自己干，或会话内子代理。

## 启动序（四步）

1. 注入前先证终端就绪：终端活着、能收输入。Claude 族还要等 reclaude 配置同步完。
2. 注入任务书。
3. 注入后回读，确认任务书完整显示在屏上，不是被吞。
4. 补一记回车（manual 态先切 auto 再回车）。

## 开工判据

token 计数在增长才算开工——启动返回成功不等于已开工。见输入框残留就补一记回车。

## 判断工人是否完成的四个信号

1. 产物出现（该出现的文件 / 输出出现）。
2. 屏上失败信号：选不会命中正常提示的短错误码——正例 `econnect`（真断线），反例 `Reconnecting`（正常的重连提示，会误报成失败）。
3. 去掉数字后的终端文字连续静止（数字总在变，先剔掉再比静止）。
4. 兜底超时。

## 一条完整命令链

任务书先写进文件，再逐条跑（PowerShell 下读文件用 `Get-Content -Raw` 而不是 `cat`）：

```bash
# 0) 建任务卡：与 master 平级，不要挂在 master 下面
orca worktree create --no-parent --name "<临时名>" --json

# 1) 建编排任务：spec 从文件读，避免 shell 改写文本
orca orchestration task-create --spec "$(cat 任务书.md)" --json

# 2) 起工人：task 用上一步 JSON 里的 id；worktree 用第 0 步 JSON 的完整 id（repo-id::path）
orca orchestration worker-start --task <task_id> --worktree worktree:<repo-id::path> --agent <agent> --json

# 多工人时：改文件的子卡挂任务卡下，git 从任务分支切
orca worktree create --parent-worktree 'name:#<PR号> - <动宾短语>' --base-branch <任务分支> --name "角色·模型" --json

# 审官 / 临时诊断工等辅助卡：挂被服务的任务卡下，归档整树收口
orca worktree create --parent-worktree 'name:#<PR号> - <动宾短语>' --name "审官·<型号>" --json

# 3) 取 dispatch id：从 JSON 里取，不解析人读文本
orca orchestration dispatch-show --task <task_id> --json

# 4) 验开工：读回输出，token 计数在涨才算开工
orca orchestration worker-read --dispatch <dispatch_id> --json
```

## 三条命令级铁律

- 多行或含反引号文本先落文件，再 `--spec "$(cat 文件)"`——禁双引号裸拼（反引号裸拼吞字符 2 例）。
- 命令只信 `--json` 出口：例：`orca orchestration dispatch-show --task <task_id> --json`——字段一律从 JSON 取，不解析人读文本。
- 路径从 PR 反查，禁手抄：例：`gh pr view <PR号> --json headRefName -q .headRefName`——分支名从 PR 的 JSON 取，不手抄。
