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

### 1.1 读设计系统 CSS

读 `design/css/<project>.css`，提取：

| 维度 | 提取内容 |
|---|---|
| 色彩 token | 所有 CSS 变量名 + 值（亮色 + 暗色），按语义分组 |
| 字体 | `--font-ui` / `--font-body` / `--font-mono` 的字体栈 |
| 圆角 | `--r-xs` ~ `--r-pill` 的值和语义 |
| 阴影 | `--shadow` / `--shadow-pop` 等层级 |
| 动画 | `--ease` / `--t-fast` / `--t-base` 的值 |
| 组件模式 | 有哪些 CSS 类，各自的尺寸/间距/行为 |
| 布局 | 主布局用 grid 还是 flex，侧栏宽度，主区域结构 |

### 1.2 读 HTML 原型

对目标页面读对应的 `design/*.html`，提取：

| 维度 | 提取内容 |
|---|---|
| DOM 结构 | 容器嵌套层级、grid/flex 布局方式 |
| 组件使用 | 用了哪些 CSS 组件类、组合方式 |
| 内容结构 | 标题/正文/标签/按钮的层级关系 |
| 交互态 | hover/active/focus/disabled 的 CSS 规则 |
| 响应式 | 有无 media query，断点值 |
| 主题差异 | 亮暗模式下的视觉差异 |

### 1.3 读 artifact 元数据

读 `*.artifact.json`，确认页面状态（`complete` vs 进行中）和最后更新时间。只对 `status: "complete"` 的页面做翻译。

---

## §1.5 · Loop 级全覆盖规划（谋线必读）

> 图难于其易，为大于其细。全局先行，不遗一页。

**当 Loop 涉及 design/ 目录的设计对齐时（由 `dao-loop` 谋线自动触发），本节提供系统化的全覆盖规划方法论，取代零散的单页翻译。**

### 1.5.0 跨页组件整合扫描

> 上善若水——先看全局水流，再看每条支流。

**在 1.5.1 全页面清点之前**，先做跨页面维度的组件整合分析。这一步捕捉的是「神」——不是单页像素，而是跨页面共享的交互模式和组件复用机会。

**步骤**：

1. **通读全部 `design/*.html`**，提取所有页面共同使用的 CSS 类和 DOM 模式
2. **建立组件复用矩阵**：

```
| 组件模式 | 出现页面 | 设计 CSS 类 | 项目组件 | 策略 |
|---------|---------|------------|---------|------|
| 顶栏导航 | 全部 | .topbar | — | custom |
| Tab 切换 | 3 页 | .tabs .tab | Tabs.tsx | extend |
| 池状态条 | 2 页 | .pool-bar | — | wrap |
```

3. **包装决策矩阵**：对每个组件决定策略级别：

| 策略 | 判据 | 示例 |
|------|------|------|
| `native` | 设计稿结构简单，直接用 HTML/CSS 翻译 | 静态信息展示区 |
| `extend` | 项目已有基础组件，扩展 variant 即可 | Button 增加 icon-only variant |
| `wrap` | 需要二次封装（组合多个基础组件 / 添加动效 / 封装复合交互） | 带动画的 Popover |
| `custom` | 项目无对应组件，设计稿有独特交互 | 拖拽排序池 |

4. **将决策写入 strategy.md 的「组件策略」段**

**为什么在清点前做**：如果先清点页面再逐页分析，跨页共享的组件会在每个页面被当作"新发现"重复处理，浪费 Task 粒度。先整合后清点，plan 中的共享组件 Task 天然排在第一梯队。

### 1.5.1 全页面清点

枚举 `design/*.html` 中**所有**页面（排除 `gallery.html` 索引页和纯组件展示页），建立完整清单：

```
| # | 页面 | 设计文件 | React 对应 | 当前状态 |
|---|------|---------|-----------|---------|
| 1 | 首页 | index.html | Home.tsx | ❌ 未对齐 |
| 2 | 工作区 | workspace.html | BrainstormView | ⚠️ 部分对齐 |
| … | … | … | … | … |
```

**铁律**：每一个 `design/*.html` 必须出现在清单中。遗漏 = spec 不完整 = 不得进入造线。

### 1.5.2 三层结构 Diff（每页必做）

对清单中**每一个页面**执行从粗到细的三层对比：

