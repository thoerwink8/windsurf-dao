# Acceptance: skill-slim

## 功能验收

| ID | 标准 | 验证方法 | 通过条件 |
|----|------|---------|---------|
| A1 | playbook SKILL.md 行数 ≤300 | `wc -l ccswitch/skills/dao-design-system-playbook/SKILL.md` | ≤300 行 |
| A2 | taste SKILL.md 行数 ≤400 | `wc -l ccswitch/skills/dao-design-taste/SKILL.md` | ≤400 行 |
| A3 | playbook references/ 目录存在且内容完整 | `ls ccswitch/skills/dao-design-system-playbook/references/` + 内容抽查 | 拆出的 Phase 操作细节、案例、工具链全部存在 |
| A4 | taste references/ 目录存在且内容完整 | `ls ccswitch/skills/dao-design-taste/references/` + 内容抽查 | §7C Construct 流程 + §A 附录存在 |
| A5 | 主文件保留流程骨架和指引 | 阅读拆分后的 SKILL.md | 每个被拆出的章节在主文件中有一句话说明 + `→ 详见 references/xxx.md` 指引 |
| A6 | 拆分零信息丢失 | 对比拆分前后的总内容 | references/ 文件 + 主文件的内容覆盖拆分前全部内容，无遗漏段落 |
| A7 | 双栈同步 | 比较 `ccswitch/skills/dao-design-system-playbook/` 与 `.devin/skills/dao-design-system-playbook/`；taste 同理 | 两侧文件结构和内容一致 |
| A8 | dao-smoke 通过 | `node scripts/dao-smoke.mjs` | exit code 0，无 FAIL 行 |
| A9 | frontmatter 不变 | 检查拆分后 SKILL.md 的 frontmatter | name 和 description 与拆分前完全一致 |

## 回归验收

| ID | 现有功能 | 验证命令 |
|----|---------|---------|
| R1 | dao-smoke 整体健康 | `node scripts/dao-smoke.mjs` |
| R2 | 其他 skill 未被改动 | `git diff --name-only` 只含目标 skill 目录 |
| R3 | loop SKILL.md 未改动 | `git diff ccswitch/skills/dao-loop/SKILL.md` 为空 |

## 边界条件

| 场景 | 预期行为 |
|------|---------|
| AI 触发 playbook skill 后需要 Phase 详情 | AI 读到主文件的 `→ 详见` 指引后，主动 Read 对应 references/ 文件 |
| AI 触发 taste skill 做 Construct 模式 | AI 读到 §7C 的指引后，主动 Read `references/construct-mode.md` |
| .devin/ 侧无对应 skill 目录 | 创建目录并同步全部文件 |
| dao-smoke 报 FAIL | 修复后重新验证直到通过 |
