# HANDOFF: dao-fusion

## 做了什么

道体融合——让 dao 规则体系从松散集合变为精密运转的整体。5 个方向 10 个任务：

1. **D5 表格恢复**：shell.md 交互命令黑名单 + autopilot 反模式表（dao-slim-v2 过度压缩 → 恢复精确配对）
2. **D2 概念去重**：qa 视觉判据改为引用 taste §4（单一真相源），消除跨 skill 重复枚举
3. **D3 入口收敛**：taste 从"全流程执行引擎"重新定位为"判据与审美标准库"；dao.md 场景速查表增加类型列（入口/自动/知识源）
4. **D1+D4 管线交接**：design-system §7 增加 Handoff Schema 表（P0→P1→P2→P3 四衔接点），下游 skill 统一引用

## 影响文件

- `ccswitch/dao.md` — 场景速查表 +类型列
- `ccswitch/skills/dao-design-{taste,qa,system,fidelity,open}/SKILL.md` — 描述/引用/schema
- `ccswitch/skills/dao-component-radar/SKILL.md` — 引用更新
- `ccswitch/commands/dao-autopilot.md` — 反模式表格恢复
- `.devin/` 侧对应文件（双栈同步）
- `.devin/rules/shell.md` — 黑名单表格恢复

## 已知偏差

- **R3 净增 +31 行**（目标 ≤0）：表格恢复 +32 超估（每表 8 行含表头×3 文件），qa 去重节省 -18 不足对冲。属 D5 与行数约束的内在矛盾，功能完整度优先。

## 后续建议

- 合并到 master 后运行 `dao.bat --deploy` 重新部署 skills/commands
- 本分支改了 skills 和 commands，deploy 后已即时生效（symlink）
