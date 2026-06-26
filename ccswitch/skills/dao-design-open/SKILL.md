---
name: dao-design-open
description: Open Design 设计消费引擎——读取 Open Design 产出的设计资产（HTML 原型 + CSS 设计系统），翻译为生产级 React 代码，三维对齐验证。UI 任务涉及 design/ 目录时触发
---

# Open Design 消费引擎 · Design-to-Code

> 道法自然。设计已成，代码当如水就形。

本 skill 定义以 **Open Design (open-design.ai)** 产出为唯一设计真相源、AI 忠实翻译为生产代码的标准流程。

**核心原则：AI 不做设计决策，只做设计翻译。** Open Design 已完成所有设计判断（色彩、字体、圆角、间距、布局、交互态、组件形态），AI 的职责是将 HTML 原型 **结构性地** 翻译为 React 组件，不是只翻译 CSS token。

**流水线位置**：Design Pipeline **Phase 1（翻译）**。上游是 `dao-design-system`（Phase 0，基础层规则 = 翻译时的合规基线），下游是 `dao-design-fidelity`（Phase 2，翻译完成后必须通过 L1+L2 验证）。布局决策查 `dao-design-layout`。详见 `dao-design-system` §7。

---

## §0 · Open Design 产出格式

Open Design 的产出是一个自包含的设计资产目录，典型结构：

```
design/
├── .od-skills/           # Open Design 的设计技能（审美标准参考，只读）
├── .claude/              # Claude Code 集成配置（预留）
├── css/<project>.css     # 共享设计系统（CSS 变量 + 组件类 + 布局原语）
├── js/<project>.js       # 共享行为（主题切换 + 持久化）
├── screenshots/          # 参考截图
├── *.html                # 各页面原型（自包含、可独立浏览）
├── *.html.artifact.json  # 每页元数据（版本、状态、时间戳）
└── gallery.html          # 全页面索引画廊
```

**设计系统 CSS** 是最关键的文件——包含：
- CSS 变量（色彩 token / 字体 / 圆角 / 动画 / 阴影）
- 亮暗双主题（`html[data-theme="light|dark"]`）
- 组件类（`.btn-*` / `.badge.*` / `.pool-bar` / `.proj` / `.input` 等）
- 布局原语（`.app` / `.side` / `.main` / `.frame` 等）
- 三池语义色（四层：color / tint / line / ink）

---

## §1 · 读取（Read）

> 不知常妄作凶。动笔前先通读全貌。

**每次涉及 design/ 目录的 UI 任务，无条件执行本步。**

1. **读 CSS**（`design/css/<project>.css`）：提取全部 token（色彩/字体/圆角/阴影/动画）+ 组件 CSS 类 + 布局结构
2. **读 HTML**（`design/*.html`）：提取 DOM 层级 + 组件使用 + 交互态 + 响应式 + 主题差异
3. **读 artifact**（`*.artifact.json`）：确认 `status: "complete"` 才翻译

---

## §1.5 · Loop 级全覆盖规划（谋线必读）

> 图难于其易，为大于其细。全局先行，不遗一页。

**当 Loop 涉及 design/ 目录的设计对齐时（由 `dao-loop` 谋线自动触发），本节提供系统化的全覆盖规划方法论，取代零散的单页翻译。**

### 1.5.0 跨页组件整合扫描

清点前先通读全部 `design/*.html`，提取跨页共享的 CSS 类和 DOM 模式，建立组件复用矩阵（组件模式 | 出现页面 | 设计 CSS 类 | 项目组件 | 策略）。每个组件按 `native/extend/wrap/custom` 四级决策（判据见 §B design-spirit 模板），结果写入 strategy.md。先整合后清点，共享组件 Task 排第一梯队。

### 1.5.1 全页面清点

枚举 `design/*.html` 所有页面（排除 gallery 索引页），建立清单（页面 | 设计文件 | React 对应 | 当前状态）。**铁律**：每个 html 必须出现，遗漏 = 不得进造线。

### 1.5.2 三层结构 Diff

每页自顶向下：**布局层**（grid/flex 骨架、容器、导航）→ **节层**（区块结构、面板、tabs）→ **组件层**（props/样式/交互态）。只做组件层 = 遗漏结构偏差。

### 1.5.3 页面维度覆盖矩阵

plan 覆盖矩阵增加 页面×层级 维度。空白且未标 `deferred` = plan 不完整。deferred 须显式标注原因，不得超过总页面 50%。

### 1.5.4 Top-Down 排序

共享结构（导航/topbar/layout shell）→ 布局层 → 节层 → 组件层 → 微调。上层先做，避免下层返工。

---

## §2 · 映射（Map）

三层映射：**Token**（OD CSS 变量 → 项目 token，项目吸收 OD 值不另建）→ **组件**（OD CSS 类 → React 组件，无对应则新建）→ **布局**（OD 布局原语 → 布局组件，窗口级包裹 `.frame`/`.titlebar` 不翻译——桌面应用有原生窗口）。

---

## §3 · 翻译（Translate）

