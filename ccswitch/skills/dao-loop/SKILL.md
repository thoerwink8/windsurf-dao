---
name: dao-loop
description: 双线程循环开发法——文档驱动的编排层。谋线生成 spec/acceptance/plan，造线自动执行。支持多 loop 并发、跨 session 协调、归档交接。当用户说"做一个功能/loop/双线程/文档驱动开发"时触发。
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

```
用户一句话需求
    ↓
预飞检查（项目结构 → 无感改造）
    ↓
情境感知（展示已有 loop → 归并判断）
    ↓
🔒 Loop 计划确认（展示名称/描述/文件集/分支/间隔 → 用户确认后才创建 STATUS.json）
    ↓
┌─ 谋线 ──────────────────┐
│ spec.md → acceptance.md  │  AI 生成 → 用户确认
│ → plan.md → 交叉校验     │
└────────┬────────────────┘
         ↓ Go 检查点
┌─ 造线 ──────────────────┐
│ dao-dev / dao-superpowers│  按复杂度分诊
│ → dao-review → dao-verify│
└────────┬────────────────┘
         ↓
归档（_archive + HANDOFF.md + INDEX.md）
PROJECT.md 自动更新
```

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

检测到中断的 loop（锁已过期 + mode 非 done）→ 弹出警告：

```
⚠️ 发现中断的 Loop：
| Loop           | 描述           | 中断位置    | 上次活跃  |
|----------------|----------------|------------|----------|
| report-export  | 报告多格式导出  | 造线 T3/T5 | 2h ago   |

建议：
1. 继续执行（从 T3 恢复）
2. 回退到谋线重新评估
3. 废弃并清理
```

**所有终止（主动/被动）由用户确认**，AI 只给建议。

### 关联归档 loop

当用户提到的内容关联到已归档 loop（关键词/文件路径匹配），追加展示：

```
📦 关联归档 Loop：
| Loop           | 描述         | 归档日期   | 重启次数 | 关联度 |
|----------------|-------------|-----------|---------|--------|
| report-export  | 报告多格式导出 | 2026-06-20 | 0       | 高     |

建议：
1. 就地小修（不开 loop）
2. 重启原 loop（Reopen）
3. 派生新 loop（Fork）
```

路由判据见 §7.5。

## §1.5 Loop 计划确认 + 提示词分发（🔒 必止）

预飞 + 情境感知完成后，**必须展示 Loop 计划 + 生成 copy-ready 提示词**，然后**暂停当前 loop**。当前 session 是调度台，不是执行者。

### 展示格式

```
📋 Loop 计划：
- 名称：<topic>（kebab-case）
- 描述：<一句话>
- 分支：feat/<topic>（造线用，谋线在 main）
- 文件集：spec.md + acceptance.md + plan.md（+ optional: <如有>）
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

```
当前 session（调度台）          新 session（执行者）
  │                                │
  ├─ 预飞 + 情境感知               │
  ├─ 展示 Loop 计划                │
  ├─ 用户确认                      │
  ├─ 生成提示词 ──→ 用户复制 ──→   ├─ /dao-loop <prompt>
  ├─ 暂停此 loop                   ├─ 创建 STATUS.json
  ├─ 可继续分发 loop B …           ├─ 谋线 → Go → 造线
  │                                │
```

### 用户操作

| 操作 | 效果 |
|------|------|
| 确认 → 复制提示词 | 新开会话执行，当前 session 可继续分发其他 loop |
| 确认 → 当前继续 | 单 loop 场景，当前 session 直接创建 STATUS.json 并执行 |
| 修改 | 调整名称/描述/间隔后重新生成提示词 |
| 取消 | 不创建 loop |

**此检查点不可跳过**——计划展示只需几秒，但能防止方向偏差。

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
| `acceptance.md` | ✅ | 功能验收、回归验收、边界条件 |
| `plan.md` | ✅ | 2-5 分钟粒度任务清单、覆盖矩阵 |
| `STATUS.json` | ✅ | 状态机 + 锁 + 进度 + 调度 |

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

#### spec.md

```markdown
# Spec: <topic>

## 定位
[一句话：做什么，为谁解决什么问题]

## 背景
[为什么要做？现状和痛点]

## 目标
[完成后达到什么状态，可观测的成功标准]

## 方案

### 推荐方案
- 思路 / 优势 / 劣势 / 工作量

### 备选方案（如有）

## 范围
- MVP 必做 / Nice-to-have / 明确不做

## 风险

## 依赖
```

#### acceptance.md

```markdown
# Acceptance: <topic>

## 功能验收

| ID | 标准 | 验证方法 | 通过条件 |
|----|------|---------|---------|
| A1 | [可验证的标准] | [命令/操作] | [通过定义] |

