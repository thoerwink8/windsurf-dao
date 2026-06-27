
# 设计资产 · Design Asset Lifecycle

> 各复归其根。草稿归草稿，正式归正式，归档归归档。反者道之动——正反双向共用同一归位机制。

本 skill 管理 Open Design 项目的**设计资产生命周期**，包含两个方向：
- **§A · 反向生成（Code→Prototype）**：从代码提取视觉结构，生成设计草稿
- **§B · 升格（Draft→Release）**：把工作区草稿升格为正式稿
- **§C · 一键发布 + 实施（CLI 专用）**：草稿 → 正式稿 + 代码落地，一条命令走完

**核心原则：AI 不做设计决策。** 反向生成反映代码实际渲染，升格执行文件操作+生成交接包。

**sync 接入（完整模式）**：当 `sync.md` 以完整模式委托时，传入漂移上下文（已检测的变更组件列表 + git diff）。接收后可跳过：§A.0.0 方向预检（sync 已确认 Code→Design）。从 §A.1 扫描开始，以传入的变更组件为输入。后续流程（§A.2 翻译 → §A.3 生成 → §A.4 验证 → §B 升格）正常执行。

---

## 命名约定（全局规范）

```
design/
  {page}.html                     ← 正式稿（当前对外基准，只读参考）
  workspaces/                     ← 草稿区（临时，升格后整目录删除）
    {name}/
      {page}.html                 ← 草稿原型
      WORKSPACE.md                ← 本次迭代目标与验收条件草稿
  archive/                        ← 旧正式稿降格保留（永不删除）
    {page}-{YYYYMMDD}.html
  handoff/                        ← 交接包（一次升格一个目录）
    {scope}-{YYYYMMDD}/
      _index.md                   ← 总览、影响范围、ADR
      components.md               ← apps/desktop/src/components/ 改动（如有）
      types.md                    ← packages/shared-types/ 改动（如有）
      prompts.md                  ← LLM prompt 改动（如有）
      acceptance.md               ← 可测试验收标准（每次必有）
  CHANGELOG.md                    ← 每次升格自动追加
  CONTEXT.md                      ← 每次升格自动更新
```

**工作区 = 设计 worktree**：
- 开始迭代 → 在 `workspaces/{name}/` 内创建草稿（开 worktree）
- 验收通过 → 运行升格（§B）（升格 + 关闭 worktree）
- 升格后工作区目录消失，旧正式稿进 archive/，新正式稿就位

---

## §O · OD 侧约定（设计端输出规范）

> 道常无为而无不为。OD 侧不调用 skill，但遵循本章约定，CLI 侧 §C 才能无缝衔接。

本章是**跨两端的协议定义**，不是可执行流程。OD 侧 AI 在设计工作中遵循本章产出要求；CLI 侧 §C 依赖本章定义的文件格式作为输入。

**核心原则：OD 侧的输出 = CLI 侧的输入。** 文件结构、字段名称、路径约定必须严格一致，两端才能零摩擦交接。

---

### §O.0 · 工作区目录结构（OD 产出）

OD 设计会话在项目内创建：

```
design/workspaces/
  {name}/
    workspace.html        ← OD 产出的设计原型（固定文件名）
    WORKSPACE.md          ← 迭代目标与验收条件（开始时写，完成时更新）
    HANDOFF.md            ← 工程实施规格（验收通过后补充）
```

**OD 与 CLI 的文件名差异**：OD 侧固定用 `workspace.html`（OD 不持有页面路由概念）；CLI 升格时通过读 `WORKSPACE.md` 的 `page` 字段确定目标正式稿路径（`design/{page}.html`）。

---

### §O.1 · WORKSPACE.md 格式

OD 设计**开始时**创建，**验收通过后**更新完成标志：

```markdown
---
started: YYYY-MM-DD
page: {page}           # 对应正式稿 design/{page}.html（如 workspace、preferences）
scope: {一句话描述}     # 须与 CONTEXT.md 功能列关键词保持一致（供 §C.0 匹配）
source: design         # OD 产出固定填 design（设计先行）
---

## 本次迭代目标
{设计目标描述}

## 受影响页面
- design/{page}.html

## 完成标志（升格条件）
- [x] 设计稿在 OD 浏览器中目测通过（亮/暗主题各一遍）
- [x] 用户验收通过
- [ ] HANDOFF.md 已补充工程实施规格
```

**关键字段**：

| 字段 | 必填 | 说明 |
|------|------|------|
| `page` | ✅ | CLI 升格的目标正式稿文件名（不含 .html） |
| `scope` | ✅ | 功能描述，须与 CONTEXT.md 功能列保持一致 |
| `source` | ✅ | 固定 `design`，决定 §B 收尾形态（生成完整交接包） |

---

### §O.2 · HANDOFF.md 格式

HANDOFF.md 是 CLI 侧 §C.2 的**唯一实施依据**——缺失则 §C 拒绝执行，设计验收完但卡在实施入口。