逐页面三维对齐，忠实翻译不加不减。

### 3.1 结构对齐

对标 HTML 原型 DOM 层级。常见偏差：嵌套层数不匹配→补容器，Grid/Flex 不一致→以设计为准，窗口包裹→桌面应用跳过。

### 3.2 视觉对齐

对标 CSS 值（字号/色彩/圆角/间距/阴影）。优先用项目 token，不覆盖时建新 token。**禁止硬编码**像素值或 hex 色值。

### 3.3 交互对齐（三层）

**状态层**：交互态（hover/focus/active/disabled）+ 数据态（empty/loading/error）+ 组合态（disabled+hover 不变色）。实现方式可与 OD 不同，视觉效果一致即可。

**动效层**：微交互/转场/反馈对标 CSS transition/animation。超出组件库能力→strategy 标 `wrap`。所有动效须尊重 `prefers-reduced-motion`。

**导航层**：确保闭环——A→B 有路径，B→A 也有。导航矩阵写入 `design-spirit.md`（起点页 | 终点页 | 触发元素 | 实现状态）。

### 3.4 批量翻译

按影响面排序：共享组件 → 核心交互页 → 辅助页面。每页翻译完 typecheck + test。

---

## §4 · 验证（Verify）

> 慎终如始，则无败事。

### 4.1 自动验证

运行项目的类型检查和测试套件（具体命令见项目 CLAUDE.md）。

### 4.2 视觉验证（截图对比）

1. 在浏览器中打开 `design/*.html`（Open Design 原型）
2. 运行项目应用（开发服务器或桌面端）
3. 截图同一页面，并排对比

**比对维度**：
- 布局结构（容器比例、对齐方式）
- 色彩（token 映射是否正确）
- 字号/字重（视觉层级是否一致）
- 间距（内外边距是否一致）
- 交互态（hover/focus 效果）

### 4.3 偏差处理

| 偏差位置 | 处理方式 |
|---|---|
| 项目代码未对齐设计 | 修改项目代码，重新跑 §3 三维对齐 |
| Open Design 原型需要更新 | 告知用户回 Open Design 更新，不自行改 `design/` 目录 |
| 设计系统 CSS 与项目 token 冲突 | 以 Open Design CSS 为准，调整项目侧 token |

### 4.4 QA 循环

发现视觉偏差时进入修复循环：

```
截图发现问题 → 定位偏差（结构/视觉/交互）→ 修改项目代码 → 验证（类型+测试）→ 再次截图
     ↑                                                                          │
     └──────────────── 还有偏差？继续循环 ─────────────────────────────────────────┘
```

循环退出条件：截图对比无明显偏差 + 测试全绿。

### 4.5 收尾自检（auto-gate）

> 慎终如始。翻译完成 ≠ 声明完成。以下两关在 §4.4 退出后**自动执行**，不需用户手动调用 fidelity 或 radar skill。

**关一：Token 合规（来自 dao-design-fidelity L1）**

| 检查 | 方法 | pass 条件 |
|------|------|----------|
| 硬编码字号 | grep `text-\[` 在改动文件范围内 | 零结果 |
| 硬编码色值 | grep `#[0-9a-fA-F]` 在 tsx 文件中 | 零结果（排除注释和 SVG） |
| 硬编码圆角 | grep `rounded-\[` 在改动文件范围内 | 零结果 |

不过 → 修 → 重跑，不声明完成。

**关二：组件健康（来自 dao-component-radar 关一）**

| 检查 | 方法 | pass 条件 |
|------|------|----------|
| 原生 `<button>` 带 className | grep 改动文件（排除 `ui/`） | 零结果或有 ARIA 豁免 |
| 原生 `<input>` 带 className | 同上 | 零结果 |
| 重复 className 组合 | 改动文件中 ≥3 token 的相同组合出现 2+ 次 | 零或已提炼组件 |

不过 → 提炼组件 → 重跑，不声明完成。

**关三：动效 & 阴影存在性验证**

> 防回归根因：Token 合规只检"合法性"（不硬编码 px），不检"正确性"（值是否与设计一致）。本关补齐存在性维度。

| 检查 | 方法 | pass 条件 |
|------|------|----------|
| 硬编码 cubic-bezier | grep `cubic-bezier` 在 tsx 文件中 | 零结果（排除 tailwind.config / CSS 变量定义 / JS 对象中与 token 值一致的 spring 缓动） |
| 非 token 缓动函数 | grep `ease-out\|ease-in-out` 在改动文件 className 中 | 零结果，或有非设计覆盖场景豁免（如 page-level fade-in 动画） |
| 阴影等级匹配 | 对照设计稿 `:hover { box-shadow }` 检查 hover shadow 类 | `shadow-hairline`↔xs, `shadow-raised`↔sm, `shadow-float`↔md, `shadow-drag`↔lg, `shadow-overlay`↔xl |
| 焦点环宽度 | 对照设计稿 `:focus-visible { box-shadow: 0 0 0 Npx }` | N=3 → `ring-[3px]`，N=2 → `ring-2`。禁止不查设计直接写 `ring-2` |
| 非 token duration | grep `duration-(100\|150\|200\|300\|500)` 在改动文件中 | 零结果，必须用 `duration-fast/base/slow` |

