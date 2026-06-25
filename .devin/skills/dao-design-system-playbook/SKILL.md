---
name: dao-design-system-playbook
description: 设计系统改造全流程手册——从参考产品分析到波次实施、暗色模式、视觉 QA、契约测试、AI 自主改造循环。覆盖「已有产品对标新设计语言」的完整可复用流程。当用户要求对标某产品风格、换肤、设计系统迁移时触发
---

# 设计系统改造手册 · Design System Transformation Playbook

> 图难于其易，为大于其细。天下难事必作于易，天下大事必作于细。

本 skill 是 `dao-design-taste`（设计原则与判据）和 `dao-design-qa`（视觉问题修复）的**操作层伙伴**——它不讲"什么是好设计"，而讲"如何系统性地把一个已有产品从 A 风格改造到 B 风格"。

**适用场景**：已有产品对标新设计语言（如"对标飞书/Linear/Notion 风格"）、设计系统大版本升级、全局换肤/设计语言统一、组件库从零散到系统化。

**不适用**：新产品从零设计（走 `dao-design-taste` §7C Construct 流程）、单个视觉 bug 修复（走 `dao-design-qa`）。

---

## 全景流程

Phase 0 知彼（参考产品分析）→ 1 建制（Token 架构）→ 2 谋篇（波次规划）→ 3 落地（系统性实施）→ 4 阴阳（暗色模式）→ 5 验真（视觉 QA）→ 6 固本（契约测试）→ 7 归根（收尾）。各 Phase 可独立执行。

---

## Phase 0 · 参考产品分析

> 知人者智，自知者明。先读懂目标产品的设计 DNA，再动手。

**不是截图然后模仿——是提取设计决策背后的系统性规律。** 对目标产品做 10 维度系统性解剖（色彩/圆角/阴影/hover/过渡/间距/字体/边框/交互/加载），产出**差异矩阵**（当前 vs 目标）作为波次规划的唯一输入。优先级：P0 token 级联全局 → P1 逐组件有模式 → P2 影响小/纯增强 → P3 可选优化。

→ 详见 `references/phase0-analysis.md`（完整解剖维度表 + 差异矩阵模板 + 公开设计系统参考）

---

## Phase 1 · Token 架构规划

> 道生一（primitive），一生二（semantic），二生三（component），三生万物（页面）。

三层 Token 分层：Primitive（原始值）→ Semantic（语义级）→ Component（组件级）。中小项目可合并 L1+L2 为 CSS 变量 + Tailwind config。**HSL 强制**：所有颜色用 `H S% L%` 三值格式。命名语义化，以"这个颜色做什么"而非"它是什么颜色"命名。

→ 详见 `references/phase1-tokens.md`（三层架构图 + HSL 实现 + 命名规范 + 暗色模式 token 模板）

---

## Phase 2 · 波次规划

> 善行无辙迹。大改造不是一锅端——是有节奏的波次推进。

按依赖关系拆分波次：token 层（影响全局、零测试风险）→ 基础组件层（按组件逐个改）→ 交互层（hover/focus/drag 统一）→ 动效层（transition/animation）→ 深度打磨。每波包含：目标/涉及文件/改法/测试影响/验证方式。

→ 详见 `references/phase2-waves.md`（波次拆分原则 + 测试影响预判 + 波次清单模板）

---

## Phase 3 · 系统性实施

> 千里之行，始于足下。

**级联原则**：改一个 token → grep 所有引用 → 确认级联效果 → 测试 → commit。先改 token 变量定义（影响最广、风险最低），再改组件引用方式。常见改造模式：hover 策略统一、inset shadow 清除、transition duration 标准化。

→ 详见 `references/phase3-implementation.md`（级联原则详解 + hover/shadow/transition 改造 pattern）

---

## Phase 4 · 暗色模式改造

> 万物负阴而抱阳，冲气以为和。

**铁律：暗色模式是独立工程，不是亮色的反转。** 语义色映射（:root → .dark 一一对应）、表面色饱和度 ≤ 16%、对比度全量校验（WCAG AA）。暗色三大陷阱：死黑背景、过饱和表面、隐身文字。

→ 详见 `references/phase4-darkmode.md`（语义色映射表 + 亮→暗转换公式 + 对比度校验 + 陷阱清单）

---

## Phase 5-6 · 视觉 QA + 契约测试

> 慎终如始。验证不靠像素比对，靠截图实测 + className 断言。

**Phase 5 视觉 QA**：截图驱动的双模式验证——亮色全页截图 + 暗色全页截图 + 关键交互态验证。发现问题进入 `dao-design-qa` 修复循环。

**Phase 6 契约测试**：用 className 断言守护设计一致性。三类断言：token 引用（正确 class）、否定（禁止的 class）、结构（variant 覆盖）。改造后更新断言，作为长期回归防线。

→ 详见 `references/phase5-6-qa-contracts.md`（QA 截图流程 + 契约测试编写模式 + 断言分类）

---

## Phase 7 · 收尾与知识沉淀

> 功成事遂，百姓皆谓我自然。

功能完整性（测试+类型检查+构建）→ 视觉完整性（全页面亮/暗截图+交互态）→ 知识归位（`design-tokens.md` 更新 + 教训沉淀：背景→现象→根因→对策→泛化）。

---

## 附录 A · AI Agent 设计改造工作流

> 道常无为而无不为。AI 替用户承担一切设计改造的执行负担。

### 自主改造循环

Phase 0 分析 → Phase 2 波次规划 → 每波循环（改码→测试+更新 contract→截图验证亮+暗→问题修复回跑/无问题 commit）→ 全波次完成→深度打磨→收尾归位。

**陷阱防线**：每波只做计划内变更（防过度修改）、必须截图验证（防测试假绿）、改 `:root` 必改 `.dark`（防暗色遗漏）、每 10 轮回读初心（防上下文丢失）。一波一 commit。

---

## 附录 B · 案例研究

→ 详见 `references/case-traceyu.md`（TraceyU 飞书改造全案：9 波 + 3 波打磨 + 关键教训）

---

## 附录 C · 工具链参考

→ 详见 `references/toolchain-ref.md`（Token 管理 / 视觉回归测试 / 设计-代码同步工具对照表）

---

## 与 dao 体系的关系

`dao-design-taste`（原则判据）→ 本 playbook（操作流程）→ `dao-design-qa`（Phase 5 调用）。波次规划专化自 `dao-plan`，验收三关引用 `dao-verify`，教训通过 `dao-evolution` 归档。

---

## 反原则

- **不为流程而流程** — 简单换色用不着 9 波规划，DIRECT 档改完验证即可
- **不追求像素完美** — 验方向不验像素，"感觉对了"比"数值一致"重要
- **不维护双真相源** — 代码是唯一真相源，设计稿是探针不是合同
- **测试是安全网不是目的** — contract 测试守护一致性，不是为测而测
- **暗色模式不是附赠** — 它是独立的设计工程，需要独立的 Phase
- **AI 不代替审美** — AI 执行效率高但审美中性，目标设计语言由人定义

法不违德，德不违道，道法自然。
