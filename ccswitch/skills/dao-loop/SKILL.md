---
name: dao-loop
description: 双线程循环开发法——文档驱动的编排层。谋线生成 spec/strategy/acceptance/plan（五文档体系），造线按 Task 级验证 + Phase 级检查点自动执行。支持多 loop 并发、跨 session 协调、目标达成度评估归档。当用户说"做一个功能/loop/双线程/文档驱动开发"时触发。
---

# 环 · Loop Engineering

> 道生一，一生二，二生三，三生万物。
> 一 = 需求，二 = 谋线与造线，三 = 轮询桥。

## 铁律

```
无文档不开工。
谋线完成才造线。
所有终止由用户确认。
造线轮询禁用 AskUserQuestion。
```

**轮询自主推进**：造线进入 ScheduleWakeup 循环后，AI 自主执行，**禁止调用 `AskUserQuestion`**——它会阻塞下一轮唤醒，导致 loop 卡死。用户无需回答即可推进是 loop 的核心契约。需要用户决策时，在回答正文中说明情况并列出选项，用户可随时打字介入。谋线阶段的用户确认（spec/plan 审批）不受此限，因为那些确认点是设计上的必要门控。

## 总览

用户一句话需求 → 预飞检查（项目结构→无感改造）→ 情境感知（展示已有 loop→归并判断）→ 🔒 Loop 计划确认（用户确认后才建 STATUS.json）→ **谋线**（spec→acceptance→strategy→plan→交叉校验→rule 检查，AI 生成→用户确认）→ Go 检查点 → **造线**（Task 级执行+验证，Phase 级检查点+组件健康+视觉，dao-review→dao-verify）→ 目标达成度评估（多维打分→严重度分流）→ 归档（学习提取+规范同步+_archive+HANDOFF.md）→ PROJECT.md 自动更新。

## §0 预飞检查

首次在项目中触发 loop 时**必须执行**：

1. `docs/specs/` 目录存在？不存在 → 创建
2. `docs/PROJECT.md` 存在？不存在 → 按模板创建
3. 扫描遗留物：
   - `TODO.md`（静态打勾清单）→ 建议删除，职责由 Loop 承担
   - `docs/plans/` 散文件 → 建议归入 `docs/plans/_legacy/`
   - 散落的 spec/design 文件 → 提议归并
4. 检查活跃/中断 loop（展示总览表，见 §1）
5. 验证 git 工作区干净度
6. **命令同步检查**：验证 `~/.claude/commands/dao-loop.md` 存在且非 0 字节。缺失或空文件 → 提示运行 `powershell -File <windsurf-dao>/ccswitch/scripts/sync-commands.ps1`

结构不合理 → 提出改造方案 → **用户确认后执行** → 再进 loop。已符合标准 → 跳过。

## §1 情境感知

当任何 session 提到"loop"或打算创建新 loop 时，**先扫描展示**：

```
📋 当前项目已有 Loop：
| Loop           | 描述                   | 阶段 | 模式      | 进度  | 锁定者       |
|----------------|------------------------|------|-----------|-------|-------------|
| report-export  | 报告导出支持多文档格式    | 造线 | executing | T3/T5 | session-xyz |
| sidebar-search | 侧栏项目搜索过滤         | 谋线 | filling   | 1/3   | 无          |
```

扫描方式：读取所有 `docs/specs/*/STATUS.json`（活跃）+ `docs/specs/_archive/INDEX.md`（已完成）。

### 归并判断

新 loop 创建时评估与已有 loop 的关系：

| 判断 | 说明 |
|------|------|
| `merge` | 功能重叠度高，合并为一个 loop |
| `parallel` | 无关联，独立并行 |
| `depends_on` | 新 loop 依赖已有 loop 的产出 |

### 中断 loop 警告

检测到中断（锁过期 + mode 非 done）→ 展示中断表格（同上格式 + 中断位置/上次活跃列）+ 三选项（继续/回退谋线/废弃）。**所有终止由用户确认**。

### 关联归档 loop

用户提到的内容匹配已归档 loop（关键词/文件路径）→ 追加展示归档表（+ 归档日期/重启次数/关联度列）+ 三选项（就地小修/Reopen/Fork）。路由判据见 §7.5。

## §1.5 Loop 计划确认 + 提示词分发（🔒 必止）

