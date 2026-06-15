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
- 格式：`ccswitch/skills/<name>/SKILL.md`，必须有 `name:` + `description:` frontmatter

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
| 审美 | dao-design-taste | ui-ux-pro-max |
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

---

# 全景地图 · 38 skill 何时用哪个

> 知人者智,自知者明。先看清自己有哪些器,才知何时取用。
>
> **触发类型**:🤖 自动(AI 按 description 自动加载) · ✋ 手动(用户显式调或主动查阅) · 🔗 被调(被工作流/其他 skill 引用,不直接面向用户)

## 怎么读这张图

- **你(用户)**:大多数时候**什么都不用记**——🤖 自动类 AI 会自己加载。你只需记住几个 ✋ 手动入口(见下"用户高频手动入口")。
- **AI**:按阶段/领域定位,description 是自动触发的判据(本图同时是 description 准确性的校准基准)。

## 用户高频手动入口(只需记这几个)

| 想做什么 | 调什么 | 类型 |
|---|---|---|
| 开始一个完整任务(隔离→plan→执行→审→收) | `/dao-superpowers` | ✋ |
| 日常迭代循环(改善现有代码) | `/dao-cycle` | ✋ |
| 从需求到交付全管线(新功能/新页面) | `/dao-dev` | ✋ |
| 深度哲学反思 / 质疑某规则的根 | `/dao-philosophy` | ✋ |
| 记录/回顾教训 | `/dao-evolve` | ✋ |
| 提交 | `/dao-commit` | ✋ |

> 其余 skill 绝大多数是 🤖 自动 或 🔗 被调,**你不用主动记**。下面分类图供需要时查阅。

## 分类地图

### A. 阶段流水线(🤖 自动,按任务阶段顺序触发)

| skill | 阶段 | 触发场景 | 章句根 |
|---|---|---|---|
| `dao-brainstorm` | 构思 | 🤖 模糊想法/架构构思,挖成 design | 图难于其易 (63) |
| `dao-empathy` | 构思 | 🤖 UX 决策/需求模糊/用户反馈解读 | 以百姓心为心 (49) |
| `dao-research` | 构思 | 🤖 分析"怎么做"需搜最优实践 | 不闭门造车 |
| `dao-plan` | 规划 | 🤖 已审批 design → 拆 2-5 分钟粒度任务 | 为大于其细 (63) |
| `dao-execute` | 执行 | 🤖 加载 plan 逐 Task 执行 | 上善若水 (8) |
| `dao-verify` | 执行 | 🤖 声明"完成"前必有 fresh 验证证据 | 涅槃门 |
| `dao-review` | 审查 | 🤖 两阶段评审(spec→quality) | 受国之垢 (78) |
| `dao-finish` | 收尾 | 🤖 Task 完成+review 过 → 决定集成方式 | 功遂身退 (9) |

### B. 设计(🤖 自动,以 dao-design-taste 为基石总闸)

| skill | 角色 | 触发场景 | 类型 |
|---|---|---|---|
| `dao-design-taste` | **基石总闸** | 任何 UI/界面/组件/主题任务先过它分诊 | 🤖 |
| `dao-ui-mockup` | 形态探索 | 分诊 FULL/SCOPED 时被调,产 HTML+tokens | 🔗 |
| `dao-design-assets` | 资产落地 | 创建组件/改样式/统一组件库 | 🤖 |
| `dao-project-structure` | 目录约定 | 创建新文件/新项目/"这文件放哪" | 🤖 |

### C. 镜头(🔗 多在 /dao-cycle 中按需加载,也可独立激活)

> "镜头" = 看代码的某个特定视角,通常在迭代循环里按需取用。

| skill | 看什么 | 触发场景 | 类型 |
|---|---|---|---|
| `dao-refactor` | 结构 | 代码重复/过长函数/命名不清 | 🔗🤖 |
| `dao-optimize` | 性能 | 运行慢/内存高,量化瓶颈 | 🔗🤖 |
| `dao-decouple` | 耦合 | 改一处牵一片/模块膨胀 | 🤖 |
| `dao-test` | 测试 | 先红后绿 TDD | 🔗🤖 |
| `dao-quality` | 质量门 | 🤖 写/审代码时按领域过检查清单 | 🤖 |
| `dao-debug` | 死磕 | 🤖 bug 死磕到底(三层螺旋) | 🤖 |

