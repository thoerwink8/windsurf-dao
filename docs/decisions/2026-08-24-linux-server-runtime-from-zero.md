# 2026-08-24 拍板：运行时搬 Linux 服务器——Windows 本机转人工，服务器全自动

> 拍板记录。起因：用户连续几天使用不适，用 /grill-me 五步法从头拷问「orca 帅位→工人→审查官」体系。
> 本文只记拍板、判据与被覆盖的旧拍板；实现另开单。

## 谁提的，什么场景

用户 2026-08-24 提出六条痛点：规则越写越多但派单不及时；看门狗与保活一直失效；orca 卡片终端异常不反馈；本想要 orca 自动化但问题太多；发现 Cursor Cloud 好用；开始质疑「疯狂建 small issue 再去修」的做法。

对账发现同一诉求在 24 小时内是第二次，粒度问题是第三次：

- #763（2026-08-24 凌晨）问过「文档仓 vs 运行时」，当时拍板「仍是运行时仓」。本次覆盖它的前提。
- #668（8-19）与 #681（8-20，用户原话「每次建 issue，需求特别小……最好是合并成一个大 issue」）已提过粒度，两次应对都是造新机制去缓解细单，不是让细单变少。

## 决定性事实

### 一、砍过一次，九天长回 4.3 倍

| | 8-14 退役拍板当天 | 8-23 | 倍数 |
|---|---|---|---|
| 仓内文件总数 | 274 | 1329 | 4.8× |
| `scripts/` + `tests/` 行数 | 23,321 | 99,741 | 4.3× |
| `scripts/*.mjs` | 11 | 75 | 6.8× |
| 测试文件 | 5 | 57 | 11.4× |

8-14 已完整拍板「规则体系退役」并执行（拆 config-sync、11 份规则文件、9 个 hooks、19/20 套旧测试）。只砍不动生长源，九天后长回四倍还多。

### 二、体系的唯一客户是它自己

8 月 375 张 issue（日均 16 张）。按标题分类，服务对象在本体系之外的只有 3 张（#136 resume-project JWT、#137 与 #139 devin-credit-claimer）。账本 8-15～8-22 回填的 110 个完成 job 全部落在自举。

闭环：唯一客户是自己 ⇒ 每次故障合法生成新 issue ⇒ 新 issue 造新机制 ⇒ 新机制新增故障面。这是结构，不是纪律松。

### 三、#652 方向早就拍对了，是 Windows 拒了

#652 拍板「Windows 计划任务保活 watchdog（**OS 是非 AI 终点**）」并划界「不造看门狗的看门狗」。实际路径：`schtasks` 被系统拒绝 → 退到启动文件夹 cmd 循环 → 该循环自身会死（#693 原文「看门狗的看门狗盲区在保活层重现」）→ 最终落成帅位 hook 触发（SessionStart + UserPromptSubmit，**要人在键盘前**）。账上两笔：守卫停摆 5 小时无人知（#683）、守卫死 15 小时无人知（主树停在非 master 分支）。

**systemd 就是 #652 要的那个「OS 级、不依赖会话」的终点。Windows 给不了，Linux 免费给。** orca 官方有《Headless Linux Server》部署文档（861 行；Ubuntu 20.04 / 22.04 / 24.04 与 Debian stable，glibc ≥ 2.31；含 systemd unit、Xvfb 托管服务、`journalctl` 健康检查、升级与回滚），另有 Linux AppImage 与 AUR 正式发行、`orca serve` 无头模式、WebSocket 配对远程客户端。

### 四、orca 已内置四样本仓重造的东西

| 本仓的实现 | orca 自带 |
|---|---|
| `flow.mjs` 1404 行常驻轮询 | `orca automations`：cron / RRULE + `--precheck`（非零记 skipped）+ `--missed-run-grace-minutes` + `--reuse-session` |
| 五层判活链约 1429 行（keepalive / mirror / revision / halt / seat） | systemd `Restart=on-failure` + `StartLimitBurst` + `journalctl` |
| #673 第四席 `dao-watchdog[bot]` 写 GitHub 以「叫醒人」 | 手机 companion：live agent status、usage、switch accounts |
| `policy/models.yml` + `bans.yml` + #669 额度耗尽停派 + #688 通道优先级 | live API usage meters + account switching |

`--precheck` 的语义（非零退出记 skipped run 而非失败）正是 #532 花一整张单立的「查到 0 条 ≠ 没查成」。

### 五、审官的代码质量标准是空指针

`reviewer-book.md` L3 与 L122、`soldier-book.md` L92 三处把判定标准推给「当时的审官任务书 / 审读规矩」。全仓（除 `tests/`、`ledger/`）搜 `审读规矩` 只命中这三处指针本身，**被指的文件不存在**。审官任务书 122 行里讲代码质量的有 0 行，其余是收信协议、判定行字符串格式、`gh-as` 身份、merge-policy、draft 转换、label 同步、结算、心跳禁令。同类缺陷前例：#286（指向已关闭 issue）、#292（指向没人看的 rules 文件）、#340（命令表空指针）；`docs/ideas.md` 第 19 条「dao-check 补跨文件指针检查」未做。

