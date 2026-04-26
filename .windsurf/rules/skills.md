---
trigger: model_decision
description: Dao Skill 的调用决策——何时加载哪个 dao-* skill(dao-debug / dao-evolution / dao-fa-mechanism / dao-observability / dao-skill-ecosystem)、Rule 与 Skill 的边界、临时脚本/中间物生命周期。讨论"加载哪个 skill"或管理 _tmp/ 时读取
---

# Skills · 何时加载哪个

> 朴散则为器。Rules 是朴，Skills 是器。

**本文件 vs `.windsurf/skills/dao-*/skill.md`**：本文件是**元决策层**（讨论"何时加载哪个 skill"）；`skills/dao-*/skill.md` 是**具体实现**（单个 skill 的方法论 + 支撑文件）。本文件只描述触发决策，不重复 skill 内容。

## Rule 与 Skill 边界

- `.windsurf/rules/*.md` 是 **rule**：通过读取文件生效，不通过 `skill()` 调用
- `.windsurf/skills/*/skill.md` 是 **skill**：仅当工具清单里存在对应 skill 名时才调用

## Skill 调用时机

| 场景 | 加载 skill |
|---|---|
| 理解 Windsurf 内部机制（注入格式 / 激活模式 / 目录结构） | `dao-fa-mechanism` |
| 任务属于特定领域（调试 / 重构 / 优化 / 测试 / 可观测） | 对应镜头 skill（见 cycle 镜头表） |
| 代码涉及定时任务 / 外部 API / schema / 锁 / 操作顺序调整 | `dao-observability` |
| 教训 / 经验 / 历史 / 踩坑记录 | `dao-evolution`（BM25 搜索 + CSV 读写） |
| 感知 skill 缺口 / 创建新 skill 后评估 | `dao-skill-ecosystem` |

## 中间物管理

> 飘风不终朝。

分析脚本 / 临时查询 / 调试辅助——皆为中间物：

- **生时有序**：集中放 `_tmp/` 或 `_scratch/`，不散落项目根目录
- **用后即清**：任务完成或方向确定后清理，不留熵
- **知识不随器灭**：洞察归入项目文件或规则，脚本本身可弃

Memory 与中间物同理——都是虚的表现，用完归位后消散。
