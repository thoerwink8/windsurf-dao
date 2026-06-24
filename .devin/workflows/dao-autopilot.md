---
description: 自动驾驶模式：AI 自主分解目标、递归执行、反思间隙、语义回退，直到目标完全达成或用户中断。当用户说"自动驾驶"、"autopilot"、"帮我自动完成"时触发。
---

# 自动驾驶 · Autopilot

> 为无为，则无不治。知常曰明，益生曰祥，心使气曰强。

**此工作流是隔离模式**：激活期间 `ask_user_question` 豁免（等同于内观模式），退出后完全恢复正常。

---

## 设计哲学

> TODO.md 是任务图的唯一载体。AGENT_GUIDE.md 是人类可读知识库。autopilot 不创建平行系统——它直接操作这两个文件和 CSV 演化源。

| 文件 | 角色 | autopilot 行为 |
|------|------|---------------|
| `TODO.md` | 任务图（待做 / 已做） | 读取 `- [ ]` 作为任务源；执行后回写 `- [x]` |
| `AGENT_GUIDE.md` | 人类可读知识库 | 维护项目概览、架构决策、开发指南与 CSV 指针 |
| `data/evolution-*.csv` | 演化真相源 | 收尾时先 `ensure`，再写入演化条目与教训 |
| `state.json` | 执行元数据（仅回退用） | 只存 commit hash 和 rollback_cmd；完成后删除 |

两个文件不存在时 autopilot **创建**（初始化为标准格式），而非另建 plan.md / archive。

---

## 激活条件

- 用户显式说"自动驾驶"、"autopilot"、"帮我自动完成"
- 用户给出模糊目标，期望 AI 自主推进到完成

---

## 核心原则

| 原则 | 含义 |
|------|------|
| **目标锚** | 原始用户目标是不变的参照系，所有判断都对照它，防止漂移 |
| **单一载体** | TODO.md 是任务的唯一来源和状态，AGENT_GUIDE.md 是知识的唯一归宿，不建平行文件 |
| **任务图** | 任务有依赖关系，不是线性队列；移除一个任务需分析级联影响 |
| **一任务一 commit** | 每个 task 对应一个 git commit，是语义回退的最小单位 |
| **feature branch** | 所有工作在独立分支，主干不受影响 |
| **新鲜用户启发** | 反思时以"只读过原始需求的用户"为视角，防止 AI 完成偏误 |
| **工件先行** | 设计方案前必须先挖掘：参考实现（_tmp/、竞品）→ 本项目已有基础设施 → 上下游系统实际存储的数据。从实物推导方案，不从理论协议推导。闭门造车是最贵的第一性原理。 |
| **隔离** | 本模式行为只在工作流激活期间有效，不污染全局规则 |

---

## 单 Task 闭环铁律

> 慎终如始，则无败事矣。— 第 64 章

dao-autopilot 的所有任务推进必须遵循 **§2.1 五步循环 + §2.1.1 涅槃门** 单 task 闭环。
**绝对不允许「批量推进」**——连做多个 task 才一次 commit / update / 验证。

### 为什么不可跨 task 合并

1. **回退最小单位 = 一个 task**：合并多 task 一 commit，丢失精确 git revert 能力；用户说「撤销 Task X」时无法做到
2. **state.json 是跨 session 真相源**：攒着不写，session 中断时下次恢复看到的是「上一批没完成」的假象，可能重做或漏做
3. **TODO.md 是用户审查唯一接口**：攒着不更新，用户看到的是「假进度」——他以为还在 Task A，其实 Task A/B/C/D 都做了但都没标
4. **验证不能合并**：「不见 GREEN 不算闭环」——把多 task 攒着只跑一次 verify，等于把错代码当 baseline 累积下游 task

合并多 task = 用「效率」的虚名，损「可审计 / 可回退 / 可恢复」的实质，是反 dao 的「成事而败之」。