## 回归验收

| ID | 现有功能 | 验证命令 |
|----|---------|---------|

## 边界条件

| 场景 | 预期行为 |
|------|---------|
```

#### plan.md

```markdown
# Plan: <topic>

> 依赖: spec.md, acceptance.md

## 任务清单

### T1: <name> (≈Nmin) → A1, A2
- 文件: `path` (NEW | MODIFY | DELETE)
- 操作: 一句话
- 代码模板: [可直接复制]
- 验证: `可跑命令`

## 覆盖矩阵

| 验收项 | 覆盖 Task |
|--------|----------|
| A1 | T1, T3 |

验收项无 Task 覆盖 → plan 不完整，需补充。
```

## §3 STATUS.json 协议

```json
{
  "version": "1.0",
  "topic": "report-export",
  "summary": "报告导出支持多文档格式",
  "created": "2026-06-22T02:00:00Z",
  "lock": {
    "holder": "session-id",
    "host": "claude-code",
    "acquired_at": "...",
    "expires_at": "...",
    "heartbeat": "..."
  },
  "thread": "spec | dev | done",
  "mode": "skeleton | filling | ready | go | executing | reviewing | done | abandoned",
  "docs": {
    "spec":       { "status": "skeleton | draft | done", "required": true },
    "acceptance": { "status": "...", "required": true },
    "plan":       { "status": "...", "required": true }
  },
  "optional_docs": {},
  "go_ready": false,
  "dispatch": {
    "branch": "feat/<topic>",
    "dispatched_at": null,
    "worker": null
  },
  "execution": {
    "current_task": null,
    "completed_tasks": [],
    "total_tasks": 0
  },
  "depends_on": null,
  "merged_into": null
}
```

### 锁机制

- TTL 10 分钟，心跳续期
- 任何 session 唤醒后检查锁，过期即可抢
- 崩溃自动过期，其他 session 接管

### 状态转换

```
谋线：skeleton → filling → ready → [用户确认] → go
造线：go → executing → reviewing → done
回退：executing → [失败] → filling（回退谋线）
终止：任意 → [用户确认] → abandoned
```

## §4 谋线（Spec Thread）

> 图难于其易，为大于其细。

**流程**：主线程编排 → subagent 生成 → 用户确认 → 修改 → 再确认

1. 创建 `docs/specs/<topic>/` + STATUS.json，文档标 `skeleton`
2. **🎨 设计目录检测**（见下方增强段）
3. **派发 `dao-brainstormer` subagent** 生成 spec.md → 用户确认 → 标 `done`
4. 主线程从 spec 推导 acceptance.md → 用户确认 → 标 `done`
5. **派发 `dao-plan-writer` subagent** 生成 plan.md → 用户确认 → 标 `done`
6. 交叉校验：plan 覆盖矩阵 ↔ acceptance 每项都有 Task 覆盖
7. 全部 done + 校验通过 → `go_ready: true`

### 设计对齐增强（design/ 自动检测）

**谋线步骤 2 自动执行**：若 Loop 范围涉及 `design/` 目录（需求含"设计还原 / 对齐 / 1:1 / UI 翻译 / design-to-code"等信号），**必须加载 `dao-design-open` §1（Read）+ §1.5（全覆盖规划）**，在 spec 生成前完成全页面清点和三层 Diff。

触发后谋线流程变化：

| 步骤 | 标准流程 | 设计对齐增强 |
|------|---------|------------|
| spec 前 | — | 加载 dao-design-open §1 + §1.5，完成全页面清点 + 三层 Diff |
| spec 输入 | 用户需求 | 用户需求 **+ §1.5 Diff 结果** |
| plan 约束 | 覆盖矩阵对验收项 | 覆盖矩阵增加**页面 × 层级**维度（§1.5.3） |
| 任务排序 | 按依赖 | 强制 **top-down**：共享结构→布局→节→组件（§1.5.4） |
| 交叉校验 | 验收项全覆盖 | 验收项全覆盖 **+ 所有页面三层均有 Task 或显式 deferred** |

**为什么强制**：未做全页面清点的设计 Loop 极易只覆盖"最显眼"的页面而悄悄跳过其余，导致造线结束后才发现大面积遗漏——此时已耗尽 budget，返工成本极高。

### subagent 调度指令

谋线中主线程是**编排者**，不亲自写大段文档：

| 步骤 | 工具调用 | 说明 |
|------|---------|------|
| spec.md | `Agent(subagent_type="dao-brainstormer", model="sonnet", prompt="基于以下需求生成 spec：<需求>。项目背景：<CLAUDE.md 摘要>。输出到 docs/specs/<topic>/spec.md，按模板格式。")` | brainstormer 做苏格拉底式挖掘 + 方案对比 |
| acceptance.md | 主线程直接写 | 从 spec 机械推导验收标准，无需 subagent |
| plan.md | `Agent(subagent_type="dao-plan-writer", model="sonnet", prompt="基于已确认的 spec.md 和 acceptance.md 生成实施计划。读取 docs/specs/<topic>/ 下两个文件，输出 plan.md，含 2-5 分钟粒度任务、代码模板、覆盖矩阵。")` | plan-writer 拆任务 + 写代码模板 |

**subagent 返回后**，主线程展示关键段落给用户确认，不全文贴出。用户确认后更新 STATUS.json。

### summary 字段

从 spec.md "定位"段提取一句话，写入 STATUS.json 的 `summary` 字段。这是情境感知表格的描述来源。

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

```
Go → 环境准备(install/基线测试)
  → 逐 Task 派发 subagent(写码→typecheck→test→commit)
  → 全量验证（主线程）
  → 逐条验收(对照 acceptance.md)
  → 交叉 Review → Agent(subagent_type="dao-reviewer")
  → 核心模块追加 → Agent(subagent_type="dao-reviewer-critical")
  → 归根(merge/PR) → 归档