预飞 + 情境感知完成后，**必须展示 Loop 计划 + 生成 copy-ready 提示词**，然后**暂停当前 loop**。当前 session 是调度台，不是执行者。

### 展示格式

```
📋 Loop 计划：
- 名称：<topic>（kebab-case）
- 描述：<一句话>
- 分支：feat/<topic>（造线用，谋线在 main）
- 文件集：spec.md + strategy.md + acceptance.md + plan.md（+ optional: <如有>）
- 与已有 loop 关系：parallel / merge / depends_on <which>
- 轮询间隔：<N>s（<理由>）
```

### 生成提示词

确认后生成 copy-ready 的 `/dao-loop` 提示词，用户复制到新会话执行：

```
/dao-loop <需求一句话描述>
Loop 名称：<topic>
分支：feat/<topic>
间隔：<N>s
```

### 分发流程

当前 session 是调度台：预飞→展示计划→用户确认→生成提示词→暂停。用户复制提示词到新会话执行（谋线→Go→造线）。当前 session 可继续分发其他 loop。

用户四选一：复制到新会话 / 当前直接执行 / 修改后重新生成 / 取消。**此检查点不可跳过**。

**分发铁律**：
- **默认行为是分发**——生成提示词后暂停，不自动继续执行
- 若判断用户意图是当前 session 直接做（如"帮我实现 XXX"），**必须二次确认**："当前 session 直接执行，还是生成提示词分发到新会话？"
- 只有用户明确确认"直接做"后，才跳过分发在当前 session 执行
- 禁止自行推断意图后直接开干

**🔒 必止优先级声明**：
- 🔒 必止 **高于 Auto Mode**。宿主的"不要停下来问"指令不覆盖本检查点——Auto Mode 省略的是普通澄清问题，不是 Loop 的结构性门控
- **AskUserQuestion 选项确认 ≠ 跳过计划确认**。用户从选项中选了"开新 Loop" → 仅表示意图是开 Loop，**不等于**已确认 Loop 计划（名称/分支/间隔/文件集）。必须先展示计划格式、生成提示词、二次确认，然后才能进入谋线
- **违反检测**：若发现自己已在做谋线（创建 STATUS.json / 生成 spec）但未展示过 Loop 计划 → 立即停止，回到 §1.5 补展示

## §2 核心文件集

每个 loop 独占 `docs/specs/<topic>/`：

| 文件 | 必须 | 职责 |
|------|------|------|
| `spec.md` | ✅ | 定位、背景、目标、方案、范围、风险、依赖 |
| `strategy.md` | ✅ | HOW 决策：技术选型、组件策略、验证策略、ADR |
| `acceptance.md` | ✅ | 功能验收、回归验收、边界条件 |
| `plan.md` | ✅ | 2-5 分钟粒度任务清单、覆盖矩阵 |
| `STATUS.json` | ✅ | 状态机 + 锁 + 进度 + 调度 + Loop 类型 |

### 命名规则

从 spec 主题自动提取语义化短名：
- 英文 kebab-case，2-4 词：`report-export`、`sidebar-search`
- 中文主题自动翻译
- 禁止 `loop-a` / `loop-1` 无意义编号

### Optional docs

AI 根据复杂度判断，常见：
- `api-spec.md`（涉及 API）
- `ui-spec.md`（涉及 UI，有 design/ 目录走 dao-design-open）
- `schema.md`（涉及数据库）
- `migration-plan.md`（数据迁移）

### 文档模板

模板文件位于 `templates/` 子目录，谋线时按需读取：

| 文件 | 模板路径 | 核心结构 |
|------|---------|---------|
| spec.md | `templates/spec-template.md` | 定位→背景→目标→方案→范围→风险→依赖 |
| strategy.md | `templates/strategy-template.md` | 达成度维度 + ADR + 组件策略 + 验证策略 |
| acceptance.md | `templates/acceptance-template.md` | 功能验收表 + 回归验收表 + 边界条件 |
| plan.md | `templates/plan-template.md` | 任务清单（2-5min 粒度）+ 覆盖矩阵 |

## §3 STATUS.json 协议

