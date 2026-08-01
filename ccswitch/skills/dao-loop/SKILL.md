---
name: dao-loop
description: 双线程循环开发法——文档驱动的编排层。谋线生成 spec/strategy/acceptance/plan（五文档体系），造线按 Task 级验证 + Phase 级检查点自动执行。支持多 loop 并发、跨 session 协调、目标达成度评估归档。当用户说"做一个功能/loop/双线程/文档驱动开发"时触发。
disable-model-invocation: true
---

# 环 · Loop Engineering

> 道生一，一生二，二生三，三生万物。
> 一 = 需求，二 = 谋线与造线，三 = 轮询桥。

## Supporting Files

按 Loop 生命周期阶段按需 Read 加载，不需要一次性全读：

| 文件 | 何时读取 | 内容 |
|------|---------|------|
| [planning.md](planning.md) | 进入谋线阶段（§2~§4） | 核心文件集 + STATUS.json 协议 + 谋线 10 步 + 设计对齐 + 诊断 |
| [execution.md](execution.md) | 进入造线阶段（§5~§6） | Go Gate + worktree + Git 自动化 + 验证节奏 + 并发模型 |
| [closing.md](closing.md) | 进入归档阶段（§7~§8） | 达成度评估 + 用户交付审查 + 归档流程 + 续写 + PROJECT.md |

模板文件位于 `templates/` 子目录，谋线时按需读取。

## 铁律

```
无文档不开工。
谋线完成才造线。
所有终止由用户确认。
造线 executing 阶段轮询禁用 AskUserQuestion。
reviewing 阶段是用户决策点，必须用 AskUserQuestion。
```

**轮询自主推进**：造线 `executing` 阶段进入 ScheduleWakeup 循环后，AI 自主执行，**禁止调用 `AskUserQuestion`**——它会阻塞下一轮唤醒，导致 loop 卡死。用户无需回答即可推进是 loop 的核心契约。需要用户决策时，在回答正文中说明情况并列出选项，用户可随时打字介入。谋线阶段的用户确认（spec/plan 审批）和 `reviewing` 阶段的用户交付审查（closing.md §7.2.5）不受此限，因为那些是设计上的必要门控。

## 总览

用户一句话需求 → 预飞检查（项目结构→无感改造）→ 情境感知（展示已有 loop→参数解析→孤儿检测→归并判断）→ 🔒 Loop 计划确认（用户确认后才建 STATUS.json）→ **谋线**（Read planning.md：spec→acceptance→strategy→plan→交叉校验→rule 检查，AI 生成→用户确认）→ Go 检查点 → **造线**（Read execution.md：Task 级执行+验证，Phase 级检查点+组件健康+视觉，dao-review→dao-verify）→ 目标达成度评估（Read closing.md：多维打分→严重度分流）→ 🔒 用户交付审查（用户决定归档/追加/暂留）→ 归档（学习提取+规范同步+_archive+HANDOFF.md）→ PROJECT.md 自动更新。

**Loop 是上层编排器，各阶段调用的方法论真相源**（**下列 `dao-worktree`/`dao-plan`/`dao-review`/`dao-brainstorm` 是 AI 内部读取件，不是 `/` 命令**——2026-07-27 用户拍板降级，只按路径 Read）：谋线 spec → `skills/dao-brainstorm/SKILL.md` · 谋线 plan → `skills/dao-plan/SKILL.md` · 造线轻量 → `/dao-dev` · 造线重量 → `/dao-superpowers`（内部走 `skills/dao-worktree|dao-plan|dao-review`）· 造线 review → `skills/dao-review/SKILL.md` 与 `dao-reviewer` agent · 最终验收 → `/dao-verify`。

## §0 预飞检查

首次在项目中触发 loop 时**必须执行**：