```

### subagent 调度指令

| 阶段 | 工具调用 | 触发条件 |
|------|---------|---------|
| Task 执行 | `Agent(subagent_type="dao-worker-batch", model="sonnet")` | 每个 Task |
| 代码审查 | `Agent(subagent_type="dao-reviewer", model="sonnet")` | 所有 Task 完成后 |
| 深度审查 | `Agent(subagent_type="dao-reviewer-critical", model="sonnet")` | 涉及 auth/payment/security/core |
| Bug 诊断 | `Agent(subagent_type="dao-debugger", model="sonnet")` | 同一 Task 失败 3 次 |
| 架构升级 | `Agent(subagent_type="dao-strategist")` | reviewer 报告架构级问题（不降模型） |

**subagent prompt 模板**：每个 subagent 调用必须包含：
1. 明确的任务边界（做什么、不做什么）
2. 输入文件路径（spec/plan 中对应段落）
3. 验证命令（怎么确认做对了）
4. 输出预期（改了哪些文件、返回什么）

### 失败处理

| 失败场景 | 处理 |
|---------|------|
| 单 task 失败 | 自动修复，最多 3 次 |
| 3 次失败 | 升级 `Agent(subagent_type="dao-debugger", model="sonnet")` |
| 验收项 fail | 回到对应 Task |
| 验收项不可实现 | **回退谋线**重新评估 |
| review 架构问题 | 升级 `Agent(subagent_type="dao-strategist")`（保持主模型） |
| 5 轮无进展 | 强制停止 + 诊断报告 |

回退到谋线后，谋线自行判断：plan 拆解问题（改 plan）/ spec 方案问题（改 spec）/ 代码 bug（重试/换方案）。

## §6 并发模型

### Peer 调度

无固定 master。任何 session 唤醒后可抢锁工作。Main 分支是共享看板。

### 分支策略

- 谋线在 **main** 操作（文档不冲突）
- 造线在**独立 feature 分支**（`feat/<topic>`）— 由 §5 Go Gate 强制创建并写入 `dispatch.branch`
- **session 恢复时必验**：`git branch --show-current` ≠ `dispatch.branch` → 先 checkout 再继续

### 跨 session 发现

git push/pull STATUS.json。新 loop push 到 main 后，其他 session pull 即发现。

### 多 loop 并行

默认并行。冲突在**合并时**解决——后合并者读先合并者的代码 + 设计文档，AI 智能 resolve。

### depends_on

- **谋线永远不阻塞**
- **造线进入前**检查依赖 loop：
  - 已 done → 正常执行
  - 还在造线 → 文件级重叠检查：无重叠 → 并行；有重叠 → 重叠任务标 `blocked`
  - 还在谋线 → 暂不启动造线，轮询等待

## §7 归档

### 流程

Loop 完成后三步：

1. STATUS.json 标 `mode: done`
2. `docs/specs/<topic>/` 移到 `docs/specs/_archive/<topic>/`
3. 自动生成 `HANDOFF.md`

### 目录结构

```
docs/specs/
├── _archive/
│   ├── INDEX.md
│   └── report-export/
│       ├── spec.md / acceptance.md / plan.md / STATUS.json
│       └── HANDOFF.md
└── sidebar-search/           ← 活跃
```

### INDEX.md

```markdown
# Loop 归档索引

