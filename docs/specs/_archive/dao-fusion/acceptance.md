# Acceptance: dao-fusion

## 功能验收

| ID | 方向 | 验收标准 | 验证方式 |
|----|------|---------|---------|
| A1 | D1 | design-system §7 含阶段间交接 schema（P0→P1→P2→P3 四衔接点） | ✅ 读文件确认 |
| A2 | D1 | 各下游 skill（open/fidelity/radar）的"关系"段引用 design-system §7 schema | ✅ Grep 三处命中 |
| A3 | D2 | qa Step 1 审视维度改为引用 taste §4，不再内联重复 | ✅ 引用句替代枚举 |
| A4 | D2 | taste §4 是视觉判据唯一真相源，fidelity 仅含验证方法 | ✅ fidelity 引用 taste §4 |
| A5 | D3 | taste description 不含"全流程执行引擎"/"总闸"/"一站式" | ✅ Grep 零命中 |
| A6 | D3 | qa description 含"自动触发"字样 | ✅ frontmatter 已含 |
| A7 | D3 | dao.md 场景速查表标注入口类型（用户入口 / 自动触发 / 知识源） | ✅ 类型列已加 |
| A8 | D5 | shell.md 交互命令黑名单恢复为 `\| 黑名单 \| 非交互替代 \|` 表格，8 行 | ✅ 8 行表格 |
| A9 | D5 | autopilot 反模式恢复为 `\| 病 \| 对治 \|` 表格，8 行 | ✅ 8 行表格双栈 |

## 回归验收

| ID | 验收标准 | 验证方式 |
|----|---------|---------|
| R1 | `node scripts/dao-smoke.mjs` 全绿（双栈 frontmatter + 交叉引用一致） | ✅ 53/53 |
| R2 | 双栈对应文件语义一致（ccswitch/ ↔ .devin/） | ✅ smoke + 逐文件同步 |
| R3 | 净增行数 ≤ 0 | ⚠️ +31（表格恢复超估，去重不足对冲） |
| R4 | 无新增文件 | ✅ 全 M 无 A |
| R5 | 所有 skill description 保留语义路由关键词 | ✅ smoke frontmatter |

## 边界条件

| ID | 条件 | 预期 |
|----|------|------|
| E1 | taste 被路由到时仍正常工作（§0 分诊、§4 判据） | 功能不受 description 改动影响 |
| E2 | design-open auto-gate 引用链不断（→ fidelity L1 + radar 关一） | 引用路径不变 |
| E3 | 无 design/ 目录的项目不受管线 schema 影响 | schema 仅在有 design/ 时激活 |
