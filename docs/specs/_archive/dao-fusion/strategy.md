# Strategy: dao-fusion

## 达成度维度

| 维度 | 达标线 | 量化方式 |
|------|--------|---------|
| 交接闭环 | 4 衔接点全有 schema | 读 design-system §7 |
| 概念去重 | 视觉判据单一真相源 | qa 中无重复枚举 |
| 入口收敛 | 用户入口 ≤ 2（design-system + design-open） | dao.md 标注验证 |
| 表格恢复 | 2 处表格恢复精确配对 | 目视 + 行数 |
| 双栈同步 | dao-smoke 全绿 | 跑脚本 |
| 净增控制 | insertions - deletions ≤ 0 | git diff --stat |

## 技术选型 / ADR

### ADR-1：判据归属——taste 还是 fidelity？

**决策**：taste §4 = "什么是好设计"（判据），fidelity L1-L5 = "如何验证"（方法）。两者互补不重叠。

**理由**：判据是设计标准（颜色纪律 / 字体 / 间距一致性等），验证方法是技术手段（grep 硬编码 / 截图 diff / ARIA snapshot）。混在一起会让两个 skill 都臃肿且难以引用。

**影响**：qa 引用 taste §4 做判据，引用 fidelity 做验证。三者形成知识链而非平行竞争。

### ADR-2：taste 重新定位——知识源而非执行引擎

**决策**：taste 保留全部内容（分诊/探索/判据/审计/资产/验收），但 description 改为知识源定位，不再自称"总闸"。

**理由**：pipeline 模式下 design-open 是执行入口，taste 的分诊和验收在非 pipeline 场景（直接 UI 改动）仍有独立价值。不删功能，只调路由权重。

**替代方案（弃）**：合并 taste 到 design-open → 会让 design-open 膨胀且违反"不新增不删除文件"约束。

### ADR-3：qa 保留独立 skill

**决策**：保留 qa 为独立 skill，去重判据部分但保留"设计工具先行修复"这一独特流程。

**理由**：qa 的三步循环（截图→设计工具修→代码回填）是独特工作流，不等于 design-open §4 QA 循环（后者无设计工具环节）。但 qa Step 1 的审视维度与 taste §4 重复，应引用而非复制。

## 验证策略

| 阶段 | 验证内容 | 方法 |
|------|---------|------|
| 每 Task | 双栈对应文件一致 | 人工比对关键段落 |
| 每 Phase | dao-smoke 全绿 | `node scripts/dao-smoke.mjs` |
| 归档前 | 全量验收 + 净增统计 | acceptance 逐条 + `git diff --stat` |
