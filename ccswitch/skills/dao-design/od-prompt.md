---
name: od-prompt.md
description: OD 提示词生成器——讨论收敛后，把交互决策翻译为 Open Design 会话提示词 + 会话初始化指引，帮用户在 OD 中出设计稿（Prompt→Design 单向）。UI 讨论收敛但设计稿未出时触发
---

# OD 提示词生成 · Prompt-to-Design

> 道法自然。未有设计时，以追问凝形。

本 skill 覆盖 Open Design 流程中的 **Prompt→Design** 方向：讨论收敛后，生成 OD 提示词 + 会话初始化指引，帮用户在 OD 中出设计稿。

**核心原则：AI 不做设计决策。** 把讨论结论翻译为 OD 提示词，由 OD 做视觉判断。

**流水线位置**：本 skill 的产出交给用户带去 Open Design 会话；OD 出稿后由 `open.md`（Design→Code 消费引擎，Design Pipeline Phase 1）接手翻译为生产代码。两者正反互补，详见 `open.md` §5 与 `system.md` §7。

---

> 图难于其易。讨论收敛了，设计还没形，补这一程。

**触发条件**：讨论中三个信号同时满足时，AI 主动建议出设计稿（询问用户确认后执行）：
1. 有了确定的 UI/交互变更（具体的交互决策，不是概念讨论）
2. 用户确认了方向（"对"/"方向对了"/"就这么做"）
3. 变更涉及视觉组件（新组件/新布局/新交互模式）

## §P.0 基线同步 + 草稿区建立（强制前置）

> Code-first, sync before change. 代码是真相源，设计稿可能落后。

**生成 OD 提示词之前，必须完成两件事：确认基线一致 + 建立草稿工作区。**

#### 基线同步

代码领先于设计稿时，OD 基于过时基线产出的新设计会引入结构冲突。

1. 检查涉及的 `design/pages/*.html` 页面是否与当前代码实现一致（快速对比 DOM 结构和关键组件）
2. 如有漂移 → 调用 `asset.md` 反向生成将代码现状同步回 `design/pages/*.html`
3. 同步完成后进入下一步

跳过条件：全新页面（`design/pages/` 中不存在对应文件，无漂移可言）。

#### 草稿区建立（worktree）

**OD 产出不直接落正式稿，必须走 `asset.md` §B.0 的 worktree 机制。**

1. 创建工作区目录 `design/workspaces/{name}/`（`{name}` 按功能命名，如 `round-regen`）
2. 修改已有页面 → 复制正式稿到工作区作为 OD 编辑起点：`design/workspaces/{name}/{page}.html`
3. 全新页面 → 工作区内从零创建，无需复制

这一步确保 Part A 的参考资产指向工作区副本，Part B 的输出落工作区，正式稿不被触碰。升格由 `asset.md` §B 在 OD 产出验收后执行。

## §P.1 产出结构

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
3. **激活设计协议**：发送 `/dao-design`（项目有 `.od-skills/` symlink 时；无则跳过，Part B 提示词已内含关键规范）
4. 将以下文件拖到右侧「设计文件」面板作为参考资产：

| 文件 | 用途 |
|------|------|
| `css/<project>.css` | 设计系统 token（必须） |
| `workspaces/{name}/{page}.html` | 当前修改基准（已复制的副本） |
| `pages/<相关页面>.html` | 需要视觉一致的相关页面（按需） |

5. 将下方「Part B · 设计提示词」的内容粘贴到 OD 输入框，发送
```

**Part B · 设计提示词**（粘贴给 OD AI 的内容）

提示词模板（AI 根据具体任务填充）：

```
你要为 <项目名> 设计 <什么>。<项目名> 是 <一句话产品定位>。

## 设计系统

沿用工作目录中的设计系统（`css/<project>.css`）。不要自创 token，所有色彩/字号/圆角/间距/动效使用 CSS 中已定义的变量。双主题（data-theme="light|dark"）。

## 样式方式：Tailwind + 项目 token

**所有 HTML 元素的样式通过 Tailwind 类名应用，不手写 CSS 选择器做布局/样式。** 仅 Tailwind 无法覆盖的（如 @keyframes、复杂伪元素）才用 `<style>` 补丁。

HTML `<head>` 必须遵循三层结构：

