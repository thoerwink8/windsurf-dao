# dao 体系重塑计划 · 202608

> 来源：2026-08-01 为道日损审计舰队（6 维双向审计 × 逐条对抗验证，12 官 opus5，32 条确认 / 8 条被对抗官驳回）。
> 用户三目标：①为道日损（瘦身）②补共性（项目有、dao 缺的 canonical）③dao-first（先改 dao 再下沉项目当场验证，一石二鸟）。
> 成功判据：重塑后 dao.md 净变短；新增只准是 canonical artifact（把卡在项目里的搬进共享）。
> 完整审计原文（32 条含 verify_note）：本仓会话产物，见 mousse 会话 `wzzl6k5yk.output`；本文只留裁决与动作。

## 执行形态

- windsurf-dao 开分支 → PR 呈审，**不自合**——dao.md 是 always-on 注入源，用户过目后合并。
- 批 A 死链/错处方（照做档，修法唯一）先行；批 B canonical 化（用户目标②主体）随后；批 C dao.md 正文砍并（判断档）做成 PR 等拍板。
- 所有 action 采**对抗官收窄版**，不采审计官原始版（多条原始 action 被证伪，见各条括注）。

## 批 A · 死链与错处方（11 件，官可机械执行）

| # | 对象 | 动作（收窄版） |
|---|---|---|
| A1 | desktop-tauri.md:53-59 | 🔴最优先：删「Stop-Process -Force 清 9222」错处方（教人杀用户装机实例）与「唯一端口即根治」错兜底（已被 user-data-dir 绑定实证证伪）；换「不杀进程 + 独立 udf + 起后验端口归属（祖先链）」三判据 + 指针 |
| A2 | stacks/ci-github-actions.md:35-58 + ci-cost-gate.md:10 | CI 处方是死 workflow（job 级 if 引 matrix.os 非法）：换 strategy.matrix + fromJSON 三元式，加「matrix 严禁出现在 jobs.<id>.if」；顺手订正 mousse ci.yml:4-5 计费注释（windows ×2 才对） |
| A3 | agents/dao-spec-writer.md:121 + dao-worker-batch.md:86 | 孪生死指针（指向空节）：改指 AGENT_GUIDE.md §4.2「遣」（四要素）与 §4.3（RED→GREEN），不搬内容 |
| A4 | skills/dao-verify/SKILL.md:173 | 把已退役的 dao-evolve 改写为「/dao-evolution（读其 system-review.md）」；:175 不动（对抗官驳回附带改法） |
| A5 | 8 个 agent 尾注「方法论已归入 dao.md §动/§反」 | 节存在内容零命中，纯死指针，删 8 行（RED-GREEN canonical 已确认活在 AGENT_GUIDE.md:112，删不丢东西） |
| A6 | dao.md:220 transcript 路径 | `tasks/<agentId>.output` 实测不存在：改指 `<session-uuid>/subagents/`（用户那句话在子代理自己的记录里，不在报告原文里） |
| A7 | dao-harvest.js:60 + workflows/README.md:242 + dao.md:215 | WORKBOARD.md 已退役但文件在 ⇒ fallback 永不触发、收割静默读历史快照零候选：缺省挪走（先探 issue 区，无则 Glob docs/ops/*.md）；dao.md:215 承接物写两态（GitHub-backed→issue 区；非 GitHub→文件面板兜底，不删档） |
| A8 | dao.md 5 处裸 `docs/` 前缀 | 同一前缀跨两仓互补（:251 一行内同时指两仓）：照 stacks/ 形态补一行根路径消歧；注意 POSITIONING 两处本就该指项目侧，别改错方向 |
| A9 | dao.md:163 + 15 处「叙事 Nx」括注 | 只取方案①：`docs/evolution/*.csv` 放宽为 `docs/evolution/`，首现「叙事」处括注一次文件名；15 处正向括注**保留**（删=条款→事故正查链断） |
| A10 | dao.md:228 (FM17)/(FM15) | 全体系无 FM 编号表，删两括注留白话 |
| A11 | desktop-tauri.md:134 后半句 | 删「windows-mcp 仅在…时才用」这条启用条件（与一票否决禁令对撞）；对比表/兜底句/存档说明**都留**（对抗官：总括条款覆盖面大于枚举面） |

## 批 B · canonical 化（8 件，用户目标②主体，dao-first 落地）

| # | 交付物 | 要点 |
|---|---|---|
| B1 | **dao-issue-center 交付单元**（合并 4 条 gap）：`templates/labels.json` + `templates/project-board.json` + `templates/dispatch-hub.template.md` + `templates/pinned-hub-issue.md`/`inbox-issue.md` + `scripts/dao-issue-bootstrap.ps1` | 标签基线 14 减 `真机欠账`（兜底遗留）；`真机`/`守卫类` 判据抽占位符去 mousse 化；置顶走 `gh api graphql` pinIssue；「自动入板」标为人工一次；六列+标签→列映射为纯数据；dao.md:166/:171 指针改指 canonical；manifest 登记 class=**conditional**（when 复刻 dao.md:171 触发信号，不用 product-type——集合不同） |
| B2 | `templates/ISSUE_TEMPLATE/{bug,task,debt,decision}.yml` | 与 PR 模板同源 STAR+折叠+标签预填；manifest 加 product-type entry；注意收益边界：只在网页开单与 --template 支路兑现（对抗官降 med） |
| B3 | 隔离启动器 canonical（文档形态） | stacks/desktop-tauri.md 加「四条硬要求 + preflight + 三关自验（祖先链是决定性判据）+ 退出码契约」一节，**不搬 1172 行 .ps1 本体**；manifest `desktop-dev-debug-script` require 改 anyOf 或新立 desktop-isolated-launcher |
| B4 | 条款库结构闸 canonical | `ccswitch/` 落 clause-structure 检查器：条款文件路径 + **条款节选择器**双参数化（直接指 dao.md 会对散文 bullet 喷假 FAIL——对抗官证伪原方案）；保四判据 + n=1/n=? 分栏退役区 + 合成夹具；挂 dao-scaffold-check 或 config-sync 必经步 |
| B5 | manifest 加 `dispatch-clauses` entry | rationale 用对抗官修正版：dao-harvest.js 硬编码缺省+无回退 ⇒ 判重闸静默假通过（比死链更坏）；class=conditional；TraceyU 会即刻报一条，届时裁真缺口 or exempt |
| B6 | product-type 触发闭环 | CLAUDE.md 骨架内建「产品型项目」声明行；scaffold 在 claude-md 缺项时把「产品型/内部工具」问成必填槽位——现状全生态没有任何东西会把这四个字写进新项目 |
| B7 | 项目级 bootstrap 入口 | `/dao-project-scaffold --init`（或 dao.ps1 init-project）：带 canonical 的缺项直接物化，不可物化项写进项目 docs/USER-ACTIONS.md；范围限**增量创建**，删除/搬移仍走建议；须先删 SKILL.md「缺项不自动创建」那块砖 |
| B8 | manifest schema 加 `template:` 字段 + 修 :109 | pr-evidence 真相源迁进 dao（现指 mousse CLAUDE.md §二.5，违 dao-first）；报文改零编辑复制指令；真正需要 template 的只有 ~6 条（对抗官订正分母） |

## 批 C · dao.md 正文瘦身 + 结构性合并（8 件，判断档，PR 呈用户拍板）

| # | 对象 | 动作（收窄版） | 净效果 |
|---|---|---|---|
| C1 | L98-110 续力「豁免的是问不是续」 | 压 3 行（判据+自定标记+叙事指针）；**先写叙事 N10 再删**（现无 N10，直删=销毁记录） | -10 行 |
| C2 | L215 问题树单段（1300+ 字混装 5 件事） | 留三判据+🌾收割槽位原文；719/719 形态学论证外迁 evolution；**订正史压一行保留**（删=给被证伪旧规则留回流路径） | 净删但低于审计官宣称 |
| C3 | L22/L24/L153/L157「写到哪」 | 三处归属地重复合一；L155（dao-first 次序）是正交轴**不并**；L22 输出模板原文保留（槽位型）；L22/L24 移出「八句根基」节 | -若干行+节序归正 |
| C4 | L44 vs L194/L195 帅位两条线 | 收敛单一真相源，**取严不取宽**：「一次 Edit 级微调」为默认线，50 行/3 轮是派将强制线并标适用面（审计官原方案会静默抬高 700 行血泪基线的天花板） | 歧义清零 |
| C5 | L301/L332/L333 merge 链 mechanize | fetch→核 rev-parse→merge→重跑→prune 化成 canonical 脚本挂 **dao-tool-nudge hook**（PostToolUse Bash matcher——scaffold-manifest 只保证脚本在不保证被调用，载体错配被对抗官证伪）；**L302 patch-id 留正文**（内里是取舍非照做档） | 文字规则→机制 |
| C6 | commands/dao-loop.md vs skills/dao-loop | command 薄壳化，**迁移是前置**：孤儿检测四选一/参数解析/轮询模板三块先搬进 SKILL.md 再删；真实缺失是三条防推断硬约束在闸生效时刻缺席 | 双写清零 |
| C7 | skills/dao-loop/SKILL.md:152-165 | :165 用户级假承诺句删；表格压一行并入 §总览（整节删会丢唯一的阶段→方法论文件映射，采对抗官备选） | -12 行 |
| C8 | mousse .claude/rules/pr-evidence.md:38-56 | 已实证漂移（「管三面」vs 真相源「前四面」、「两共用面」vs「一面」）：砍成指针；:22-36 速查可留但标「冲突以 CLAUDE.md 为准」（mousse 侧 PR） | always-on 注入减 ~3KB |

## 依赖与顺序

1. A 批无依赖，先行（A1/A2 是危险错误内容，最优先）。
2. B1 依赖 A 批不冲突可并行；B7 依赖 B1-B3 的 canonical 先落地（「今天可物化的只有 1 个文件」→ 做完 B1-B3 后 B7 才有东西可物化）。
3. C 批全部走 PR 呈审；C1 前置写叙事 N10；C5 涉及 hook 改动（settings.json 投影问题——改 git 快照层由用户 restore）。
4. mousse 侧下沉验证（一石二鸟）：B1 bootstrap 脚本拿 mousse 当第一个验证对象（标签/看板已存在=幂等跑应零变更，即验证）；C8 是 mousse PR。

## 显式不覆盖

- 审计中被对抗官 REJECTED 的 8 条不执行。
- Projects v2「新 issue 自动入板」无 API——保持「人工点一次」诚实记载，不硬造自动化。
- dao.md 八句根基正文、军衔制、品·产品之思——审计未报问题，不动。
