# Orca 编排底座探索报告（pi agent · 2026-08-11 · v3 门阀共议稿整合 + 质量层重造）

> 任务来源：`_tmp/DIRECTION-orca.md`。v3 变化：整合用户与指挥官三轮共议的**出口门阀草案**（含两次收窄拍板）；按三次拍板（「还是太重」）**重造质量保障层**——批级异步复审与「判据类先过对抗验证」窄铁律均不预设保留，参考业界形态以轻为默认重建。出处纪律：线上来源带 URL（本机 curl 实取，HTTP 200）；凭模型知识写的逐条标注「模型知识·未核」。
> 性质：探索 + 提案，不动 dao 规则文件；orca 命令全程只读。
> 证据基座：orca 两份版本匹配手册（v1.4.179 二进制吐出）+ 各级 `--help` + `run-list`/`task-list`/`agent-context`（159KB schema）/`agent hooks status` 探针；dao 侧四份文件通读。

## 0. TL;DR

- 编排底座迁 Orca 成立的根因：dao 派单体系最痛的病（无头不可观测/幽灵进程/轮询等待/条款投递率 9%/明文门 92KB）全是「Claude Code subagent 底座 + 文字纪律」的病，Orca 原语逐格对症（§1）。
- 质量保障层按「出口门阀」重造：**工兵的话一概不信，盘上的事实一概机核；只扫 diff 不扫全仓**——五道机械门（秒级）→ 帅薄终审 → 合并链（全量测试原样保留）→ 批级异步雷达（不拦路）。明文条款让位给**交活单 schema**：过程自由、出口收严（§3）。
- 「判据类/护栏类先过对抗验证」铁律的替代：**举证责任机制化**——交活单 schema 对护栏类改动加「先破再验证据」必填格，合并链机检该格存在。对抗官方法论（mutation 那套）从「必经门」降级为「举证格式 + 按需雷达」（§3.4）。
- 业界形态对照支持这个方向：机器查的做门、人判断的做门、**模型建议的不做门**（§3.5，三条线上来源）。

---

## 1. Orca 编排原语（只读实测，v2 起未变，压缩保留）

| 层 | 原语 | 要点 |
|---|---|---|
| Run | `run-create`/`run-use` | 命名空间+协调者收件箱；一 Run 绑一协调者（takeover 有显式原语） |
| Task | `task-create --spec [--deps]` | 状态六值；**原生 DAG**；连续 3 败熔断标 failed；`--ready` 只列依赖已清的 |
| Dispatch | `dispatch --inject` / `dispatch-show` | 生命周期权威；preamble 自动注入（worker_done/heartbeat/ask 规矩+两个 ID） |
| Worker | `worker-start`/`worker-show`/`worker-read`/`worker-release`/`worker-retain`/`worker-stop`/`--retry-of` | `--agent claude\|codex\|pi\|...`；`--model`+`--effort`；`--on` 跨机 |
| 消息 | `check --wait`（FIFO Delivery + **ack 重放**）/ `send`（含 `--to dispatch:<id>`）/ `ask`/`reply` / `gate-create`/`gate-resolve` | Delivery 不 ack 就一直重放——**未处理事项有持久形态，赖不掉** |

关键实测/实证：
- `run-list` 只有空墓碑 ⇒ DB 干净。
- **`agent-context` 159KB schema 无 worker 权限层**（permission 只涉 computer-use/Android/HTTP auth）⇒ 权限边界全在 worker 各自 agent CLI 配置。
- **`automations` 是 cron 不是事件**；`agent hooks on/off/status` 是 Orca 往 claude/codex 的 settings 装**自己的状态采集 hook**（worker-read 转录来源），**不是开放的事件订阅**；pi 不在受管理列表 ⇒ pi worker 的 worker-read 落 terminal 降级档（有界输出，知情接受）。
- pi 在手册 agent id 枚举内（`claude | codex | omp | pi | grok`）⇒ 可用 `--agent pi` + 内网 new-api 网关（边际成本≈0）。

## 2. dao 派单体系三分类（压缩保留，全文见 v2）

- **可删**（机制替换文字）：「别停等 Monitor 通知」/停摆类条款 · 官种 profile 四份+`[#派-官种底座]` · `dao-subagent-clauses.js` · `[#官通-先读后写]`（Claude 宿主规则，按 worker 类型附带）· 档位调整里 workflow/别名半 · 「越权先查」转录 Grep 路径。
- **要改写**：派单令首行→task spec 模板 · 军衔四级→`--agent`+`--model` 映射 · 对话席铁律→`send --to dispatch`/`worker-stop` · 接手令四格→`--retry-of`+spec · worktree→`worktree create`（本仓托管）· 成本门 15× 分母重估。
- **照旧**：诚实铁律全线 · mutation 方法论（改挂举证格式，见 §3.4）· 止步 gh pr create · 基点对齐 · PR-first · 工艺铁律（`--body-file`/禁 2>&1/编码）· 三层归位 · issue 中枢。