```json
{
  "version": "1.0",
  "topic": "report-export",
  "type": "design | feature | refactor | fix | infra",
  "summary": "一句话描述（从 spec 定位段提取）",
  "created": "...",
  "lock": { "holder": "session-id", "host": "claude-code", "acquired_at": "...", "expires_at": "...", "heartbeat": "..." },
  "thread": "spec | dev | done",
  "mode": "skeleton | filling | ready | go | executing | reviewing | done | abandoned",
  "docs": { "spec": {"status":"skeleton|draft|done"}, "strategy": {...}, "acceptance": {...}, "plan": {...} },
  "go_ready": false,
  "dispatch": { "branch": "feat/<topic>", "dispatched_at": null, "worker": null },
  "execution": { "current_task": null, "completed_tasks": [], "total_tasks": 0 },
  "depends_on": null, "merged_into": null
}
```

**锁**：TTL 10 分钟 + 心跳续期，过期即可抢，崩溃自动释放。

**状态转换**：谋线 `skeleton→filling→ready→[用户确认]→go` | 造线 `go→executing→reviewing→done` | 回退 `executing→filling` | 终止 `任意→[用户确认]→abandoned`

## §4 谋线（Spec Thread）

> 图难于其易，为大于其细。

**流程**：主线程编排 → subagent 生成 → 用户确认 → 修改 → 再确认

1. 创建 `docs/specs/<topic>/` + STATUS.json（含 `type` 字段），文档标 `skeleton`
2. **🎨 设计目录检测**（见下方增强段）
3. **派发 `dao-brainstormer` subagent** 生成 spec.md → 用户确认 → 标 `done`
4. 主线程从 spec 推导 acceptance.md → 用户确认 → 标 `done`
5. **主线程生成 strategy.md** → 用户确认 → 标 `done`（见下方「strategy.md 生成」段）
6. **派发 `dao-plan-writer` subagent** 生成 plan.md → 用户确认 → 标 `done`
7. 交叉校验：plan 覆盖矩阵 ↔ acceptance 每项都有 Task 覆盖
8. **项目 rule 检查**：按 Loop type 检查是否需要创建/更新项目级 rule 文件（见下方）
9. 全部 done + 校验通过 → `go_ready: true`

### 设计对齐增强（design/ 自动检测）

**谋线步骤 2**：若需求涉及 `design/` 目录，**必须先加载 `dao-design-open` §1 + §1.5**（全页面清点 + 三层 Diff），结果注入 spec 输入。plan 覆盖矩阵增加页面×层级维度，任务排序强制 top-down（共享结构→布局→节→组件），交叉校验要求所有页面三层均有 Task 或显式 deferred。

### strategy.md 生成

**步骤 5**：主线程根据 spec + acceptance 按 `type` 生成——design 侧重组件策略+视觉验证，feature 侧重 ADR+API 契约，refactor 侧重迁移路径+兼容，fix 侧重根因+回归防护，infra 侧重工具链+CI/CD。每个 Loop 必须定义达成度维度（功能完整度/验收通过率/视觉保真度/测试覆盖/回归安全/文档同步），§7 归档时逐维度打分，未达标不可归档。

### 项目 rule 检查

**谋线步骤 8**（Go Gate 前最后检查）：按 `type` 检查 `.claude/rules/` 是否缺必要文件——design 需 `design-tokens.md`+`design-spirit.md`，feature/refactor 需 `architecture.md`（+`testing.md`），全部需 `CLAUDE.md` <80 行。缺则创建/提醒。归档时同步造线中新增的规范。

### subagent 调度

谋线主线程是**编排者**：spec.md 派 `dao-brainstormer`（苏格拉底式挖掘），acceptance.md 主线程直接写，strategy.md 主线程直接写，plan.md 派 `dao-plan-writer`（拆任务+代码模板）。subagent 返回后展示关键段落给用户确认，确认后更新 STATUS.json。

## §5 造线（Dev Thread）

> 道常无为而无不为。

**触发**：`go_ready = true`

### 造线入口门控（Go Gate）

> 不知常妄作凶。环境没备好就动笔 = 妄作。

状态从 `go → executing` 之前，**必须逐项完成并在 STATUS.json 记录**：

1. **切分支** — `git checkout -b feat/<topic>`，确认 `git branch --show-current` 输出 `feat/<topic>`
2. **STATUS.json 写入 `dispatch.branch`** — 值 = 实际分支名，后续每次恢复 session 时验证当前分支与此值一致
3. **基线验证** — 项目有构建/测试的先跑一次确认绿灯（无构建的跳过）
4. **三项全过 → 才写 `mode: executing`**

