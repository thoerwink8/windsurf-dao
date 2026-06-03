---
name: dao-plan
description: 实施 plan 撰写铁律：把已审批的 design 拆成 2-5 分钟粒度的可执行任务清单,每个任务含精确文件路径、完整代码模板、验证命令。"图难于其易,为大于其细"——难事必细拆,大事必小起。
---

# 划 · Plan Lens

> 图难于其易，为大于其细。
> 天下难事，必作于易；天下大事，必作于细。
> 千里之行，始于足下。
> ——《道德经》第 63、64 章

道家把"难易"颠倒过来看:**真正难的是把难拆成易,把大拆成细**。
plan 的核心不是"想怎么做",是"把怎么做拆细到每一步都不再需要思考"。

## 铁律

```
不拆到 2-5 分钟粒度,不算 plan。
不给完整代码模板(不留 TODO),不算 plan。
不附验证命令,不算 plan。
plan 必依赖已审批 design,不允许凭空 plan。
```

## 何时激活

- dao-brainstorm 完成,design 已审批 → 进入 dao-plan
- 用户给了清晰需求 + 范围,可以直接写 plan(跳过 brainstorm)
- dao-dev §一·谋·设 阶段
- /dao-cycle 大幅改动前

**不激活**:
- design 还没明确(回 dao-brainstorm)
- 单步任务(主会话直接做,不用 plan)
- bug 调查(派 dao-debug,不写 plan)

## 入参(必须)

进入本 skill 前必须有:

```
□ 已审批 design 文档(来自 dao-brainstorm)
  路径:docs/specs/YYYY-MM-DD-<topic>-design.md
□ 用户已批准方向
□ 项目上下文(代码风格、依赖、目录结构)已掌握
```

无 design 就来 plan = 凭空,**回打 dao-brainstorm**。

若处于 `delegated-continuous`（用户已授权持续推进 / autopilot 隔离模式）：

- `已审批 design` 可由当前上下文 + AI 自审替代
- `用户已批准方向` 可由 `delegated-continuous` 委托授权替代
- plan 写完后不等待用户审批，记录“delegated-continuous 下自动通过”
- 只有方向互斥、权限/安全/费用/不可逆风险、或无法根据当前上下文裁剪时才问用户

## plan 文档格式(强制)

```markdown
# Plan: <feature/refactor name>

## 背景
<3-5 句业务背景 + 为什么做>

## 目标
<可观测完成判据,1-3 条>

## 任务清单

### Task 1: <name> (≈3 min)
- 文件: `path/to/file1.ts` (NEW | MODIFY | DELETE)
- 操作: <一句话动作>
- 完整代码模板:
  ```ts
  // 完整代码,worker 可直接复制
  export function ... { /* 全部实现 */ }
  ```
- 参考文件(只读): <列表>
- 验证: `<可跑命令>`
- 依赖: 无 / Task X

### Task 2: ... (≈4 min)
...

## 任务依赖图
Task 1 → Task 2 → Task 3
       ↘ Task 4 (并行)

## 总验证(全部 task 完成后)
- `<命令1>` 预期 exit 0
- `<命令2>` 预期 ...

## Out of Scope (硬边界)
- 不改 ...
- 不引入 ...
```

## 2-5 分钟粒度的判据

每个 Task 必须满足:

| 检查 | 问什么 |
|------|--------|
| 时间 | 一个有经验工程师能在 2-5 分钟内完成? |
| 路径 | 文件路径精确到文件名(不是"在 utils 里")? |
| 代码 | 给的代码是完整的,**没有** `// TODO` / `...` / 伪代码? |
| 验证 | 有可执行的命令? |
| 边界 | 明确说不该做什么? |
| 依赖 | 标了它依赖哪些前置 Task? |

**任一项不满足 → 拆细 / 补全 / 重写**。

## 拆任务的 3 个原则

### 1. 难拆易(图难于其易)

每个 Task 应该是"无脑可做"——拿到 spec 不再需要思考。
拿不准的部分 = 还没拆够细。

### 2. 大拆细(为大于其细)

任何 > 5 分钟的工作 → 必拆。
> 5 分钟通常意味着含多个决策点,每个决策点应是独立 Task。

### 3. 始足下(始于足下)

**第一个 Task 必须是可立即开干的最小起点**——不要让 Task 1 是"思考 / 调研 / 设计",那是 brainstorm 的事。
Task 1 应该是具体改动:创建文件、加函数、改配置。

## 任务依赖图

明确**串行 vs 并行**:

```
Task 1 (前置) ─┬─→ Task 2 (依赖 1) ─→ Task 3
               └─→ Task 4 (依赖 1, 与 Task 2 并行)
```

并行任务标识 = dao-pyramid「并行调度模式」的输入。

## 反模式表

| 病 | 症状 | 道德经诊断 | 对治 |
|----|------|-----------|------|
| 大颗粒 | Task "实现登录功能" (1 小时) | 不细 | 拆到具体函数级 |
| 模糊代码 | 代码模板含 `// TODO 实现` | 不诚 | 给完整代码,不留 |
| 路径不实 | "在 utils 里加" | 不实 | 精确到文件名 |
| 无验证 | 只说做什么,没说怎么验 | 不慎终 | 每 Task 必有命令 |
| 跳过依赖 | 不标 Task 之间的依赖 | 不知次 | 必标依赖图 |
| 凭空 plan | 没 design 就来 plan | 妄作 | 回 dao-brainstorm |
| 范围爬 | plan 中加了 design 没说的事 | 失边界 | 严格按 design 拆 |
| 顺手优化 | "这里可以一起重构" | 不止 | 不在 plan 里夹带私活 |
| Task 1 抽象 | "调研一下" | 不始足下 | Task 1 必须立即可做 |

## 涅槃门(进 dao-execute 前)

- [ ] 每个 Task ≤ 5 分钟可完成
- [ ] 每个 Task 含完整代码模板(无 TODO / 无伪代码)
- [ ] 每个 Task 含可执行验证命令
- [ ] 任务依赖图清晰
- [ ] Out of Scope 已明确(避免 worker 出轨)
- [ ] plan 文档已 commit (`docs/specs/<topic>-plan.md`)，或在 delegated-continuous 下已记录为自动通过的执行依据

任一未通 = 不进 dao-execute。

## 与其他 dao-* 协作

```
dao-brainstorm (上游)
   │ 已审批 design
   ▼
dao-plan (你)
   │ 2-5 分钟粒度任务清单
   ▼
dao-execute / 主会话调度
   │ 串行 / 并行 (dao-pyramid 并行调度)
   ▼
dao-test (RED-GREEN) + dao-verify (验证)
   │
   ▼
dao-review → dao-finish
```

## 反原则(保留 dao 风格)

- **不为粒度而粒度**——简单 plan 可能只有 3 个 Task,这是健康的
- **不为模板而模板**——某些 Task 实在难写完整代码(如交互式调试),允许写"具体步骤"代替
- **plan 不是合同**——执行中发现问题应回 dao-plan 重写,不要硬扛
- **无为 ≠ 不写**——plan 是"无为而无不为"的具体形式:写细了,执行就不再需要思考

