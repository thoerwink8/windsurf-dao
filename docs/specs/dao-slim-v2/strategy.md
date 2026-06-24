# Strategy: dao-slim-v2

## 达成度维度（Loop 出口判据）

| 维度 | 定义 | 度量方式 | 达标线 |
|------|------|---------|--------|
| 功能完整度 | plan 所有 Task ✅ | completed / total | 100% |
| 行数达标 | 四项行数目标全达 | wc -l 实测 | dao.md≤180, skills≤3600, cmds≤9文件/≤1900行 |
| 双栈一致性 | dao-smoke 无 FAIL | `node scripts/dao-smoke.mjs` | exit 0 |
| 引用完整性 | 无断链交叉引用 | grep §/skill名 全扫 | 0 断链 |
| 回归安全 | 8 项回归验收全过 | R1-R6 逐项验证 | 全 ✅ |

## 技术决策记录（ADR）

### ADR-001: 外置 vs 内联模板

- **背景**：dao-loop 的 spec/strategy/acceptance/plan 四套模板占 ~120 行，每次加载 skill 都注入
- **备选**：A) 保持内联 B) 外置到 `templates/` 目录，skill 内仅保留结构概要+链接
- **决策**：选 B。模板是低频参考内容，不需每次注入；外置后 skill 从 909→~760 行
- **后果**：skill 加载时 AI 需额外 Read 模板文件（仅在谋线时），可接受

### ADR-002: 设计流水线 skill 合并 vs 独立压缩

- **背景**：design-system/design-open/design-fidelity/component-radar 四个 skill 有 30-40% 内容重复
- **备选**：A) 合并为单一 `dao-design-pipeline` B) 各自独立压缩去重，保持独立 skill
- **决策**：选 B（独立压缩）。理由：
  1. 四个 skill 触发场景不同（system=新项目, open=翻译, fidelity=审计, radar=健康），合并会导致每次加载不相关内容
  2. Claude Code skill 按 description 语义调度，独立 skill 精准匹配更好
  3. 去重后各 skill 降到合理范围，无需强制合并
- **后果**：保持 17 个 skill 文件数不变，但总行数下降 ~800 行

### ADR-003: Command 合并策略

- **背景**：dao-remove(10行)/gs(34行) 功能过轻；dao-thread-tree(66行) 与 autopilot 重叠；dao-cycle(210行) 与 dev 重叠
- **备选**：A) 全部保留 B) 删 2 + 合并 2 C) 更激进合并
- **决策**：选 B。删 dao-remove + gs；thread-tree 并入 autopilot；cycle 核心并入 dev（保留 cycle 为 dev 内引用段，不保留独立文件）
- **后果**：12→8 个 command 文件。dao-cycle 用户需改用 `/dao-dev`

### ADR-004: dao.md 外置目标

- **背景**：浏览器选择门(20行)、续力门控(18行)、知识归位表(12行) 等段落并非每消息都需要
- **备选**：A) 保持 always-on B) 移到 `.claude/rules/` 条件加载 C) 移到对应 skill
- **决策**：浏览器门→rules/（已有项目级覆盖机制），续力门控→回归各 skill，知识归位表→删（项目 CLAUDE.md 已有），德·行止→压缩内联
- **后果**：dao.md 从 240→~170 行，条件加载的内容仅在相关场景注入

## 验证策略

| 层级 | 工具/方式 | 频率 |
|------|---------|------|
| 行数检查 | `wc -l` 脚本 | 每 Task |
| 双栈一致性 | `node scripts/dao-smoke.mjs` | 每 Phase |
| 引用完整性 | grep `§` + skill 名交叉验证 | Phase 4 |
| 回归验证 | R1-R6 逐项 grep | 归档前 |
