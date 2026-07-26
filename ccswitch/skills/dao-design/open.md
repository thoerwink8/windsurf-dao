---
name: open.md
description: Open Design 设计消费引擎——读取 Open Design 产出的设计资产（HTML 原型 + CSS 设计系统），翻译为生产级 React 代码，含结构提取与视觉 QA 循环。UI 任务涉及 design/ 目录时触发
---

# Open Design 消费引擎 · Design-to-Code

> 道法自然。设计已成时，代码当如水就形。

本 skill 覆盖 Open Design 的 **Design→Code** 方向：OD 产出设计资产后，忠实翻译为生产级 React 代码，含结构提取（§2.5）与视觉 QA 循环（§4.4）。

**反向（Prompt→Design）**：讨论收敛但设计稿未出时，先走 `od-prompt.md` 生成 OD 提示词 + 会话初始化指引；OD 出稿后回到本 skill 接手翻译。两者正反互补，见 §5。

**核心原则：AI 不做设计决策。** 把 OD 产出翻译为代码，不自行改设计——设计判断留给 Open Design。

**流水线位置**：Design Pipeline **Phase 1（翻译）**。上游是 `system.md`（Phase 0，基础层规则 = 翻译时的合规基线），下游是 `fidelity.md`（Phase 2，翻译完成后必须通过 L1+L2 验证）。布局决策查 `standards.md §L`。结构提取见 §2.5（已内联）。视觉 QA 循环见 §4.4。详见 `system.md` §7。

**sync 接入（完整模式）**：当 `sync.md` 以完整模式委托时，传入漂移上下文（已检测的变更文件列表 + git diff + 人话描述）。接收后可跳过：§0 格式概览（已知）、§1 全量读取（只读变更文件）、§2.5.1 变更检测（已完成）。从 §2.5.2 结构提取开始，以传入的变更文件为输入。后续流程（§3 翻译 → §4 验证 → §4.5 auto-gate）正常执行。

---

## §0 · Open Design 产出格式

Open Design 的产出是一个自包含的设计资产目录。完整目录规范见 `protocol-od.md` §工作区模型，此处列出 CLI 端关注的结构：