| Loop | 描述 | 日期 | 版本 | 影响文件 | 关键词 |
|------|------|------|------|---------|--------|
| report-export | 报告导出多格式 | 2026-06-22 | v0.3 | report-view.tsx | 导出,PDF,报告 |
```

### HANDOFF.md

```markdown
# Handoff: <topic>
> 归档于 YYYY-MM-DD | 版本 vX.Y | 耗时 N 轮

## 做了什么
## 改了哪些文件
## 关键决策
## 验收结果
## 关键词
## 后续补丁
<!-- 就地小修时在此记录，格式：日期 | 改了什么 | 为什么 -->
```

### 关联触发

任何新任务开始前，AI 扫 INDEX.md 的关键词 + 影响文件列，匹配到相关归档就提示。

### 时效性（日期 + 版本双轨）

| 条件 | 权重 |
|------|------|
| ≤ 90 天 | 高相关 |
| 90-180 天 | 中相关（标注"较早"） |
| > 180 天 | 低相关（仅文件路径完全匹配时提） |
| 版本差 ≥ 2 major | 降权 |
| 影响文件已删除 | 降权 |

永不自动删除，低相关只降展示优先级。

## §7.5 Loop 续写（Follow-up）

已完成/已归档的 loop 发现后续问题时，按严重程度三层路由：

### 决策树

```
Loop 已完成（mode: done / archived）→ 发现后续问题
    │
    ├─ 小修（≤2 文件，≤30min，不涉及方案变更）
    │   └─ 就地修（任意 session 直接改，不开/续 loop）
    │      记一笔到 HANDOFF.md「后续补丁」段
    │
    ├─ 中修（3+ 文件，但仍在原 spec 范围内）
    │   └─ 重启原 loop（Reopen）
    │
    └─ 大改（超出原 spec 范围 / 新需求）
        └─ 派生新 loop（Fork）
```

### Reopen（重启原 loop）

适用：问题在原 spec 范围内，需要 3+ 文件改动。

**操作流程**：

1. 从 `_archive/<topic>/` 移回 `docs/specs/<topic>/`
2. STATUS.json 更新：

```jsonc
{
  "mode": "reopened",        // done → reopened
  "reopen_count": 1,         // 累计重启次数
  "reopen_reason": "...",    // 重启原因
  "reopen_at": "YYYY-MM-DD",
  "phase": "dev"             // 直接进造线（spec 不变）
}
```

3. `plan.md` 追加「Reopen Round N」段落 + 新 Task（编号 T-R1, T-R2...）
4. `acceptance.md` 追加新验收项（如有）
5. 跳过谋线，直接进造线
6. 完成后再次归档，`reopen_count` +1

**约束**：

- Reopen ≤ 3 次。第 4 次强制 Fork 新 loop（原 spec 已不够用）
- 每次 Reopen 必须写明 `reopen_reason`
- INDEX.md 更新日期和版本，标注 `(reopened×N)`

### Fork（派生新 loop）

适用：问题超出原 spec 范围，或需要重新设计方案。

就是开新 loop，但多两件事：

1. 新 `spec.md` 头部加 `extends: <original-topic>`
2. 谋线阶段自动读取原 loop 的 `HANDOFF.md` + `spec.md` 作为背景输入

INDEX.md 记录关联：`extends: <original-topic>` 列。

### 路由规则

| 角色 | 适合处理 |
|------|---------|
| 调度台 session | 路由判断（小修/中修/大改）+ 分发 Reopen/Fork 提示词 |
| 原执行 session（如果还活着） | 小修就地改 / Reopen 后继续造线 |
| 新 session | 接 Reopen/Fork 提示词执行 |

**触发方式**：用户在任意 session 说"之前的 XX loop 还有问题"，AI 扫描 `_archive/INDEX.md` 找到对应 loop → 展示 HANDOFF.md 摘要 → 判断路由 → 执行或分发。

## §8 PROJECT.md 仪表盘

替代 TODO.md，成为项目追踪唯一入口。

```markdown
# <项目名> · 项目仪表盘

> 自动生成，勿手动编辑（Backlog 除外）。Loop 状态变更时 AI 自动更新。

## 当前版本
vX.Y.Z（上次更新：YYYY-MM-DD）

## 活跃 Loop
| Loop | 描述 | 阶段 | 模式 | 进度 |
|------|------|------|------|------|

## 待启动（Backlog）
<!-- 唯一手动区域 -->

## 近期完成
| Loop | 描述 | 完成日期 | 版本 |
|------|------|---------|------|

## 里程碑
| 版本 | 定位 | 状态 |
|------|------|------|
```

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

```
执行 dao-loop：
1. 读取 docs/specs/<topic>/STATUS.json
2. 根据 thread + mode 执行对应动作
3. 更新 STATUS.json
4. ScheduleWakeup
目标：<需求>
```

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
