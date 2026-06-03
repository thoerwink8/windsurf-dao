---
name: dao-execute
description: 按 plan 执行铁律：加载 dao-plan 产出的任务清单,逐 Task 执行 + 设置 checkpoint。不二次解释 plan,不抢 plan 之功。"行不言之教,为而不恃,功成而弗居"——执行者只负责忠实落地,不重复决策。
---

# 行 · Execute Lens

> 行不言之教。为而不恃,功成而弗居。
> 是以圣人后其身而身先,外其身而身存。
> ——《道德经》第 2、7 章

道家把"执行"放在"言"之后——**plan 已成,执行不需要再"言"**。
执行的美德是"为而不恃"(做了不据为己有)、"功成而弗居"(成功了不抢功)——执行者忠实落地,功劳归 plan,问题回 plan。

## 铁律

```
不二次解释 plan,只忠实落地。
不在执行中改 plan,有问题回 dao-plan 重写。
每 Task 完成必跑验证,无证据不报完成(对接 dao-verify)。
checkpoint 是用户的关卡,不是建议。
```

## 何时激活

- dao-plan 已产出可执行任务清单 → 进 dao-execute
- /dao-dev §二·造·编 阶段
- 批量同质任务(多文件改动、N 个测试写)
- 用户说"按 plan 跑"

**不激活**:
- 还没有 plan(回 dao-plan)
- 单步小改(主会话直接做)
- 探索性 / 不确定 task(回 dao-brainstorm 挖清楚)

## 入参(必须)

```
□ 已审批 plan 文档(来自 dao-plan)
  路径: docs/specs/<topic>-plan.md
□ Task 都满足 2-5 分钟粒度
□ 每个 Task 含完整代码模板 + 验证命令
□ 任务依赖图清晰
```

无 plan / plan 不细 = 凭空执行,**回 dao-plan**。

## 执行流程

```
1. 加载 plan 文档
   └─ 读完整 task 清单 + 依赖图

2. 串行 / 并行 调度
   ├─ 无依赖且独立 → dao-pyramid 并行调度模式(推荐单 worker 批量)
   └─ 有依赖 → 串行,前置完成才开下一个

3. 对每个 Task:
   ├─ 读 Task spec(完整代码 + 验证命令)
   ├─ 执行(派 worker-batch subagent 或主会话)
   ├─ 跑验证命令(走 dao-verify 涅槃门)
   └─ 通过 → 进下一个;失败 → 回打

4. Checkpoint(用户关卡；若处于 delegated-continuous，则记录但不等待)
   ├─ 阶段性完成(N 个相关 Task 一组)
   ├─ 大改动前后(改动范围超 5 文件)
   └─ 用户主动要求审视

5. 全部 Task 完成
   └─ 进 dao-review(两阶段评审) → dao-finish
```

## Checkpoint 触发条件

不是每个 Task 都设 checkpoint,**关键节点才设**:

| 触发 | 何时 | 用户要做什么 |
|------|------|-------------|
| 阶段切换 | 一组相关 Task 完成 | 看产物,决定继续/调整 |
| 大改动 | 改动 ≥ 5 文件 | 跑构建,看完整度 |
| 范围扩大 | 发现需要超 plan 范围 | 决定是否回 dao-plan |
| 新发现 | 执行中发现 plan 缺漏 | 决定补 plan / 跳过 |
| 关键决策点 | 多种可行实现路径未在 plan 中决策 | 选一种 |

每个 Checkpoint 必须**显式呈现给用户**,不静默通过。
但若本次执行处于 `delegated-continuous`（用户已授权持续推进 / autopilot 隔离模式）委托连续模式，Checkpoint 降级为执行记录，不调用 AskUserQuestion 工具，不中断流程；只有权限、不可逆、安全/隐私/费用、目标互斥歧义等阻断才问用户。

```
🔒 Checkpoint
完成了: <Task X-Y>
产出: <文件/产物列表>
跑过验证: <命令> → exit 0
下一组: <Task X+1 起>
→ 确认继续 / 暂停调整
```