```markdown
# 工程实施规格 · {scope}

## 变更摘要
{设计变更的人话描述：什么功能变了，从什么变到什么}

## 新增/修改 CSS 类
| 类名 | 说明 |
|------|------|
| .{class-name} | {用途} |

## DOM 结构变更
```html
<!-- 新增/修改的 HTML 结构 -->
```

## 组件映射（设计层 → 代码层）
| 设计元素 | 目标代码文件 | 修改说明 |
|---------|------------|---------|
| {设计元素} | `{代码路径}` | {改什么} |

## 状态机（如有交互变更）
{状态描述，可选}

## 注意事项
- {token 命名约束、兼容性提示、数据绑定约束等}
```

**最简版**（纯视觉调整、无 DOM 结构变更时）：

```markdown
# 工程实施规格 · {scope}

## 变更摘要
{一句话描述}

## 注意事项
纯样式调整，无 DOM 结构变更，无新增 token。
```

---

### §O.3 · CONTEXT.md 注册（设计完成后更新）

OD 验收完成后，在 `design/CONTEXT.md` 活跃草稿区将条目状态更新为「✅ 验收通过，待升格 + 代码实施」：

```
| 「{scope}」 | design/workspaces/{name}/workspace.html | design/{page}.html | design/workspaces/{name}/HANDOFF.md | ✅ 验收通过，待升格 + 代码实施 |
```

此行是 CLI 侧 §C.0 关键词发现的基础——不注册则 §C.0 关键词匹配零命中，退化到目录扫描。

---

### §O.4 · 设计完成检查清单

进入 CLI §C 之前，OD 侧确认：

- [ ] `workspace.html` 已在浏览器目测通过（亮/暗主题）
- [ ] `WORKSPACE.md` 设计侧完成标志已全部打勾
- [ ] `HANDOFF.md` 已补充工程实施规格（即使是最简版）
- [ ] `CONTEXT.md` 活跃草稿区状态已更新为「✅ 验收通过，待升格 + 代码实施」

以上完成 → 切换到 CLI 侧运行 `/asset.md §C {功能名}`。

---

### §O.5 · 反模式

1. **HANDOFF.md 留空或不写** — CLI §C.2 拒绝实施，设计验收完但无法进入代码实施
2. **WORKSPACE.md 缺 page 字段** — CLI 升格时不知道目标正式稿路径，需手动指定
3. **scope 与 CONTEXT.md 功能列不一致** — §C.0 关键词匹配失败，功能名无法解析到路径
4. **验收未通过就更新 CONTEXT.md 为「待升格」** — CLI 直接执行升格，绕过设计验收
5. **设计完成但不更新 CONTEXT.md** — CLI 侧无法感知草稿就绪，只能靠目录扫描降级发现

---

## §A · 反向生成（Code→Prototype）

> 反者道之动。消费引擎（open.md）从设计到代码，本章反向——从代码到设计。

本章从项目组件代码中提取视觉结构，生成可浏览的 HTML 设计快照——**页面级视觉布局，不只是设计系统元数据。**

**核心原则：代码是真相源，AI 不自行做设计判断。** 原型反映代码的实际渲染逻辑，不是 AI 对"应该长什么样"的推测。

**实现细节（技术栈、组件映射、输出格式）由项目级配置定义**，本章只描述通用流程与原则。

---

### §A.0 · 方向预检 + 配置发现

> 不知常妄作凶。先判方向，再找配置。

#### A.0.0 方向预检（必做）

**第一步不是读代码，而是判方向。** 检查目标页面在 `design/` 下是否有 OD 原型：

| 情况 | 动作 |
|---|---|
| 无对应原型 / 代码新增了原型没有的区块 | ✅ 继续本章 |
| 原型有代码没渲染的区块（设计领先） | ⛔ 改走 `open.md` |
| 两边结构一致 | ⛔ 不需要，告知用户 |

**比法**：轻量扫描主视图顶层功能区块（结构性独立区域），数谁多谁少。边缘状态（empty/loading/error）、交互行为（拖拽/动画）、条件分支变体不算功能区块。

#### A.0.1 查找项目级配置

**方向预检通过后，找配置。**

并行执行：

1. 检查项目规范目录（如 `.claude/rules/code-to-prototype.md` 或 `.windsurf/rules/code-to-prototype.md`）
2. 检查 `design/` 或等价原型目录是否存在
3. 读 `package.json`（获取技术栈线索）

#### A.0.2 配置已存在 → 加载并继续

从配置文件提取三块核心信息：

| 配置项 | 作用 |
|---|---|
| 翻译底座 | 读哪些文件建立映射表（CSS 变量源、框架配置、设计侧 CSS） |
| 样式展开策略 | 如何在 HTML 中运行样式（三层叠加方案或其他） |
| 输出格式规范 | HTML 模板结构、文件命名规则、壳层结构 |

组件→CSS 映射和 Demo 数据**不写入配置**——每次执行时从代码和现有原型自动推断（配置会腐烂，推断不会）。A11y 基线属于 skill 通用层（§A.3.5），不下放到项目配置。

加载完成后直接进入 §A.1，不再询问已知信息。

