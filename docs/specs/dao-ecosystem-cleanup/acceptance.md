# Acceptance: dao-ecosystem-cleanup

## 功能验收

| ID | 标准 | 验证方法 | 通过条件 |
|----|------|---------|---------|
| A1 | playbook skill 退役 | `Glob ccswitch/skills/dao-design-system-playbook/` + `.devin/skills/dao-design-system-playbook/` | ✅ 双栈目录均不存在 |
| A2 | autopilot command 退役 | `Glob ccswitch/commands/dao-autopilot.md` + `.devin/workflows/dao-autopilot.md` | ✅ 双栈文件均不存在 |
| A3 | distill 声明为 evolution 子集 | 读 `ccswitch/commands/dao-distill.md` 头部 | ✅ 有明确子集声明 |
| A4 | evolve 声明为 evolution 子集 | 读 `ccswitch/commands/dao-evolve.md` 头部 | ✅ 有明确子集声明 |
| A5 | qa 引用链完整 | Grep `dao-design-qa` 在活跃 skill/command 中 | ✅ ≥1 非自引用的活跃引用 |
| A6 | dao-loop command 含 strategy.md | 读 `ccswitch/commands/dao-loop.md` §4 | ✅ 文档列表包含 strategy.md |
| A7 | brainstormer 知道诊断报告 | 读 `ccswitch/agents/dao-brainstormer.md` | 有 refactor 型诊断报告处理逻辑 |
| A8 | dao-smoke 全过 | `node scripts/dao-smoke.mjs` | 0 failures |
| A9 | 双栈一致 | dao-smoke 交叉引用检查 | ✅ |
| A10 | dao.md 场景表同步 | 读 `ccswitch/dao.md` 场景速查表 | 退役模块已移除，类型列准确 |

## 回归验收

| ID | 现有功能 | 验证方法 |
|----|---------|---------|
| R1 | design-open 翻译流程完整 | 读 design-open SKILL.md §5 关系表 |
| R2 | dao-loop 谋线流程完整 | 读 dao-loop SKILL.md §4 |
| R3 | dao-dev 核心逻辑不变 | 读 dao-dev 无新增大段内容 |

## 边界条件

| 场景 | 预期行为 |
|------|---------|
| playbook 有独有价值内容 | 提取到 design-system 后再删除 |
| autopilot 有独有价值内容 | 提取到 dao-dev 后再删除 |
| 持续推进无收敛 | 连续 2 轮 micro-audit 无新发现 → 停止 |