---

## 3. ★ 质量保障层重造（三次拍板：以轻为默认）

### 3.0 重造原则（用户与指挥官共议，可优化不可弱化）

> **工兵的话一概不信，盘上的事实一概机核；只扫 diff 不扫全仓（秒级出结论）。**

### 3.1 出口门阀（六道框架，两次拍板收窄后的形态）

| 门 | 内容 | 耗时 | 红的处置 |
|---|---|---|---|
| 1 格式门 | 交活单机器可解析：任务号/commit 清单/验证命令+真实退出码/改动文件清单；schema 校验 | 亚秒 | 自动打回附模板 |
| 2 凭据门 | 单上声明 vs 盘上对账：commit 真存在、文件清单与 `git diff --name-only` 一致、命令带退出码 | 亚秒 | 打回 |
| 3 边界门 | diff 文件名 × 禁区路径表（secrets/CI/部署配置） | 亚秒 | 打回 |
| 4 卫生门 | 正则扫 diff 内容：冲突标记/真 key 形态/乱码 BOM/超大文件 | 亚秒 | 打回 |
| 5 限时重放门 | 只重放工兵自报耗时 ≤5s 的验证命令；硬顶 10s；**超时跳过不算红、转合并链兜底**（用户拍板收窄：出口必须秒级，最坏耗时由构造保证是常数） | ≤10s 封顶 | 复现红 ⇒ 打回；超时 ⇒ 记「未验」不记红 |
| ~~6 质检官门~~ | **已从出口路径摘除**（用户拍板：太重）→ 降为批级异步雷达（§3.3） | — | — |

**过五道机械门（全亚秒~10s，零模型调用）→ 帅终审（读结构化结论，薄但不可让渡）→ 合并链（dao-pr-merge + 全量测试原样保留）。**

**落地形态**（共议稿）：宿主无关的 `scripts/dao-exit-gate.mjs <worktree> <交活单>`，退出码 0 过 / 1 红 / **3 没交单也算红**；自身进 tests/ 按「先破再验」守。**交活单 schema 就是新的官侧条款**——过程自由、出口收严：92KB 条款里「出口该交什么」的那部分被 schema 吸收，「怎么干活」的那部分还给模型自由。

### 3.2 重点探明（共议稿点名的三格）

**① worker_done 能否挂自动触发？—— 不能，也没有必要。**
实证：Orca 无事件订阅（automations 是 cron；agent hooks 是 Orca 自用的状态采集，不开放自定义动作）。事件通道就是 `check --wait` 拉模型。⇒ **门阀的触发点 = 帅收到 worker_done Delivery 的那一刻**（处理环是架构枢纽）：`check --wait` 醒 → 先跑 `dao-exit-gate.mjs` → 绿才 ack，红不 ack（重放赖不掉）+ 打回。「自动」由 ack 语义兜住：**不跑门阀就永远处理不完这批邮件**。

**② 打回回路用什么机制最顺？—— `orca terminal send`，且必须排在 `worker-release` 之前。**
对比：`send --to dispatch:<id>` 是 inbox 邮件，worker 要**自己 check 才看得到**——而 worker 发完 worker_done 就 idle 在 prompt 上，不会 check ⇒ 邮件打回会死等。`terminal send` 直接把红单打进它的输入框、立即唤醒续跑——**这才是「自动回路」**（共议稿选的就是它，评估确认最优）。时序纪律：对账 → 红则 terminal send 打回（保留现场）→ 绿才 worker-release。限两轮，第三轮升帅（连红两轮说明任务本身或交活单有问题，不是工兵手滑）。

**③ 六道门有没有该增删的？—— 不增不删，两处实现注记。**
- 第 5 门「工兵自报 ≤5s」与「工兵的话一概不信」存在张力：耗时自报也不可信。实现注记：重放资格不看自报耗时，看**命令形态白名单**（如 `node tests/<单套>` / `node scripts/<已知快脚本>`），不在白名单的一律记「未验」转合并链。白名单住 dao-exit-gate.mjs 里，是代码不是叮嘱。
- 候选观察线（只出声不判红）：**diff 尺寸**。依据见 §3.5 E6——评审效力随尺寸锐减；先以观察线攒数据，够数再议判红（这符合本仓「先观察线后硬闸」的惯例）。

### 3.3 批级异步雷达（原第 6 门的新位置）

