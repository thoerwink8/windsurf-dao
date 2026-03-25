---
description: 系统健康检查：检测规则/配置/Skills是否完整，发现缺失自动恢复。IDE重启后、新对话开始时触发。
---

# 健康检查 · Health Check

> 知人者智，自知者明。胜人者有力，自胜者强。

## 触发条件

- IDE 重启后首次交互
- 感觉系统行为异常
- 新对话开始且有 SYSTEM-RETRIEVED-MEMORY
- 用户显式调用 `/health-check`

## 流程

### 一、检测（☲离 · 视 · 照见缺失）

检查以下关键文件是否存在且内容完整：

**规则层：**
- [ ] `rules/dao-layer.md` — 道层规则
- [ ] `rules/de-layer.md` — 德层规则
- [ ] `rules/fa-layer.md` — 法层规则
- [ ] `rules/shu-layer.md` — 术层规则

**工作流：**
- [ ] `workflows/dev.md` — 开发管线
- [ ] `workflows/cycle.md` — 转法轮
- [ ] `workflows/debug-escalation.md` — 调试升级
- [ ] `workflows/doc.md` — 文档
- [ ] `workflows/evolve.md` — 进化
- [ ] `workflows/health-check.md` — 健康检查
- [ ] `workflows/review.md` — 代码审查
- [ ] `workflows/test.md` — 测试
- [ ] `workflows/refactor.md` — 重构
- [ ] `workflows/optimize.md` — 性能优化

**技能：**
- [ ] `skills/` 目录下各技能的 `skill.md` 存在

**内容完整性：**
- 每个规则文件有 `trigger: always_on` frontmatter
- 每个工作流文件有 `description:` frontmatter
- 四层架构一致：道/德/法/术 文件齐全

### 二、诊断（☵坎 · 听 · 听回响）

- 缺失文件 → 标记为 🔴
- 内容不完整 → 标记为 🟡
- 正常 → 标记为 🟢

### 三、恢复（☳震 · 触 · 修复）

- 缺失的规则文件 → 从模板或备份恢复
- 过时的 Memory → 归位后删除
- 不一致的引用 → 更新

### 四、报告（☶艮 · 味 · 总结）

```
## 🏥 健康检查报告
| 域 | 状态 | 发现 |
|----|------|------|
| 规则 | 🟢/🟡/🔴 | [具体] |
| 工作流 | 🟢/🟡/🔴 | [具体] |
| 技能 | 🟢/🟡/🔴 | [具体] |
| Memory | 🟢/🟡/🔴 | [残留/已清空] |
```
