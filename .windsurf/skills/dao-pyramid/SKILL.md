---
name: dao-pyramid
description: Subagent 金字塔调度铁律：高级模型出 spec 与决策,低级模型按 spec 执行,主会话当 dispatcher。8 个 .devin/agents profile 各司其职,通过派活四要素和两阶段 review 协同。"小国寡民、无为而无不为"——主会话不亲为而万事成。
---

# 金字塔 · Pyramid Lens

> 小国寡民。使有什佰之器而不用。
> 无为而无不为。
> ——《道德经》第 80、48 章

道家"小国寡民"是治理观:**让每个小国(subagent)只做一件事，互不干涉**。
"无为而无不为"是行动观:**主会话不亲手写代码，反而成就一切**——靠的是合理派活。

每个 subagent 是"小国"——窄职责、单模型、有边界。
主会话是"圣人"——不强为而万事成，靠的是把活派给该派的人。

## 铁律

```
不该亲为则不亲为。该派 subagent 时不要"我顺手做"。
不在该用 Opus 时省 Opus。该用 SWE 时不要"反正我用 Sonnet"。
不让任何一个 subagent 越界。spec 之外的事,回打调度层。
```

## 何时激活

- 任务需要**多步**协同(单步任务直接做)
- 任务有**可拆批量子任务**(改 50 个文件、写 100 个测试)
- 任务包含**需要 review 的关键改动**(支付/认证/安全/核心抽象)
- 复杂度超过单会话上下文(派 subagent 节省主会话 context)
- /dev 或 /cycle 工作流执行时

**不激活**:
- 简单问答 / 闲聊 / 信息查询(主会话 Adaptive 直接答)
- 紧耦合架构设计(整体性思考,不该拆)
- 探索性、不确定要做啥(先 brainstormer 挖,别拆 task)

## 金字塔结构

```
战略层  Opus 4.7 XHigh/Max     ── strategist        架构定调 / 卡死攻坚
                                                   稀少召唤,贵但值
─────────────────────────────────────────────────────────────────
指挥层  Opus 4.7 High          ── reviewer-critical 核心模块对抗性 review
        Sonnet 4.6 Thinking    ── brainstormer      Step 1 苏格拉底问需求
                               ── spec-writer       把 plan 翻成 worker 可执行 spec
                               ── reviewer          two-stage review 主力
                               ── debugger          systematic-debugging 4 phases
        GPT 5.5 Low/High       ── plan-writer       PRD/方案/选型/2-5 分钟任务清单
─────────────────────────────────────────────────────────────────
调度层  Adaptive               ── 主会话默认         调度 + 不确定时兜底
─────────────────────────────────────────────────────────────────
工人层  SWE 1.6 Fast (free)    ── worker-batch      严格按 spec 执行,零自主判断
```

源文件:`.devin/agents/<name>/AGENT.md`

## 8 profile 速查

| profile | 模型 | 何时派 | 不该派 |
|---------|------|--------|--------|
| **brainstormer** | Sonnet Thinking | 用户提"我想做 X"的开放需求 | 任务已具体到细节 |
| **plan-writer** | GPT Low/High | 写 PRD / 方案 / 选型对比 / 2-5 分钟任务清单 | 写代码 / 调试 |
| **strategist** | Opus XHigh/Max | 架构定调一次性 / 卡 3 次失败质疑架构 | 普通 review / 简单任务 |
| **spec-writer** | Sonnet Thinking | 把 plan 翻成 worker 可执行 spec | 自由探索性任务 |
| **reviewer** | Sonnet Thinking | 两阶段评审 worker 产出 | 核心模块(派 critical) |
| **reviewer-critical** | Opus High | 支付/认证/安全/核心抽象 review | 普通 CRUD |
| **debugger** | Sonnet Thinking | 任意阶段遇 bug | 还没出现问题 |
| **worker-batch** | SWE 1.6 Fast | 严格按 spec 批量执行 | spec 不清就拒绝 |

## 派活四要素(每次派 subagent 必含)