## 五步法结论

### S1 质疑需求 —— 需求成立，载体也成立

结果层保留，标准仍是 8-14 那句：「我拍板，活被干对，不要让我操心过程；模型选最合适的，快、少出错、出错有兜底。」

载体层用户拍板**保留 orca 编排**：多套餐按模型特长派活是真价值；orca 能同时起异厂终端，多臂盲考（`design-exam`，要求各臂起在中性目录、不读仓内约定）只有它做得到。

### S2 删除 —— 删「Windows 本机自动派单」整层

用户拍板：完全按 Linux 走，Windows 本机脱离自动派单改人工派单；**服务器端全自动是第一性原理**。

方法论与无人看守能力**不删**，只换承重面（systemd + `orca automations`），本机保留手动入口。因此没有能力被丢掉，被删的是 Windows 专有的保活与判活管道。

### S3 简化 —— 三条合并加一个定位

1. **一条命令两处用**：本机手动调它，服务器 automations 调同一条。不留「服务器版」分支——双真相源前例见 #753（orca 桌面旗标 vs 仓内 launch）。
2. **一个真相源：GitHub**。PR 是任务，issue 是队列，review 是判定，merge 是收口。把 #686「恢复锚 GitHub 不锚信箱」执行到底，删掉 `_flow/*` 本机文件当权威状态的一切用法。
3. **automations 的 prompt 只写「跑这条命令」**，不写业务逻辑。prompt 是 LLM 输入会飘，命令是确定的。

**定位**：本仓是那台 Linux 服务器上的多模型派工闭环运行时；Windows 本机是它的手动客户端。README 那句「AI 和人一起干活的协作机制」要改窄——它什么都装得进去，这是本仓长到十万行没人喊停的原因之一。

### S4 加速 —— 只加速人在等的三段

搬服务器后「慢」的定义变了：机器等多久不花用户的时间，只有人等的那几段算慢。

1. **拍板到活开始跑**。#760 记「一行 README 派 10 次烧 14.5 小时」；PR #761 已把方向改对（fire-and-forget，热路秒级返回「已受理」），#762 补两处漏接（`--repo` 选择符、`consumer_fenced`）后成立。本机改手动后这段更该秒级——手动意味着人在等。
2. **活跑完到人知道**。用 orca 手机 companion 推送，**不自造报帅通道**；#673 写 GitHub 的机制留作留档，但 GitHub 评论不叫人。
3. **全量测试不挡路**。#300 记「验证那个改动本身只要 1.2 秒，走完流程要跑两遍全量测试 12 分钟以上」；CI 异步跑，人不排在它前面。

**明确不加速**：审官乒乓轮次、automations 轮询间隔、机器互等的任何一段。花的是机器时间，而每次加速都要新增判活或重试层——本仓补丁链一半这么来的。

**反向一条：给拍板加过夜闸。** 影响体系的拍板不当夜落地，第二天复看还认才开工。前例：#688 推翻 8/20 拍板、#684（#545 方向被拷问推翻）、#487（拆单判据被推翻）、#489（自由文本解析连续四层失守）、#763（当夜拍板次日覆盖）。全自动会放大拍板错误的成本——以前拍错了慢慢做还能拦住，以后拍错了服务器一夜做完。

### S5 自动化 —— 待拍板

## 保留 / 删除清单

