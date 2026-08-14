---
name: grill-me
description: Grill the user relentlessly about a plan, decision, or idea. Use when the user wants to stress-test their thinking, or uses any 'grill' trigger phrases.
---
> 来源：设计树那一半是 Matt Pocock 原版（MIT），上游同步义务只覆盖那一半；五步法骨架为本仓扩展。2026-08-11 用户拍板收进本仓（host/），随 dao 部署、换机自带；上游有更新时人工同步（仅设计树节）。

## 先判对象，再选拷问法

开拷之前先问一句：被拷问的对象是哪一类？

- **存量决策** —— 对象是「已存在或要新增的东西**该不该**（做 / 留 / 退役）」：一个功能要不要上、一条规则要不要留、一个组件要不要退役。⇒ 走下面的**五步法**。
- **增量设计** —— 对象是「要做的东西**长什么样**」：方案已定要做，细节还没掰开。⇒ 走下面的**设计树轮询**。

拿不准就先按存量决策拷第一步（质疑需求），拷完自然分晓——需求都站不住的东西没有「长什么样」可谈。

## 五步法（存量决策）

马斯克五步法：**质疑需求 → 删除 → 简化 → 加速 → 自动化**。顺序不可换——最贵的错误是优化一个本不该存在的东西。每步一问一答：AI 按模板发问并附上自己的推荐答案，等用户作答；**五步全过才算拷问完**，中途任何一步把对象拷死了（需求不成立 / 该删），拷问即刻收束，后面的步不再走。

每步的问题格式与设计树节相同：

```
❓ **S<n> · <步名>** - <question body>

➡️ <your recommended answer>
```

1. **质疑需求**：这条要求是谁提的、为什么提、今天还成立吗？要挖到具体的人和场景——「大家都觉得」「一直如此」不是答案。答不出提出者与理由的需求，默认不成立。
2. **删除**：删掉它（或它的哪一层）会发生什么坏事？坏事多久发生一次、谁会叫？删到偶尔要加回来才算删够；从没被迫加回来过，说明还删得不够狠。
3. **简化**：需求站住、删无可删之后，剩下的部分能不能更简单？合并同类项、去掉条件分支、用已有机制替代新造机制。
4. **加速**：简化后的流程哪一步最慢、最常等？只加速确定要留的东西——给一个还没过前三步的环节提速是白费。
5. **自动化**：最后才谈自动化。要自动化的这条流程已经被前四步榨干了吗？自动化一个错误的流程只会更快地产出错误。

## 设计树轮询（增量设计）

Interview the user relentlessly until you reach a shared understanding. Map this as a **design tree**: every decision branches into the decisions that hang off it.

Work the tree in **rounds**. The **frontier** is every decision whose prerequisites are already settled — the questions you can ask _now_ without guessing at answers you haven't heard yet. Ask the whole frontier in one round: number each question and give your recommended answer. Then wait for the user's answers before the next round.

Each question should be formatted like so:

```
❓ **Q1** - **<question title>**: <question body, might be multiple paragraphs, including multiple choices>

➡️ <your recommended answer>
```

Each round the user answers reshapes the tree — settled decisions push the frontier outward and unblock questions that depended on them. Recompute the frontier and ask the next round. A question whose answer depends on another question still open in this round belongs to a _later_ round, not this one.

Finding _facts_ is your job, never the user's. When a frontier question needs a fact from the environment (filesystem, tools, etc.), dispatch a sub-agent to find it — don't ask the user for anything you could look up yourself. Don't block on it: a running exploration is an unsettled prerequisite, so only the questions downstream of it wait for the sub-agent to report — ask the rest of the frontier now. The _decisions_ are the user's — put each to them and wait.

The session is done when the frontier is empty: every branch of the design tree visited, nothing left silently assumed. Do not act on it until the user confirms you have reached a shared understanding.