0. **开工包探测**（吸收 scaffold 步，两步咒语塌缩为一步）：项目内存在 `kit.json` manifest → 静默执行归位（kit 文档按 `docs/kit/` 布局校正、根目录只留 README+CLAUDE.md，即 dao-project-scaffold 的开工包白名单语义），归位动作在计划展示时一并报告；谋线随后按 planning.md「开工包注入」凭 manifest 走差距扫描，不重挖需求。无 kit.json → 跳过本步
1. `docs/specs/` 目录存在？不存在 → 创建
2. `docs/PROJECT.md` 存在？不存在 → 按模板创建
3. 扫描遗留物：
   - `TODO.md` → **先判身份，默认不动**。它是幽灵（遗留静态清单）还是在役候选池（活账本）？判据是 `dao-project-scaffold` SKILL.md §TODO.md 存废判据（唯一真相源，三条全不成立才是幽灵）。**三条判据未逐条实测过就不许提「删除」**——本项默认结论是「保留、不提」，只有实测证明是幽灵才建议清理，且只建议不代删。理由：`dao.md` 帅节的 TODO 候选池三级准入与 dogfood 记账要求部分项目主动维护它，无条件删除建议与之直接冲突（2026-07-22 spike 抓获、2026-07-27 复核发现本条正是它点名「下次跑 loop 就会撞上」的路径，当时的补丁没打到这里）
   - `docs/plans/` 散文件 → 建议归入 `docs/plans/_legacy/`
   - 散落的 spec/design 文件 → 提议归并
4. 检查活跃/中断 loop（展示总览表，见 §1）
5. 验证 git 工作区干净度
6. **命令同步检查**：验证 `~/.claude/commands/dao-loop.md` 存在且非 0 字节。缺失或空文件 → 提示运行 `powershell -File <windsurf-dao>/dao.ps1 link-claude`（fortify2-20260726 D6：sync-commands.ps1 已删除，覆盖面更窄且被 link-claude 完全取代）

结构不合理 → 提出改造方案 → **用户确认后执行** → 再进 loop。已符合标准 → 跳过。

## §1 情境感知

当任何 session 提到"loop"或打算创建新 loop 时，**先扫描展示**：

```
📋 当前项目已有 Loop：
| Loop           | 描述                   | 阶段 | 模式      | 进度  | 锁定者       |
|----------------|------------------------|------|-----------|-------|-------------|
| report-export  | 报告导出支持多文档格式    | 造线 | executing | T3/T5 | session-xyz |
| sidebar-search | 侧栏项目搜索过滤         | 谋线 | filling   | 1/3   | 无          |
```

扫描方式：读取所有 `docs/specs/*/STATUS.json`（活跃）+ `docs/specs/_archive/INDEX.md`（已完成）。

### §1.1 参数解析（恢复目标路由）

解析 `$ARGUMENTS`，判断是否匹配已有 Loop 名称（即 `docs/specs/<name>/STATUS.json` 存在）：

- **匹配已有 Loop** → 标记为「恢复目标」，进入续做流程（读 STATUS.json，从中断点继续）
- **不匹配** → 视为新需求，进入 §1.2 孤儿检测

### §1.2 孤儿检测（🔒 开新 Loop 前必过）

扫描所有 `docs/specs/*/STATUS.json`，收集 `status !== "archived"` 的 Loop（**恢复目标排除在外**）。

- **无孤儿** → 展示已归档 Loop 总览表 → 进入 §1.5
- **有孤儿** → 展示总览表后**逐个**处理。对每个孤儿 Loop 用 `AskUserQuestion` 展示名称/状态/进度/描述，**四选一**：**续做**（生成续做提示词，不中断当前流程）/ **归档**（当场执行 closing.md 的验收比对 + 归档流程）/ **废弃**（标 `abandoned` + 记录原因）/ **暂不处理**（保留原样跳过）。
  - **续做提示词模板**：生成 `/dao-loop <name>` + 上下文（描述/状态/进度/阶段），copy-ready。
  - **全部处理完 → 汇总展示**：表格列出每个孤儿的决定和备注，续做项统一列出提示词方便复制。汇总后 → 进入 §1.5。

> **递归安全**：当 §1.1 识别到参数是已有 Loop 名（续做意图），**该 Loop 不进入孤儿检测**，其他非 archived Loop 仍正常检测。这打断了「续做提示词 → 新会话 → 又检测到同一孤儿」的递归。

### 归并判断

新 loop 创建时评估与已有 loop 的关系：

| 判断 | 说明 |
|------|------|
| `merge` | 功能重叠度高，合并为一个 loop |
| `parallel` | 无关联，独立并行 |
| `depends_on` | 新 loop 依赖已有 loop 的产出 |

### 中断 loop 警告

