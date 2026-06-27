---
name: open.md
description: Open Design 设计消费引擎——读取 Open Design 产出的设计资产（HTML 原型 + CSS 设计系统），翻译为生产级 React 代码，含结构提取与视觉 QA 循环。UI 任务涉及 design/ 目录时触发
---

# Open Design 双向引擎 · Prompt-to-Design + Design-to-Code

> 道法自然。未有设计时，以追问凝形；设计已成时，代码当如水就形。

本 skill 覆盖 Open Design 的**双向流程**：
- **§P · Prompt→Design**：讨论收敛后，生成 OD 提示词 + 会话初始化指引，帮用户在 OD 中出设计稿
- **§0~§5 · Design→Code**：OD 产出设计资产后，忠实翻译为生产级 React 代码

**核心原则：AI 不做设计决策。** 向上（§P）把讨论结论翻译为 OD 提示词，由 OD 做视觉判断；向下（§0~§5）把 OD 产出翻译为代码，不自行改设计。

**流水线位置**：Design Pipeline **Phase 1（翻译）**。上游是 `system.md`（Phase 0，基础层规则 = 翻译时的合规基线），下游是 `fidelity.md`（Phase 2，翻译完成后必须通过 L1+L2 验证）。布局决策查 `standards.md §L`。结构提取见 §2.5（已内联）。视觉 QA 循环见 §4.4。详见 `system.md` §7。

**sync 接入（完整模式）**：当 `sync.md` 以完整模式委托时，传入漂移上下文（已检测的变更文件列表 + git diff + 人话描述）。接收后可跳过：§0 格式概览（已知）、§1 全量读取（只读变更文件）、§2.5.1 变更检测（已完成）。从 §2.5.2 结构提取开始，以传入的变更文件为输入。后续流程（§3 翻译 → §4 验证 → §4.5 auto-gate）正常执行。

---

## §P · OD 提示词生成（Prompt→Design）

> 图难于其易。讨论收敛了，设计还没形，补这一程。

**触发条件**：讨论中三个信号同时满足时，AI 主动建议出设计稿（询问用户确认后执行）：
1. 有了确定的 UI/交互变更（具体的交互决策，不是概念讨论）
2. 用户确认了方向（"对"/"方向对了"/"就这么做"）
3. 变更涉及视觉组件（新组件/新布局/新交互模式）

### §P.0 基线同步 + 草稿区建立（强制前置）

> Code-first, sync before change. 代码是真相源，设计稿可能落后。

**生成 OD 提示词之前，必须完成两件事：确认基线一致 + 建立草稿工作区。**

#### 基线同步

代码领先于设计稿时，OD 基于过时基线产出的新设计会引入结构冲突。

1. 检查涉及的 `design/*.html` 页面是否与当前代码实现一致（快速对比 DOM 结构和关键组件）
2. 如有漂移 → 调用 `asset.md` 反向生成将代码现状同步回 `design/*.html`
3. 同步完成后进入下一步

跳过条件：全新页面（`design/` 中不存在对应文件，无漂移可言）。

#### 草稿区建立（worktree）

**OD 产出不直接落正式稿，必须走 `asset.md` §B.0 的 worktree 机制。**

1. 创建工作区目录 `design/workspaces/{name}/`（`{name}` 按功能命名，如 `round-regen`）
2. 修改已有页面 → 复制正式稿到工作区作为 OD 编辑起点：`design/workspaces/{name}/{page}.html`
3. 全新页面 → 工作区内从零创建，无需复制

这一步确保 Part A 的参考资产指向工作区副本，Part B 的输出落工作区，正式稿不被触碰。升格由 `asset.md` §B 在 OD 产出验收后执行。

### §P.1 产出结构

AI 产出一份 OD 提示词文档（写入 `docs/specs/od-prompt-<topic>.md`），包含两个部分：

**Part A · OD 会话初始化指引**（给用户操作的步骤）