来自 Anthropic 多 agent 实测:**任务描述缺任一要素,subagent 会重复劳动 / 留缝隙 / 找不到东西**。

### 1. Objective(目标)

可观测的完成判据。

- ✅ "在 `src/utils/retry.ts` 创建 `retryOperation`,通过 `__tests__/retry.test.ts` 中所有断言"
- ❌ "实现重试逻辑"(太抽象)

### 2. Output Format(输出格式)

精确到文件路径 + 完整代码模板,worker 直接复制。

### 3. Tools / Sources(工具与来源)

明确用哪些工具、读哪些文件、跑哪些命令。

### 4. Task Boundaries(任务边界)

显式说"不该做什么":
- ✅ "不修改 `src/utils/sleep.ts`,不引入新依赖"
- ❌ 没有边界 → worker 顺手优化邻居代码 → 引发回归

## 升级路径(失败回打方向)

```
worker-batch 失败            → spec-writer(spec 不清)
spec-writer 失败            → plan-writer(plan 不细)
plan-writer 失败            → brainstormer(需求不明)
普通 reviewer 发现严重问题   → reviewer-critical(核心模块)
reviewer-critical 卡住       → strategist(架构嫌疑)
debugger 失败 ≥3 次          → strategist(质疑架构本身)
```

不可跳层。worker 不应该直接被升级到 strategist——必须经过中间层让信息浓缩。

## Subagent-Driven Development 完整流程

> 来自 superpowers `subagent-driven-development` 核心 + dao 升级。

每个 plan task 都派**全新 subagent**(不复用),通过两阶段 review 闭环:

```
plan 输出 N 个 task
   ↓
对每个 task:
  ┌──────────────────────────────────────┐
  │ 1. 派 fresh subagent(不复用旧 agent) │
  │    - 新 context 窗口                  │
  │    - 派活四要素齐                     │
  │    - 引用 dao-test (RED) + dao-verify │
  └────────────┬─────────────────────────┘
               ↓
  ┌──────────────────────────────────────┐
  │ 2. subagent 走 RED-GREEN-REFACTOR    │
  │    - RED:写失败测试,跑必看到 fail    │
  │    - GREEN:最小代码,跑必看到 pass    │
  │    - REFACTOR:清理,跑仍 pass         │
  └────────────┬─────────────────────────┘
               ↓
  ┌──────────────────────────────────────┐
  │ 3. 派 reviewer Stage 1(spec合规)     │
  │    - 对照 plan 任务清单逐项勾         │
  │    - FAIL → 回打 worker(执行偏)     │
  └────────────┬─────────────────────────┘
               ↓ PASS
  ┌──────────────────────────────────────┐
  │ 4. 派 reviewer Stage 2(代码质量)     │
  │    - P0/P1/P2/P3 分级                │
  │    - 核心模块 → reviewer-critical    │
  │    - FAIL 普通 → 回 spec-writer      │
  │    - FAIL 严重 → 升级 strategist     │
  └────────────┬─────────────────────────┘
               ↓ PASS
  ┌──────────────────────────────────────┐
  │ 5. 接收批评(若 review 有 issue)     │
  │    - dao-review "受国之垢" 流程       │
  │    - 全读不抢话 / 逐条分类            │
  │    - 修后必走 dao-verify 重跑         │
  └────────────┬─────────────────────────┘
               ↓ Task DONE
  → 下一个 task(回 1)
```

### 关键原则

1. **Fresh subagent per task** —— 每个 task 起新 subagent,**不复用**。理由:旧 subagent context 含上一任务上下文,会污染新任务判断。
2. **状态通过 plan + 文件传递** —— subagent 间不直接对话,通过 plan 文档 + 共享文件系统协调。
3. **review 是 gate 不是建议** —— Stage 1/2 是硬关卡,不过不进下一 task。
4. **失败回打方向决定层级** —— spec 不清回 spec-writer,执行偏回 worker,架构问题升 strategist。

### 与 dao-execute 的关系

```
dao-execute        作为执行调度入口(决定何时进入 SDD 流程)
   ↓
dao-pyramid SDD    作为单 task 执行的微观闭环
   ↓
dao-review         两阶段评审是 SDD 的核心 gate
   ↓
dao-finish         所有 task 完成后的收尾决策
```