检测到中断（锁过期 + mode 非 done）→ 展示中断表格（同上格式 + 中断位置/上次活跃列）+ 三选项（继续/回退谋线/废弃）。**所有终止由用户确认**。

### 关联归档 loop

用户提到的内容匹配已归档 loop（关键词/文件路径）→ 追加展示归档表（+ 归档日期/重启次数/关联度列）+ 三选项（就地小修/Reopen/Fork）。路由判据见 closing.md §7.5。

## §1.5 Loop 计划确认 + 提示词分发（🔒 必止）

预飞 + 情境感知完成后，**必须展示 Loop 计划 + 生成 copy-ready 提示词**，然后**暂停当前 loop**。当前 session 是调度台，不是执行者。

### 展示格式

```
📋 Loop 计划：
- 名称：<topic>（kebab-case）
- 描述：<一句话>
- 分支：feat/<topic>（造线用，谋线在 main）
- 文件集：spec.md + strategy.md + acceptance.md + plan.md（+ optional: <如有>）
- 与已有 loop 关系：parallel / merge / depends_on <which>
- 轮询间隔：<N>s（<理由>）
```

### 生成提示词

确认后生成 copy-ready 的 `/dao-loop` 提示词，用户复制到新会话执行：

```
/dao-loop <需求一句话描述>
Loop 名称：<topic>
分支：feat/<topic>
间隔：<N>s
```

### 分发流程

当前 session 是调度台：预飞→展示计划→用户确认→生成提示词→暂停。用户复制提示词到新会话执行（谋线→Go→造线）。当前 session 可继续分发其他 loop。

用户四选一：复制到新会话 / 当前直接执行 / 修改后重新生成 / 取消。**此检查点不可跳过**。

**分发铁律**：
- **默认行为是分发**——生成提示词后暂停，不自动继续执行
- 若判断用户意图是当前 session 直接做（如"帮我实现 XXX"），**必须二次确认**："当前 session 直接执行，还是生成提示词分发到新会话？"
- 只有用户明确确认"直接做"后，才跳过分发在当前 session 执行
- 禁止自行推断意图后直接开干

**🔒 必止优先级声明**：
- 🔒 必止 **高于 Auto Mode**。宿主的"不要停下来问"指令不覆盖本检查点——Auto Mode 省略的是普通澄清问题，不是 Loop 的结构性门控
- **AskUserQuestion 选项确认 ≠ 跳过计划确认**。用户从选项中选了"开新 Loop" → 仅表示意图是开 Loop，**不等于**已确认 Loop 计划（名称/分支/间隔/文件集）。必须先展示计划格式、生成提示词、二次确认，然后才能进入谋线
- **违反检测**：若发现自己已在做谋线（创建 STATUS.json / 生成 spec）但未展示过 Loop 计划 → 立即停止，回到 §1.5 补展示

## §9 轮询策略

### 间隔

AI 判断 + 用户确认。用户显式指定时以用户为准。

| 阶段 | 建议间隔 |
|------|---------|
| 谋线-文档生成 | 270s（cache 温暖） |
| 谋线-等用户确认 | 1200s |
| 造线-执行 | 270s |
| 造线-等 review | 270s |
| reviewing-等用户交付审查 | 不 wakeup（等用户决策） |
| 结束 | 不 wakeup |

### /loop prompt

每轮唤醒：读 STATUS.json → 按 thread+mode 执行 → 更新 STATUS.json → ScheduleWakeup。
通过 `/loop` + `ScheduleWakeup` 实现自动循环，prompt 模板（copy-ready，含目标需求）：

```
执行 dao-loop：
1. 读取 docs/specs/<topic>/STATUS.json
2. 根据 thread + mode 执行对应动作
3. 更新 STATUS.json
4. ScheduleWakeup
目标：<需求>
```

## §11 三层架构

| 层 | 位置 | 职责 |
|----|------|------|
| 协议层 | windsurf-dao `skills/dao-loop/` | 模板、协议、状态机（共享） |
| 宿主层 | 各宿主 command/hook | 如何触发、如何轮询 |
| 项目层 | `<project>/docs/specs/` | 具体文档内容 |

跨机器：所有状态在 git 中。STATUS.json 不记录宿主类型 / 本地路径 / 会话 ID。