### 唯一允许的合并场景

**强耦合组合 task**：A 的 verify 隐含 B 的前置（如「装包 + 写 config」，写 config 的 verify 必然包含装包成功）。
- 必须在 commit message 显式写组合 ID，且保留当前宿主前缀：`[宿主] autopilot(TG-1+TG-2): ...`
- 必须在 §2.1.1 涅槃门中标明这是组合 task
- ≤ 2 个 task 合并；超过 2 个一律拆开

---

## 流程

### 一、激活（☲视 · 建立意图锚）

#### 1.1 初始化项目文件

读取或创建两个核心文件：

**TODO.md**（若不存在则创建）：标准三段结构——`## ✅ 已完成` / `## ❌ 已作废` / `## 🚧 待实现`。

**AGENT_GUIDE.md**（若不存在则创建）：标准两段——`## 一、项目概览` / `## 二、演化索引`（指向 `data/evolution-*.csv`）。

#### 1.2 意图建模

读取 TODO.md 中 `🚧 待实现` 下的 `- [ ]` 条目，结合用户当前目标，建立**意图模型**：

五字段：`原始目标`（用户原话不改）/ `成功标准`（可验证条件，对应 TODO 条目）/ `范围`（TODO ID 列表）/ `范围外` / `风险容忍`（保守/正常/激进）。

- TODO.md 有对应条目 → 直接映射，保留原 ID（如 `N1`、`F4`）
- 目标是全新内容 → 先在 TODO.md `🚧 待实现` 区追加条目，再映射

小缺失 → AI 自行补全并注明。大缺失（影响方向）→ 一轮 `ask_user_question`。

#### 1.2.1 Open Threads 扫描

如果 TODO.md 存在 `## 🌳 Open Threads` 区域（由 `/thread-tree` 沉淀），扫描其中的 `- [ ]` 条目并按类型前缀分类：

| 前缀 | 权限 | autopilot 行为 |
|------|------|---------------|
| 🔀 | 🔴 红灯 | **绝不自动执行**。跳过，累积到"需人类决策"报告 |
| ✋ | 🟡 黄灯 | 评估置信度：高置信→执行并标注 `⚡ AI assumed` + 理由；低置信→跳过，加入待决报告 |
| 🔨 | 🟢 绿灯 | 纳入任务图，正常自动执行 |

**置信度评估标准**（仅 ✋ 黄灯项）：
- **高置信**：上下文中有强暗示用户倾向某方案，或方案是讨论中的唯一候选
- **低置信**：存在多个未排除的方案，或用户曾表达犹豫

Open Threads 中的 🔨 项与 `🚧 待实现` 中的普通任务同等对待，合并进任务图。

#### 1.3 构建任务图（写入 state.json）

state.json 字段：`mode` / `goal` / `branch` / `started` / `success_criteria` / `tasks[]`。每个 task 含：`id` `desc` `todo_line`（精确定位回写用）`depends_on` `status` `commit` `rollback_cmd`。

依赖关系从任务语义推断；无明确依赖则设为空。

**分解原则**：
- 每个 Task 是独立的逻辑单元（一个功能、一个模块、一个修复）
- 依赖关系尽量扁平（宽而浅，优于深依赖链）
- Task 粒度：≤ 1 小时工作量，确保 context 内可完成

#### 1.3.0 state 文件为什么不放 `.windsurf/`（重要设计约束）

> **铁律**：autopilot state 文件**必须**放 `.dao-autopilot/state.json`，**不得**放 `.windsurf/autopilot/state.json`（v1 旧路径已废弃）。

**原因**：windsurf-dao 走 **Sidecar workspace** 模式 — windsurf-dao 作为伴生 workspace 打开时，目标项目**只有不存在 `.windsurf/` 目录**，Cascade 才会从 sidecar 加载 always_on rules（如 `execution.md` 含「禁 create_memory」铁律）。

