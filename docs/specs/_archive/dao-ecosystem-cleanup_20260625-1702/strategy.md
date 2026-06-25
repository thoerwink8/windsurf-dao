# Strategy: dao-ecosystem-cleanup

## 达成度维度（Loop 出口判据）

| 维度 | 定义 | 度量方式 | 达标线 |
|------|------|---------|--------|
| 功能完整度 | plan 所有 Task ✅ | completed / total | 100% |
| 验收通过率 | acceptance A1-A10 全过 | passed / total | 10/10 |
| 回归安全 | dao-smoke.mjs 全检查通过 | 0 failures | ✅ |
| 文档同步 | dao.md + CLAUDE.md + README 引用一致 | 无悬空引用 | ✅ |
| 生态健康 | 引用图谱无 0-ref 孤岛 | grep 全量扫描 | 0 孤岛 |
| 净行数 | 为道日损——删 > 增 | git diff --stat | 净删除 |

## 技术决策记录（ADR）

### ADR-001: playbook 处置——直接删除 vs 合并到 design-system

- **背景**：playbook 有 7 phase 的设计系统转型方法论，与 design-system 有重叠
- **备选**：A) 提取精华合并到 design-system 再删 / B) 直接删（content 在 references/ 子目录仍有）/ C) 保留但标 deprecated
- **决策**：B — playbook 的 references/ 子目录有 6 个详细 phase 文件，这些已经是渐进披露的知识源，design-system SKILL.md 已经是独立完整的。playbook 本身只是一个编排壳
- **后果**：减少 1 个 skill 目录（双栈共 2 个），消除 context 浪费

### ADR-002: autopilot 处置——合并到 dao-dev vs 直接删除

- **背景**：autopilot 的递归分解/反思机制与 dao-dev 重叠，且 autopilot 使用 TODO.md 作为任务图（与 dao-loop 的 docs/specs/ 冲突）
- **备选**：A) 提取递归/反思到 dao-dev / B) 直接删 / C) 重写对齐 dao-loop
- **决策**：先检查 autopilot 是否有 dao-dev 未覆盖的独有内容，有则提取，无则直接删
- **后果**：减少 1 个 command（双栈共 2 个），消除概念冲突

### ADR-003: 持续推进策略

- **背景**：用户要求每 Task 后重评，发现新机会则追加
- **决策**：每 Task 完成后执行 micro-audit（scope 限定为改动影响区域），发现问题则追加 T+ Task。连续 2 轮无新发现 = 收敛
- **后果**：总 Task 数动态增长，但有硬收敛条件

## 验证策略

| 层级 | 工具/方式 | 频率 |
|------|---------|------|
| 引用一致性 | dao-smoke.mjs | 每 Task |
| 双栈同步 | dao-smoke 交叉引用 | 每 Task |
| 引用图谱 | Grep 全量扫描 | Phase 末 |
| 最终验证 | dao-smoke + 人工 review | 归档前 |