| 层级 | 对比内容 | 典型发现 |
|------|---------|---------|
| **布局层** | 整页 grid/flex 骨架、容器数量、列数、rail 有无、导航系统 | 页面完全缺失、导航缺失、布局列数不对 |
| **节层** | 各内容区块的结构（header/body/footer、面板分组、tabs、topbar） | 区块遗漏、顺序错误、功能区缺失 |
| **组件层** | 具体组件的 props/样式/尺寸/间距/色彩/交互态 | token 不对、字号偏差、圆角不匹配 |

**反模式**：只做组件层 diff 就写 plan → 遗漏整页/整节结构偏差。三层必须自顶向下全做。

### 1.5.3 页面维度覆盖矩阵

plan.md 的覆盖矩阵必须包含**页面 × 层级**维度：

```
| 页面 | 布局层 Task | 节层 Task | 组件层 Task | 状态 |
|------|-----------|----------|-----------|------|
| workspace.html | T01 | T02, T03 | T04, T05 | 覆盖 |
| overview.html | T06 | T07 | T08 | 覆盖 |
| index.html | — | — | — | deferred(下一 Loop) |
```

**铁律**：
- 任何页面的三层中有空白且未标 `deferred` = plan 不完整，不得进入造线
- `deferred` 必须显式标注并说明原因（优先级/依赖），禁止悄悄跳过
- 一个 Loop 内 `deferred` 不得超过总页面数的 50%——超过说明 Loop 范围定义不合理

### 1.5.4 任务排序原则（Top-Down）

任务必须遵循从共享到局部、从粗到细的顺序：

```
第一梯队：跨页共享结构（导航系统、topbar、layout shell、侧栏）
    ↓
第二梯队：各页面布局层对齐（grid 骨架、容器结构）
    ↓
第三梯队：各页面节层对齐（内容区块、面板、功能区）
    ↓
第四梯队：各页面组件层对齐（具体组件 props/样式）
    ↓
第五梯队：微调（间距/字号/颜色精修）
```

**理由**：共享结构（如 tab 导航）影响所有页面；先做布局层再做组件层，避免上层变更导致下层返工。

---

## §2 · 映射（Map）

> 各复归其根。CSS 类归 React 组件，结构归 JSX。

将 Open Design 的 CSS 设计系统映射到项目的 React 组件体系。

### 2.1 Token 映射

Open Design CSS 变量 → 项目的 CSS 变量 / 框架 token。

**原则**：项目的样式系统应该 **吸收** Open Design 的 token 值，而非另建一套。当两边变量名不同时，以 Open Design 的语义为准，在项目侧建别名。

### 2.2 组件映射

Open Design 的 CSS 类 → 项目的 UI 组件。逐一建立对照表：

```
示例（具体映射由项目决定）：
.btn-primary   → 项目的主按钮组件
.badge.*       → 项目的状态标签组件
.input         → 项目的输入组件
.dialog        → 项目的对话框组件
```

**若项目侧无对应组件**：需要新建——从 HTML 原型提取样式 → 建 variant 系统 → 补测试。

### 2.3 布局映射

Open Design 的布局原语 → 项目的布局组件。

```
示例：
.app { grid-template-columns: Npx 1fr }   → 主布局壳的 grid 结构
.side { ... }                              → 侧栏组件
.main { ... }                              → 主内容区组件
```

**窗口级包裹**（`.frame` / `.titlebar` 等）：Open Design 用 HTML 模拟桌面窗口外观，实际桌面应用（Tauri/Electron）有原生窗口——这层不翻译。

---

## §3 · 翻译（Translate）

> 道常无为而无不为。忠实翻译，不加不减。

逐页面执行三维对齐。

### 3.1 结构对齐

对标 HTML 原型的 DOM 层级，确保 React JSX 有对应的容器结构。

**常见偏差**：
- HTML 原型有 3 层嵌套，项目只有 1 层 → 补容器
- HTML 原型用 CSS Grid，项目用 Flex → 改为 Grid（以设计为准）
- HTML 原型有窗口级包裹（`.frame` / `.titlebar`）→ 桌面应用有原生窗口，跳过这层

### 3.2 视觉对齐

对标 CSS 值，确保字号/色彩/圆角/间距/阴影一致。