不过 → 修 → 重跑，不声明完成。

**三关都过 → 声明翻译完成。** 全面审计（Loop 归档 / 设计体系升级）仍需独立调用 `dao-design-fidelity` 和 `dao-component-radar` 做深度检查。

---

## §5 · 与其他 skill 的关系

交接契约见 `dao-design-system` §7。

| Skill | 关系 |
|---|---|
| `dao-design-taste` | 翻译时的视觉判据来源（§4 通用体检表） |
| `dao-code-to-prototype` | **正反互补**。本 skill 是 Design→Code，code-to-prototype 是 Code→Design。共享 `design/` 目录 |
| `dao-component-radar` | 翻译过程中自动触发，检测原生 HTML → 组件提炼 |
| `dao-verify` | 翻译完成后走涅槃门验证 |
| `dao-loop` | **双向联动**。谋线检测 design/ 时加载 §1+§1.5；造线逐页面执行 §3。见 dao-loop §4 |
| `dao-brainstorm` | OD 产出已是设计决策，brainstorm 用于澄清功能需求 |
| `dao-design-qa` | 视觉偏差修复循环——翻译后发现 UI 偏差时自动触发（截图→定位→修代码→再验证） |

---

## §A · 反模式

> 不知常妄作凶。

1. **只翻译 token 不翻译结构** — token 对齐（CSS 变量值匹配）只是一维。结构对齐（DOM 层级、布局方式）和交互对齐（状态切换）同样重要。三维必须同步，缺一则视觉偏差难免。

2. **建中间映射表** — 不要手动建"设计变量 A → 项目变量 B"的映射文档。直接对标 HTML 原型和项目代码的最终渲染效果，不需要中间抽象层。

3. **AI 自行做设计判断** — Open Design 产出与项目代码不一致时，以 Open Design 为准。AI 不应自行决定"这个颜色应该更深"或"这个间距太大"——设计决策属于设计工具，不属于编码 agent。

4. **在翻译流程中修改 design/ 目录** — 执行 design-open（Design→Code）翻译时，`design/` 是只读的设计真相源，不可改动。需要改设计时回 Open Design 重新生成。注意：`dao-code-to-prototype`（Code→Design 反向流程）有权更新 `design/` 下的文件——两个方向不会同时执行，用户是编排者。

---

## §B · 项目 rule 脚手架模板

> 各复归其根。设计精神归 rule 文件，不归会话。

**当 dao-loop 谋线 rule 检查（§4 步骤 9）检测到 design Loop 缺少 `design-spirit.md` 时，按以下模板自动创建。**

模板路径：`.claude/rules/design-spirit.md`，`paths:` 设为 `apps/*/src/**`（或项目实际前端路径）。

```markdown
---
paths:
  - "apps/*/src/**"
  - "packages/*/src/**"
---

# 设计精神（四维检查清单）

> 本文件由 dao-design-open 谋线自动创建，造线过程中持续更新。

## 视觉维度
- [ ] 所有色彩使用语义 token，禁止硬编码 hex/hsl
- [ ] 字号使用 design-tokens.md 定义的 token
- [ ] 圆角/阴影/间距使用项目 token 体系
- [ ] 亮暗双主题视觉一致

## 交互维度
- [ ] 所有可交互元素有 hover/focus/active/disabled 四态
- [ ] 动效尊重 prefers-reduced-motion
- [ ] Loading/Empty/Error 三态有设计覆盖
- [ ] 键盘可达性（Tab 序 + Enter/Escape 响应）

## 导航维度
- [ ] 页面间导航形成闭环（去得了就回得来）
- [ ] 深层页面有返回上级路径
- [ ] 导航矩阵（下方）覆盖所有页面跳转

## 无障碍维度
- [ ] 图标按钮有 aria-label
- [ ] 对话框有 aria-modal + aria-labelledby
- [ ] 进度指示有 role="progressbar" + aria-valuenow
- [ ] 状态变更有 aria-live 通知

## 组件策略判据

| 场景 | 策略 | 判断标准 |
|------|------|---------|
| 设计稿结构简单，直接翻译 | native | 无交互、无状态、无复用 |
| 项目已有组件可扩展 | extend | 增加 variant/size 即可覆盖 |
| 需要组合或添加动效 | wrap | 单个基础组件不够，需封装 |
| 全新独特交互 | custom | 无现有组件可复用 |

## 导航闭环矩阵

<!-- 造线过程中持续填写 -->
| 起点页 | 终点页 | 触发元素 | 实现状态 |
|--------|--------|---------|---------|
```

**更新时机**：
- 谋线创建（§4 步骤 9）：初始化模板
- 造线 Phase 检查点（§5）：更新导航矩阵 + 勾选已覆盖的检查项
- 归档规范同步（§7.4）：最终更新，标记未覆盖项为 deferred