如果 autopilot 把 state.json 放 `.windsurf/autopilot/`：
- 目录被创建 → 目标项目变成「有自己 .windsurf 配置」
- Cascade 切换为仅扫描本项目 `.windsurf/rules/`（空）
- **sidecar rules 整体被屏蔽** → autopilot 期间 Cascade 失去 dao 体系约束
- 实测后果：2026-05-11 TraceyU M1 autopilot 期间，Cascade 多次违反「禁 create_memory」铁律（属于 sidecar 的 `execution.md` 完全没注入）

→ 移到 `.dao-autopilot/` 后，`.windsurf/` 保持不存在，sidecar 持续生效。

#### 1.3.1 mode 状态机（autopilot-watchdog 依据）

> **背景**：「无感切号」插件 v2.15.0+ 内置 `autopilot-watchdog`，扫描 `.dao-autopilot/state.json`（v2.16.0+；旧版本扫 `.windsurf/autopilot/state.json` 兼容），当 `mode === "running"` 且 Cascade 静默 ≥120s（state.json mtime + state.vscdb mtime 双信号）时，自动注入 `continue` 让 autopilot 恢复推进。
> 单 run 注入上限 50 次（防失控）。详见 `d:\frank\道\无感切号\docs\specs\2026-05-11-autopilot-watchdog-plan.md`。

**mode 字段必须显式管理**，让 watchdog 知道何时该注入、何时该避让：

| 阶段 | mode 值 | watchdog 行为 |
|------|---------|--------------|
| 1.6 激活后进入执行循环 | `"running"` | ✅ 监听是否 stalled，stalled 则注入 continue |
| 2.2 错误处理（系统级阻断写 checkpoint）| `"running"` | 同上（错误恢复也算 stalled 的一种） |
| §三 用户中断 → `ask_user_question` 前 | `"awaiting_user_decision"` | ❌ **不注入**——这是设计上的用户决策点 |
| §三 ask 返回后继续执行 | `"running"` | 恢复 ✅ |
| §四 用户范围调整 ask | `"awaiting_user_decision"` | ❌ 不注入 |
| §五 收尾 ask（合并/继续/回退）| `"awaiting_user_decision"` | ❌ 不注入 |
| §五.4 完成清理前 | `"completed"` | ❌ 不注入 |
| §四 用户主动 abort | `"aborted"` | ❌ 不注入 |
| §五.4 完成清理后 | _state.json 删除_ | 文件不存在 = watchdog 跳过 |

**mode 转换操作**：读 state.json → `ConvertFrom-Json` → 改 `.mode` 为目标值（`awaiting_user_decision` / `running` / `completed`）→ `ConvertTo-Json -Depth 10 | Set-Content -Encoding UTF8` 写回。完成时紧接 §5.4 删除 state.json。

**watchdog 写入的字段**（autopilot 流程读到时透传保留）：

- `_stalled_inject_count`: number — watchdog 注入次数计数
- `_last_stalled_inject_at`: ISO 时间戳 — 最近一次注入时间

#### 1.4 创建工作分支

`git checkout -b autopilot/[goal-slug]`，然后确保 `.dao-autopilot/` 写入 `.git/info/exclude`（检查已有则跳过，否则 `Add-Content`），最后 `New-Item -ItemType Directory -Force ".dao-autopilot"`。

#### 🔒 唯一激活关卡

向用户展示「🚗 自动驾驶准备就绪」：含意图模型（目标/成功标准 checklist 对应 TODO ID/范围外）、任务图（依赖箭头）、工作分支名。末尾提示"确认后开始，过程中静默执行，发任何消息可中断"。

用户确认 → 进入执行循环
用户调整 → 修订后重新确认

---

### 二、执行循环（☳触 · 静默推进）

> 大音希声。善行无辙迹。

**激活期间：不发 chat 消息，不调用 ask_user_question。进度只写文件。**

#### 2.1 单任务执行