- 挂载点：合并链/收官，与全量测试**并行**跑（墙钟近似零新增）。
- 形态：Opus（或 pi `gpt-5.6-luna` 试点）批级复审一整批 diff，产出**评论落 PR/issue**，发现问题开新单。
- 性质：**雷达不是门**——永不拦工兵的打回回路，永不阻塞合并。它替代的是「每活必过对抗官」的覆盖焦虑：抽检+批检代替逐件前置审。

### 3.4 「判据类/护栏类先过对抗验证」窄铁律的替代（三次拍板不预设保留 ⇒ 我的提案）

**撤门，换举证责任机制化**：
1. 交活单 schema 加**条件必填格**：diff 触及护栏类路径（`check-*`/`guard`/hooks/拦截清单——路径表机判）⇒ 「先破再验证据」格必填（改坏→红、复原→绿的两态记录 + 至少一种换靶形态）。
2. **合并链机检该格存在性**（秒级）：触及护栏路径而没有证据格 ⇒ 合并链拒。这是机制不是叮嘱。
3. mutation 方法论全文（两态/调用点覆盖率/红集归因/负控一格一样本）从「必经门」改为「**证据格的填写规范**」——内容一个字不丢，强制力从「再派一个人」换成「schema 必填 + 雷达抽检」。
4. 帅在终审看到护栏类改动时**可**现场升格（要求补对抗官深审）——终审不可让渡包含这个裁量。

**为什么敢撤**：旧铁律治的病是「护栏缺陷先合后审进主干」。新结构里同一病被三层分担：举证格式（出口）+ 合并链机检（合并前）+ 批级雷达（合并后）。它不再是「一个人必须读一遍」，而是「证据必须存在且可复查」——**可复查性**才是那道门真正提供的东西。

### 3.5 业界形态对照（出处纪律：线上带 URL，模型知识逐条标注）

- **E1（线上，已取）** Anthropic 官方多 agent 博客：「more capable orchestrator models are increasingly able to evaluate subagent work directly **without a separate verification step**. However, verification subagents remain valuable when using less capable orchestrators」；且验证 subagent 的合理形态是**黑盒机核**（「run tests and report results does not require implementation context」；适用面列举全是跑测试/lint/schema 校验）。⇒ 帅（Fable，最强档）直接评 + 机核做验证步，独立验证官不预设——支持撤第 6 门。https://claude.com/blog/building-multi-agent-systems-when-and-how-to-use-them
- **E2（线上，已取）** 同博客：「teams build elaborate multi-agent systems with separate agents for planning, execution, **review**, and iteration, only to discover lost context at each handoff and **spent more tokens coordinating than executing**」（multi-agent 典型 3-10× token）；「Dividing by type of work (one writes features, another writes tests, a third reviews code) creates constant coordination overhead」⇒ **「实现官/评审官强制分离」正是业界点名的反模式**——这是「还是太重」直觉的线上证据。
- **E3（线上，已取）** GitHub branch protection：required status checks（机检做门）+ required reviews（人审做门）+ merge queue（合并串行化 + 合并后验证）——CI 门禁业界形态一句话：**机器查的做门、人判断的做门、模型建议的做评（comment）不做门**。本方案 §3.1/§3.3 与此同构。https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches
- **E4（线上，已取）** Anthropic Managed Agents 文档：advisor（mid-turn 咨询更强模型）/ escalation（疑难子任务升级）/ session budget（全线程共享预算帽）——「质检官」在官方形态里是**顾问与升级通道**，不是门禁。https://platform.claude.com/docs/en/managed-agents/multiagent-orchestration.md
- **E5（模型知识·未核）** Google/trunk-based 实践：pre-submit 只跑快检，全量测试在 post-submit/merge queue，红了自动回滚——「全量不必拦在每件出口」的工业先例（出自 Google SRE/eng-practices 的通识转述，本次未取原文）。
- **E6（模型知识·未核）** 代码评审缺陷发现率随 diff 尺寸锐减（业界常引 SmartBear/CISQ 口径：>~400 行骤减）⇒ 小步 PR 比加深审查更划算——支撑 PR-first 与 diff 尺寸观察线（本次未取原文）。

### 3.6 重造后的质量层全景（一张表）

| 层 | 是什么 | 耗时 | 拦不拦 |
|---|---|---|---|
| L0 出口五门 | 机械机核（schema/对账/边界/卫生/限时重放） | 秒级，上限 10s 常数 | 拦（自动打回，两轮升帅） |
| L1 帅终审 | 读交活单+门结论+diff 概览；护栏类看证据格 | 分钟级，薄 | 拦（不可让渡） |
| L2 合并链 | dao-pr-merge + 全量测试（--env 串行环境） | 分钟级 | 拦（现状保留） |
| L3 批级雷达 | Opus/pi 异步批审，评论落 PR/issue | 与 L2 并行 | **不拦** |
| 已拆除 | 每活必过对抗官 · 92KB 明文门 · 出口质检官门 | — | — |

