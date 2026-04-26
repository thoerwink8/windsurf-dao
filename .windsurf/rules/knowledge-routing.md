---
trigger: model_decision
description: 知识归位决策——判断"这个知识/经验应该写到哪个文件"。归属表(AGENT.md / AGENT_GUIDE.md / skills/ / workflows/ / data/evolution-*.csv)、双文件模式、Memory 归位四步。需要写新知识或处理 SYSTEM-RETRIEVED-MEMORY 时读取
---

# 知识归位 · 写到哪

> 万物归根，归根曰静。

## 归位路由表

| 知识类型 | 归属 |
|---|---|
| 不变原则 / 道德经哲学 | `dao-philosophy.md` / `道德经.md` |
| 项目级铁律 | `execution.md` |
| 普适哲学 | `global_rules.md`（用户级，跨项目） |
| 命令安全 / 工具选择 / Skill 调用 | `shell.md` / `cli.md` / `skills.md` |
| 操作流程 | `workflows/` |
| 具体技能（实现层） | `skills/` |
| 编码规则（怎么写代码） | `AGENT.md` |
| 项目知识（学到了什么） | `AGENT_GUIDE.md` |
| 教训 / 踩坑 | `data/evolution-lessons.csv`（优先） |
| 演化条目 | `data/evolution-entries.csv` |

## 双文件模式

每个项目最终都应有 `AGENT.md`（规则）+ `AGENT_GUIDE.md`（知识）：

- **AGENT.md** 存：编码规范、技术栈约束、代码风格
- **AGENT_GUIDE.md** 存：项目概览、发现的模式/反模式、架构决策、演化记录

不存在时**创建**。

## AGENT_GUIDE.md 结构

§概览（always）→ §演化索引（路由表）→ §教训 → §决策 → §指南

演化详情超 200 行时分离到 `docs/evolution.md`，§索引保留每版本一行（版本 | 日期 | 摘要 | 教训号），AI 按需读取——主文件不因历史增长而膨胀。

## 虚 · Memory 归位

> Memory 是虚的载体，非知识仓库。理想态为空。

### 预防 · 少生

- **优先写文件**：知识有明确归属时，直接写入目标文件，不经 Memory 中转
- **Memory 只存真正的中间态**：跨多步操作的临时上下文，完成即删
- **判据**：这条知识属于哪个文件？知道 → 直接写。不知道 → 暂存 Memory，涅槃时归位

### 执行 · 涅槃归位

涅槃时四步：
1. 扫描存活 Memory
2. 路由到归属文件（用 `edit` / `write_to_file` 写入）
3. 用 `create_memory` Action="delete" 逐条删除
4. 验证为空

**不可跳过**——涅槃报告必须含"虚：已归位/已清空"或"虚：无残留 Memory"。

### 补漏 · 会话审计

会话开始时若注入了 `SYSTEM-RETRIEVED-MEMORY`：

- 已过时 → 直接 `create_memory` Action="delete"
- 有价值但属于文件 → 归位后删除
- 仍需跨会话 → 保留（极少数情况）

**不主动创建新 Memory 来替代旧的**——归位是写文件，不是换一条 Memory。