对每个 `status: pending` 且依赖已满足的 Task：

1. 执行任务（编码/构建/测试，视任务而定）
2. 验证任务结果（构建通过、功能可运行）
3. Git commit：`git commit -m "[宿主] autopilot([ID]): [task description]"`（宿主前缀：Claude Code → `[cc]`，Codex → `[codex]`）
4. **回写 TODO.md**：将 `- [ ]` 改为 `- [x]`（定位用 `todo_line` 字段）
5. 更新 `state.json`：`status: "done"`，记录 commit hash 和 rollback_cmd

#### 2.1.1 Task 涅槃门（每 task 必过，5 项全勾才能进下一 task）

完成一个 task 时，AI 必须显式输出「Task \<ID\> 涅槃 ✅」+ 5 项 checklist：1.实现完成（文件路径）2.验证通过（命令+关键输出）3.Git commit（hash）4.TODO.md 已 `[x]` 5.state.json 已 `done` + hash。**任一未勾 → 留在当前 task，禁止开始下一个。** 跨 task 推进 = 违反 §2.1（假涅槃）。此门使完成判断从 AI 内部变为可外部审计的显式证据。

#### 2.2 错误处理

| 错误类型 | 行为 |
|---------|------|
| 可恢复（构建失败、小 bug）| 自动修复，记录日志，继续 |
| 需判断（需求歧义，多种可行路径） | 跳过此 Task，标记 `blocked`，继续其他 Task |
| 系统级阻断（核心依赖缺失） | 写 checkpoint，**主动发消息**告知用户，等待 |
| Risk ≥ 2（不可逆操作） | 暂停，**必须**用户确认后才执行 |

#### 2.3 间隙分析（Gap Analysis）—— 每轮结束后

每完成一批 Task 后，AI 执行反思：

**新鲜用户测试**：
> "如果一个只读过原始目标的用户，现在看到系统/代码，他会说'是的，这就是我要的'吗？"

逐条检查成功标准（`✓` 已达成 / `✗` 缺口描述 / `？` 不确定）：

- 全部 ✓ → 退出循环，进入「收尾」
- 有缺口 → 在 TODO.md `🚧 待实现` 追加新条目，加入任务图，继续循环

**防止无限循环**：连续 2 轮 Gap Analysis 后新增 Task 数为 0 且仍有缺口 → 退出并报告，让用户决策。

---

### 三、用户中断（☵坎 · 随时响应）

用户在执行期间发送任何消息：

1. 读取 `state.json` + 当前 `TODO.md` 状态
2. 展示「📊 自动驾驶当前状态」：已完成 ID 列表（n/m）+ 进行中 + 待执行 + 当前分支（进度以 TODO.md `[x]` vs `[ ]` 数量为准）
3. 处理用户消息（可能是：查看/调整/回退/停止）
4. `ask_user_question`：继续/调整/回退/停止

---

### 四、语义回退（☴巽 · 精确撤除）

用户说"移除 N2 和 N4"时：

#### 4.1 依赖影响分析

展示每个被移除 Task 的直接影响（依赖它的 Task）、间接影响（需重新评估的）、无影响列表，`ask_user_question` 确认移除范围。

#### 4.2 技术回退

逐个 `git revert [commit-hash] --no-edit`。

#### 4.3 同步 TODO.md

回退后，将 TODO.md 中对应 `- [x]` 改回 `- [ ]`（或标记为 `- [~] 已移除`）。

#### 4.4 目标重推演

移除后重新执行 Gap Analysis：
- 原始目标是否仍可达成（不含 N2 N4）？
- 是 → 追加新 Task 到 TODO.md，继续
- 否 → 告知用户，等待决策

---

### 五、收尾（☶艮 · 涅槃交付）

退出执行循环后：

#### 5.1 最终验证

对照成功标准逐条验证（同 Gap Analysis，但这是最终核查）。

#### 5.2 写入演化记录