---

## 4. 取向 3：账本——issue 主账 + 完工回写桥

- 无事件 hook（§3.2①）⇒ 回写走**帅的 Delivery 处理环固定一步**：对账（门 2）通过后 `gh issue comment`（outcome+commit hash+dispatch id+报告路径）。零新组件；环不会漏（ack 重放），环里那步靠模板。
- 双向指针：spec 写 issue #N；回写评论写 dispatch id。Orca DB 换机即丢 ⇒ **issue 是唯一活过换机的账本**，回写必选。
- 打回回路与回写共用同一处理环，一处模板化。

## 5. 取向 1：帅位 = Fable + Opus 质检官（按三次拍板修订）

- 质检官**从出口路径摘除**（不拦任何单）；两个保留形态：**advisor 式**（帅终审时疑难格现场咨询——E4 的官方形态）与**批级雷达**（§3.3）。
- 免质检清单不再需要——默认全部免，升格由帅裁量（护栏类改动靠 §3.4 证据格兜底，不靠人）。
- 档位映射：帅=Fable（主会话）；尉/兵=`--agent pi` + new-api（kimi-k3/glm-5.2/deepseek-v4-flash 契约闭合件）；校/雷达=Opus 或 pi `gpt-5.6-luna` 试点；判官跨族天然成立（pi vs Claude 不同族）。
- 第一约束从 Anthropic 限流换成 new-api 网关并发容量（未标定，拍板点 P2 的压测）。

## 6. 取向 4：一步切换——清单 / 步骤 / 风险与回退

**新建**：`ccswitch/rules/dao-orchestration-orca.md`（派单层正文：协调者循环+spec 模板+门阀挂载+回写桥）；`scripts/dao-exit-gate.mjs` + 它的 tests/（先破再验）。（可选）`ccswitch/scripts/dao-orch.mjs`（task-create+worker-start 封装，条款渲进 spec——Quote 形态 76-77% 杠杆，拍板点 P4）。

**改写**：`dao.md` 帅节存根指向新文件 · `dao-dispatch.md`（可删清单删除、其余按新形态改写，预估 25KB→8KB 量级）· `dao-officer-clauses.md`（底座绑定类删/改写，92KB→55–65KB，与 #301 同一刀）· `docs/rules/dispatch-clauses.md` 派单中枢节 · `dao-worktree` SKILL（本仓默认 orca）· `dao-pr-merge.ps1` 前置加「护栏类证据格机检」。

**删除/退役**：`dao-subagent-clauses.js`（摘钩+删文件+回归网同步）· `agents/dao-{implementer,adversary,scout,dogfood}.md` · render-clauses 的 hook 消费路径（渲染器保留给 dao-orch 复用）。

**照旧不动**：合并链主体 · run-tests 全套 · 条款库守卫 · config-sync · stacks · 其余 hooks。

**迁移步骤**：①首例实测（用 #300 收尾，验 U1/U2/U4/U6）→ ②新派单层文件+spec 模板 → ③条款改写批（=#301 瘦身主体）→ ④退役批 → ⑤合并链接入。

**风险与回退**：R1 Orca orchestration 是 experimental（三方产品改/砍风险）⇒ git revert 全回（改动全是文本），账本在 issue 不丢，DB 残留由用户 `reset --all` · R2 preamble+dao 场域叠加（首例第一验；撞车则 worker 全倒 pi）· R3 pi worker-read 降级（知情接受）· R4 gate-resolve 权限面未明（首例验；若不限帅则门 1-5+终审仍成立，gate 仅作留痕）· R5 迁移批自身用旧流程验（最后一批旧流程，元风险写明）· R6 worker 环境继承面（首例 env 清点）· R7 new-api 并发容量未标定（P2 压测）。

## 7. 未验清单

U1 preamble+dao 场域叠加 · U2 `--agent pi` 全链（TUI idle/降级读） · U3 new-api 并发容量 · U4 gate-resolve 权限面 · U5 DB 换机路径 · U6 worker 环境继承面 · U7 `--model` 对 pi 是否生效。首例实测覆盖 U1/U2/U4/U6。

## 8. 拍板点

- **P1** 质量层重造方案（§3 全景：五门+薄终审+合并链+雷达；撤「必过对抗官」换举证格式）——指挥官二次分析后呈用户。
- **P2** pi 对照实验 + new-api 并行压测授权。
- **P3** 首例用 #300 收尾（建议）。
- **P4** `dao-orch.mjs` 薄脚本做不做。
