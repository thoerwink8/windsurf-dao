# Plan: dao-slim-v2

> 依赖: spec.md, strategy.md, acceptance.md

## Phase 1: dao.md 瘦身（乘数效应最高）

### T1: 删除全局重复段 (≈3min) → A1, R1 ✅
- 文件: `ccswitch/dao.md` (MODIFY)
- 操作: 删除与 `~/.claude/CLAUDE.md` 重复的语言规则（"所有回复必须用中文" 出现 2 处）、删除与项目 `CLAUDE.md` 重复的知识归位表（约 12 行）
- 验证: `wc -l ccswitch/dao.md`（应减少 ~14 行）

### T2: 压缩产出归位段 (≈4min) → A1 ✅
- 文件: `ccswitch/dao.md` (MODIFY)
- 操作: 产出归位提醒（当前 ~22 行）压缩到 5 行启发式规则，删除决策树图（文件写入位置判断逻辑）和详细示例
- 验证: `wc -l ccswitch/dao.md`（应再减 ~17 行）

### T3: 外置浏览器门 + 续力门控回归 (≈5min) → A1, A7 ✅
- 文件: `ccswitch/dao.md` (MODIFY), `ccswitch/skills/dao-loop/SKILL.md` (MODIFY), `ccswitch/skills/dao-design-fidelity/SKILL.md` (MODIFY)
- 操作:
  1. 浏览器工具选择门（~20 行）从 dao.md 删除（项目侧已有 `.claude/rules/` 覆盖机制，且 dao.md 里的描述是给项目用的，不是全局 always-on 内容）
  2. 续力门控感知（~18 行，含门控表格和豁免列表）从 dao.md 删除，门控表格已在各 skill 内自带（dao-loop §1.5 已有必止声明）
- 验证: `wc -l ccswitch/dao.md`（应再减 ~38 行）; grep "浏览器" dao.md 应无结果

### T4: 八句根基 + 德·行止 + 言·名之则压缩 (≈4min) → A1, R1, R3 ✅
- 文件: `ccswitch/dao.md` (MODIFY)
- 操作:
  1. 八句根基：去掉章号 `(25 章)` 等，每句压到一行（12→8 行）
  2. 德·行止之则：阳/阴/和/归 四行保留，删掉引言和空行（8→4 行）
  3. 言·名之则：删哲学引言、压缩 commit 前缀规则说明（9→5 行）
- 验证: grep "道法自然" dao.md 仍存在; grep "\[cc\]" dao.md 仍存在; `wc -l`（应再减 ~12 行）

### T5: dao.md 项目规范沉淀段压缩 (≈3min) → A1 ✅
- 文件: `ccswitch/dao.md` (MODIFY)
- 操作: 「项目规范自动沉淀」段（~8 行）压缩到 2 行核心规则；「流程缺口修复归因」段判据树（~12 行）压缩到 3 行决策要点；「项目标准结构」首次检查清单（~10 行）已有 dao-project-scaffold skill 覆盖，dao.md 内仅保留一句引用
- 验证: `wc -l ccswitch/dao.md` 目标 ≤180 行

---

## Phase 2: Skills 压缩

### T6: dao-loop 模板外置 (≈5min) → A2, A7 ✅
- 文件: `ccswitch/skills/dao-loop/SKILL.md` (MODIFY), `ccswitch/skills/dao-loop/templates/` (NEW, 4 files)
- 操作: §2 核心文件集中的 spec/strategy/acceptance/plan 四套模板（~120 行）外置到 `templates/` 子目录，skill 内替换为结构概要 + "详见 templates/xxx-template.md"
- 验证: `wc -l ccswitch/skills/dao-loop/SKILL.md`（应减 ~100 行）; 4 个模板文件存在且非空

### T7: dao-loop 协议压缩 + 护栏合并 (≈5min) → A2 ✅
- 文件: `ccswitch/skills/dao-loop/SKILL.md` (MODIFY)
- 操作:
  1. §3 STATUS.json 协议：JSON 示例保留，状态转换图压缩（去重复描述），锁机制压缩到 3 行（~80→45 行）
  2. §4-5 subagent 调度指令：Agent() 调用示例压缩为表格（~100→30 行）
  3. 重复护栏（"禁用 AskUserQuestion" 出现 3+ 次）合并到 §0 铁律一处
- 验证: `wc -l`（目标 ≤700 行）; grep "AskUserQuestion" 只在铁律段出现