加载 `dao-evolution` skill，先运行 `search.py ensure --data-dir <project>/data`，再调用 `write_entry` + `write_lesson` 写入 `data/` CSV。

`AGENT_GUIDE.md` 仅维护项目概览、架构决策、开发指南与 CSV 指针，不再兼容双写演化条目。

> 版本号规则：若项目有 `package.json` 则读取并递增 patch 版本；否则按日期格式 `YYYY.MM.DD`。


#### 5.2.5 lesson 上提评估关卡（强制）

> 知常曰明。重要 lesson 不上提 = 失明。

§5.2 把 lesson 写入 `data/evolution-lessons.csv` 后,**必须**对每条新写入 lesson 走一次"上提评估"。即便所有 lesson 都判"无需上提",也必须**显式说明**(不允许跳过)。

**评估三问**(逐条 lesson 过):

1. **跨项目可复用方法论？** → 评估上提到 `windsurf-dao/.devin/skills/dao-*/SKILL.md` 对应 skill
   - 例: HTTP socket.on(end) 误诊 → 对应 dao skill 加调试模式
   - 例: SQL 节流 > JS Map → 对应 dao skill 或新 skill

2. **项目反复会撞的特定坑？** → 评估上提到该项目 `AGENT.md` 「项目特定坑」段
   - 例: nginx keep-alive 项目特有配置 → 项目 AGENT.md
   - 例: 项目 schema 反复踩的 migration 坑 → 项目 AGENT.md

3. **打破现有不变量 / 修改流程信念？** → 评估上提到 `windsurf-dao/.devin/rules/*.md` 对应规则
   - 例: superpowers 实战见证 → `superpowers-gate.md` 末尾加见证段
   - 例: 发现 worktree 流程漏洞 → `dao-mantra.md` 或新建 sidecar rule

**输出格式**（§5.3 报告内必含）：`### lesson 上提评估` 下逐条 `- T<id> "<title>": [上提到 <位置> | 仅留 CSV 因 <理由>]`。

**上提归位表**(参考 `windsurf-dao/.devin/rules/knowledge-routing.md`):

| 性质 | 位置 |
|---|---|
| 跨项目通用调试模式 | 已内化到 `dao.md`，无需独立 skill |
| 跨项目通用执行模式 | 对应 dao skill 或 `dao.md` |
| 跨项目通用 review | `.devin/skills/dao-review/SKILL.md` |
| 项目反复会撞的坑 | 项目 `AGENT.md` 「项目特定坑」段(若无则新建) |
| 流程规则修订 | `.devin/rules/*.md` 对应文件 |
| 实战案例展示 | `windsurf-dao/README.md` 「实战案例」段 |
| 仅历史可追溯 | 仅 CSV 即可,无需上提 |

**反模式**:

| 病 | 症状 | 对治 |
|---|---|---|
| 写完 CSV 就跑 | 单 task 写完 entry/lesson 直接进 §5.3 报告,不评估上提 | §5.2.5 是 §5.3 的硬前置,跳过 = §5 整体未完成 |
| 全判"无需上提" | 默认全 skip,跳过显式评估 | 必须**逐条说出**判定依据,即便结论是"仅留 CSV" |
| 边界模糊就不提 | "我不确定是不是跨项目通用" | 用户视角问: "另一个项目踩到同样坑时,这条 lesson 帮得上吗?" 帮得上 = 上提 |


#### 5.3 最终报告

展示「🏁 自动驾驶完成」，六段：① 原始目标（用户原话）② 完成情况（`✓` 已完成 / `～` 已移除 / `✗` 未完成，对应 TODO.md 标记）③ Open Threads 处理（若有：🟢已执行/🟡已推进含 AI assumed 理由/🔴需决策）④ 成功标准逐条验证 ⑤ lesson 上提评估（§5.2.5 产出，必含）⑥ 工作产物（分支/commits/合并命令 `--no-ff` + 撤销命令）。

