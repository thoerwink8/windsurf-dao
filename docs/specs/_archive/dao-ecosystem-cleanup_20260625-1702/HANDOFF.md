# Handoff: dao-ecosystem-cleanup
> 归档于 2026-06-25 | Fork of dao-fusion | 11 Tasks 20 commits | 52 files, +444 -2806

## 做了什么

基于 v2 审计的 6 个发现，清理 dao 生态孤岛和冗余。原始 6 条扩展为 11 个 Task（持续推进 T8-T10 + 用户审查追加 T11）。

- T1: playbook skill 双栈退役（18 文件删除，0-ref 真孤岛）
- T2: autopilot command 双栈退役 + 13 文件引用清理
- T3: distill/evolve 声明为 evolution 子集
- T4: qa 补引用到 design-open §5 关系表
- T5: dao-loop command §4 补 strategy.md
- T6: brainstormer agent 加 refactor/audit 诊断报告处理
- T7: 全量同步验证
- T8: AGENT_GUIDE 计数/路径系统性修正（rules 11→13, workflows 9→7, skills 27→16, agents 路径修正）
- T9: dao-loop frontmatter + README 补 dao-goal
- T10: README skill 计数 17→16
- T11: evolution 档案层 memory+A+C 改造（CSV 10→5 字段，默认写入，脚本修复）

## 改了哪些文件

**删除（20 文件）**：playbook skill 双栈 18 文件, autopilot command 双栈 2 文件

**修改（32 文件）**：AGENT_GUIDE.md, README.md, global_rules.md, dao-smoke.mjs, dao-dev/distill/evolve/loop commands, brainstorm/plan/design-open/evolution SKILL.md 双栈, evolution scripts 双栈, dao-loop SKILL.md, brainstormer agent, execution/workflow-system rules

## 关键决策

1. **playbook 退役而非合并** — design-system 已覆盖全部编排逻辑，playbook 是纯冗余
2. **autopilot 退役而非重命名** — "autopilot" 概念已过时，功能被 dao-dev delegated-continuous 模式覆盖
3. **distill/evolve 加子集声明而非合并** — 保持独立触发路径，避免 evolution skill 膨胀
4. **evolution CSV 10→5 字段 + 默认写入** — 降低摩擦让 CSV 实际被使用，为 Obsidian 积累数据
5. **dao-loop 加主动追加提醒** — reviewing 中浮现新想法时主动提醒，不默默归类为未来话题

## 验收结果

- A1-A11 全 ✅，dao-smoke 51/51，双栈一致
- 搜索脚本修复验证通过（旧 schema 与实际 CSV 完全不一致，此前搜索功能实际是坏的）

## 关键词

生态清理,孤岛,退役,playbook,autopilot,子集声明,evolution,CSV,默认写入,memory+A+C,AGENT_GUIDE,计数修正

## 后续补丁
<!-- 就地小修时在此记录，格式：日期 | 改了什么 | 为什么 -->