### T8: dao-design-system 压缩 (≈5min) → A2 ✅
- 文件: `ccswitch/skills/dao-design-system/SKILL.md` (MODIFY)
- 操作:
  1. §3.0-3.10 token 命名完整表（~280 行）：每类保留 1 行定义 + 命名模式，删除详细示例和解释（→~100 行）
  2. §1.5 OD 工作区准备（~90 行）：压缩到 10 行核心步骤
- 验证: `wc -l`（目标 ≤400 行）

### T9: dao-design-open 去重 + 压缩 (≈5min) → A2, A6 ✅
- 文件: `ccswitch/skills/dao-design-open/SKILL.md` (MODIFY)
- 操作:
  1. §1.5.0 组件策略矩阵（native/extend/wrap/custom）：与 dao-design-taste 重复，删除本处，加"组件策略见 dao-design-taste §0-pre"引用（-50 行）
  2. §1 读取阶段：机械性步骤压缩为 checklist 格式（-60 行）
  3. §A 反模式：删与其他 skill 重复项，仅保留本 skill 独有（-25 行）
- 验证: `wc -l`（目标 ≤330 行）; grep "组件策略" 指向 design-taste

### T10: dao-design-taste 压缩 (≈4min) → A2 ✅
- 文件: `ccswitch/skills/dao-design-taste/SKILL.md` (MODIFY)
- 操作:
  1. §7L 设计工具哲学段（~80 行）：压缩到 3 条核心原则（-60 行）
  2. references 引用段（~80 行散布各处）：统一为文末索引表（-30 行）
- 验证: `wc -l`（目标 ≤330 行）

### T11: dao-design-fidelity 压缩 (≈4min) → A2 ✅
- 文件: `ccswitch/skills/dao-design-fidelity/SKILL.md` (MODIFY)
- 操作:
  1. §6.5 验证脚本段（~100 行）：压缩到核心 workflow + 决策树（-70 行）
  2. §6.4 状态矩阵段（~80 行）：压缩到 checklist + 示例（-30 行）
- 验证: `wc -l`（目标 ≤290 行）

### T12: dao-code-to-prototype 压缩 (≈4min) → A2 ✅
- 文件: `ccswitch/skills/dao-code-to-prototype/SKILL.md` (MODIFY)
- 操作:
  1. §0 配置发现段（~120 行）：压缩为 strategy 概要 + 核心步骤（-90 行）
  2. §A 反模式：删与 design-open 重复项（-15 行）
- 验证: `wc -l`（目标 ≤265 行）

---

## Phase 3: Commands 整理

### T13: 删除 dao-remove + gs (≈2min) → A3, A4 ✅
- 文件: `ccswitch/commands/dao-remove.md` (DELETE), `ccswitch/commands/gs.md` (DELETE)
- 操作: 直接删除两个文件（共 44 行）
- 验证: `ls ccswitch/commands/*.md | wc -l`（应为 10）

### T14: dao-thread-tree 并入 dao-autopilot (≈5min) → A3, A4, R6 ✅
- 文件: `ccswitch/commands/dao-autopilot.md` (MODIFY), `ccswitch/commands/dao-thread-tree.md` (DELETE)
- 操作: 将 thread-tree 的 Open Threads 扫描逻辑（红/黄/绿标记处理）整合到 autopilot §1.2.1，然后删除 thread-tree 文件
- 验证: grep "Open Threads" autopilot.md 有结果; `ls ccswitch/commands/*.md | wc -l`（应为 9）

### T15: dao-cycle 并入 dao-dev (≈5min) → A3, A4, R6 ✅
- 文件: `ccswitch/commands/dao-dev.md` (MODIFY), `ccswitch/commands/dao-cycle.md` (DELETE)
- 操作: dao-cycle 五阶段核心（观/行/验/省/改升）并入 dao-dev 作为 §2.5 深度迭代模式段（~30 行精华），删除 cycle 独立文件
- 验证: grep "观.*行.*验.*省" dao-dev.md 有结果; `ls ccswitch/commands/*.md | wc -l`（应为 8）

---

## Phase 4: 交叉引用修复 + 验证

### T16: 全量交叉引用扫描修复 (≈5min) → A6 ✅
- 文件: 多文件 (MODIFY，按需)
- 操作: grep 所有 `§` 引用 + skill 名引用（如"见 dao-design-taste §0-pre"），验证目标段落仍存在；断链则修正引用或补回内容
- 验证: 0 断链