```
design/
├── .od-skills/           # Open Design 的设计技能（审美标准参考，只读）
├── css/<project>.css     # 共享设计系统（CSS 变量 + 组件类 + 布局原语）
├── js/<project>.js       # 共享行为（主题切换 + 持久化）
├── pages/                # 页面设计稿（对应代码路由，只读真相源）
│   └── {page}.html
├── components/           # 组件/弹窗设计稿（覆盖层，非独立页面）
│   └── {component}.html
├── ref/                  # 参考工具（不对应代码，辅助开发）
│   ├── gallery.html
│   └── component-gallery.html
├── workspaces/           # 草稿区（临时，升格后删除）
│   └── {name}/
│       ├── {page}.html   # 草稿原型
│       └── WORKSPACE.md  # 迭代目标 + source（design|code）
├── archive/              # 旧正式稿（升格时降格至此，永不删除/编辑）
│   └── {page}-{YYYYMMDD}.html
├── handoff/              # 交接包（持久保留，一次升格一个目录）
│   └── {scope}-{YYYYMMDD}/
├── CONTEXT.md            # 全局上下文（会话恢复 + 页面状态追踪）
├── CHANGELOG.md          # 升格日志（每次 promote 自动追加）
└── PROTOTYPE-SPEC.md     # 项目专属 OD 输出规范（如有）
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
2. **读 HTML**（`design/pages/*.html`）：提取 DOM 层级 + 组件使用 + 交互态 + 响应式 + 主题差异
3. **读 artifact**（`*.artifact.json`）：确认 `status: "complete"` 才翻译

---

## §1.5 · Loop 级全覆盖规划（谋线必读）

> 图难于其易，为大于其细。全局先行，不遗一页。

**当 Loop 涉及 design/ 目录的设计对齐时（由 `dao-loop` 谋线自动触发），本节提供系统化的全覆盖规划方法论，取代零散的单页翻译。**

### 1.5.0 跨页组件整合扫描

清点前先通读全部 `design/pages/*.html`，提取跨页共享的 CSS 类和 DOM 模式，建立组件复用矩阵（组件模式 | 出现页面 | 设计 CSS 类 | 项目组件 | 策略）。每个组件按 `native/extend/wrap/custom` 四级决策（判据见 `dao-project-scaffold` design-assets.md「design-spirit.md 模板」节），结果写入 strategy.md。先整合后清点，共享组件 Task 排第一梯队。

### 1.5.1 全页面清点

枚举 `design/pages/*.html` 所有页面（排除 gallery 索引页），建立清单（页面 | 设计文件 | React 对应 | 当前状态）。**铁律**：每个 html 必须出现，遗漏 = 不得进造线。

### 1.5.2 三层结构 Diff（§2.5 结构提取）

每页自顶向下：**布局层**（grid/flex 骨架、容器、导航）→ **节层**（区块结构、面板、tabs）→ **组件层**（props/样式/交互态）。只做组件层 = 遗漏结构偏差。

**执行方式**：按 §2.5 结构提取流程对每个变更的 design/pages/*.html 做结构提取，产出实施规格。规格包含 DOM 层级树、CSS→Tailwind 三列映射、约束链分析、CSS 变量变更。这些规格是 §3 Translate 的直接输入——翻译者按规格写代码，不需要"理解设计意图"。

### 1.5.3 页面维度覆盖矩阵

plan 覆盖矩阵增加 页面×层级 维度。空白且未标 `deferred` = plan 不完整。deferred 须显式标注原因，不得超过总页面 50%。

### 1.5.4 Top-Down 排序

共享结构（导航/topbar/layout shell）→ 布局层 → 节层 → 组件层 → 微调。上层先做，避免下层返工。

---

## §2 · 映射（Map）

三层映射：**Token**（OD CSS 变量 → 项目 token，项目吸收 OD 值不另建）→ **组件**（OD CSS 类 → React 组件，无对应则新建）→ **布局**（OD 布局原语 → 布局组件，窗口级包裹 `.frame`/`.titlebar` 不翻译——桌面应用有原生窗口）。

---

## §2.5 · 结构提取（Sync）

> 天下之至柔，驰骋天下之至坚。读源码不猜意图。

**AI 不该"解读"设计意图，应该"提取"设计结构。** 翻译前必须先提取结构化规格——产出的实施规格是 §3 的直接输入，翻译者按规格逐条写代码，不需要回头看设计截图"理解意图"。

跳过条件：纯文案/数据变更（无 CSS/DOM 变化）。

### 2.5.0 核心原则

1. **读 CSS 源码，不看截图猜**——`design/pages/*.html` 的 `<style>` 块和链接的 CSS 文件是精确数据源
2. **提取属性值，不描述视觉效果**——输出 `padding: 10px 26px` 而不是"增加一些内边距"
3. **映射 DOM 结构，不只映射样式**——sibling/child 关系决定布局行为（sticky vs flex）
4. **追踪约束链，不只看单个元素**——overflow-scroll 依赖从 root 到容器的完整 min-height:0 链

### 2.5.1 变更检测

**识别变更范围**：

```bash
# 设计文件变更
git diff [base]..HEAD -- design/pages/*.html design/components/*.html design/css/*.css

# 或指定文件
git diff HEAD~1 -- design/pages/workspace.html
```

**变更分类**：

| 变更类型 | 判据 | 提取深度 |
|---------|------|---------|
| 新增元素 | diff 中有新选择器或新 DOM 节点 | 完整提取（2.5.2 全流程） |
| 属性修改 | diff 中现有选择器的属性值变化 | 属性级提取（2.5.2.2） |
| 结构重组 | DOM 层级变化（父子→兄弟、拆分/合并容器） | 结构级提取（2.5.2.1 + 2.5.2.3） |
| CSS 变量重命名 | `--var-old` → `--var-new` | 全局搜索替换范围（2.5.2.4） |

### 2.5.2 结构提取（核心）

#### 2.5.2.1 DOM 层级提取

从 design HTML 源码提取元素层级关系，输出为结构树：

```
.main                          ← 对应 React: WorkspaceMain
├── .topbar                    ← 对应: TopBar (sibling, 不在滚动区内)
├── .dim-nav                   ← 对应: DimNav (sibling, 不在滚动区内)
│   ├── .dn-no                 ← badge: 维度序号
│   ├── h2                     ← 维度标题
│   └── button.next            ← 下一维度
└── .board                     ← 对应: candidate-feed (flex:1, overflow:auto)
    └── .card-list             ← 卡片列表
```

**关键输出**：每个元素的**父子/兄弟关系**（决定布局行为）、与 React 组件的**映射关系**、布局角色标注（`shrink-0` / `flex-1` / `overflow:auto` / `min-height:0`）。

#### 2.5.2.2 CSS 属性提取

从 `<style>` 块和链接 CSS 文件中，提取每个选择器的**完整属性列表**：

```
.dim-nav {
  display: flex;
  align-items: center;
  gap: 10px;                   → Tailwind: gap-[10px]
  padding: 10px 26px;          → Tailwind: px-[26px] py-[10px]
  border-bottom: 1px solid var(--color-border-soft);  → border-b border-border-soft
  background: var(--color-bg); → bg-background
  flex-shrink: 0;              → shrink-0
}
```

**输出格式**：选择器 → CSS 属性 → Tailwind 等效类名（三列对照表）。

#### 2.5.2.3 约束链分析

对于涉及滚动的布局，追踪从 root 到滚动容器的完整约束链：

```
约束链：overflow-y:auto 生效条件
──────────────────────────────────
AppShell        → h-screen, grid
├── SidePanel   → (resizable, 独立滚动)
└── MainPanel   → h-full, min-h-0 ⚠️ (必须！缺失则 flex 子级不收缩)
    └── div     → h-full, min-h-0, min-w-0, flex-col
        └── WorkspaceMain → min-h-0, flex-1, flex-col
            ├── TopBar      → shrink-0
            ├── DimNav      → shrink-0
            └── Board       → min-h-0, flex-1, overflow-y-auto ✅
```

**关键输出**：链中每一层的 `min-height` / `height` / `flex` 约束、标记缺失的必要约束（如 `min-h-0`）、标记滚动容器的位置和哪些元素在其内/外。

#### 2.5.2.4 CSS 变量变更提取

检测 CSS 变量的重命名或新增：

```
CSS 变量变更：
  --color-fg         → --fg          (重命名)
  --color-border-light → --color-border-soft (重命名)
  --radius-button    → (删除，合并到 --radius-sm)

影响范围搜索：
  grep --include="*.tsx" --include="*.css" "color-fg\b" apps/ packages/
```

### 2.5.3 输出规格

每次提取产出一份**实施规格**：

```markdown
## 实施规格：<组件名> (<design-file>)

### 1. DOM 结构
<2.5.2.1 的结构树>

### 2. CSS → Tailwind 映射
<2.5.2.2 的三列对照表>

### 3. 约束链
<2.5.2.3 的约束链（仅涉及滚动时）>

### 4. CSS 变量变更
<2.5.2.4 的变更列表（仅有变更时）>

### 5. 验证检查点
- [ ] <从结构中推导的关键检查点>
- [ ] <例：dim-nav 是 board 的 sibling 不是 child>
- [ ] <例：MainPanel div 有 min-h-0>
```

**消费方式**：

| 消费者 | 如何使用 |
|--------|---------|
| §3 翻译 | 直接按规格写代码，不需要"理解设计意图" |
| `dao-loop` 造线 worker | 规格作为 Task 的输入 spec |
| `fidelity.md` L2 | 验证检查点用于结构验证 |
| 人工 review | 规格即 diff 说明，reviewer 可逐条对照 |

### 2.5.4 提取流程

**前置：读取项目 Token 映射**

提取前先读项目的 token 配置（CSS 变量 → Tailwind 类名映射）：`index.css`（CSS 变量定义）+ `tailwind.config.*`（自定义 theme extend）+ `.claude/rules/design-tokens.md`（如有）。

**Diff 驱动提取**（增量）：git diff 获取变更范围 → 对变更的每个选择器提取完整 CSS 属性（不只是 diff 行）并映射 Tailwind → 对变更的 DOM 结构提取前后层级对比 → 涉及滚动的追踪完整约束链 → 对 CSS 变量变更列出所有引用位置 → 组装实施规格。

**全量提取**（新页面/首次对齐）：读取页面完整 `<style>` 块 + 链接 CSS → 逐选择器提取 CSS 属性并映射 → 提取完整 DOM 结构树 → 分析所有约束链 → 组装实施规格。

---

## §3 · 翻译（Translate）

逐页面三维对齐，忠实翻译不加不减。**输入：§2.5 产出的结构化实施规格。**

### 3.1 结构对齐

对标实施规格的 DOM 层级树。常见偏差：嵌套层数不匹配→补容器，Grid/Flex 不一致→以设计为准，窗口包裹→桌面应用跳过。**sibling/child 关系是结构对齐的核心——两者视觉可能相似但行为不同（sticky vs flex shrink-0）。**

### 3.2 视觉对齐

对标实施规格的 CSS→Tailwind 映射表，逐属性写入 className。优先用项目 token，不覆盖时建新 token。**禁止硬编码**像素值或 hex 色值。

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

1. 在浏览器中打开 `design/pages/*.html`（Open Design 原型）
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

### 4.4.1 设计工具先行路径（有 MCP 时）

> 反者道之动。直接改代码是症状修复，设计工具修是根因修复。

当有设计工具 MCP（Penpot / Figma）且偏差涉及设计决策（不只是代码实现错误）时：

1. **在设计工具中定位对应页面/组件**
2. **在设计工具中修复**：修前截图 → 实施修改 → 修后截图确认改进。用 Library Component / token，不硬编码
3. **回填代码**：优先改 token/CSS 变量 → 其次改 ui/ 共享组件 → 最后改业务层
4. **验证三关**：测试套件 + 类型检查 + 截图对齐。改亮必查暗

**何时走此路径 vs 直接改代码**：
- 偏差是设计决策问题（颜色/间距/布局方向不对）→ 设计工具先行
- 偏差是代码实现问题（组件用错/props 漏传）→ 直接改代码
- 无设计工具 MCP → 直接改代码

截图存放路径：`<项目根>/_tmp/qa/design-qa/`，命名格式：`<type>-<description>.png`

### 4.5 收尾自检（auto-gate）

> 慎终如始。翻译完成 ≠ 声明完成。以下两关在 §4.4 退出后**自动执行**，不需用户手动调用 fidelity 或 radar skill。

**关一：Token 合规（来自 fidelity.md L1）**

| 检查 | 方法 | pass 条件 |
|------|------|----------|
| 硬编码字号 | grep `text-\[` 在改动文件范围内 | 零结果 |
| 硬编码色值 | grep `#[0-9a-fA-F]` 在 tsx 文件中 | 零结果（排除注释和 SVG） |
| 硬编码圆角 | grep `rounded-\[` 在改动文件范围内 | 零结果 |

不过 → 修 → 重跑，不声明完成。

**关二：组件健康（来自 component-radar.md 关一）**

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

**三关都过 → 声明翻译完成。** 全面审计（Loop 归档 / 设计体系升级）仍需独立调用 `fidelity.md` 和 `component-radar.md` 做深度检查。

---

## §5 · 与其他 skill 的关系

交接契约见 `system.md` §7。

| Skill | 关系 |
|---|---|
| `od-prompt.md` | **正反互补 + 上游生产者**。讨论收敛但设计稿未出时先走 od-prompt.md 生成 OD 提示词；OD 出稿后回到本 skill 执行 Design→Code |
| `standards.md` | 翻译时的视觉判据来源（§4 通用体检表）+ 布局策略（§L） |
| `asset.md` | **正反互补**。本 skill 是 Design→Code，asset 的反向生成是 Code→Design。共享 `design/` 目录 |
| `component-radar.md` | 翻译过程中自动触发，检测原生 HTML → 组件提炼 |
| `dao-verify` | 翻译完成后走涅槃门验证 |
| `dao-loop` | **双向联动**。谋线检测 design/ 时加载 §1+§1.5；造线逐页面执行 §3。见 dao-loop §4 |
| `dao-brainstorm` | OD 产出已是设计决策，brainstorm 用于澄清功能需求 |
| `sync.md` | **快捷入口**。sync 完整模式委托本 skill 执行 Design→Code，传入漂移上下文跳过前置扫描 |

---

## §A · 反模式

> 不知常妄作凶。

1. **只翻译 token 不翻译结构** — token 对齐（CSS 变量值匹配）只是一维。结构对齐（DOM 层级、布局方式）和交互对齐（状态切换）同样重要。三维必须同步，缺一则视觉偏差难免。

2. **建中间映射表** — 不要手动建"设计变量 A → 项目变量 B"的映射文档。直接对标 HTML 原型和项目代码的最终渲染效果，不需要中间抽象层。

3. **AI 自行做设计判断** — Open Design 产出与项目代码不一致时，以 Open Design 为准。AI 不应自行决定"这个颜色应该更深"或"这个间距太大"——设计决策属于设计工具，不属于编码 agent。

4. **在翻译流程中修改 design/ 目录** — 执行 design-open（Design→Code）翻译时，`design/` 是只读的设计真相源，不可改动。需要改设计时回 Open Design 重新生成。注意：`asset.md`（Code→Design 反向流程）有权更新 `design/` 下的文件——两个方向不会同时执行，用户是编排者。

5. **只读 diff 行不读完整选择器** — CSS 属性有上下文依赖（`display:flex` + `gap` 组合），只看变更行会丢失组合语义。结构提取时必须提取选择器的全部属性。

6. **跳过约束链分析** — 单个元素的 `overflow:auto` 写对了也不滚动，因为父级缺 `min-height:0`。涉及滚动的翻译必须追踪完整约束链。

---

## §B · 项目 rule 脚手架模板（已迁移）

> 各复归其根。设计精神归 rule 文件，不归会话。

原 §B「项目 rule 脚手架模板」（design-spirit.md 自动创建模板）已迁移至 `dao-project-scaffold` skill 的 `design-assets.md`「design-spirit.md 模板」节——该模板服务的是项目脚手架场景（dao-loop 谋线 rule 检查触发创建），归属 scaffold 家族比归属本消费引擎更贴切。触发条件、模板内容、更新时机均原样保留，见该文件。
