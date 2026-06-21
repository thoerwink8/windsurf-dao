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
```

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

## §1.5 Loop 计划确认（🔒 必止）

预飞 + 情境感知完成后，**必须展示 Loop 计划并等待用户确认**，确认前不创建 STATUS.json、不生成任何文档。

展示格式：

```
📋 Loop 计划：
- 名称：<topic>（kebab-case）
- 描述：<一句话>
- 文件集：spec.md + acceptance.md + plan.md（+ optional: <如有>）
- 分支策略：谋线 main / 造线 feat/<topic>
- 与已有 loop 关系：parallel / merge / depends_on <which>
- 轮询间隔：<N>s（<理由>）

确认后开始创建 STATUS.json + 谋线第一步。
```

用户可以：
- 确认 → 开始
- 修改名称/描述/间隔 → AI 调整后再确认
- 取消 → 不创建 loop

**此检查点不可跳过**，即使用户语气急迫（"直接做"）——计划展示本身只需几秒，但能防止方向偏差。

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
- `ui-spec.md`（涉及 UI，走 dao-design-taste）
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

**流程**：AI 自动生成 → 用户确认 → 修改 → 再确认

1. 创建 `docs/specs/<topic>/` + STATUS.json，文档标 `skeleton`
2. 生成 spec.md（调用 `dao-brainstorm` 逻辑）→ 用户确认 → 标 `done`
3. 生成 acceptance.md → 用户确认 → 标 `done`
4. 生成 plan.md（调用 `dao-plan` 逻辑）→ 用户确认 → 标 `done`
5. 交叉校验：plan 覆盖矩阵 ↔ acceptance 每项都有 Task 覆盖
6. 全部 done + 校验通过 → `go_ready: true`

### summary 字段

从 spec.md "定位"段提取一句话，写入 STATUS.json 的 `summary` 字段。这是情境感知表格的描述来源。

## §5 造线（Dev Thread）

> 道常无为而无不为。

**触发**：`go_ready = true`

### 分诊规则

| 条件 | 调度到 |
|------|--------|
| < 3 文件、非核心模块 | `dao-dev` |
| ≥ 3 文件或核心模块 | `dao-superpowers`（含 worktree + reviewer） |

### 执行管线

```
Go → 环境准备(worktree/install/基线测试)
  → 逐 Task 执行(写码→typecheck→test→commit)
  → 全量验证
  → 逐条验收(对照 acceptance.md)
  → 交叉 Review(dao-reviewer)
  → 归根(merge/PR) → 归档
```

### 失败处理

| 失败场景 | 处理 |
|---------|------|
| 单 task 失败 | 自动修复，最多 3 次 |
| 3 次失败 | 升级 dao-debugger |
| 验收项 fail | 回到对应 Task |
| 验收项不可实现 | **回退谋线**重新评估 |
| review 架构问题 | 升级 dao-strategist |
| 5 轮无进展 | 强制停止 + 诊断报告 |

回退到谋线后，谋线自行判断：plan 拆解问题（改 plan）/ spec 方案问题（改 spec）/ 代码 bug（重试/换方案）。

## §6 并发模型

### Peer 调度

无固定 master。任何 session 唤醒后可抢锁工作。Main 分支是共享看板。

### 分支策略

- 谋线在 **main** 操作（文档不冲突）
- 造线在**独立 feature 分支**（`feat/<topic>`）

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