### T17: .devin/ 侧同步 (≈5min) → A8 ✅
- 文件: `.devin/` 下对应文件 (MODIFY)
- 操作: 将 ccswitch/ 侧的改动同步到 .devin/ 侧（删除/合并/压缩对应文件）
- 验证: `node scripts/dao-smoke.mjs` 全绿

### T18: 全量回归验收 (≈5min) → R1-R6, A5 ✅
- 文件: 无修改（只读验证）
- 操作: 逐项执行 R1-R6 回归验收 + A1-A8 功能验收
- 验证: 全 ✅

---

## Phase 5: 持续优化（动态）

### T19: dao-autopilot 压缩 (577→451, -126 lines) ✅
- 文件: `ccswitch/commands/dao-autopilot.md` (MODIFY)
- 操作: 単Task闭環铁律 22→4行、模板代码块→2行摘要、状态机表格压缩、教训上提評估 46→7行
- 验证: `wc -l`（451 行）

### T20: dao-evolve + dao-superpowers 压缩 ✅
- 文件: `ccswitch/commands/dao-evolve.md` (MODIFY, 272→228, -44), `ccswitch/commands/dao-superpowers.md` (MODIFY, 257→221, -36)
- 操作: evolve 追踪日志/教训新鲜度/Git考古/执行格式压缩; superpowers 删35行重复执行模板
- 验证: `wc -l`（evolve 228, superpowers 221）

### T21: dao-loop §7-§8 模板外置 + §1/§1.5/§9 压缩 (511→403, -108) ✅
- 文件: `ccswitch/skills/dao-loop/SKILL.md` (MODIFY), `ccswitch/skills/dao-loop/templates/` (NEW, 3 files)
- 操作: INDEX.md/HANDOFF.md/PROJECT.md 模板外置; §1 展示格式/§1.5 分发流程/§9 prompt 压缩

### T22: dao-design-system-playbook 压缩 (197→135, -62) ✅
- 文件: `ccswitch/skills/dao-design-system-playbook/SKILL.md` (MODIFY)
- 操作: 全景流程图/附录A流程+表格/关系表/验收三关压缩

### T23: dao-verify 压缩 (193→153, -40) ✅
- 文件: `ccswitch/skills/dao-verify/SKILL.md` (MODIFY)
- 操作: 红灯词/报告格式/临时文件清理压缩

### T24: dao-doc 压缩 (186→136, -50) ✅
- 文件: `ccswitch/commands/dao-doc.md` (MODIFY)
- 操作: 校验步骤/损之又损/关系/执行格式压缩

### T25: dao-worktree 压缩 (173→141, -32) ✅
- 文件: `ccswitch/skills/dao-worktree/SKILL.md` (MODIFY)
- 操作: e163教训详解/工作流ASCII/反模式行压缩

### T26: dao-dev 压缩 (351→301, -50) ✅
- 文件: `ccswitch/commands/dao-dev.md` (MODIFY)
- 操作: 关卡一/二/三展示格式/工作流协作/执行格式 code blocks 压缩

### T27: dao-autopilot 二次压缩 (451→392, -59) ✅
- 文件: `ccswitch/commands/dao-autopilot.md` (MODIFY)
- 操作: 唯一激活关卡/用户中断/清理/stale检测/跨session恢复 展示格式压缩

### T28: dao-loop cmd + dao-design-qa + dao-design-layout 压缩 ✅
- 文件: `ccswitch/commands/dao-loop.md` (MODIFY, 137→102, -35), `ccswitch/skills/dao-design-qa/SKILL.md` (MODIFY, 134→118, -16), `ccswitch/skills/dao-design-layout/SKILL.md` (MODIFY, 161→158, -3)
- 操作: 孤儿展示/续做模板/汇总/总览表 code blocks→prose; QA ASCII流程图→1行prose; layout引言压缩

### T29+: 动态追加
- 每轮造线结束后反问：还有什么可以优化？
- 根据发现追加新 Task

---

## 覆盖矩阵

| 验收项 | 覆盖 Task |
|--------|----------|
| A1 | T1, T2, T3, T4, T5 |
| A2 | T6, T7, T8, T9, T10, T11, T12 |
| A3 | T13, T14, T15 |
| A4 | T13, T14, T15 |
| A5 | T18 |
| A6 | T9, T16 |
| A7 | T3, T6 |
| A8 | T17 |
| R1 | T1, T4 |
| R2 | T3 |
| R3 | T4 |
| R4 | T4 |
| R5 | T18 |
| R6 | T14, T15 |
