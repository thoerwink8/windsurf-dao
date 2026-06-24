# Spec: dao-slim-v2

## 定位
对 windsurf-dao 全局做三层瘦身（dao.md → skills → commands），在不损失任何功能的前提下，削减冗余、去除重复、外置模板，降低 token 开销，提升每轮注入的信噪比。

## 背景
经过多轮 skill 迭代（含 skill-slim Loop 38→17），整体能力更完善，但行数也在膨胀：
- dao.md（每消息注入）240 行，含与全局/项目 CLAUDE.md 的重复段
- 17 个 skills 共 ~4,414 行，设计流水线 4 个 skill 间 30-40% 内容重复
- 12 个 commands 共 ~2,285 行，4 个可删/合并
- 近期 3 次提交又增 335 行（fidelity/loop/截图规范）

总计 ~8,305 行。每多一行 always-on 内容 = 每条消息多一行 token 开销。

## 目标
| 维度 | 现状 | 目标 | 削减率 |
|------|------|------|--------|
| dao.md | 240 行 | ≤180 行 | ≥25% |
| Skills | ~4,414 行 | ≤3,600 行 | ≥18% |
| Commands | 12 文件/2,285 行 | ≤9 文件/1,900 行 | ≥17% |
| Agents | 1,366 行 | 不动 | 0% |
| **总计** | **~8,305 行** | **≤6,946 行** | **≥16%** |

可观测成功标准：
1. `node scripts/dao-smoke.mjs` 全绿（双栈一致性不退化）
2. 所有 skill frontmatter 的 description/when_to_use 仍准确
3. 无孤立交叉引用（A 引用 B 的 §X，B 的 §X 仍存在）
4. 功能覆盖不退化：删/合并前后的能力矩阵一一对应

## 方案

### Phase 1: dao.md 瘦身（优先级最高，乘数效应）
- 删除与全局 `~/.claude/CLAUDE.md` 重复的语言规则（2 处）
- 删除与项目 `CLAUDE.md` 重复的知识归位表
- 浏览器选择门（20 行）→ 外置到 `.claude/rules/browser-tool-selection.md`
- 续力门控感知（18 行）→ 回归各 skill 自带
- 德·行止之则（8 行）→ 压缩到八句根基内联
- 产出归位决策树（22 行）→ 压缩到 5 行启发式 + 外置完整树
- 八句根基去掉章号，每句压到一行

### Phase 2: Skills 压缩
- dao-loop：模板外置到 `templates/`（-100 行）、状态机协议压缩（-40 行）、重复护栏合并（-40 行）
- dao-design-system：token 完整表外置到 references（-160 行）、OD 集成段压缩（-80 行）
- dao-design-open：组件策略矩阵去重（与 design-taste 重复，-50 行）、读取阶段压缩（-60 行）
- dao-design-taste：去重组件扫描（-50 行）、哲学段压缩（-60 行）
- dao-design-fidelity：验证脚本段压缩（-70 行）、状态矩阵段压缩（-50 行）
- dao-code-to-prototype：配置发现段压缩（-90 行）、反模式去重（-25 行）

### Phase 3: Commands 整理
- 删除 dao-remove.md（10 行，/clear 已覆盖）
- 删除 gs.md（34 行，git status 别名）
- dao-thread-tree.md 合并入 dao-autopilot.md（-66 行独立文件）
- dao-cycle.md 核心逻辑并入 dao-dev.md，保留为轻量引用（-150 行）

### Phase 4: 交叉引用修复 + 验证
- 全量 grep 所有 `§` 引用，确保无断链
- `node scripts/dao-smoke.mjs` 双栈校验
- .devin/ 侧同步更新

### Phase 5: 持续优化（开放）
- 网上查 Claude Code / AI 规则系统最佳实践
- 动态发现新的压缩点
- 直到改无可改

## 范围
- **MVP 必做**: Phase 1-4（确定性瘦身 + 验证）
- **Nice-to-have**: Phase 5（探索性优化）
- **明确不做**: 改 agent 文件（审计确认无冗余）；改 dao 哲学内核（道德经/阴符经源文本）

## 风险
1. 外置内容后 skill 内引用断链 → 用 grep 验证
2. 合并 commands 后用户习惯受影响 → 保留别名或提示
3. 双栈漂移 → dao-smoke 校验兜底
4. 其他会话并行改动 → 每轮 git diff 感知，冲突时协调

## 依赖
- 前置 Loop: skill-slim（已完成，本 Loop 是其 Fork）
- 工具: `node scripts/dao-smoke.mjs`（双栈校验）