#### A.0.3 配置不存在 → 引导创建

**自动扫描**（并行静默）：package.json（技术栈）+ 框架配置（token 扩展）+ 全局 CSS（变量定义）+ 组件/原型目录结构 + 设计侧 CSS。

**一次性呈现推断**：技术栈（CSS 框架/组件系统/图标库）+ 翻译底座（CSS 变量源/框架配置/设计侧 CSS）+ 已有原型 + 样式展开策略。已能确认的直接用，只对不确定项提问。

**必问**：壳层结构（桌面应用的 .frame/.titlebar 是否需要）。**选问**：原型输出位置（无原型目录时）、样式框架（无法确定时）。**不问**：组件→CSS 映射（自动推断）、Demo 数据（从原型提取）、A11y（§A.3.5 覆盖）。

**写入配置**：生成 `code-to-prototype.md` 到项目规范目录，含翻译底座（文件→用途）+ 样式展开策略 + 输出格式（模板/命名/壳层）。

---

### §A.1 · 扫描（Scan）

> 道法自然。读代码本身，不读描述。

#### A.1.1 组件树追踪

从入口组件广度优先展开，最多 4 层（0=页面根 → 1=功能区 → 2=复用块 → 3=原子组件映射到 CSS 类 → 4+ 跳过用占位符）。每层提取：DOM 结构、样式类、布局方式（grid/flex）、variant 默认值、内容 slot。

#### A.1.2 条件类展开

条件样式取默认/false 分支：`cn(base, isActive && "x")` → idle 态不展开 `"x"`；`variant === "primary"` → 取 `defaultVariants` 对应分支；三元 → 取 false 分支。

#### A.1.3 样式提取 + 动态内容

收集所有影响视觉的样式声明（颜色/尺寸/间距/圆角/阴影/字体/动画），不论框架。标记动态内容位置（props/state/API），原型中用 demo data 填充。

---

### §A.2 · 翻译（Translate）

> 各复归其根。组件归 HTML，样式归 CSS，动态归静态 demo。

#### A.2.1 三维翻译

| 维度 | 原则 |
|---|---|
| **结构** | 组件树 → HTML 标签嵌套，保留语义标签（section/aside/nav/article） |
| **样式** | 样式类/属性 → 展开为可在 HTML 中运行的 CSS，优先走 token 变量 |
| **数据** | 动态内容 → 填充代表性 demo data；与项目已有原型保持一致 |

#### A.2.2 样式展开策略（通用原则）

**优先顺序**：

1. **复用**：项目已有 CSS 类（设计系统的组件类），直接引用
2. **桥接**：样式框架的 utility class，通过 CDN 或项目构建输出引入
3. **内联**：无法通过上述两种方式覆盖的，提取为 `<style>` 块内的 CSS，**使用 CSS 变量不硬编码值**

**禁止**：翻译过程中引入硬编码色值或像素值——发现时标注 `/* TODO: token化 */`。

#### A.2.3 Demo 数据原则

- **一致性优先**：与项目现有原型使用相同的 demo 数据（项目名/人名/内容），保持跨页面叙事连贯
- **中间状态**：展示功能的中间态（如进度 54%），不用极端值（0% 或 100%）
- **语义合理**：demo 数据的内容与页面功能语境一致，不用"Lorem ipsum"

#### A.2.4 图标处理

| 情况 | 处理方式 |
|---|---|
| 项目图标库可读取 SVG 源 | 提取 SVG path 内联 |
| 无法读取 | 同尺寸占位 SVG + 注释标注图标名 |

---

### §A.3 · 生成（Generate）

> 为道日损。输出格式对标现有原型，不引入新结构。

#### A.3.1 输出归位：草稿进 worktree，token 直写 css/

`design/` 是 OD 和代码侧的**共享空间**，用户是编排者——CC 和 OD 不会同时写入，不存在并发冲突。但**反向生成不直接落地正式稿**，而是收敛到草稿区（worktree），与正向迭代共用同一升格机制（见 §C 闭环）。

**两类产物，两个去处**：

| 产物 | 写入位置 | 理由 |
|------|---------|------|
| 页面原型 HTML | `design/workspaces/{name}/{page}.html`（草稿） | 反向生成是「待审阅草稿」，须经 §B 升格才成正式稿 |
| 设计系统 token CSS | `design/css/<project>.css`（直写） | token 同步是从代码真相源刷新，非页面草稿，不走升格 |

**写入权限**：
- 在 `workspaces/{name}/` 下生成草稿 HTML + `WORKSPACE.md`（`source: code`）
- 更新 `design/css/<project>.css`（从代码侧真相源同步最新 token）
- **不直接写 `design/{page}.html` 正式稿**，**不删除 OD 产出的文件**

若项目尚无 `workspaces/` 结构（旧项目），先按 `dao-project-scaffold` 的 Open Design 附加结构补齐。

#### A.3.2 设计系统 CSS 同步