层 1 — 项目 CSS 变量（链接 `css/<project>.css`，含主题 token + 组件基类）
层 2 — Tailwind CDN + 项目自定义 config（读取 `css/<project>.css` 中的 CSS 变量名，映射为 Tailwind 语义类如 `bg-surface`、`rounded-panel`、`text-sm`）
层 3 — 补丁 `<style>`（仅 Tailwind 无法覆盖的，如 keyframes、prefers-reduced-motion guard）

<如果项目有 design/PROTOTYPE-SPEC.md>
读取工作目录中的 `PROTOTYPE-SPEC.md`，按其中的三层 HTML 模板和类名速查表输出。
<否则>
读取 `css/<project>.css`，自行构建 tailwind.config 映射：提取所有 CSS 变量名，按类别（colors / borderRadius / fontSize / spacing / boxShadow / transitionDuration / transitionTimingFunction）映射为 Tailwind theme.extend。
</如果>

## 要设计什么

<具体的设计需求描述——从讨论结论中提炼>

## 参考

<如果右侧有参考文件> 参考已有的 <页面名>.html 保持视觉一致。
<具体哪些元素要保持一致>

## 示例数据

<用于填充设计稿的示例内容>

## 输出

在工作区 `workspaces/{name}/` 中修改 `{page}.html`。
- **样式用 Tailwind 类名**，与代码侧 React 组件 className 一致
- **自包含**：workspace HTML 可独立浏览（内联 `:root` CSS 变量 + Tailwind CDN 脚本 + 内联 tailwind.config）
- **亮暗双主题**：`data-theme="light|dark"`
- **禁止手写 CSS 类做布局/样式**——用 `flex`、`grid`、`gap-4`、`bg-surface`、`rounded-panel` 等 Tailwind 类名
- **禁止硬编码**：颜色（`#xxx`/`hsl()`）→ 用 `bg-surface` 等；字号（`text-[14px]`）→ 用 `text-sm` 等 token 级别类名

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

## §P.1.5 · 出稿后动作（消费队列，缺一即断链）

od-prompt 文档写完**不等于交付完成**，必须接三步——两份提示稿悬空 47 小时无人消费是实证教训：

1. **CONTEXT 登记**：`design/CONTEXT.md` 活跃草稿区加 🟡 行（含登记日期），状态「提示稿已出，待 OD 出原型」——漏登记曾被审计抓到
2. **od-sync 备面板**：项目配置了 `design/.od-sync.json` → 当场跑 od-panel-sync（把草稿区与 css 快照进 OD 面板），OD 侧打开即能引用；未配置 → 交接信息提示用户 `/dao-design od-sync`
3. **消费闭环口径**：向用户明示下一步动作（打开 OD → 贴 Part A/B）；挂起超 7 天由 SKILL.md §0 巡检自动浮出裁决提醒

## §P.2 文件扫描

生成提示词前，**自动扫描** `design/` 目录和项目根：

1. `Glob design/css/*.css` — 找到设计系统 CSS 文件名
2. `Glob design/pages/*.html` — 列出所有现有页面
3. `Read design/PROTOTYPE-SPEC.md`（如存在）— 读取项目级原型输出规范（含 tailwind.config 映射 + 类名速查）
4. `Glob **/tailwind.config.*`（如 PROTOTYPE-SPEC.md 不存在）— 探测项目 tailwind.config，用于自动构建 OD 提示词中的层 2 配置
5. 判断哪些页面与当前任务相关（要修改的页面 + 视觉上下文页面）
6. 写入 Part A 的文件清单；PROTOTYPE-SPEC.md 存在时加入 Part A 参考资产

## §P.3 提示词必含要素

每次生成的 OD 提示词必须包含以下七个部分（缺一不可）：