```markdown
## OD 会话初始化

0. 先建工作区草稿目录（worktree）
在项目中创建：`design/workspaces/{name}/`
把当前基准复制进去作为起点：`design/workspaces/{name}/{page}.html`
本次产出全部落在 `workspaces/{name}/` 草稿区，定稿后再按 asset.md §B 升格到 `design/` 根目录，不直接改正式稿。

1. 在 Open Design 中打开项目会话
2. 点击左下角「选择工作目录」→ 选择 `<项目根>/design`
3. 将以下文件拖到右侧「设计文件」面板作为参考资产：

| 文件 | 用途 |
|------|------|
| `css/<project>.css` | 设计系统 token（必须） |
| `workspaces/{name}/{page}.html` | 当前修改基准（已复制的副本） |
| `<相关页面>.html` | 需要视觉一致的相关页面（按需） |

4. 将下方「Part B · 设计提示词」的内容粘贴到 OD 输入框，发送
```

**Part B · 设计提示词**（粘贴给 OD AI 的内容）

提示词模板（AI 根据具体任务填充）：

```
你要为 <项目名> 设计 <什么>。<项目名> 是 <一句话产品定位>。

## 设计系统

沿用工作目录中的设计系统（`css/<project>.css`）。不要自创 token，所有色彩/字号/圆角/间距/动效使用 CSS 中已定义的变量。双主题（data-theme="light|dark"）。

## 要设计什么

<具体的设计需求描述——从讨论结论中提炼>

## 参考

<如果右侧有参考文件> 参考已有的 <页面名>.html 保持视觉一致。
<具体哪些元素要保持一致>

## 示例数据

<用于填充设计稿的示例内容>

## 输出

在工作区 `workspaces/{name}/` 中修改 `{page}.html`，与现有设计文件格式一致（自包含、可独立浏览、亮暗双主题）。

完成后在同目录创建 WORKSPACE.md：
```yaml
---
started: YYYY-MM-DD
page: {page}
scope: {一句话描述}
source: design
---
```
```markdown
## 本次迭代目标
## 受影响页面
## 完成标志（升格条件）
- [ ] ...
```
```

### §P.2 文件扫描

生成提示词前，**自动扫描** `design/` 目录：

1. `Glob design/css/*.css` — 找到设计系统 CSS 文件名
2. `Glob design/*.html` — 列出所有现有页面
3. 判断哪些页面与当前任务相关（要修改的页面 + 视觉上下文页面）
4. 写入 Part A 的文件清单

### §P.3 提示词必含要素

每次生成的 OD 提示词必须包含以下七个部分（缺一不可）：

1. **文件加载指令**：告诉 OD 从工作目录读取哪些文件（CSS token + 工作区副本 + 相关参考页面）
2. **设计需求描述**：要设计什么、新旧差异、具体交互细节、示例数据
3. **讨论口**：提示词末尾加一句"如果有任何不清楚的地方先讨论，不要猜测后直接画"，给 OD 留提问空间
4. **实施交接指令**：要求 OD 设计完成后额外输出一段实施交接提示词（变更摘要、CSS 类、DOM 结构、组件映射、交互行为、注意事项），用于粘贴回编码 AI
5. **工作区指令**：产出必须落 `workspaces/{name}/` 草稿区 + 生成 WORKSPACE.md，不直接改正式稿。升格由 `asset.md` §B 负责
6. **自包含性要求**：workspace HTML 是自包含文件，不链接外部 CSS。OD 读取设计系统 CSS 后必须把所有用到的 token 定义也写入 workspace HTML 的 `:root`，不得只引用 `var(--*)` 而不补全定义。提示词中须显式加一句："workspace HTML 是自包含文件，所有 CSS 变量须在 `:root` 中定义，不依赖外部样式表。读取项目设计系统 CSS，把所有用到的 token 按分类（字号、字体、颜色与前景色、圆角、间距、动效、阴影）逐类写入 `:root`，不漏分类。" **验收**：§P.7 关一自动覆盖此项
7. **锚点重置原则**：`<a>` 元素作为交互控件（按钮、导航项等）使用时，其 CSS 样式类必须显式重置浏览器对锚点的默认装饰（下划线、字体颜色继承等），不可依赖浏览器默认行为。提示词中加一句："用作交互控件的 `<a>` 元素，CSS 须显式重置浏览器默认锚点装饰。" **验收**：§P.7 关四自动覆盖此项