代码演进后，`design/css/` 中的设计系统 CSS 会过时。反向生成执行时**同步更新**：
- 从代码侧 CSS 变量文件（真相源）读取当前值
- 转换为 OD 格式（`html[data-theme]` 选择器 + hex 值）
- 写入 `design/css/<project>.css`

这样 OD 下次打开项目就看到最新态。

#### A.3.3 格式一致性

输出 HTML 必须与项目已有原型**格式完全一致**——包括：

- 文件头（charset / viewport / 字体引入 / 主题脚本）
- CSS 引用顺序（引用更新后的 `design/css/`）
- 平台模拟层（若有，从现有原型复用，不从代码生成）
- 脚本引入位置
- A11y 基线（lang / aria / 键盘 / 动效 guard）

**具体格式由项目级配置定义。**

#### A.3.4 文件命名与工作区

反向生成创建一个**草稿工作区**（worktree），而非在 `design/` 根放后缀文件：

```
design/workspaces/{page}-from-code/
  {page}.html        ← 草稿原型（与正式稿同名，便于 §B 升格对位）
  WORKSPACE.md       ← source: code，记录代码漂移
```

`WORKSPACE.md` 由本章生成，`source` 必须为 `code`：

```markdown
---
started: YYYY-MM-DD
page: {page}
scope: 从代码反向同步 {page}
source: code
---

## 本次迭代目标
将代码现状还原为设计稿，追平设计/代码漂移。

## 代码漂移（设计稿缺失或过时的部分）
- {代码已实现但原型没有的区块/变更}

## 完成标志（升格条件）
- [ ] 草稿在浏览器目测通过（§A.4.1）
- [ ] 设计师确认草稿如实反映代码
```

工作区命名约定：`{page}-from-code`，明确标识来源。升格由 §B 接手。

#### A.3.5 A11y 基线（不可删减）

无论项目技术栈：

- `lang` 属性标注语言
- 图标按钮有 `aria-label`
- 对话框有 `role="dialog" aria-modal aria-labelledby`
- 进度指示有 `role="progressbar" aria-valuenow`
- 动画有 `prefers-reduced-motion` guard

---

### §A.4 · 验证（Verify）

> 慎终如始。原型必须目测通过才算完成。

#### A.4.1 必做验证

在浏览器中打开生成的 HTML 文件，目测：

- 布局结构不崩溃（主区域无 0 宽度 / 文字无堆叠）
- 色彩正确（使用项目 token，不是浏览器默认蓝/黑）
- 亮暗主题切换正常
- 字体加载正确

#### A.4.2 可选：对比验证

若项目 dev server 可运行，截图同一页面并排对比：

| 比对维度 | 判定标准 |
|---|---|
| 布局比例 | 主区域 / 侧栏比例视觉一致 |
| 色彩 | token 映射正确，无意外默认色 |
| 字号层级 | 标题/正文/标签的视觉层级一致 |
| 间距 | 主要内边距/外边距一致 |

#### A.4.3 偏差处理

| 偏差类型 | 处理方向 |
|---|---|
| 样式框架 class 不生效 | 手工展开为 `<style>` CSS，走 token 变量 |
| 布局结构错误 | 回 §A.1.1 重新读 JSX/模板，检查嵌套层级 |
| 图标占位 | 手工找图标 SVG 路径补全 |
| 与现有原型风格不一致 | 检查项目级配置是否完整 |

---

### §A.5 · 反模式

1. **不查配置就动手** — 技术栈假设错误会导致全部重做。§A.0 配置发现是第一步，不可跳过。
2. **配置不存在时直接报错** — 应进入引导创建模式（§A.0.3），协助用户建立配置后再执行。
3. **扫描后重复问已能推断的问题** — package.json 里有 `tailwindcss`，就不要再问"你用什么 CSS 框架"。只问不确定的。
4. **直接覆盖正式稿** — 反向生成只写 `workspaces/{page}-from-code/` 草稿，绝不直接覆盖 `design/{page}.html` 正式稿。升格由 §B 负责，归档旧正式稿后才替换。
5. **展开超过 4 层** — 原子 UI 组件（Button/Input/Badge 等）映射到 CSS 类即止，不读内部实现。
6. **自行做设计判断** — 代码里是 `gap-3`，原型里就是 `gap-3`，不改成"看起来更好"的 `gap-4`。
7. **硬编码色值** — 翻译时优先找 CSS 变量对应项。无对应时保留原值并标注 `/* TODO: token化 */`。
8. **跳过浏览器验证** — §A.4.1 目测验证不可跳过。未在浏览器确认外观的文件不算完成。

---

## §B · 升格（Draft→Release）

> 各复归其根。草稿归草稿，正式归正式，归档归归档。

---

### §B.0 · 开工作区（迭代起点）

当用户说"开始新一轮迭代"/"新建草稿"/"开工作区"时：

```powershell
# 1. 创建工作区目录
New-Item -ItemType Directory "design\workspaces\{name}"

# 2. 复制正式稿作为起点
Copy-Item "design\{page}.html" "design\workspaces\{name}\{page}.html"
```