| 东西 | 判断 | 理由 |
|---|---|---|
| 五层判活链（guard-keepalive / mirror / revision / halt / seat，约 1429 行） | 删 | systemd `Restart=on-failure` 顶掉 |
| `flow.mjs` 常驻轮询 1404 行 | 删 | `orca automations` + `--precheck` 顶掉 |
| `watchdog.mjs` 2091 行 | 瘦，不删 | 进程死活归 systemd；「agent 撞限流 / 卡在弹窗」systemd 看不出来，这部分留 |
| `inbox-station.mjs` 1242 行 + 租约 | 先留，实测再定 | 服务器常开后中继是否仍需保活未实测 |
| 80 处 `windowsHide` + 6 个 powershell 依赖点 | 删 | Linux 上不存在；powershell 依赖：`lib/guard-keepalive.mjs`（`Get-CimInstance Win32_Process`）、`inbox-station.mjs`、`dao-check.mjs`、`lib/machine-path-check.mjs`、两个 cursor-agent shim |
| 保活类 hook（SessionStart / UserPromptSubmit） | 删 | 保活不再靠人敲键盘触发 |
| `quick-fix.mjs` 微通道 620 行 | 删 | 它是让细单变便宜的补贴，已决定回到大需求 |
| 判定行字符串协议 + `judgment.mjs` | 删 | #573 后审官能真 approve / request-changes，GitHub 状态本身机器可读，两套留一套 |
| 消歧门 hook 那一层 | 改，不删 | 从 PreToolUse hook 改成 `dispatch` 命令自己的前置检查——服务器上挂不了交互式 hook |
| 「帮我开单」 | 留，换形态 | 文字三问没拦住（375 张单）。改成命令：强制填「做到什么算做完」「这批还是下批」「能否独立交付一个会用到的能力」，填不出不给建。服务器自动开单走同一道闸 |
| 「起工人 / 起审官」 | 留，核心 | S1 的核心价值。硬约束：本机手动与服务器自动跑同一条命令 |
| 选型 `dianjiangtai-core.mjs` 632 行 | 留能力匹配，外包额度层 | 能力匹配是用户的判断；额度与换号交给 orca usage meters |
| `ledger/` 账本 | 留 | 全自动后更看不见过程，这是「哪个模型在哪类活上好用」的唯一数据源；append-only 一事件一文件，跨平台无障碍 |
| bot 三身份 + `gh-as.mjs` | 留 | 全自动后「谁干的」必须可追，70 行，便宜 |
| `dao-check.mjs` 25 项 | 留框架，筛项 | ⑦（orca --help）⑧（态注入 hook）⑨（memory Junction）⑳（仓外路径）为 Windows 本机状态而设，要改要删；①③⑤㉖ 与平台无关，留 |
| `grill-me` / `design-exam` / `grill-ai` | 留 | 真方法论且由人主动调用，符合判据。`design-exam` 搬服务器后更好使——多臂盲考需要一台不睡觉的机器 |
| `docs/decisions/` + `docs/ideas.md` | 留 | 零成本，唯一活过重构的东西 |

判据只有一条：**留下来的每一样，必须是「一条能跑的命令」或「一份供查的档案」，不许是「一段要记住的纪律」。** 8 月最贵的教训——8-14 拍板说不把「AI 记得守规则」当承重墙，但承重墙缺一块，只能用文字顶，规则必然反弹。

## 搬家前必须先做的一条

**补审官的代码质量标准**（填掉上面第五条的空指针），删掉任务书里讲协议的行。

理由：全自动之后无人在旁，坏的审查会被自动化放大成一堆 approve。现在至少能当场发现审官在审判定行格式。**优先级高于搬家本身。**

## 被本次覆盖的旧拍板

1. `docs/dianjiangtai-design.md` L387「中心服务器发令牌 / 重型 credential broker 弃」，理由是「换机、离线、git 原则全破」。本次凭据集中到服务器，前提「会换机」不再是设计约束。
2. #763（2026-08-24 凌晨）「仍是运行时仓，不按尽量删测试来」。身份改为「Linux 服务器上的运行时仓」，Windows 本机不再是运行时；「测试不按尽量删」这半仍然成立。
3. 8-15 融合裁定书的「`worker_done` 有效即自动结账」与「裸 `terminal create + dispatch --inject` 旁路封死」——**本次不动**。搬平台与删结算层是两件事，不绑在一起做。

## 体系类三问

1. **谁提的，什么场景？** 用户 2026-08-24，六条痛点 + `/grill-me` 五步法；同一诉求 24 小时内第二次，粒度第三次。
2. **删哪一层能让这个问题不存在？** 删「Windows 本机当无人值守运行时」这一层。五层判活、`flow` 常驻、powershell 依赖、保活 hook 全是这一层的派生物，层去则它们无宿主——不是要重写，是没有存在理由。
3. **从零重做今天还会造它吗？** 会造「多模型派活的命令库 + 一条自检 + 拍板档案」，跑在有 OS 级监督者的 Linux 上。不会造自研保活层、判定行字符串协议、为细单造的微通道、700+ 夹具。

## 验收（实现另开单，不在本 PR）

- [ ] 补审官代码质量标准，删协议行（搬家前置，优先级最高）
- [ ] 服务器起 `orca serve` + systemd（含 Xvfb），同提交更新 `NEW-MACHINE.md`
- [ ] 删五层判活链，systemd 顶替；验收证据 = 故意 kill 进程后自动拉起的记录
- [ ] `flow.mjs` 常驻换 `orca automations` + `--precheck`
- [ ] 删 80 处 `windowsHide` 与 6 处 powershell 依赖
- [ ] 删 `quick-fix.mjs` 微通道、判定行协议与 `judgment.mjs`
- [ ] 开单改命令化（强制填三问，填不出不给建）
- [ ] `inbox-station.mjs` 实测后再定去留
- [ ] `dao-check` 25 项按服务器形态筛一遍
- [ ] README 与 `NEW-MACHINE.md` 定位改窄
- [ ] 拍板过夜闸：夜里的 automations 只做已过夜的单