### §P.4 不做的事

- 不替代 OD 做视觉判断——提示词描述"什么"和"约束"，不描述"怎么画"
- 不在提示词中硬编码 CSS 属性值——只引用 token 名，具体值由 OD 从 CSS 文件读取
- 不把流程拆成"第一步/第二步"给用户——产出是一段完整的提示词，用户复制粘贴到 OD 即可
- 不假设 OD 会话已有上下文——每次都包含完整的文件加载指令
- 不让 OD 直接输出到 `design/{page}.html` 正式稿——产出落草稿区 `workspaces/{name}/`，升格由 `asset.md` §B 负责

### §P.5 · workspace 验收后的强制交付物（HANDOFF.md）

> 太上不知有之。设计完了不写交接文档，等于没有交付最后一公里。

**触发条件**：OD 产出 workspace.html 并完成渲染验收（WORKSPACE.md checklist 全部打勾）后，立即执行本节。

**强制动作**：在 `design/workspaces/{name}/HANDOFF.md` 写入六节工程实施交接文档。

**禁止行为**：
- ❌ 只在回复文字里输出六节内容（用户无法直接转发给工程师）
- ❌ 询问"是否需要存成文件"（必须直接写，不经询问）
- ❌ 把交接内容混在验收截图日志里（必须是独立文件）
- ❌ 声明"设计完成"而未写 HANDOFF.md

**HANDOFF.md 六节结构**（缺一不可）：

| 节 | 标题 | 内容要点 |
|---|---|---|
| 1 | 变更摘要 | 一段话说清做了什么、核心技术决策（工程师看完即知意图） |
| 2 | 新增 CSS 类 | 表格：类名 + 作用说明 |
| 3 | DOM 变更 | 代码块：新增/修改的 HTML 骨架，可直接粘贴 |
| 4 | 组件映射 | 表格：UI 元素 → 实现方式（图标组件/原生元素/UI 组件名） |
| 5 | 交互说明 | 代码块：状态机触发路径 + CSS 联动规则 |
| 6 | 注意事项 & 备注 | Token 升格待办、兼容性边界、数据绑定说明、原型专用元素（需在生产删除） |

**写完后告知用户**：
```
HANDOFF.md 已写入 `design/workspaces/{name}/HANDOFF.md`，可直接交工程师实施。
```

**OD 无法生成时的降级处理**：若 OD BYOK 未配置无法由 OD 自动输出交接提示词，AI 根据 workspace.html 源码自行构造六节内容写入文件，不跳过本步骤。

### §P.6 · 设计文件同步到 OD 面板（强制，与 §P.5 并行）

> 各复归其根。OD Design Files 面板只显示 `$CWD`（Claude Code 当前工作目录 = OD 项目数据目录），不显示通过 Junction 或绝对路径写入代码仓的文件。不同步则设计稿对用户不可见，等同于没有交付。

**两个空间必须区分**：

| 空间 | 路径特征 | OD 面板可见 |
|---|---|---|
| OD 项目数据目录 | Claude Code `$PWD` / Write 工具默认工作目录 | ✅ 可见 |
| 外部代码仓设计目录 | 通过 Junction 或绝对路径写入的外部路径 | ❌ 不可见 |

**触发条件**：每次写入或更新 workspace HTML（无论使用绝对路径还是 Junction 路径）后，立即执行。

**强制动作**：将外部代码仓的 workspace HTML 复制到 Claude Code `$PWD`（OD 项目目录）的镜像相对路径 `workspaces/{name}/{page}.html`，使两份副本结构对称——代码仓副本供 git 追踪与升格，OD 项目副本供面板可见。具体复制命令用当前平台的文件工具执行（不在本 skill 固化）。