然后在 `workspaces/{name}/` 下创建 `WORKSPACE.md`：

```markdown
---
started: YYYY-MM-DD
page: {page}
scope: {一句话描述}
source: design   # design = 手动/OD 设计迭代；code = 由 §A 反向生成
---

## 本次迭代目标
## 受影响页面
## 完成标志（升格条件）
- [ ] ...
```

`source` 字段是双向闭环的方向开关（详见 §C）：
- `source: design` — 正向（设计先行），升格后代码需改造
- `source: code` — 反向（代码先行），由 §A 生成草稿，升格后代码无需动作

提示用户：**后续所有编辑在工作区草稿上进行，不动正式稿**。

工作区命名建议：`feature-{描述}` 或 `{page}-v{N}`

**自动注册到活跃草稿区**：工作区创建后，在 `design/CONTEXT.md` 活跃草稿区追加一行（若章节不存在则先创建）：

| 「{scope}」 | `design/workspaces/{name}/{page}.html` | `design/{page}.html` | — | 进行中 |

注册失败不阻断工作区创建，仅提示用户手动补充。

---

### §B.1 · 识别目标

#### B.1.1 自动识别（优先）

从活跃文件上下文判断：
- 当前打开的是 `design/workspaces/{name}/{page}.html` → 目标 = `{page}`，工作区 = `{name}`
- 当前打开的是 `design/{page}.html`（正式稿）→ 询问用户要升格哪个工作区

#### B.1.2 无法自动识别时

列出 `design/workspaces/` 下所有子目录，让用户选择。

---

### §B.2 · 升格前检查

并行确认：

| 检查项 | 目的 |
|---|---|
| `design/workspaces/{name}/{page}.html` 存在 | 确认草稿真实存在 |
| `design/{page}.html` 存在 | 确认有正式稿可归档（首次升格则跳过归档步骤） |
| `design/archive/{page}-{today}.html` **不存在** | 避免覆盖同日归档（同日二次升格需确认） |

---

### §B.3 · 执行升格（文件操作）

三步**串行执行**：

#### B.3.1 归档旧正式稿

```powershell
$today = Get-Date -Format "yyyyMMdd"
Copy-Item "design\{page}.html" "design\archive\{page}-$today.html"
Remove-Item "design\{page}.html"
```

#### B.3.2 升格草稿为正式稿

```powershell
Copy-Item "design\workspaces\{name}\{page}.html" "design\{page}.html"
```

#### B.3.3 关闭工作区（删除草稿目录）

```powershell
Remove-Item -Recurse -Force "design\workspaces\{name}"
```

工作区目录在此步后消失（worktree 关闭）。

---

### §B.4 · 更新跨文件引用

#### B.4.1 gallery.html（如存在）

搜索 `gallery.html` 中该页面的 `.gcard` 条目，更新 `.cd` 描述文字。询问用户确认后写入。

#### B.4.2 其他引用

Grep 所有 `design/*.html` 中对工作区草稿路径的引用（`workspaces/{name}/{page}.html`），若有则询问是否改为正式稿路径。

---

### §B.5 · 收尾三件套（每次必做）

#### B.5.1 写 CHANGELOG.md

在 `design/CHANGELOG.md` 顶部追加一条：

```markdown
## {YYYY-MM-DD} · [{BREAKING|MINOR|PATCH}] {scope}: {一句话摘要}

**范围**：{page}.html（+受影响的周边页面）
**交接文档**：`design/handoff/{scope}-{YYYYMMDD}/`

### 破坏性变更（如有）
```diff
- 旧结构/接口
+ 新结构/接口
```

### 同步更新页面
| 页面 | 变更类型 | 摘要 |
```

内容由 AI 根据本次迭代改动填充，询问用户确认后写入。

#### B.5.2 生成交接文档目录

在 `design/handoff/{scope}-{YYYYMMDD}/` 下生成以下文件：

**_index.md**（必须）：
```markdown
---
date: YYYY-MM-DD
scope: {page}（+受影响页面）
type: BREAKING | MINOR | PATCH
design-file: design/{page}.html
archive: design/archive/{page}-{YYYYMMDD}.html
---

# 设计交接 · {页面名} {版本摘要}

## 交接包索引
（指向本目录下各子文件）

## 视觉参考
（直接在浏览器打开的文件路径 + 说明）

## 变更摘要
（diff 格式：旧结构 → 新结构）

## 设计决策背景（ADR）
> 在 [场景] 下，面对 [约束]，
> 选择 [方案] 以实现 [质量目标]，
> 接受 [代价]。
```

**按受影响的代码层分文件**（只生成有实际改动的）：

| 文件 | 代码层含义 | 具体路径 |
|------|-----------|---------|
| `components.md` | UI / 业务组件层 | 由项目 CLAUDE.md 定义 |
| `types.md` | 类型定义层 | 由项目 CLAUDE.md 定义 |
| `store.md` | 状态管理层 | 由项目 CLAUDE.md 定义 |
| `prompts.md` | LLM / AI prompt 层 | 由项目 CLAUDE.md 定义 |
| `i18n.md` | 国际化文案层 | 由项目 CLAUDE.md 定义 |