1. **文件加载指令**：告诉 OD 从工作目录读取哪些文件（CSS token + 工作区副本 + 相关参考页面）
2. **设计需求描述**：要设计什么、新旧差异、具体交互细节、示例数据
3. **讨论口**：提示词末尾加一句"如果有任何不清楚的地方先讨论，不要猜测后直接画"，给 OD 留提问空间
4. **实施交接指令**：要求 OD 设计完成后额外输出一段实施交接提示词（变更摘要、CSS 类、DOM 结构、组件映射、交互行为、注意事项），用于粘贴回编码 AI
5. **工作区指令**：产出必须落 `workspaces/{name}/` 草稿区 + 生成 WORKSPACE.md，不直接改正式稿。升格由 `asset.md` §B 负责
6. **三层 Tailwind 自包含**：workspace HTML 是自包含文件，可独立在浏览器中打开。自包含通过三层结构实现：① 内联 `:root` CSS 变量定义（从项目 `css/<project>.css` 提取）；② Tailwind CDN 脚本 + 内联 `tailwind.config`（CDN 必须在 config 前，否则全局 `tailwind` 对象不存在致 config 静默失效）；③ 补丁 `<style>`（仅 Tailwind 无法覆盖的）。HTML 元素样式通过 Tailwind 类名应用（如 `bg-surface`、`rounded-panel`），不手写 CSS 选择器做布局/样式。提示词中须显式加一句："workspace HTML 是自包含文件，通过内联 `:root` CSS 变量 + 内联 tailwind.config + Tailwind CDN 实现。所有样式用 Tailwind 类名，禁止手写 CSS 选择器做布局/样式。读取项目设计系统 CSS，把所有用到的 token 按分类逐类写入 `:root` 和 tailwind.config，不漏分类。" **验收**：§P.7 关一+关五自动覆盖此项
7. **锚点重置原则**：`<a>` 元素作为交互控件（按钮、导航项等）使用时，其 CSS 样式类必须显式重置浏览器对锚点的默认装饰（下划线、字体颜色继承等），不可依赖浏览器默认行为。提示词中加一句："用作交互控件的 `<a>` 元素，CSS 须显式重置浏览器默认锚点装饰。" **验收**：§P.7 关四自动覆盖此项

## §P.4 不做的事

- 不替代 OD 做视觉判断——提示词描述"什么"和"约束"，不描述"怎么画"
- 不在提示词中硬编码 CSS 属性值——只引用 token 名，具体值由 OD 从 CSS 文件读取
- 不把流程拆成"第一步/第二步"给用户——产出是一段完整的提示词，用户复制粘贴到 OD 即可
- 不假设 OD 会话已有上下文——每次都包含完整的文件加载指令
- 不让 OD 直接输出到 `design/pages/{page}.html` 正式稿——产出落草稿区 `workspaces/{name}/`，升格由 `asset.md` §B 负责

## §P.5 · workspace 验收后的强制交付物（HANDOFF.md）

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

## §P.6 · 设计文件同步到 OD 面板（强制，与 §P.5 并行）

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

## §P.7 · Workspace HTML 代码质量门（强制，§P.5/§P.6 之后、声明完成之前）

> 未验不声明。视觉截图验"像素"，本节验"代码合规"——两者独立，缺一不可。

**触发条件**：OD 产出或修改 workspace HTML 后，声明"设计完成"之前，必须执行本节。

**五关顺序执行**（任一不过，修 workspace.html 后重检，不得声明完成）：

| 关 | 检查项 | Pass 条件 |
|---|---|---|
| 一 | **变量自包含**：读 workspace.html，提取所有 `var(--*)` 引用名与 `:root` 定义名，求差集 | 差集为空——所有被引用的 token 在 `:root` 中有定义 |
| 二 | **无硬编码字号**：在 workspace.html 中搜索 `font-size` 硬编码（CSS 区域）和 `text-[` Tailwind 任意值（class 属性中） | 零结果——所有字号通过 token 类名（如 `text-sm`） |
| 三 | **无硬编码颜色**：在 `<style>` 块内搜索颜色字面量 + 在 class 属性中搜索 `bg-[#`、`text-[#`、`border-[#` 等 Tailwind 任意颜色值 | 零结果——所有颜色通过语义类名（如 `bg-surface`） |
| 四 | **锚点重置**：找出带 `class` 属性的 `<a>` 元素，检查其 Tailwind 类或 CSS 规则是否显式重置了浏览器默认锚点装饰 | 每个 `<a>` 有 `no-underline` 或等效重置 |
| 五 | **Tailwind 三层完整**：检查 `<head>` 中是否包含三层结构——`:root` CSS 变量定义 + `tailwind.config` 内联脚本 + Tailwind CDN `<script>` 引用 | 三层均存在且顺序正确 |

**修复后同步铁律**：本节发现问题并修复后，必须同步到 workspace HTML 的所有副本（OD 项目数据目录副本 + 外部代码仓副本），两份内容必须一致。

**禁止行为**：
- ❌ 以"视觉截图正常"代替本节检查
- ❌ 发现问题标记"待优化"跳过本节
- ❌ 只修一份副本，另一份留旧内容