执行后在回复中告知：`workspace.html 已同步到 OD 设计文件面板（workspaces/{name}/）`

**为什么截图可见但 HTML 不可见**：Playwright 截图 `filename` 使用相对路径，落到 `qa/`（相对 `$PWD`），故面板可见。HTML 若用绝对路径写到外部代码仓，面板则不可见。规律：**凡需在面板中可见的文件，必须有一份写到 `$PWD` 相对路径下。**

**禁止行为**：
- ❌ 只写外部代码仓副本，不同步到 `$PWD`
- ❌ 声明"设计稿已完成"或"截图验证通过"而面板里看不到 HTML 本体
- ❌ 以截图可见等同于设计文件可见（截图是验证产物，HTML 才是设计文件本体）

### §P.7 · Workspace HTML 代码质量门（强制，§P.5/§P.6 之后、声明完成之前）

> 未验不声明。视觉截图验"像素"，本节验"代码合规"——两者独立，缺一不可。

**触发条件**：OD 产出或修改 workspace HTML 后，声明"设计完成"之前，必须执行本节。

**四关顺序执行**（任一不过，修 workspace.html 后重检，不得声明完成）：

| 关 | 检查项 | Pass 条件 |
|---|---|---|
| 一 | **变量自包含**：读 workspace.html，提取所有 `var(--*)` 引用名与 `:root` 定义名，求差集 | 差集为空——所有被引用的 token 在 `:root` 中有定义 |
| 二 | **无硬编码字号**：在 workspace.html CSS 区域搜索 `font-size` 后直接接数字单位的写法 | 零结果——所有字号通过 token 引用 |
| 三 | **无硬编码颜色**：在 `<style>` 块内搜索颜色字面量写法（排除注释） | 零结果——所有颜色通过 token 引用 |
| 四 | **锚点重置**：找出带 `class` 属性的 `<a>` 元素，检查其匹配 CSS 规则是否显式重置了浏览器默认锚点装饰 | 每个带样式类的 `<a>` 对应 CSS 规则已完成重置 |

**修复后同步铁律**：本节发现问题并修复后，必须同步到 workspace HTML 的所有副本（OD 项目数据目录副本 + 外部代码仓副本），两份内容必须一致。

**禁止行为**：
- ❌ 以"视觉截图正常"代替本节检查
- ❌ 发现问题标记"待优化"跳过本节
- ❌ 只修一份副本，另一份留旧内容

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

### 1.5.2 三层结构 Diff（§2.5 结构提取）

每页自顶向下：**布局层**（grid/flex 骨架、容器、导航）→ **节层**（区块结构、面板、tabs）→ **组件层**（props/样式/交互态）。只做组件层 = 遗漏结构偏差。

**执行方式**：按 §2.5 结构提取流程对每个变更的 design/*.html 做结构提取，产出实施规格。规格包含 DOM 层级树、CSS→Tailwind 三列映射、约束链分析、CSS 变量变更。这些规格是 §3 Translate 的直接输入——翻译者按规格写代码，不需要"理解设计意图"。

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

1. **读 CSS 源码，不看截图猜**——`design/*.html` 的 `<style>` 块和链接的 CSS 文件是精确数据源
2. **提取属性值，不描述视觉效果**——输出 `padding: 10px 26px` 而不是"增加一些内边距"
3. **映射 DOM 结构，不只映射样式**——sibling/child 关系决定布局行为（sticky vs flex）
4. **追踪约束链，不只看单个元素**——overflow-scroll 依赖从 root 到容器的完整 min-height:0 链

### 2.5.1 变更检测

**识别变更范围**：

```bash
# 设计文件变更
git diff [base]..HEAD -- design/*.html design/css/*.css

# 或指定文件
git diff HEAD~1 -- design/workspace.html
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

> 本文件由 open.md 谋线自动创建，造线过程中持续更新。

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
