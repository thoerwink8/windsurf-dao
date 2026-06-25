# Plan: dao-fusion

## Phase 1 · 恢复表格（D5）

### T1 · shell.md 恢复黑名单表格
- **文件**：`.devin/rules/shell.md`
- **操作**：行 18-20 prose 黑名单 → 恢复为 `| 黑名单 | 非交互替代 |` 表格（8 行）
- **来源**：`git show 0396892^:.devin/rules/shell.md` 的表格格式
- **验证**：读文件确认表格 8 行 + 精确配对
- **行数**：+7（表头+8行-1行prose）

### T2 · autopilot 恢复反模式表格（双栈）
- **文件**：`ccswitch/commands/dao-autopilot.md` + `.devin/workflows/dao-autopilot.md`
- **操作**：末尾 prose 反模式 → 恢复为 `| 病 | 对治 |` 表格（8 行）
- **来源**：`git show ae2b3c0^:ccswitch/commands/dao-autopilot.md` 的表格格式
- **验证**：读两文件确认表格 8 行 + 双栈一致
- **行数**：+8×2=+16（两文件）

**Phase 1 小计**：+23 行

## Phase 2 · 概念去重 + 入口收敛（D2+D3）

### T3 · taste 重新定位
- **文件**：`ccswitch/skills/dao-design-taste/SKILL.md`
- **操作**：
  1. frontmatter description 改为 `UI 设计判据与审美标准库——三旋钮定调·通用体检表·组件审计·设计资产管理。design-open 和 fidelity 的判据来源`
  2. §0 标题或引言去掉"总闸"/"全流程执行引擎"/"一站覆盖"表述
- **验证**：Grep 确认 "总闸"/"全流程执行引擎"/"一站式" 零命中
- **行数**：0（改文字不改行数）

### T4 · qa 去重 + 重新定位
- **文件**：`ccswitch/skills/dao-design-qa/SKILL.md`
- **操作**：
  1. frontmatter description 改为 `UI 视觉问题迭代修复——截图找问题→设计工具修→代码回填。发现 UI 视觉 bug 时自动触发`
  2. Step 1 审视维度（行 36-44 的 5 项枚举）替换为引用句：`按 dao-design-taste §4 通用判据逐维度审视（颜色/字体/形状/交互/组件/图标/表单/文案/主题 9 维）`
  3. 同时压缩 Step 1 的分项描述，合并为一句引用 + 保留交互态三层模型（这是 qa 独有的）
- **验证**：Grep "dao-design-taste §4" 在 qa 中命中；重复枚举消失
- **行数**：约 -15（去掉重复枚举）

### T5 · 双栈同步 taste + qa
- **文件**：`.devin/skills/dao-design-taste/SKILL.md` + `.devin/skills/dao-design-qa/SKILL.md`
- **操作**：T3 + T4 的改动同步到 .devin/ 侧
- **验证**：diff ccswitch vs .devin 对应段落一致（允许平台差异）
- **行数**：约 -15（同 T4）

**Phase 2 小计**：约 -30 行

## Phase 3 · 管线交接 schema（D1+D4）

### T6 · design-system §7 增加交接 schema
- **文件**：`ccswitch/skills/dao-design-system/SKILL.md`
- **操作**：§7 流水线总览下方增加"交接契约"子段：
  ```
  ### 交接契约（Handoff Schema）
  | 衔接点 | 上游输出 | 下游输入 | 格式定义位置 |
  | P0→OD | OD 提示词 | OD 消费 | 本 skill §6 |
  | OD→P1 | design/ 目录 | design-open §1 读取 | design-open §0 |
  | P1→P2 | 变更文件列表 + token 映射 | fidelity L1-L5 | design-fidelity §1 |
  | P2→P3 | 组件级 fail 项 | component-radar 三关 | component-radar §检测模式 |
  ```
- **同时**：压缩 §7 "典型场景" 段（4 条 → 合并为 2 句 prose）对冲行数
- **验证**：读 §7 确认 schema 表存在
- **行数**：约 0（增 schema 表 +6，压缩典型场景 -6）

### T7 · 下游 skill 更新引用
- **文件**：`ccswitch/skills/dao-design-{fidelity,open,component-radar}/SKILL.md`
- **操作**：
  1. fidelity 开头"流水线位置"段增加 `交接契约见 design-system §7`
  2. open §5 "与其他 skill 的关系"增加同样引用
  3. radar 开头"流水线位置"段增加同样引用
- **验证**：Grep `design-system.*§7` 在三文件中命中
- **行数**：+3（每文件 +1 句）

### T8 · 双栈同步 system + fidelity + open
- **文件**：`.devin/skills/dao-design-{system,fidelity,open}/SKILL.md`
- **操作**：T6 + T7 改动同步到 .devin/ 侧（radar 无 .devin/ 对应，跳过）
- **验证**：diff 对应段落一致
- **行数**：约 +3

**Phase 3 小计**：约 +6 行

## Phase 4 · 入口标注（D3）

### T9 · dao.md 场景速查表标注入口类型
- **文件**：`ccswitch/dao.md`
- **操作**：场景速查表增加"类型"列：
  - `用户入口`：design-system / design-open
  - `自动触发`：fidelity / radar / qa（括号注释"日常由 open auto-gate 覆盖"已有，补充 qa）
  - `知识源`：taste / layout
  - 非设计 skill 不变
- **验证**：读表确认类型列存在
- **行数**：0（改表格内容不加行）

**Phase 4 小计**：0 行

## Phase 5 · 验证

### T10 · 全量验证 + 净增统计
- **操作**：
  1. `node scripts/dao-smoke.mjs` 全绿
  2. `git diff --stat` 确认 insertions - deletions ≤ 0
  3. 逐条比对 acceptance.md
- **修复**：有问题就地修

**Phase 5 小计**：0 行

---

## 覆盖矩阵

| 验收 | T1 | T2 | T3 | T4 | T5 | T6 | T7 | T8 | T9 | T10 |
|------|----|----|----|----|----|----|----|----|----|----|
| A1   |    |    |    |    |    | ✓  |    |    |    |     |
| A2   |    |    |    |    |    |    | ✓  |    |    |     |
| A3   |    |    |    | ✓  |    |    |    |    |    |     |
| A4   |    |    |    |    |    |    | ✓  |    |    |     |
| A5   |    |    | ✓  |    |    |    |    |    |    |     |
| A6   |    |    |    | ✓  |    |    |    |    |    |     |
| A7   |    |    |    |    |    |    |    |    | ✓  |     |
| A8   | ✓  |    |    |    |    |    |    |    |    |     |
| A9   |    | ✓  |    |    |    |    |    |    |    |     |
| R1   |    |    |    |    |    |    |    |    |    | ✓   |
| R2   |    |    |    |    | ✓  |    |    | ✓  |    |     |
| R3   |    |    |    |    |    |    |    |    |    | ✓   |
| R4   |    |    |    |    |    |    |    |    |    | ✓   |
| R5   |    |    | ✓  | ✓  |    |    |    |    |    |     |

## 行数预算

| Phase | 预估 | 累计 |
|-------|------|------|
| P1 恢复表格 | +23 | +23 |
| P2 去重收敛 | -30 | -7 |
| P3 交接 schema | +6 | -1 |
| P4 入口标注 | 0 | -1 |
| **净增** | | **≤ 0 ✓** |