> 项目首次使用本 skill 时，在 CLAUDE.md 中声明各层对应的实际代码目录，此后自动沿用。

每个子文件格式：
- 移除清单（含验证命令 `grep -r ...`）
- 新增清单（含 Props/Schema 定义）
- Before/After diff（BREAKING 必须，MINOR 建议）

**acceptance.md**（每次必须，即使 PATCH）：
```markdown
# 验收标准 · {scope}

> 以下每一条必须通过才能声明完成。

## {分类1}
- [ ] （可测试条件，精确到文件路径或可观测行为）

## 验证命令
（grep / build / test 命令，可直接复制运行）
```

**原则**：开发者看完交接包不需要问任何问题。每个 breaking change 必须有 before/after diff + 验证命令。

#### B.5.3 更新 CONTEXT.md

更新 `design/CONTEXT.md` 中：
- 对应页面的"设计版本"和"与代码侧对齐状态"
- "最近变更"列表（保留最近 3 条）
- 如有新设计决策，追加到"核心设计决策"表
- 更新"设计与代码侧最大差距"中的交接文档路径

#### B.5.4 按 source 分方向收尾（双向闭环）

读 `WORKSPACE.md` 的 `source` 字段，决定收尾形态：

| source | 含义 | handoff | acceptance | CONTEXT 对齐状态 |
|--------|------|---------|-----------|----------------|
| `design`（默认） | 设计先行，代码待改 | 完整交接包（components/types/...） | 必有，代码侧据此验收 | ❌/⚠️ 待代码对齐 |
| `code` | 代码先行，设计追平 | `_index.md` 仅记录「代码已实现，无需动作」，**不生成 components/types 任务清单** | 退化为「设计稿与代码一致性核对表」 | ✅ 已对齐（设计稿刚从代码生成） |

**反向（`source: code`）的 CHANGELOG 条目**必须标注来源，例如：

```markdown
## {YYYY-MM-DD} · [SYNC] {scope}: 设计稿从代码反向同步
**来源**：代码（§A 反向生成）· 代码侧无需动作
**原因**：{为何代码先行——热修/临时实现/补设计稿}
```

`[SYNC]` 是反向专用类型，与 `[BREAKING|MINOR|PATCH]` 区分——它表示设计稿在追平代码，而非代码要追平设计稿。

---

### §B.6 · 完成报告

```
✅ 升格完成

工作区（worktree）：design/workspaces/{name}/ → 已关闭（删除）
正式稿：design/{page}.html
归档：design/archive/{page}-{YYYYMMDD}.html

📋 交接包：design/handoff/{scope}-{YYYYMMDD}/
  _index.md          ← 总览 + ADR
  components.md      ← 组件改动（如有）
  types.md           ← 类型变更（如有）
  prompts.md         ← LLM 变更（如有）
  acceptance.md      ← 验收标准（代码侧完成标志）

📝 收尾：
  CHANGELOG.md       ← 已追加本次条目
  CONTEXT.md         ← 已更新状态
```

---

### §B.7 · 反模式

1. **直接编辑正式稿** — 迭代应在 `workspaces/{name}/` 草稿上进行
2. **升格前不检查归档名冲突** — §B.2 三项检查必须通过
3. **跳过收尾三件套** — 无 handoff 包则代码侧无法对齐
4. **删除归档稿** — `archive/` 目录永不删除
5. **handoff 无 acceptance.md** — 纯文字描述对开发者无效，必须有可勾选验收标准
6. **handoff 用单文件** — 大型变更必须按代码目录分文件，否则开发者无法按模块认领
7. **同日二次升格覆盖归档** — §B.2 检查归档名冲突，必要时加时间戳（`{page}-{YYYYMMDD}-{HHMM}.html`）
8. **工作区残留** — 升格后必须执行 §B.3.3 删除工作区目录，不留孤儿目录

---

## §C · 一键发布 + 实施（CLI 专用）

> 为道日损。草稿 → 正式稿 → 代码落地，消除「升格完 → 再开新会话 → 再找 HANDOFF → 再开始实施」三次切换摩擦。

**正向闭环概念**：正反双向共用同一升格机制（§B），区别在 `source` 字段和收尾形态：

```
正向 Design→Code：  手动/OD 改草稿 ──┐
                                      ├─> workspaces/{name}/ ──§B升格──> 正式稿 + handoff
反向 Code→Design：  §A 生成草稿 ─────┘   （收敛点）        （按 source 分方向收尾）
```

§C 是**正向流程**（`source: design`）的最后一公里，不适用于反向（`source: code` 升格后代码无需动作）。

**触发条件**：用户说「升格并实施」/「§C」/「一键发布实施」，附带功能名或草稿路径（二选一）。

---

### §C.0 · 草稿发现（路径解析）

> 不知常妄作凶。先从功能名找路径，再开始执行。

用户通常知道**功能名**（如「换个方向」），不知道目录名（如 `round-regen`）。本节把语义映射到路径，解析出 `{name}` 供后续各节使用。

