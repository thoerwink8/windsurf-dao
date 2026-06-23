---
name: dao-design-open
description: Open Design 设计消费引擎——读取 Open Design 产出的设计资产（HTML 原型 + CSS 设计系统），翻译为生产级 React 代码，三维对齐验证。UI 任务涉及 design/ 目录时触发
---

# Open Design 消费引擎 · Design-to-Code

> 道法自然。设计已成，代码当如水就形。

本 skill 定义以 **Open Design (open-design.ai)** 产出为唯一设计真相源、AI 忠实翻译为生产代码的标准流程。

**核心原则：AI 不做设计决策，只做设计翻译。** Open Design 已完成所有设计判断（色彩、字体、圆角、间距、布局、交互态、组件形态），AI 的职责是将 HTML 原型 **结构性地** 翻译为 React 组件，不是只翻译 CSS token。

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

### 3.3 交互对齐

对标 HTML 原型的 hover / focus / disabled / active 状态。

**注意**：HTML 原型的交互态通常写在 CSS 里（`:hover`、`:focus-visible`），项目组件可能用 variant 系统或框架 state modifier。只要视觉效果一致即可，实现方式可以不同。

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
