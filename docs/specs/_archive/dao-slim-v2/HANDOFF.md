# HANDOFF: dao-slim-v2

> 归档于 2026-06-25 | 版本 v2.0 | 36 轮任务 · 40 commits

## 做了什么

全局三层瘦身——always-on 层（dao.md / CLAUDE.md / .devin/rules）、on-demand 层（skills / commands / agents）、docs 层（AGENT_GUIDE / README / 孤儿文件）。核心手法：格式块压缩（ASCII 流程图 / 多行代码块显示格式 → 1-2 行 prose）、冗余删除、双栈同步、交叉引用修复。

## 改了哪些文件

| 层 | 文件 | 变化 |
|---|---|---|
| always-on | `ccswitch/dao.md` | 486→128 行 (-74%) |
| always-on | `~/.claude/CLAUDE.md` | 46→33 行 (-28%)，去重复语言规则 + 八句根基引用化 |
| always-on | `.devin/rules/` (5 files) | 399→276 行 (-31%) |
| always-on | 项目 `CLAUDE.md` | 93→82 行 |
| on-demand | `ccswitch/skills/` (17 skills) | 4420→2887 行 (-35%) |
| on-demand | `ccswitch/commands/` (8 commands) | ~2100→1432 行 (-32%) |
| on-demand | `.devin/workflows/` (双栈同步) | 对齐 ccswitch 压缩 |
| on-demand | `.devin/skills/` (双栈同步) | 对齐 ccswitch 压缩 |
| docs | `AGENT_GUIDE.md` | 288→178 行 (-38%) |
| docs | `README.md` | skill 清单 38→17，去除 15+ 废弃引用 |
| docs | `.devin/rules/design-assets.md` | -59 行 (code blocks→prose) |
| docs | `.devin/rules/project-structure.md` | -36 行 (code blocks→prose) |
| archive | `docs/specs/_archive/` | 5 孤儿 spec 归档 (1060 行) |

**净删减**：~4132 行

## 关键决策

1. **格式块压缩**而非内容删减——ASCII 流程图和代码块展示格式压缩为 prose，信息零损失。判据：是输出模板（不可压）还是展示格式（可压）
2. **双栈差异保留**——ccswitch/`.devin/` 之间的 platform-specific 差异（命令命名、turbo 标记、工具名、Memory 系统）确认为有意设计，不强制统一
3. **always-on 优先**——按 ROI 排序：every-message 注入文件 > on-demand skills > reference docs
4. **templates/ 策略放弃**——原计划将内容外置到 templates/，实际执行中发现 inline 压缩更高效，不增加文件数

## 验收结果

| ID | 标准 | 实际 | 状态 |
|---|---|---|---|
| A1 | dao.md ≤180 行 | 128 | ✅ |
| A2 | Skills ≤3,600 行 | 2,887 | ✅ |
| A3 | Commands ≤9 文件 | 8 | ✅ |
| A4 | Commands ≤1,900 行 | 1,432 | ✅ |
| A5 | dao-smoke 全绿 | 53/53 | ✅ |
| A6 | 无孤立交叉引用 | 0 断链 | ✅ |
| A7 | 外置文件可达 | references/ 12 files | ✅ |
| A8 | .devin/ 同步 | 0 漂移 | ✅ |
| R1-R6 | 回归 | 全部通过 | ✅ |

## 关键词

瘦身, 压缩, 格式块, always-on, 双栈, 交叉引用, dao.md, skills, commands

## 后续补丁
<!-- 就地小修时在此记录，格式：日期 | 改了什么 | 为什么 -->