**解析优先级（依次尝试）：**

1. **读 `design/CONTEXT.md` 活跃草稿区** — 搜索「功能」列，与用户描述做关键词模糊匹配
   - 唯一匹配 → 提取草稿路径，`{name}` 已解析，进入 §C.1
   - 多个匹配 → 列出候选让用户选择后继续
   - 零匹配 → 进入步骤 2

2. **列出 `design/workspaces/` 所有子目录** — 让用户从列表中指认目标工作区后继续

3. **工作区目录为空 / 用户无法选择** — 告知当前无可升格草稿，停止执行

> **为什么 CONTEXT.md 是第一优先级**：活跃草稿区是设计侧和代码侧都认可的单一真相源；每次新增草稿时应同步在此登记（见 §B.5.3），否则 §C.0 只能依赖目录列表降级发现，识别率下降。

---

### §C.0.5 · 草稿预览 + 确认门

> 慎终如始。§B.3.3 会永久删除草稿目录——写操作前先让用户看清楚将要做什么。

路径解析完成后，**在任何写操作开始前**，读取并向用户呈现草稿摘要，等待明确确认：

**摘要来源（并行读取）**：
- `WORKSPACE.md`：scope、source、升格条件列表
- `HANDOFF.md`（如有）：变更摘要、受影响代码层

**摘要呈现格式**：

```
📋 草稿内容预览（design/workspaces/{name}/）
────────────────────────────────────────
功能：{scope}
方向：source: design — 设计先行，实施后代码将发生变更

升格条件：
  {[x]} {条件1}
  {[x]} {条件2}
  ...（原样列出，未完成的 [ ] 用 ⚠️ 标出）

即将实施（来自 HANDOFF.md 变更摘要）：
  {变更摘要内容}

受影响代码层：
  {组件映射列表}

⚠️  执行后 design/workspaces/{name}/ 目录将被永久删除。
    如需保留草稿，请先备份后再继续。

继续？ [确认执行 / 取消 / 查看完整 HANDOFF.md]
```

**响应处理**：

| 用户回复 | 动作 |
|---------|------|
| 确认 / y / 继续 / 任何肯定 | 进入 §C.1 |
| 取消 / n / 停止 / 退出 | 停止，不执行任何写操作 |
| 查看 HANDOFF / 看详细 / 展开 | 输出完整 HANDOFF.md，再次呈现确认提示 |

**HANDOFF.md 不存在时**：摘要仅含 WORKSPACE.md 内容，在"即将实施"处标注「⚠️ 未找到 HANDOFF.md，实施前需补充工程规格」，询问是否继续或先补充后再执行。

---

### §C.0.6 · 多草稿冲突检测

> 慎终如始。两个草稿同时指向同一正式稿时，先升格者会重置基线，后升格者的 HANDOFF.md diff 将失真。

扫描 `design/CONTEXT.md` 活跃草稿区，检查是否有**其他草稿**的「目标正式稿」列与当前草稿相同。

**命中冲突时**（其他草稿也指向同一 `design/{page}.html`）：停止升格，展示：

```
⚠️  冲突：同时有多个草稿指向 design/{page}.html

当前草稿：design/workspaces/{name}/（即将升格）
冲突草稿：design/workspaces/{other-name}/

升格先到者会更新正式稿基线；后升格者的 HANDOFF.md diff 描述将基于旧基线，实施时差异失真。

选项：
  A. 继续升格当前草稿（知晓风险，冲突草稿届时需重新 diff）
  B. 先查看冲突草稿状态再决定
  C. 取消，手动协调顺序后再执行
```

**未命中冲突时**：静默通过，进入 §C.1。

---

### §C.1 · 验证升格条件

读 `design/workspaces/{name}/WORKSPACE.md`，确认：

- `source` 字段为 `design`（反向流程不走本节）
- 所有升格条件 `- [ ]` 已改为 `- [x]`（无未完成项）

任一不满足 → 列出缺失项，停止执行。

---

### §C.2 · 提取实施计划（§B 执行前）

> 先读 HANDOFF.md，再执行 §B——§B.3.3 会删除草稿目录，HANDOFF.md 随之消失。

读 `design/workspaces/{name}/HANDOFF.md`，提取：

| 字段 | 用途 |
|------|------|
| 变更摘要 | 了解功能范围与边界 |
| 新增 CSS 类 | 组件样式对照 |
| DOM 结构变更 | 组件结构实现依据 |
| 组件映射 | 对应代码文件定位 |
| 状态机（如有） | 交互逻辑实现依据 |
| 注意事项 | token 命名、兼容性、数据绑定约束 |

**HANDOFF.md 不存在时**：停止执行，提示用户先在草稿目录补充 HANDOFF.md。没有工程规格不实施。

---

### §C.2.5 · Token 孤岛扫描

> 不知常妄作凶。草稿引入的新 CSS 变量若不同步到 token 层，代码侧运行时视觉静默失效——无报错、无类型错误，只是"看起来不对"。

