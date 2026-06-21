# Spec: skill-slim

## 定位

瘦身 3 个超标 SKILL.md（playbook 921 行、taste 637 行、loop 474 行），将操作细节/模板/案例拆入 `references/` 子文件，主文件只留流程骨架 + 分诊逻辑 + 跨节引用，降低触发时的 token 注入量。

## 背景

最佳实践建议单文件 <500 行。当前 `dao-design-system-playbook`（921 行）严重超标，`dao-design-taste`（637 行）中度超标，`dao-loop`（474 行）卡线。每次触发这些 skill，全文注入上下文，造成不必要的 token 消耗。

skill 的渐进披露原则：frontmatter（总是加载）→ SKILL.md 正文（触发时加载）→ references/（按需加载）。目前 playbook 和 taste 缺少第三层，所有内容都塞在正文里。

## 目标

1. `dao-design-system-playbook/SKILL.md` 从 921 行降到 ≤300 行
2. `dao-design-taste/SKILL.md` 从 637 行降到 ≤400 行
3. `dao-loop/SKILL.md` 保持现状（474 行刚好卡线，不动）
4. 拆出的内容放入各 skill 的 `references/` 目录，SKILL.md 中保留引用指引
5. 双栈同步：`.devin/` 侧对应文件同步更新
6. `node scripts/dao-smoke.mjs` 通过

## 方案

### 推荐方案：references/ 拆分

**思路**：将大段操作细节、代码模板、案例研究、工具参考等抽入 `references/*.md`，SKILL.md 保留骨架 + 入口 + 简短说明 + `→ 详见 references/xxx.md` 指引。

**dao-design-system-playbook 拆分计划**（921 → ~250 行）：

| 抽出内容 | 目标文件 | 预估行数 |
|---------|---------|---------|
| Phase 0 完整操作（§0.1-0.3） | `references/phase0-analysis.md` | ~100 行 |
| Phase 1 Token 架构详情（§1.1-1.3） | `references/phase1-tokens.md` | ~100 行 |
| Phase 2 波次规划详情（§2.1-2.4） | `references/phase2-waves.md` | ~100 行 |
| Phase 3 实施详情（§3.1-3.5） | `references/phase3-implementation.md` | ~120 行 |
| Phase 4 暗色模式详情（§4.1-4.5） | `references/phase4-darkmode.md` | ~100 行 |
| Phase 5-6 QA + 契约测试 | `references/phase5-6-qa-contracts.md` | ~150 行 |
| 附录 B 案例研究 | `references/case-traceyu.md` | ~70 行 |
| 附录 C 工具链参考 | `references/toolchain-ref.md` | ~30 行 |

SKILL.md 保留：frontmatter + 适用/不适用 + 全景流程图 + 每 Phase 一句话说明 + 附录 A 自主循环 + Phase 7 收尾 + 反原则 + skill 关系表。

**dao-design-taste 拆分计划**（637 → ~350 行）：

| 抽出内容 | 目标文件 | 预估行数 |
|---------|---------|---------|
| §7C Construct 模式 S1-S5（设计系统构建） | `references/construct-mode.md` | ~130 行 |
| §A 附录（营销页规则） | `references/landing-page-rules.md` | ~30 行 |

taste 的核心流程（§0-pre 扫描、§0 分诊、§1-§6、§7 双模式概述、§8 验收）都是分诊/执行必读内容，不适合抽出。只有 §7C 的详细 5 步构建流程和附录 A 是按需内容。

**优势**：最小改动，不影响 skill 的触发逻辑和语义，双栈同步简单。
**劣势**：references/ 文件需要 AI 按需加载，多一次 Read 调用。
**工作量**：中等（2-3 小时）。

### 备选方案：拆分为独立子 skill

将 playbook 拆成多个独立 skill（如 `dao-design-tokens`、`dao-design-waves`）。
劣势：增加 skill 总数（当前 11 个已接近上限 12 个）、每个 skill 的 frontmatter 都消耗 token、维护成本高。不推荐。

## 范围

### MVP 必做
- playbook 拆分（降幅最大：921 → ~250）
- taste 拆分（§7C + §A 抽出）
- 双栈同步
- dao-smoke 通过

### Nice-to-have
- 在 SKILL.md 中添加 `<!-- @references: ... -->` 注释，帮助 AI 判断何时按需加载
- 统一所有 skill 的 references/ 命名规范

### 明确不做
- dao-loop 不动（474 行卡线，内容紧凑不适合拆）
- 其他 8 个 <500 行的 skill 不动
- 不改 skill 的 frontmatter description（触发逻辑不变）
- 不改 skill 的功能语义

## 风险

1. **references/ 不被 AI 自动加载**：SKILL.md 主文件够用时 AI 不会去读 references/，相当于信息丢失。**缓解**：主文件保留足够的骨架信息 + 明确的 `→ 详见` 指引，AI 遇到具体操作时自然去读。
2. **双栈同步遗漏**：拆分后 .devin/ 侧忘记同步。**缓解**：dao-smoke.mjs 会校验。
3. **拆过头**：把流程核心步骤也拆出去导致 skill 不完整。**缓解**：保守策略，只拆"操作细节/模板/案例"，不拆"分诊/流程骨架/反原则"。

## 依赖

无外部依赖。仅需 windsurf-dao 仓库内操作。