## Two-Stage Review 机制

每个 worker 任务完成后:

```
Stage 1: Spec Compliance     →  reviewer
         "做的是不是 spec 要求的事?"
         失败 → 回打 worker

Stage 2: Code Quality        →  reviewer 或 reviewer-critical
         "做得好不好?有没有 bug?"
         失败 → 回打 spec-writer 或升级 critical
```

Stage 1 不通过 → **不必进 Stage 2**(评审一个根本没按 spec 做的产物 = 浪费)。

## 调用方式

### 在 Devin/Windsurf 内主会话调用

```
"派 brainstormer subagent 帮我挖需求 X"
"派 spec-writer subagent 把 plan 翻成 spec"
"派 worker-batch subagent 批量改 50 个文件,spec 见 ...md"
```

主会话(Adaptive)读到指令 → 起 background/foreground subagent。

### 派活前自检

```
□ 这个任务真要派 subagent?(单步任务别派)
□ 派给哪个 profile?(对照"何时派"表)
□ 四要素齐全?(objective/format/tools/boundaries)
□ subagent 完成后谁 review?(reviewer / critical / 自己)
```

## 反模式表

| 病 | 症状 | 道德经诊断 | 对治 |
|----|------|-----------|------|
| 圣人亲为 | 主会话(Opus)亲手写代码 | 不无为 | 派 worker-batch |
| 工人决策 | SWE 自己决定怎么实现 | 不在其位 | 派 spec-writer 出指令 |
| 跳层升级 | worker 失败直接派 strategist | 不阶进 | 先 spec-writer 中转 |
| 跳过 review | worker 报 done 就采纳 | 假涅槃 | 必走 Stage 1+2 |
| 重叠 spec | spec 让 worker 决定细节 | 不智 | spec 必须封死歧义 |
| 过度并发 | 一次派 5+ subagent | 失节制 | Windsurf 账户级 rate limit 实测 ≤1 并发 + 时间间隔 |
| Opus 当 worker | 派 Opus 干批量改名 | 杀鸡用牛刀 | SWE 1.6 free 够用 |
| SWE 当 reviewer | 让 SWE 找 bug | 不知人 | reviewer 至少 Sonnet |
| 死 subagent | subagent 卡住不 cleanup | 不归根 | 用 read_subagent 检查或 kill |

## 涅槃门(任务交付前)

- [ ] 所有 subagent 都已完成或显式 cancel
- [ ] 所有 worker 产出都过了 Stage 1+2 review
- [ ] 失败的 subagent 已回打到正确层级
- [ ] 没有"半成品"的 subagent 输出被采纳
- [ ] 调度链完整记录(谁派谁、谁审谁)

## 实测限制(Windsurf 账户级)

⚠️ **2026-05-08 实测**:Windsurf 个人账户 subagent 派发受**1 小时滚动 rate limit**。
- 单 subagent + 时间间隔 → 可行
- 任意 ≥2 个并发 → 立即 rate limited
- "no credits used"——节流不扣费,但配额耗尽 1 小时内不能再派

**调度策略**:**串行 + 节流**,不要假设可并发。Pro 账户上限可能更高,自行测试。

## 与其他 dao-* 的协作

- **dao-dev** workflow:每个阶段(谋/造/成)显式标注派哪个 profile
- **dao-test**:RED 阶段派 spec-writer 出测试设计,GREEN 阶段派 worker-batch 实施
- **dao-verify**:任何 subagent 完成都必须走涅槃门验证
- **dao-debug**:横切横扫——任意阶段出 bug 派 debugger
- **dao-review**:Two-stage 评审就是 reviewer/critical 的工作

## 反原则(保留 dao 风格)

- **不为多 agent 而多 agent**——简单任务别拆
- **不为节省 token 而强拆**——拆开本身有调度开销
- **金字塔不是层级森严的官僚** —— 是合理分工
- **派 subagent 不能甩锅**—— 主会话仍负责最终交付质量
