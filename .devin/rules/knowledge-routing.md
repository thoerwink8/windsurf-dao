---
trigger: always_on
description: 知识归位决策——判断"这个知识/经验应该写到哪个文件"。归属表(AGENT.md / .devin/rules/ / skills/ / workflows/ / data/evolution-*.csv)、Rule vs Skill 边界、中间物 _tmp/ 管理、Memory 归位四步。需要写新知识或处理 SYSTEM-RETRIEVED-MEMORY 时读取
---

# 知识归位 · 写到哪

> 万物归根，归根曰静。

## 归位路由表

| 知识类型 | 归属 |
|---|---|
| 不变原则 / 道德经哲学 | `dao-philosophy.md` / `道德经.md` |
| 项目级铁律、编码规范 | `AGENT.md`（<80 行，精简入口） |
| 项目级领域规范（设计 token / 架构 / 测试约定等） | `.devin/rules/`（按领域拆分） |
| 普适哲学 | `global_rules.md`（用户级，跨项目） |
| 命令安全 / 工具选择 | `shell.md` / `cli.md` |
| 操作流程 | `workflows/` |
| 具体技能（实现层） | `skills/` |
| 固定技术栈选型（框架/脚手架） | `stacks/` |
| 教训 / 踩坑 | `data/evolution-lessons.csv`（优先） |
| 演化条目 | `data/evolution-entries.csv` |

## AI 上下文通道

`AGENT.md`（<80 行入口）+ `.devin/rules/`（领域规范）是唯一的 AI 上下文通道。禁止维护 `AGENT_GUIDE.md` / `KNOWLEDGE.md` 等冗余入口——归入 `AGENT.md` 或 rules。

## 回顾即检索

遇回顾类提问（之前/上次/记得吗）先搜 Memory + 演化教训库再答，勿凭记忆断言。

## Rule 与 Skill 边界

> 朴散则为器。Rules 是朴，Skills 是器。

- `.devin/rules/*.md` 是 **rule**：通过读取文件生效，不通过 `skill()` 调用
- `.devin/skills/*/skill.md` 是 **skill**：仅当工具清单里存在对应 skill 名时才调用
- skill 调用时机由 system prompt 中 skill 列表的 description 决定，本文不重复

## 中间物 · _tmp/ 归位

分析脚本/临时查询/调试辅助集中放 `_tmp/`，用后即清，洞察归项目文件/规则。

## 虚 · Memory 归位

Memory 是虚的载体非知识仓库，理想态为空。**预防**：知识有归属 → 直接写文件不经 Memory。**涅槃**：扫存活 Memory → 路由到归属文件 → delete → 验证为空（报告必含"虚：已归位/已清空"）。**审计**：`SYSTEM-RETRIEVED-MEMORY` 过时→删，有价值→归位后删，仍需跨会话→保留（极少）。不创建新 Memory 替代旧的。