`ask_user_question`：合并到 main / 继续完善 / 回退某些任务 / 保持现状

#### 5.4 清理

删除 `.dao-autopilot/state.json`，若目录为空则删除 `.dao-autopilot/`（任务状态已在 TODO.md，知识已在 AGENT_GUIDE.md）。

**退出自动驾驶模式，ask_user_question 规则恢复正常。**

---

### 六、跨 Session 恢复（含 stale 检测）

> 慎终如始 + 不知常妄作。30 天前的死 state.json 视为待恢复任务,等于妄作。

如果 session 中断，下次对话开始时：

#### 6.1 stale 检测（先做,避免误恢复死文件）

1. 检查 `.dao-autopilot/state.json` 是否存在
2. 不存在 → 跳过此节,正常进入新对话
3. 存在 → 读 state.json，算 mtime 距今天数，判 stale：`mtime ≥ 7 天 AND mode ∈ (idle, aborted, completed)` → stale
4. 若 stale → **不视为待恢复任务**，展示 mode/天数/目标摘要，`ask_user_question`：删除 stale state / 强制恢复 / 留着参考
5. 若非 stale (<7 天 + mode=running 或 awaiting_user_decision) → 走 §6.2 正常恢复

#### 6.2 正常跨 session 恢复

1. 读取 state.json + TODO.md，告知用户目标及 `[x]` 进度（N/M）
2. `ask_user_question`：继续 / 查看进度 / 放弃

恢复执行时：从第一个 `status: pending` 且依赖已满足的 Task 继续（state.json 与 TODO.md 双重确认）。

---

## 文件规范

### 目录结构

三文件：`TODO.md`（任务图，永久）/ `AGENT_GUIDE.md`（知识库，永久）/ `.dao-autopilot/state.json`（执行元数据，完成后删除，通过 `.git/info/exclude` 排除）。权威任务状态在 TODO.md，state.json 仅记录 commit hash 支持回退。

---

## 任务评分标准（决定是否自动执行）

| 维度 | 3 | 2 | 1 | 0 |
|------|---|---|---|---|
| **相关性** | 达成原始目标必须 | 直接改善目标 | 松散相关 | 不相关 |
| **可逆性** | 完全可逆（加代码） | 基本可逆（有依赖） | 难以逆转 | 不可逆 |
| **置信度** | 明确要求/强烈暗示 | 合理推断 | 不确定 | 纯猜测 |

**自动执行**：相关性 ≥ 2 AND 可逆性 ≥ 1 AND 置信度 ≥ 2

其余 → 追加到 TODO.md 候选区，不自动执行，最终报告时呈现给用户。

---

## 反模式

| 病 | 对治 |
|----|------|
| 目标漂移（执行中忘记原始目标） | 每次 Gap Analysis 重读原始目标原文 |
| 完成偏误（AI 觉得完成了但没有） | 新鲜用户测试 + 成功标准逐条验证 |
| 无限延伸（不断生成新任务） | 连续 2 轮无缺口新增 → 强制退出 |
| 双重追踪（另建 plan.md / archive/） | TODO.md 是唯一任务载体，禁止创建平行任务文件 |
| 知识遗失（执行完不写演化记录） | 5.2 先 `ensure` 后写 `data/evolution-*.csv` 是强制步骤，不可跳过 |
| 全局污染（autopilot 行为渗漏到正常对话） | 退出时删除 state.json，ask_user_question 规则恢复 |
| 越权执行（自动决策 🔀 红灯项） | 严格按 1.2.1 权限表：🔀 绝不碰，✋ 需标注假设，🔨 才可自动 |
| 批量跳过（连做多个 task 才一次 commit / update / 验证） | 严格按 §2.1.1 涅槃门：每 task 5 步全勾才能进下一个，禁止跨 task 推进；合并 commit 等于损失精确回退能力 |