**原则**：
- 优先用项目已有的 token 系统（CSS 变量 / 框架 utility class）
- 项目 token 不覆盖时，用 `design/css/` 的精确值建新 token
- **禁止硬编码**：不用内联像素值或 hex 色值，必须走 token

### 3.3 交互对齐（三层）

> 形而下者谓之器，形而上者谓之道。交互是设计之神，不止于 hover 色。

#### 3.3.1 状态层

对标 HTML 原型的 hover / focus / disabled / active / loading / empty / error 状态。

| 状态类型 | 检查内容 | 常见遗漏 |
|---------|---------|---------|
| 交互态 | `:hover`、`:focus-visible`、`:active`、`:disabled` | focus ring 缺失 |
| 数据态 | empty state、loading skeleton、error fallback | 只做了 happy path |
| 组合态 | disabled + hover（不应变色）、loading + click（不应触发） | 态叠加逻辑缺失 |

**注意**：HTML 原型的交互态通常写在 CSS 里，项目组件可能用 variant 系统或框架 state modifier。只要视觉效果一致即可，实现方式可以不同。

#### 3.3.2 动效层

对标 HTML 原型中的 CSS transition / animation / keyframes。

| 动效类型 | 检查内容 |
|---------|---------|
| 微交互 | 按钮点击反馈、hover 渐变、focus 过渡 |
| 转场 | 页面/视图切换动画、面板展开/收起 |
| 反馈 | loading 旋转、进度动画、toast 滑入 |

**shadcn/ui 动效边界**：若设计稿动效超出 shadcn 原生能力（如弹簧物理曲线、复杂序列动画），strategy.md 中应标记为 `wrap` 策略并记录二次封装方案。

**无障碍**：所有动效必须尊重 `prefers-reduced-motion: reduce`。

#### 3.3.3 导航层

对标 HTML 原型的页面间导航关系，确保导航闭环。

| 检查维度 | 内容 |
|---------|------|
| 导航入口 | 每个页面的所有可点击导航元素（link/button/tab）→ 目标页面 |
| 导航闭环 | A→B 有路径，B→A 也有路径（或有合理的返回机制） |
| 面包屑/后退 | 深层页面有返回上级的路径 |
| 404/空态 | 导航到不存在内容时的 fallback |

**导航矩阵**（写入项目 rule 文件 `design-spirit.md`）：

```
| 起点页 | 终点页 | 触发元素 | 实现状态 |
|--------|--------|---------|---------|
| index | workspace | 项目卡片点击 | ✅ |
| workspace | overview | Tab 切换 | ✅ |
| overview | history | "完整历史→"链接 | ✅ |
```

### 3.4 批量翻译策略

多个页面需要翻译时，按影响面从大到小排序：
1. 共享组件（改一处影响所有页面）
2. 核心交互页（用户使用最频繁）
3. 辅助页面

每翻译完一个页面：`typecheck + test` 验证无回归。

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

**两关都过 → 声明翻译完成。** 全面审计（Loop 归档 / 设计体系升级）仍需独立调用 `dao-design-fidelity` 和 `dao-component-radar` 做深度检查。

---

## §5 · 与其他 skill 的关系

| Skill | 关系 |
|---|---|
| `dao-code-to-prototype` | **正反互补**。本 skill 是 Design→Code（消费原型），code-to-prototype 是 Code→Design（还原原型）。共享 `design/` 目录，用户编排切换方向 |
| `dao-component-radar` | 翻译过程中自动触发，检测原生 HTML → 组件提炼 |
| `dao-verify` | 翻译完成后走涅槃门验证 |
| `dao-loop` | **双向联动**。dao-loop 谋线检测到 design/ 时自动加载本 skill §1 + §1.5；造线逐页面执行 §3 翻译。见 dao-loop §4「设计对齐增强」 |
| `dao-brainstorm` | Open Design 产出已是设计决策，brainstorm 用于澄清功能需求而非设计需求 |

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

**当 dao-loop 谋线 rule 检查（§4 步骤 8）检测到 design Loop 缺少 `design-spirit.md` 时，按以下模板自动创建。**

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
- 谋线创建（§4 步骤 8）：初始化模板
- 造线 Phase 检查点（§5）：更新导航矩阵 + 勾选已覆盖的检查项
- 归档规范同步（§7.4）：最终更新，标记未覆盖项为 deferred
