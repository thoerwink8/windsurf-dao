---
name: dao-design-asset
description: 设计资产生命周期管理——反向可视化（Code→Prototype）+ 草稿升格（Draft→Release）+ 双向闭环。管理 design/workspaces/ 的完整生命周期
---

# 设计资产 · Design Asset Lifecycle

> 各复归其根。草稿归草稿，正式归正式，归档归归档。反者道之动——正反双向共用同一归位机制。

本 skill 管理 Open Design 项目的**设计资产生命周期**，包含两个方向：
- **§A · 反向生成（Code→Prototype）**：从代码提取视觉结构，生成设计草稿
- **§B · 升格（Draft→Release）**：把工作区草稿升格为正式稿
- **§C · 闭环流程**：正反两个方向如何汇合

**核心原则：AI 不做设计决策。** 反向生成反映代码实际渲染，升格执行文件操作+生成交接包。

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

## §A · 反向生成（Code→Prototype）

> 反者道之动。消费引擎（dao-design-open）从设计到代码，本章反向——从代码到设计。

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
| 原型有代码没渲染的区块（设计领先） | ⛔ 改走 `dao-design-open` |
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

## §C · 闭环流程

> 反者道之动。正反双向共用同一升格机制，这是双向闭环的关键。

```
正向 Design→Code：  手动/OD 改草稿 ──┐
                                      ├─> workspaces/{name}/ ──§B升格──> 正式稿 + handoff
反向 Code→Design：  §A 生成草稿 ─────┘   （收敛点）        （按 source 分方向收尾）
```

**完整流程**：

| 方向 | 触发 | 草稿生成 | 审阅 | 升格 | 收尾 |
|------|------|---------|------|------|------|
| **正向**（设计先行） | 用户开工作区（§B.0） | 手动编辑或 OD 生成 | 浏览器审阅 | §B 升格 | handoff 含代码任务 |
| **反向**（代码先行） | 代码领先设计时 | §A 自动生成 | 浏览器审阅（§A.4） | §B 升格 | handoff 标「代码已实现」 |

升格时 §B.5.4 读 `WORKSPACE.md` 的 `source` 字段自动分方向：
- `source: design` → 正向，handoff 含完整代码任务清单
- `source: code` → 反向，CHANGELOG 记 `[SYNC]`，handoff 标「代码已实现，无需动作」

---

## 与其他 skill 的关系

| Skill | 关系 |
|---|---|
| `dao-design-open` | **正反互补**。open 是 Design→Code（消费原型），本 skill §A 是 Code→Design（还原原型）。共享 `design/` 目录 |
| `dao-design-standards` | 翻译和验证的视觉判据来源 |
| `dao-component-radar` | §A 扫描阶段可并行触发 radar，检测应提炼为组件的原生 HTML |
| `dao-project-scaffold` | 项目无 `workspaces/` 结构时先按其 Open Design 附加结构补齐 |
| `dao-verify` | 生成/升格完成后可走涅槃门做完整体检 |
