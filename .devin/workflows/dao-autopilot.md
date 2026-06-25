---
description: 自动驾驶模式：AI 自主分解目标、递归执行、反思间隙、语义回退，直到目标完全达成或用户中断。当用户说"自动驾驶"、"autopilot"、"帮我自动完成"时触发。
---

# 自动驾驶 · Autopilot

> 为无为，则无不治。知常曰明，益生曰祥，心使气曰强。

**此工作流是隔离模式**：激活期间 `ask_user_question` 豁免（等同于内观模式），退出后完全恢复正常。

---

## 设计哲学

> TODO.md 是任务图的唯一载体。AGENT_GUIDE.md 是人类可读知识库。autopilot 不创建平行系统——它直接操作这两个文件和 CSV 演化源。

`TODO.md`（任务图，读 `- [ ]` → 执行 → 回写 `- [x]`）· `AGENT_GUIDE.md`（人类可读知识库，维护概览/架构/指南）· `data/evolution-*.csv`（演化真相源，收尾时 ensure → 写入）· `state.json`（执行元数据，仅存 commit hash + rollback_cmd，完成后删除）

两个文件不存在时 autopilot **创建**（初始化为标准格式），而非另建 plan.md / archive。

---

## 激活条件

- 用户显式说"自动驾驶"、"autopilot"、"帮我自动完成"
- 用户给出模糊目标，期望 AI 自主推进到完成

---

## 核心原则

**目标锚**（原始目标不变，防漂移）· **单一载体**（TODO.md 任务 + AGENT_GUIDE.md 知识，不建平行文件）· **任务图**（有依赖，非线性队列）· **一任务一 commit**（语义回退最小单位）· **feature branch**（主干不受影响）· **新鲜用户启发**（反思时以"只读过原始需求的用户"为视角）· **工件先行**（先挖参考实现/已有基础设施/上下游数据，再推方案）· **隔离**（激活期行为不污染全局）

---

## 单 Task 闭环铁律

> 慎终如始，则无败事矣。

所有推进遵循 **§2.1 五步循环 + §2.1.1 涅槃门** 单 task 闭环。**绝对不允许批量推进**——每 task 必须独立 commit + state 更新 + TODO 勾选 + 验证。原因：回退粒度 / 跨 session 恢复真相 / 用户看到的进度必须实时准确。

**唯一例外**：强耦合 ≤2 task（A 的 verify 隐含 B 的前置），commit message 写 `[宿主] autopilot(TG-1+TG-2): ...`。

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

🔀 红灯 → 绝不自动执行，累积到待决报告。✋ 黄灯 → 评估置信度（高=强暗示/唯一候选→执行并标注 `⚡ AI assumed`；低=多方案/犹豫→跳过）。🔨 绿灯 → 纳入任务图正常执行。

#### 1.3 构建任务图（写入 state.json）

state.json 字段：`mode` / `goal` / `branch` / `started` / `success_criteria` / `tasks[]`。每个 task 含：`id` `desc` `todo_line`（精确定位回写用）`depends_on` `status` `commit` `rollback_cmd`。

依赖关系从任务语义推断；无明确依赖则设为空。

**分解原则**：
- 每个 Task 是独立的逻辑单元（一个功能、一个模块、一个修复）
- 依赖关系尽量扁平（宽而浅，优于深依赖链）
- Task 粒度：≤ 1 小时工作量，确保 context 内可完成

#### 1.3.0 state 文件位置

> **铁律**：state 文件**必须**放 `.dao-autopilot/state.json`，**不得**放进 `.windsurf/` 目录（历史教训：写进 `.windsurf/` 导致 Sidecar workspace 模式下 dao 体系规则整体被屏蔽——目标项目有了自己的 `.windsurf/` 后 Cascade 不再从 sidecar 加载 always_on rules）。通过 `.git/info/exclude` 本地排除，不进 git、不混淆项目配置、完成后整目录可删。

#### 1.3.1 mode 状态机

**mode 字段必须显式管理**（续推机制据此判断注入/避让）：

`"running"`（激活后/ask 返回后）→ stalled 则注入 continue。`"awaiting_user_decision"`（ask 前/中断/收尾）/ `"completed"` / `"aborted"` → 不注入。mode 转换：读→改→写回 state.json。续推写入的 `_stalled_*` 字段透传保留。

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

可恢复（构建失败/小 bug → 自动修复继续）· 需判断（歧义 → 跳过标 `blocked`，继续其他）· 系统级阻断（核心依赖缺失 → checkpoint + 主动告知用户）· Risk ≥ 2（不可逆 → 暂停，必须用户确认）

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


#### 5.2.5 lesson 上提评估（强制 · §5.3 硬前置）

每条新 lesson 必须过三问（即便结论"仅留 CSV"也须显式说明）：
1. **跨项目可复用？** → 上提到 `.devin/skills/dao-*/SKILL.md` 或 `dao.md`
2. **项目反复会撞？** → 上提到项目 `AGENT.md`
3. **打破现有流程信念？** → 上提到 `.devin/rules/*.md` 或对应 skill

判据："另一个项目踩到同样坑时帮得上吗？"帮得上 = 上提。归位路由详见 `.devin/rules/knowledge-routing.md`。


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

三维度各 0-3 分：**相关性**（3=必须/2=直接改善/1=松散/0=无关）· **可逆性**（3=完全/2=基本/1=难/0=不可逆）· **置信度**（3=明确要求/2=合理推断/1=不确定/0=猜测）。**自动执行**：相关性≥2 AND 可逆性≥1 AND 置信度≥2。其余 → TODO.md 候选区，最终报告呈现。

---

## 反模式

目标漂移（Gap Analysis 重读原始目标）| 完成偏误（新鲜用户测试+逐条验证）| 无限延伸（2 轮无新增→强制退出）| 双重追踪（TODO.md 唯一载体，禁平行文件）| 知识遗失（§5.2 演化记录不可跳）| 全局污染（退出删 state.json 恢复规则）| 越权执行（🔀 绝不碰/✋ 标注/🔨 可自动）| 批量跳过（§2.1.1 涅槃门每 task 5 步全勾才进下一个）
