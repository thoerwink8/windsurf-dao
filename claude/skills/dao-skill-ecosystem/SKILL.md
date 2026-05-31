---
name: dao-skill-ecosystem
description: 技能供应链——任务中发现技能缺口时查图书馆、junction或创建；创建新技能后评估通用性、提议入库。感知技能不足时加载。
---

# 技能生态 · Skill Ecosystem

> 加载 dao-philosophy skill §推理链第 4 步"器"的延伸：skill（已装）→ 图书馆 → 创建 → 写代码。

## 正向供给（感知缺口时）

### 1. 查图书馆（find-skill）

```powershell
# 列出图书馆所有可用 skills（按分类显示）
<skills-kit-path>\add-skill.ps1 list
```

将任务需求与列表中的 skill name + description 匹配。

### 2. 有匹配 → Junction

```powershell
# 只需 skill 名，无需知道分类
<skills-kit-path>\add-skill.ps1 <current-project-path> <skill-name>
```

Junction 完成后，用 `skill` 工具加载该 skill，继续任务。

### 3. 图书馆无匹配 → 搜开源生态（find-skills）

加载 `find-skills` skill，用 `npx skills find [query]` 搜索 skills.sh 开源生态。
找到后评估质量，决定直接安装还是参考后自建。

### 4. 无匹配 → 评估是否创建

- 一次性任务 → 不创建，直接执行
- 反复出现的领域 → 创建 skill
- 格式：`claude/skills/<name>/SKILL.md`，必须有 `name:` + `description:` frontmatter

## 反向传播（创建新 skill 后）

### 通用性评估

| 信号 | 通用 | 专属 |
|------|:----:|:----:|
| 不依赖项目特定 API/数据 | ✅ | |
| 其他项目可能遇到同类问题 | ✅ | |
| 包含项目专有业务逻辑 | | ✅ |
| 引用项目特定文件路径 | | ✅ |

### 入库流程

1. AskUserQuestion：提议入库 + 建议分类（dev / business / meta）
2. 用户确认 → 移动 skill 目录到图书馆对应分类
3. 在项目中创建 junction 指向图书馆位置
4. 验证 frontmatter 完整性

## 路径发现

图书馆路径不硬编码。按优先级定位：

1. 从当前 workspace 列表中查找名称含 `skills-kit` 的 workspace
2. 从已知 junction 的 Target 反推
3. 询问用户

## 决策树

```
任务中感知技能缺口
  ├→ 查已装 skills → 有匹配 → 加载，继续
  ├→ 查图书馆(add-skill.ps1 list) → 有匹配 → junction，继续
  ├→ 搜开源生态(find-skills) → 有匹配 → 评估/安装，继续
  ├→ 值得创建？
  │   ├→ 否 → 直接执行
  │   └→ 是 → 创建 → 执行 → 评估通用性
  │       ├→ 通用 → 提议入库（AskUserQuestion）
  │       └→ 专属 → 保留项目
  └→ 继续任务
```

## 互补对照（道 ↔ 器）

dao skills 提供方法论（HOW），kit skills 提供实现（WHAT）。加载一方时检查互补：

| 领域 | dao (方法论) | kit (实现) |
|------|------------|-----------|
| 调试 | dao-debug | —（已完全内化） |
| 重构 | dao-refactor | — |
| 优化 | dao-optimize | — |
| 测试 | dao-test | test-driven-development, webapp-testing |
| 审美 | dao-frontend-aesthetics | ui-ux-pro-max |
| UI 决策 | dao-ui-mockup | ui-ux-pro-max（消费方向库） |
| 设计 | dao-research | brainstorming |
| 安全 | — | security-audit |
| 数据库 | — | database-patterns |
| 后端 | — | express-typescript-api |
| 移动端 | — | react-native-expo |

## 与现有机制的关系

| 机制 | 角色 |
|------|------|
| dao-philosophy skill §推理链第 4 步 | 触发点：推理链"器"步感知缺口 |
| 本 skill | 供应链：查库 → junction → 创建 → 反哺 |
| `add-skill.ps1` | 执行层：junction 操作 |
| `/dao-evolve` | 定期审查：批量检查所有项目的 skill 健康度 |
