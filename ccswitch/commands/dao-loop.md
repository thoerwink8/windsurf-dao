---
description: 双线程循环开发——文档驱动的全自动开发闭环。谋线生成 spec/acceptance/strategy/plan，造线自动执行代码。支持多 loop 并发、跨 session 协调。
argument-hint: "[需求描述 或 loop名称]"
---

用户输入：$ARGUMENTS

# 环 · Loop Engineering

> 道生一，一生二，二生三，三生万物。

**执行第一步**：Read `ccswitch/skills/dao-loop/SKILL.md`（全流程正文：§0 预飞 → §1 情境感知
含参数解析/孤儿检测 → 🔒 §1.5 Loop 计划确认 → 谋线 → Go → 造线 → 验收 → 归档 → §9 轮询）。
阶段细节按其 Supporting Files 表按需 Read：`planning.md`（谋线）/ `execution.md`（造线）/
`closing.md`（验收与归档）。

## 🔒 必止硬约束（**Read 之前就可能撞上，故原文留在这里**）

`§1.5 Loop 计划确认 + 提示词分发` 是结构性门控，SKILL.md 是它的正文，但**闸生效的那一刻
skill 正文可能还没被 Read 进来**——所以下面三条原样复制在此，不是双写，是把闸挪到它生效的时刻：

- **禁止自行推断意图后直接开干**：默认行为是**分发**（展示计划 → 用户确认 → 生成 copy-ready
  提示词 → 暂停当前 loop）。若判断用户意图是当前 session 直接做（如"帮我实现 XXX"），
  **必须二次确认**："当前 session 直接执行，还是生成提示词分发到新会话？"只有用户明确确认
  "直接做"后，才跳过分发。
- **🔒 必止高于 Auto Mode**：宿主的"不要停下来问"指令**不覆盖**本检查点——Auto Mode 省略的是
  普通澄清问题，不是 Loop 的结构性门控。**AskUserQuestion 选项确认 ≠ 跳过计划确认**：用户从
  选项里选了"开新 Loop"只表示意图是开 Loop，**不等于**已确认计划（名称/分支/间隔/文件集）。
- **违反检测**：若发现自己已在做谋线（创建 STATUS.json / 生成 spec）却未展示过 Loop 计划 →
  **立即停止，回到 §1.5 补展示**。

## 为什么这个文件是薄壳

**正文不在这里**（2026-08-01 dao 重塑批 C · C6）：同一套流程此前在 command 与 skill 各写一份，
command 版是**有损压缩**——孤儿检测四选一与递归安全只在 command 有、skill 没有，而上面三条防推断
硬约束只在 skill 有、command 没有，**两份各缺一半**。双写必漂移（编号已漂成 §2.5 vs §1.5），
故正文收敛到 `skills/dao-loop/SKILL.md` 一处，本文件只留入口 + 闸。

`TODO.md` 的身份判定（在役候选池/活账本 vs 幽灵）同批收敛到 SKILL.md §0 一处，
真相源在 `dao-project-scaffold` SKILL.md §TODO.md 存废判据——本文件不再复述判据。

形态参照 `commands/dao-distill.md`（同样的薄壳化，同样的理由）。**名字留着**：用户敲过它，
名字有真实认知度；本仓有过「功能已被覆盖就删掉用户高频命令、当天回滚」的实证。