读草稿 HTML（`design/workspaces/{name}/{page}.html`）的 `:root` 块，提取全部 CSS 变量名。

读项目 token 文件（路径来自项目 `CLAUDE.md` 或 `design/css/` 下的主 CSS）已有的 CSS 变量名。

**对比结果**：

| 情况 | 动作 |
|------|------|
| 草稿 `:root` 无新变量 | 静默通过，进入 §C.3 |
| 有新变量（token 层未定义） | 列出缺失变量，询问用户处理方式 |

**缺失变量展示格式**：

```
⚠️  草稿引入了 {N} 个项目 token 层中不存在的 CSS 变量：

  {--variable-name}: {value}   （草稿用法：{使用场景描述}）
  ...

不同步到 token 层 → 代码侧 fallback 到 unset，视觉静默失效。

选项：
  A. 同步到 token 文件再继续  → AI 追加上述变量到项目 token CSS
  B. 跳过，我手动处理        → 记录为 TODO，继续 §C.3
  C. 取消整次执行
```

**选 A 时**：将新变量追加到项目 token 文件，询问用户确认后写入，再进入 §C.3。

**无法定位 token 文件时**：询问用户提供路径，或改选 B 跳过。

---

### §C.3 · 执行 §B 升格

完整执行 §B 流程（§B.1 ~ §B.5），产出：
- `design/{page}.html`（新正式稿到位）
- `design/archive/{page}-{today}.html`（旧正式稿归档）
- `design/handoff/{scope}-{today}/`（交接包）
- `design/CHANGELOG.md`、`design/CONTEXT.md`（已更新）

---

### §C.4 · 定位目标文件

读项目 `CLAUDE.md` 中"设计交接代码层映射"表，将 §C.2 提取的改动按代码层分配到对应目录。

**映射表不存在时**：停止执行，提示用户在项目 CLAUDE.md 中添加"设计交接代码层映射"表。不猜测文件路径。

---

### §C.5 · 逐层实施

**实施顺序**：按 CLAUDE.md 映射表从底层到上层依次实施（通常：类型层 → 业务逻辑层 → 组件层 → 样式层）。

每层完成后 checkpoint，确认无编译/类型错误后再进入下一层。

**实施边界（铁律）**：
- 只实施 HANDOFF.md 明确声明的改动
- 不自行扩展 HANDOFF.md 未覆盖的 UI 细节
- 不修改 HANDOFF.md 范围外的文件

---

### §C.6 · 验证

按项目 `CLAUDE.md` 中记录的构建与测试命令**串行执行**（并行输出会交叉导致假结论）：
- 类型检查
- 单元 / 集成测试
- 全量构建

任一失败 → 修复后重跑，不声明完成。

---

### §C.7 · 收尾归位

1. 从 `design/CONTEXT.md` **活跃草稿区**删除该条目（已升格 + 已实施）
2. 提示用户 commit：格式 `[cc] feat({scope}): 实施 {功能名} · 对齐设计稿 {date}`

---

### §C.8 · 反模式

1. **HANDOFF.md 在 §B 后读** — §B.3.3 删草稿目录，HANDOFF.md 随之消失；必须在 §C.2 先读
2. **HANDOFF.md 缺失时强行实施** — 没有工程规格不实施，停下来让用户补充
3. **CLAUDE.md 无映射表时猜路径** — 猜测路径改错地方，停下来让用户添加映射表
4. **并行跑构建/测试** — 输出串线致假结论，必须串行
5. **§B 未完成就进入 §C.5** — §C 是 §B 的顺延，升格失败不进实施
6. **实施后不更新 CONTEXT.md 活跃草稿区** — 遗留条目误导下次 CLI 发现草稿
7. **跳过 §C.2.5 token 扫描** — 新 CSS 变量不同步到 token 层，代码运行时视觉静默失效，无报错无类型错误，极难排查
8. **跳过 §C.0.6 冲突检测** — 多草稿并存时不检测，先升格者重置基线后，后升格者 HANDOFF.md diff 失真，代码实施结果与设计意图不符
9. **§B.0 不写 CONTEXT.md** — 开工作区不注册，§C.0 关键词匹配零命中，退化到目录列表，功能名检索失效

---

## 与其他 skill 的关系

| Skill | 关系 |
|---|---|
| `open.md` | **正反互补 + 入口互补**。open 是 OD 会话驱动的 Design→Code；本 skill §C 是 CLI 驱动的 Draft→Formal+Code。两者覆盖不同入口，共享 `design/` 目录 |
| `standards.md` | 翻译和验证的视觉判据来源 |
| `component-radar.md` | §A 扫描阶段可并行触发 radar，检测应提炼为组件的原生 HTML |
| `dao-project-scaffold` | 项目无 `workspaces/` 结构时先按其 Open Design 附加结构补齐 |
| `dao-verify` | 生成/升格完成后可走涅槃门做完整体检 |
| `sync.md` | **快捷入口**。sync 完整模式委托本 skill §A 执行 Code→Design，传入漂移上下文跳过方向预检 |
