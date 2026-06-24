# Acceptance: dao-slim-v2

## 功能验收

| ID | 标准 | 验证方法 | 通过条件 |
|----|------|---------|---------|
| A1 | dao.md 行数 ≤180 | `wc -l ccswitch/dao.md` | ≤180 |
| A2 | Skills 总行数 ≤3,600 | 逐目录 `wc -l` 求和 | ≤3,600 |
| A3 | Commands 文件数 ≤9 | `ls ccswitch/commands/*.md \| wc -l` | ≤9 |
| A4 | Commands 总行数 ≤1,900 | 逐文件 `wc -l` 求和 | ≤1,900 |
| A5 | dao-smoke 全绿 | `node scripts/dao-smoke.mjs` | exit 0，无 FAIL |
| A6 | 无孤立交叉引用 | grep 所有 `§` + skill 名引用，验证目标存在 | 0 断链 |
| A7 | 外置文件可达 | 新建的 templates/ 和 references/ 文件存在且非空 | 全部存在 |
| A8 | .devin/ 侧同步 | dao-smoke 双栈校验 | 无漂移警告 |

## 回归验收

| ID | 现有功能 | 验证方式 |
|----|---------|---------|
| R1 | dao.md 八句根基完整 | grep 8 个关键词（道法自然/为道日损/反者道之动/各复归其根/道常无为/不知常/慎终如始/太上不知有之） |
| R2 | 续力机制仍生效 | dao.md 含 AskUserQuestion 相关指引 |
| R3 | Commit 前缀规则仍在 | dao.md 含 `[cc]` / `[codex]` 前缀铁律 |
| R4 | Shell 独有项保留 | dao.md 含 PowerShell 假错 / 路径锚点 / 验证 marker |
| R5 | Skill frontmatter 准确 | dao-smoke 检查 description/when_to_use 非空 |
| R6 | 被合并 command 功能不丢 | dao-thread-tree 逻辑在 autopilot 中可追溯；dao-cycle 逻辑在 dev 中可追溯 |

## 边界条件

| 场景 | 预期行为 |
|------|---------|
| 外置模板文件被删 | skill 内有"见 templates/xxx"提示，用户可重建 |
| 其他会话并行改 skill | git merge 正常解决，不覆盖其改动 |
| dao-smoke 报 .devin/ 不同步 | Phase 4 已包含同步步骤 |
