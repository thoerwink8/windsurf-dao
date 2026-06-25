# Plan: dao-ecosystem-cleanup

> 依赖: spec.md, strategy.md, acceptance.md

## 任务清单

### Phase 1: 退役孤岛（高优先 🔴）

#### ✅ T1: playbook skill 退役 (≈5min) → A1, A8, A9

- 文件:
  - `ccswitch/skills/dao-design-system-playbook/` (DELETE 整个目录)
  - `.devin/skills/dao-design-system-playbook/` (DELETE 整个目录)
  - `ccswitch/dao.md` 场景速查表 (MODIFY — 移除 playbook 行)
  - `.devin/` 对应引用 (MODIFY — 如有)
  - `README.md` (MODIFY — 移除 playbook 引用)
- 操作: 删前 grep 确认无活跃引用（排除自引用/归档/README），确认 design-system 已覆盖其编排逻辑
- 验证: `node scripts/dao-smoke.mjs` + Grep `playbook` 确认无悬空引用

#### ✅ T2: autopilot command 退役 (≈5min) → A2, A8, A9

- 文件:
  - `ccswitch/commands/dao-autopilot.md` (DELETE)
  - `.devin/workflows/dao-autopilot.md` (DELETE)
  - `ccswitch/dao.md` (MODIFY — 如有 autopilot 引用)
  - `README.md` (MODIFY — 移除 autopilot 引用)
- 前置: 读 autopilot 内容，与 dao-dev 对比，有独有价值内容先提取
- 验证: `node scripts/dao-smoke.mjs` + Grep `autopilot` 确认无悬空引用

### Phase 2: 关系梳理（⚠️ 中优先）

#### ✅ T3: distill/evolve 声明为 evolution 子集 (≈3min) → A3, A4

- 文件:
  - `ccswitch/commands/dao-distill.md` (MODIFY — 头部加子集声明)
  - `ccswitch/commands/dao-evolve.md` (MODIFY — 头部加子集声明)
- 操作: 在 `## 触发条件` 前加一行：`> 本命令是 `dao-evolution` skill 的 <会话级/系统级> 子集。`
- 验证: 读取确认声明存在

#### ✅ T4: qa 补引用 (≈3min) → A5

- 文件:
  - `ccswitch/skills/dao-design-open/SKILL.md` §5 关系表 (MODIFY — 加 qa 行)
  - `.devin/skills/dao-design-open/SKILL.md` §5 关系表 (MODIFY — 加 qa 行)
- 操作: 在 design-open §5 关系表补一行 `dao-design-qa | 视觉偏差修复时自动触发`
- 验证: Grep `dao-design-qa` 在 design-open 中有结果

### Phase 3: 流程补齐（⚠️ 中优先）

#### ✅ T5: dao-loop command 补 strategy.md (≈3min) → A6

- 文件:
  - `ccswitch/commands/dao-loop.md` §4 (MODIFY)
  - `.devin/` 对应文件 (MODIFY — 如有同名)
- 操作: §4 谋线文档列表从 `spec.md → acceptance.md → plan.md` 改为 `spec.md → acceptance.md → strategy.md → plan.md`
- 验证: 读取确认 strategy.md 在列表中

#### ✅ T6: brainstormer agent 加诊断报告处理 (≈3min) → A7

- 文件:
  - `ccswitch/agents/dao-brainstormer.md` (MODIFY)
- 操作: 在"适合派给你的场景"或"工作流程"段加条件：refactor/audit 型 Loop 谋线时，以诊断报告为首要输入，从发现推导方向而非从目标推导
- 验证: 读取确认逻辑存在

### Phase 4: 同步验证 + 持续推进

#### ✅ T7: 全量同步验证 (≈3min) → A8, A9, A10

- 操作: `node scripts/dao-smoke.mjs` 全量检查 + Grep 确认无悬空引用 + dao.md 场景表核对
- 验证: 0 failures

#### T+: 持续推进（动态追加）

- 每 Task 完成后 micro-audit 改动影响区域
- 发现新缺口/整合机会 → 追加 T8, T9... 
- 连续 2 轮无新发现 → 收敛，进入验收

## 覆盖矩阵

| 验收项 | 覆盖 Task |
|--------|----------|
| A1 playbook 退役 | T1 |
| A2 autopilot 退役 | T2 |
| A3 distill 子集声明 | T3 |
| A4 evolve 子集声明 | T3 |
| A5 qa 引用完整 | T4 |
| A6 loop command 补 strategy | T5 |
| A7 brainstormer 诊断逻辑 | T6 |
| A8 dao-smoke 全过 | T1, T2, T7 |
| A9 双栈一致 | T1, T2, T7 |
| A10 dao.md 场景表同步 | T1, T2, T7 |

验收项无 Task 覆盖 → plan 不完整，需补充。✅ 全覆盖。