违反检测：任何时刻发现 `mode = executing` 但当前 git 分支是 `main`/`master` → **立即停止任务执行**，先补创分支再继续。

### 分诊与 subagent 调度

造线中主线程是**调度器**，按 plan.md 逐 Task 派发 subagent 执行：

| 条件 | 调度方式 |
|------|---------|
| 单 Task < 3 文件、非核心模块 | `Agent(subagent_type="dao-worker-batch", model="sonnet", prompt="执行 Task T<N>：<任务描述>。Spec: <路径>。验证命令: <命令>。")` |
| 单 Task ≥ 3 文件或核心模块 | 主线程走 `dao-superpowers` 流程（含 worktree + reviewer） |
| 多个独立 Task 无依赖 | **并行派发**多个 `dao-worker-batch`（同一消息多个 Agent 调用） |
| 有依赖的 Task | 串行：前序完成后再派发后续 |

### 执行管线

Go → 环境准备 → 逐 Task 派发 subagent（写码→commit→三文件同步）→ Task 级验证 → Phase 级检查点 → 全量验证 → 逐条验收 → Review（`dao-reviewer` + 核心模块追加 `dao-reviewer-critical`）→ 目标达成度评估（§7）→ 归根 → 归档

### 验证节奏

**Task 级**（每 commit 后）：typecheck + test（`--changedSince`）+ 契约测试。**禁止 file 级验证**。

**Phase 级**（每 Phase 末尾）：组件健康（`dao-component-radar`）+ 视觉回归（design Loop 必须 `dao-design-fidelity` L1~L3 截图 diff）+ 交互验证（L4）+ 动态组件提炼。截图路径：`_tmp/qa/<loop-topic>/<type>-<desc>.png`。

### Spec 三文件同步（🔒 每 Task commit 后）

每 Task commit 后立即同步：① STATUS.json（current_task + completed_tasks）② plan.md（标 ✅）③ acceptance.md（勾 `[x]`）。违反检测：completed_tasks 长度 > plan 中 ✅ 数量 → 立即补齐。

### subagent 调度 + 失败处理

| subagent | 触发 |
|----------|------|
| `dao-worker-batch` | 每个 Task |
| `dao-reviewer` | 所有 Task 完成后 |
| `dao-reviewer-critical` | 核心模块（auth/payment/security） |
| `dao-debugger` | 同一 Task 失败 3 次 |
| `dao-strategist` | reviewer 报告架构级问题 |

每个 prompt 必含：任务边界 + 输入路径 + 验证命令 + 输出预期。失败 3 次升级 debugger，验收项不可实现则回退谋线，5 轮无进展强制停止。

## §6 并发模型

无固定 master，任何 session 抢锁即可工作。谋线在 main（文档不冲突），造线在 `feat/<topic>`（Go Gate 强制）。session 恢复时必验分支一致。多 loop 默认并行，冲突合并时解决。`depends_on`：谋线不阻塞，造线前检查依赖——已 done 正常走，还在造线看文件重叠（无重叠并行/有重叠标 blocked），还在谋线则轮询等待。

## §7 归档

### 目标达成度评估（🔒 归档前必须）

> 慎终如始——plan 全 ✅ ≠ 真完成。"所有任务做完" ≠ "目标达成"。

**当 plan.md 所有 Task 标记 ✅ 时，禁止直接归档**。必须完成以下四步评估：

#### 7.1 多维度打分

对照 strategy.md 达成度维度逐项打分（维度 | 达标线 | 实际 | ✅/⚠️/❌）。全 ✅ → 7.3 学习提取。有 ⚠️/❌ → 7.2 严重度分流。

**design Loop**：打分必须含 `dao-design-fidelity` L1~L5 全量验证（L3 Playwright 截图 diff，L3 前先 §6.4 状态矩阵枚举）。Token 变更须执行 §6.5 diff 流程。

#### 7.2 严重度分流

| 严重度 | 判据 | 处理 |
|--------|------|------|
| `trivial` | ≤1 文件 ≤5 行 | 就地修 |
| `minor` | 2-3 行，当前范围内 | 追加 micro-task 当场修 |
| `major` | 3+ 文件 | 追加正式 Task，继续造线 |
| `critical` | 超出 spec 范围 | 归档当前 + 开新 Loop |

