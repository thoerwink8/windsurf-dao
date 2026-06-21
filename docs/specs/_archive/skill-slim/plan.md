# Plan: skill-slim

> 依赖: spec.md, acceptance.md

## 任务清单

### T1: playbook references/ 文件创建 (≈5min) → A3, A6

逐个创建 `ccswitch/skills/dao-design-system-playbook/references/` 下的文件，内容从当前 SKILL.md 原样剪切：

- 文件: `ccswitch/skills/dao-design-system-playbook/references/phase0-analysis.md` (NEW)
  - 操作: 从 SKILL.md 剪切 Phase 0 全部内容（§0.1-0.3，约第 46-104 行）
  - 文件头加 `# Phase 0 · 参考产品分析` 标题

- 文件: `ccswitch/skills/dao-design-system-playbook/references/phase1-tokens.md` (NEW)
  - 操作: 剪切 Phase 1 全部内容（§1.1-1.3，约第 107-210 行）

- 文件: `ccswitch/skills/dao-design-system-playbook/references/phase2-waves.md` (NEW)
  - 操作: 剪切 Phase 2 全部内容（§2.1-2.4，约第 212-322 行）

- 文件: `ccswitch/skills/dao-design-system-playbook/references/phase3-implementation.md` (NEW)
  - 操作: 剪切 Phase 3 全部内容（§3.1-3.5，约第 325-424 行）

- 文件: `ccswitch/skills/dao-design-system-playbook/references/phase4-darkmode.md` (NEW)
  - 操作: 剪切 Phase 4 全部内容（§4.1-4.5，约第 426-528 行）

- 文件: `ccswitch/skills/dao-design-system-playbook/references/phase5-6-qa-contracts.md` (NEW)
  - 操作: 剪切 Phase 5 + Phase 6 内容（§5.1-6.4，约第 530-682 行）

- 文件: `ccswitch/skills/dao-design-system-playbook/references/case-traceyu.md` (NEW)
  - 操作: 剪切附录 B（§B.1-B.4，约第 802-865 行）

- 文件: `ccswitch/skills/dao-design-system-playbook/references/toolchain-ref.md` (NEW)
  - 操作: 剪切附录 C（§C.1-C.3，约第 868-896 行）

- 验证: `ls ccswitch/skills/dao-design-system-playbook/references/` 列出 8 个 .md 文件

### T2: playbook SKILL.md 瘦身 (≈5min) → A1, A5, A9

- 文件: `ccswitch/skills/dao-design-system-playbook/SKILL.md` (MODIFY — 重写)
- 操作: 重写主文件，保留以下结构：
  1. **frontmatter** — 原样保留（name + description 不变）
  2. **标题 + 引言 + 适用/不适用** — 原样保留（~18 行）
  3. **全景流程图** — 原样保留（~20 行）
  4. **每个 Phase 一段摘要**（每 Phase 3-5 行）：一句话说明 + 关键产出 + `→ 详见 references/phaseX-xxx.md`。共 ~50 行
  5. **Phase 7 收尾与知识沉淀** — 原样保留（精简版 ~30 行，验收三关 + 文档更新）
  6. **附录 A 自主循环** — 原样保留（~60 行，这是执行层核心不能拆）
  7. **附录 B/C 指引** — 各一行 `→ 详见 references/xxx.md`
  8. **skill 关系表 + 反原则** — 原样保留（~25 行）
- 目标: ≤250 行
- 验证: `wc -l ccswitch/skills/dao-design-system-playbook/SKILL.md` ≤ 300

### T3: taste references/ 文件创建 (≈3min) → A4, A6

- 文件: `ccswitch/skills/dao-design-taste/references/construct-mode.md` (NEW)
  - 操作: 从 SKILL.md 剪切 §7C Construct 模式全部内容（S1-S5 + 铁律，约第 422-493 行）
  - 文件头加 `# §7C · Construct 模式：设计系统构建流程`

- 文件: `ccswitch/skills/dao-design-taste/references/landing-page-rules.md` (NEW)
  - 操作: 剪切 §A 附录（A.1 + A.2，约第 604-623 行）
  - 文件头加 `# §A · 附录：营销落地页专属规则`

- 验证: `ls ccswitch/skills/dao-design-taste/references/` 列出 2 个 .md 文件

### T4: taste SKILL.md 瘦身 (≈3min) → A2, A5, A9

- 文件: `ccswitch/skills/dao-design-taste/SKILL.md` (MODIFY)
- 操作:
  1. §7C 区域替换为摘要（3-5 行）+ `→ 详见 references/construct-mode.md`
  2. §A 区域替换为一行 `→ 详见 references/landing-page-rules.md`
  3. frontmatter 不动
- 目标: ≤400 行
- 验证: `wc -l ccswitch/skills/dao-design-taste/SKILL.md` ≤ 400

### T5: 双栈同步 (≈3min) → A7

- 文件: `.devin/skills/dao-design-system-playbook/` (NEW — 整个目录)
  - 操作: 从 ccswitch 侧复制拆分后的完整 skill 目录（SKILL.md + references/）
  - 注意: .devin 侧之前没有这个 skill，需要新建

- 文件: `.devin/skills/dao-design-taste/` (MODIFY)
  - 操作: 用 ccswitch 侧的拆分结果覆盖（SKILL.md 更新 + 新建 references/）
  - 注意: .devin 侧已有 500 行版本（与 ccswitch 637 行有漂移），以 ccswitch 拆分后版本为准

- 验证: `diff -rq ccswitch/skills/dao-design-system-playbook/ .devin/skills/dao-design-system-playbook/` 无差异（taste 同理）

### T6: 验证 + 收尾 (≈2min) → A8, R1, R2, R3

- 操作:
  1. `node scripts/dao-smoke.mjs` — 确认 exit 0
  2. `wc -l ccswitch/skills/dao-design-system-playbook/SKILL.md ccswitch/skills/dao-design-taste/SKILL.md` — 确认行数达标
  3. `git diff --name-only` — 确认只改了目标目录
  4. `git diff ccswitch/skills/dao-loop/SKILL.md` — 确认 loop 未动
- 验证: 全部通过

## 覆盖矩阵

| 验收项 | 覆盖 Task |
|--------|----------|
| A1 | T2, T6 |
| A2 | T4, T6 |
| A3 | T1 |
| A4 | T3 |
| A5 | T2, T4 |
| A6 | T1, T3 |
| A7 | T5 |
| A8 | T6 |
| A9 | T2, T4 |
| R1 | T6 |
| R2 | T6 |
| R3 | T6 |

验收项无 Task 覆盖 → plan 完整。