### D. 专项术(🤖 自动,特定情境触发)

| skill | 情境 | 类型 |
|---|---|---|
| `dao-full-coverage` | 重大变更后/发布前/接手新项目 → 8 维体检 | 🤖 |
| `dao-user-simulation` | 功能上线前/UI 大改后 → E2E 仿真 | 🤖 |
| `dao-observability` | 变更涉及异步/外部API/共享状态 → 设计日志 | 🤖 |
| `dao-reverse-engineering` | 面对未知/混淆代码库 → 系统化逆向 | 🤖 |
| `dao-boundary-probe` | 集成外部系统前 → 最小穿透测试 | 🤖 |
| `dao-windsurf-extension` | 逆向第三方平台/开发 IDE 扩展 | 🤖 |
| `dao-deploy` | 部署上线 | 🤖 |
| `dao-scaffold` | 新项目启动选脚手架 | 🤖 |
| `dao-terminal-resilience` | 终端卡死/工具反复失败/"卡住了" | 🤖 |

### E. 调度与隔离(🔗 被工作流引用,或 ✋ 显式)

| skill | 作用 | 类型 |
|---|---|---|
| `dao-worktree` | 独立工作前建 git 沙箱 | 🤖🔗 |
| `dao-pyramid` | subagent 金字塔调度 + **并行调度模式**(2+ 独立任务,实操单 worker 批量/串行节流) | 🔗 |

### F. 元层 / 参考(✋ 手动查阅为主)

| skill | 查什么 | 类型 |
|---|---|---|
| `dao-philosophy` | 八条不变之道,深度反思 | ✋ |
| `dao-meta` | 编辑 dao 体系自身文件前过三关 | 🤖(改 dao 时) |
| `dao-skill-ecosystem` | **本图所在**:技能供应链 + 全景地图 | 🤖✋ |
| `dao-workflow-system` | 9 个工作流何时用哪个 | ✋ |
| `dao-fa-mechanism` | Claude Code 运行机制参考 | ✋ |
| `dao-cli` | 工具选择(CLI-first/MCP边界/工具箱) | 🤖 |
| `dao-evolution` | 教训/经验/历史问题检索 | 🤖✋ |
| `dao-memory` | 会话复盘/长期记忆/协作偏好/skill 缺口沉淀 | 🤖✋ |
| `dao-compliance-check` | 用户问"是否遵守 CLAUDE.md" | 🤖 |

## 减量提案(待用户拍板,AI 不擅自删)

> 为道日损。下面是体检的减量决策记录。

| 候选 | 决策 | 论据 |
|---|---|---|
| `dao-parallel` → 并入 `dao-pyramid` | ✅ **已执行** | 实测并发≤1、自述"实操串行更稳",价值存疑;并行调度模式已并入 dao-pyramid「并行调度模式」节,引用已改向,skill 已删 |
| `dao-refactor` + `dao-optimize` + `dao-decouple` 合并 | ⏸️ **保留不合并** | 三者触发词不同,合并后 description 变长会降低自动触发精度(准则分层原则) |
| `dao-cli` + `dao-fa-mechanism` + `dao-windsurf-extension` 降为文档 | ⏸️ **暂不动** | 都是低频手动查阅类,日后若 skill 渐进披露成本凸显再评估降为 references/ |
| `dao-boundary-probe` + `dao-reverse-engineering` + `dao-windsurf-extension` 合并探测族 | ⏸️ **暂不动** | 主题相近但各有独立触发场景,暂保留 |

> 体检后已修的 description(触发词偏弱):`dao-debug` / `dao-deploy` / `dao-verify` / `dao-research` / `dao-reverse-engineering` 补触发场景,`dao-compliance-check` 清理 trigger 残留文本。

