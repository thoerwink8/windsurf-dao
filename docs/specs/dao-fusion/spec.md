# Spec: dao-fusion

> 道体融合——让 dao 体系从"规则集合"变成"精密运转的整体"。

## 定位

dao-slim-v2 完成减法（-4132 行），各部件体积合理但衔接仍是隐性的。本轮做融合：让各 skill 知道彼此、数据格式对齐、概念不重叠、用户入口最少化。

## 背景

调查发现的具体问题：

1. **交接靠散文**：design-system §7 定义了 Phase 0→1→2→3 流水线，但每阶段的输入/输出格式散落在各 skill 内部，没有统一 schema
2. **视觉判据三处重复**：taste §4（9 维体检表）、qa Step 1（布局/颜色/字体/组件/交互态审视）、fidelity L1-L5（验证方法）——"什么是好设计"和"如何验证"混在一起
3. **taste 定位模糊**：自称"全流程执行引擎"+"总闸"，与 design-open（pipeline Phase 1）争夺语义路由；实际价值是判据库+审美标准
4. **qa 独立性存疑**：design-open §4 已有 QA 循环，qa skill 的独特价值（设计工具先行修复）可以用更少文字表达
5. **压缩过度**：shell.md 交互命令黑名单 8 对映射被压成 prose（失去精确配对），autopilot 反模式表 8 行被压成单行 pipe 分隔

## 目标（五方向）

### D1 · 管线交接 schema

在 design-system §7 增加阶段间数据契约：

| 衔接点 | 上游输出 | 下游输入 |
|--------|---------|---------|
| P0→OD | OD 提示词（§6 格式） | OD 消费 |
| OD→P1 | `design/` 目录（§0 格式） | design-open §1 读取 |
| P1→P2 | 变更文件列表 + token 映射 | fidelity L1-L5 验证 |
| P2→P3 | 组件级 fail 项 | component-radar 三关检测 |

各下游 skill 的"与其他 skill 的关系"段同步引用此 schema。

### D2 · 概念去重

**单一真相源分配**：
- **"什么是好设计"** → taste §4（通用判据，9 维体检表）= 唯一权威
- **"如何验证"** → fidelity L1-L5（验证方法+阈值+工具链）= 唯一权威
- **"发现问题→修复"** → qa（截图→设计工具→代码三步循环）= 唯一流程权威

**去重操作**：qa Step 1 审视维度（约 15 行）改为引用 taste §4，不再内联重复。

### D3 · 入口收敛

**改 taste description**：从"全流程执行引擎——一站式覆盖所有 UI/设计任务"改为"UI 设计判据与审美标准库——三旋钮定调·通用体检表·组件审计·设计资产管理"。去掉"总闸"定位，明确是被引用的知识源。

**改 qa description**：明确"发现 UI 视觉 bug 时自动触发"，降低误路由。

**更新 dao.md 场景速查表**：标注哪些是用户主动入口（design-system / design-open）、哪些是自动触发（fidelity / radar / qa）、哪些是知识源（taste / layout）。

### D4 · 双栈一致性

ccswitch/ 改动同步到 .devin/ 对应文件。涉及：
- `.devin/skills/dao-design-{taste,qa,fidelity,system,open}/SKILL.md`
- `.devin/workflows/dao-autopilot.md`
- `.devin/rules/shell.md`

### D5 · 恢复 2 处表格

- `.devin/rules/shell.md` 行 18-20：prose 黑名单 → 恢复为 `| 黑名单 | 非交互替代 |` 8 行表格（从 git 0396892^ 恢复原格式）
- `ccswitch/commands/dao-autopilot.md` 末尾：prose 反模式 → 恢复为 `| 病 | 对治 |` 8 行表格（从 git ae2b3c0^ 恢复原格式）
- `.devin/workflows/dao-autopilot.md` 同步恢复

## 范围

### 改动文件（估算）

| 文件 | 方向 | 变化 |
|------|------|------|
| `ccswitch/skills/dao-design-system/SKILL.md` | D1 | §7 增加交接 schema |
| `ccswitch/skills/dao-design-taste/SKILL.md` | D2,D3 | 改 description + §0 去掉"总闸" |
| `ccswitch/skills/dao-design-qa/SKILL.md` | D2,D3 | Step 1 引用 taste + 改 description |
| `ccswitch/skills/dao-design-fidelity/SKILL.md` | D1,D2 | 引用 taste 判据 + 更新交接引用 |
| `ccswitch/skills/dao-design-open/SKILL.md` | D1 | §5 更新交接引用 |
| `ccswitch/skills/dao-component-radar/SKILL.md` | D1 | 更新 pipeline 引用 |
| `ccswitch/commands/dao-autopilot.md` | D5 | 恢复反模式表 |
| `.devin/rules/shell.md` | D5 | 恢复黑名单表 |
| `ccswitch/dao.md` | D3 | 场景速查表标注入口类型 |
| `.devin/` 对应文件 ×7 | D4 | 双栈同步 |

### 范围外

- 不改 skill 内部实施逻辑（只改交接描述和元信息）
- 不合并/删除 skill 文件
- 不改非设计类 skill（brainstorm/plan/review/verify/evolution/worktree）
- 不改 Loop 协议本身

## 约束

- **零新文件**：只改现有文件
- **净增 ≤ 0 行**：恢复表格的增量（~14 行）由 qa 去重（~15 行）对冲
- **双栈同步**：每次改完跑 `node scripts/dao-smoke.mjs` 验证

## 风险

| 风险 | 缓解 |
|------|------|
| 改 taste description 影响语义路由 | 保留关键词"设计/UI/判据/审美"，测试路由不漂移 |
| 概念去重后 qa 过于单薄 | qa 保留独立价值（设计工具先行修复的工作流），只去重判据列表 |
| 恢复表格突破行数预算 | 精确计算：shell +7、autopilot +8 = +15，qa 去重 -15 |

## 依赖

- dao-slim-v2 ✅ 已完成
