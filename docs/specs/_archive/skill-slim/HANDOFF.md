# HANDOFF: skill-slim

## 概要

超标 skill 瘦身——将 playbook（921→197 行）和 taste（637→398 行）的详细内容拆分到 references/ 子目录，实现渐进披露（frontmatter 常驻 → SKILL.md 触发加载 → references/ 按需深入）。

## 产出

| 产物 | 说明 |
|------|------|
| `ccswitch/skills/dao-design-system-playbook/references/` | 8 个文件：Phase 0-6 操作细节 + 案例 + 工具链 |
| `ccswitch/skills/dao-design-taste/references/` | 4 个文件：construct-mode + landing-page + design-criteria + component-audit |
| `.devin/` 侧完全同步 | 双栈一致 |
| `ccswitch/skills/dao-loop/SKILL.md` | 新增 Go Gate 四步门控（造线入口强制分支创建） |

## 关键决策

1. **拆分策略选 references/ 而非 sub-skill** — 保持单一 skill 调度入口，避免 frontmatter 膨胀
2. **骨架+指针模式** — 主文件保留流程图 + 每节一句话摘要 + `→ 详见` 指引，不丢信息
3. **Go Gate 是闭环不是补丁** — 在状态机里插入不可跳过的门控，而非提醒 AI "记得切分支"

## 教训

- 状态元数据转换 ≠ 实际操作完成（STATUS.json 改 mode 不等于切了分支）→ 已加 Go Gate
- skill 行数控制要在创建时就守住，事后瘦身成本高于预防

## 验收结果

A1-A7, A9: 全部通过。A8/R1: 2 个 pre-existing 失败（dao-loop/dao-project-scaffold 无 .devin 对应物）。R3: loop 有改动但属于用户要求的范围扩展。