trivial/minor 修完重新打分，major 继续循环，critical 开新 Loop。

#### 7.3 学习提取

达成度全 ✅ 后，AI 扫 git log 提取可沉淀知识（项目级→`.claude/rules/`，跨项目→`memory/`，方法论→skill/dao.md），起草条目通过 **AskUserQuestion** 让用户确认。纯事实不写——那是 HANDOFF.md 的职责。

#### 7.4 规范同步

归档时将造线新增的规范（token / 组件 / 架构约束）同步到对应 rule 文件。**违反检测**：`completed_tasks.length ≥ total_tasks` 且准备写 `mode: done` → 未执行达成度评估则强制回到 7.1。

### 流程

验收比对通过后三步：

1. STATUS.json 标 `mode: done`
2. `docs/specs/<topic>/` 移到 `docs/specs/_archive/<topic>/`
3. 自动生成 `HANDOFF.md`

### 归档目录与模板

归档位置：`docs/specs/_archive/<topic>/`（含全套文件 + HANDOFF.md）。活跃 loop 在 `docs/specs/<topic>/`。

- **INDEX.md**（归档索引表）：详见 `templates/index-template.md`
- **HANDOFF.md**（交接文档）：详见 `templates/handoff-template.md`

### 关联触发

新任务开始前扫 INDEX.md 关键词+影响文件列，匹配则提示。时效权重：≤90天高、90-180天中、>180天低（仅路径完全匹配）。版本差≥2 major 或文件已删→降权。

## §7.5 Loop 续写（Follow-up）

已归档 loop 发现后续问题，三层路由：
- **小修**（≤2 文件 ≤30min）→ 就地改 + 记 HANDOFF.md「后续补丁」段
- **中修**（3+ 文件，原 spec 范围内）→ **Reopen**：移回 `docs/specs/`，STATUS.json 加 `mode:reopened` + `reopen_count` + `reopen_reason`，plan 追加 T-R1 系列，跳过谋线直接造线。≤3 次，第 4 次强制 Fork
- **大改**（超出 spec 范围）→ **Fork**：开新 loop，spec 头部加 `extends: <原topic>`，谋线自动读取原 HANDOFF.md 作背景

触发：用户说"之前的 XX loop 有问题"→ 扫 `_archive/INDEX.md` → 展示摘要 → 判断路由。

## §8 PROJECT.md 仪表盘

替代 TODO.md，成为项目追踪唯一入口。自动生成（Backlog 除外），Loop 状态变更时 AI 自动更新。详见 `templates/project-template.md`。

## §9 轮询策略

### 间隔

AI 判断 + 用户确认。用户显式指定时以用户为准。

| 阶段 | 建议间隔 |
|------|---------|
| 谋线-文档生成 | 270s（cache 温暖） |
| 谋线-等用户确认 | 1200s |
| 造线-执行 | 270s |
| 造线-等 review | 270s |
| 结束 | 不 wakeup |

### /loop prompt

每轮唤醒：读 STATUS.json → 按 thread+mode 执行 → 更新 STATUS.json → ScheduleWakeup。prompt 含目标需求。

## §10 与现有命令的关系

Loop 是**上层编排器**，包裹现有命令不替代：

| Loop 阶段 | 调用的 dao 命令 |
|-----------|----------------|
| 谋线 spec | dao-brainstorm |
| 谋线 plan | dao-plan |
| 造线（轻量） | dao-dev |
| 造线（重量） | dao-superpowers |
| 造线 review | dao-review / dao-reviewer |
| 最终验收 | dao-verify |

现有命令**完全不改**。用户可以跳过 Loop 直接用单个命令。

## §11 三层架构

| 层 | 位置 | 职责 |
|----|------|------|
| 协议层 | windsurf-dao `skills/dao-loop/` | 模板、协议、状态机（共享） |
| 宿主层 | 各宿主 command/hook | 如何触发、如何轮询 |
| 项目层 | `<project>/docs/specs/` | 具体文档内容 |

跨机器：所有状态在 git 中。STATUS.json 不记录宿主类型 / 本地路径 / 会话 ID。