## 单 Task 执行模板

```
Task <N>: <name>

1. 读 spec
   ├─ Files to Change: <清单>
   ├─ Code Templates: <已读完整>
   └─ Verification: <命令>

2. 派工
   ├─ 简单/模板化 → worker-batch subagent
   ├─ 中等 → 主会话直接做
   └─ 复杂 → spec-writer 重出 spec → worker

3. 执行
   ├─ 严格按 Code Templates,不"顺手优化"
   └─ 不超出 Files to Change 范围

4. 验证(必走 dao-verify)
   ├─ 跑 Verification 命令
   ├─ 读完整输出
   ├─ exit 0 + 输出符合预期 → 过
   └─ 否则 → 回打 worker / spec-writer / debugger

5. 记录
   └─ Status: DONE / BLOCKED / FAILED + 证据贴上
```

## 失败处理路径

```
Task 失败
   │
   ├─ Verification 失败 → dao-verify 给 evidence + 决定下一步
   │  ├─ 测试 bug → 回 worker(改代码)
   │  ├─ 复杂 bug → 派 dao-debug
   │  └─ spec 错 → 回 dao-plan(重出 task)
   │
   ├─ Worker 越界 → 回 worker(限定范围重做)
   │
   ├─ 发现 plan 缺漏 → 暂停,回 dao-plan(补 task)
   │
   └─ 卡死 ≥3 次 → 升级 strategist 质疑架构
```

**绝不"再试一次"**——每次失败必有原因,补 spec / 改 worker / 升级。

## 反模式表

| 病 | 症状 | 道德经诊断 | 对治 |
|----|------|-----------|------|
| 二次解释 | 执行时重新理解 plan | 不行不言之教 | 严格按 plan,有疑回 dao-plan |
| 顺手优化 | "这里可以一起改" | 失边界 | 严守 Out of Scope |
| 跳验证 | "改了应该好了" | 假涅槃 | 必走 dao-verify |
| 失败再试 | "再跑一次看看" | 不诚 | 找原因,不试运气 |
| 跳 checkpoint | 一口气跑到底且无记录 | 不慎 | 关键节点必记录；delegated-continuous 下记录但不停 |
| 抢 plan 功 | "我重新设计了实现" | 不弗居 | 执行不抢功,有想法回 dao-plan |
| 范围爬 | 加了 plan 没说的事 | 失止 | 严格止于 plan |
| 沉默推进 | 非委托模式下不报 checkpoint 给用户 | 独行 | 用户要看见进度；delegated-continuous 下最终报告汇总 checkpoint |

## 涅槃门(全 plan 完成前)

- [ ] 所有 Task 都过了对应的 Verification
- [ ] 每个 checkpoint 用户都已确认、显式跳过，或在 delegated-continuous 下已记录并自动通过
- [ ] 没有"差不多了"未验证的 Task
- [ ] Out of Scope 边界未被破坏(主分支没意外改动)
- [ ] 失败的 Task 都已有处置(回打 / 升级 / 跳过 + 记录)

任一未通 = 不进 dao-review / dao-finish。

## 与其他 dao-* 协作

```
dao-plan (上游)
   │ 任务清单
   ▼
dao-execute (你)
   ├─ dao-pyramid: 并行可拆 task（并行调度模式）
   ├─ dao-test: 每个 Task 走 RED-GREEN
   ├─ dao-verify: 每次完成必有证据
   ├─ dao-debug: 任意 Task 出 bug
   ├─ dao-pyramid: 派 worker-batch / spec-writer subagent
   ▼
dao-review → dao-finish
```

## 反原则(保留 dao 风格)

- **行不言**——执行不啰嗦,verification 命令的输出就是发言
- **不为执行而执行**——发现 plan 错就停,改 plan 是更深的"行"
- **后其身**——主会话当 dispatcher,不抢着写代码,反而成就一切
- **执行 ≠ 蛮干**——遇到障碍升级是道,撞墙不是

