# Spec: dao-ecosystem-cleanup

> extends: dao-fusion

## 定位

基于 v2 生态诊断报告，清理 dao 规则系统中的孤岛模块、冗余命令和引用缺口，使 skill/command/agent 生态形成紧密互引的有机体。

## 背景

dao-fusion Loop 完成后进行 v2 生态审计，扫描全部 skill（12）+ command（9）+ agent（8）的引用图谱，发现 6 个结构性问题：

**诊断报告（v2 审计 6 发现）**：

1. 🔴 **playbook 真孤岛**：`dao-design-system-playbook` 被外部引用 0 次，7 phase 内容与 design-system 高度重叠
2. 🔴 **autopilot 孤岛 + 过时**：`dao-autopilot` command 使用 TODO.md 作为任务图（与 dao-loop 的 docs/specs/ 冲突），递归/反思机制与 dao-dev 重叠
3. ⚠️ **distill/evolve/evolution 三名近义**：三个模块名字相近职责交叉，用户不知道用哪个
4. ⚠️ **qa 接近孤岛**：`dao-design-qa` 唯一活跃引用来自 playbook（正在退役），退役后变真孤岛
5. ⚠️ **dao-loop command 缺 strategy.md**：§4 谋线流程列 spec→acceptance→plan，漏了 strategy.md
6. ⚠️ **brainstormer 不知诊断报告**：agent 定义无 refactor 型 Loop 的诊断报告处理逻辑

## 目标

- 引用图谱无 0-ref 孤岛节点（退役或补引用）
- 近义模块关系明确（子集声明或合并）
- dao-smoke.mjs 全部检查通过
- 双栈（ccswitch/ + .devin/）一致
- 「持续推进」：每 Task 后重评生态现状，动态追加新发现，直到改无可改

## 方案

### 推荐方案：退役 + 合并 + 补引用

| 发现 | 处置 |
|------|------|
| playbook 孤岛 | 检查有价值内容是否已在 design-system 中覆盖，有则直接删除 skill 目录（双栈） |
| autopilot 过时 | 检查递归/反思有独立价值则提取到 dao-dev，删除 command（双栈） |
| distill/evolve 近义 | 在文件头加声明：distill = evolution 的会话级子集，evolve = evolution 的系统级子集 |
| qa 弱引用 | 在 design-open §5 关系表补 qa 引用；确认 dao.md 场景表已列 |
| loop command 缺 strategy | §4 补 strategy.md 到文档列表 |
| brainstormer 缺诊断 | agent 定义加"refactor 型 Loop 时，以诊断报告为首要输入"条件 |

### 备选方案：不做

playbook 和 autopilot 虽是孤岛但不伤害运行——只是占 context token。可以暂时不动。但随着 skill 数量增长，无用 context 成本会持续上升。

## 范围

- **MVP**：6 个发现全部处理 + dao-smoke 验证
- **持续推进**：每 Task 后 micro-audit 当前改动影响区域，发现新缺口/整合机会则追加 Task
- **明确不做**：不重写任何 skill 的核心逻辑，只做引用关系和模块边界调整

## 风险

| 风险 | 应对 |
|------|------|
| 双栈漂移 | 每次改动 ccswitch/ 必须同步 .devin/，改完跑 dao-smoke |
| 删错有价值内容 | 删前 grep 确认无活跃引用，有价值内容先提取 |
| 持续推进无收敛 | 设硬上限：连续 2 轮 micro-audit 无新发现则收敛 |

## 依赖

- dao-fusion Loop ✅ 已归档，已合并 master
- dao-loop 新流程（诊断扫描 + 用户交付审查）✅ 已就绪
