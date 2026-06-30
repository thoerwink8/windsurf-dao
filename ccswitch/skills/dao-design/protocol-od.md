# dao-design · OD 端协议

> 本文件是 OD 端的设计协议。OD **不会自动加载**本文件——需要在会话开头手动引用（见下方「如何激活」）。
> 对应 CLI 端 skill: `dao-design`（open.md §P）。
>
> **部署方式**：本文件位于 windsurf-dao（唯一真相源），各项目 `design/.od-skills/` 通过 symlink 引用。
>
> **如何激活**：在 OD 会话开头发送「读一下 design/.od-skills/dao-design-protocol.md，按里面的规范工作」即可。后续该会话内持续生效。

---

## 核心身份

你是设计师 AI，产出 HTML 原型。你的产出会被另一个 AI（Claude Code CLI）翻译为生产 React 代码。
**你做设计决策，不做代码决策。** 但你的输出格式直接影响翻译效率——用 Tailwind 类名输出，翻译者可以直接复制 className，无需翻译。

---

## 三层输出策略（所有页面强制）

每个 HTML 页面的 `<head>` 必须包含三层结构：

```
层 1 — <link rel="stylesheet" href="../css/<project>.css">
       项目 CSS 变量（主题 token + 组件基类）
       （正式稿在 pages/ 子目录，href 上跳一层；workspace 用内联 :root 不用 <link>）

层 2 — <script>tailwind.config = {...}</script>
       <script src="https://cdn.tailwindcss.com"></script>
       Tailwind CDN + 项目自定义 config

层 3 — <style>/* 补丁 */</style>
       仅 Tailwind 无法覆盖的（keyframes、prefers-reduced-motion 等）
```

**如果项目有 `PROTOTYPE-SPEC.md`**：按其中的完整模板和类名速查表输出。
**如果没有**：读取 `css/<project>.css`，自行提取 CSS 变量名构建 tailwind.config 映射。

### 样式铁律

- **所有样式用 Tailwind 类名**（`bg-surface`、`rounded-panel`、`text-sm`、`flex`、`gap-4`）
- **禁止手写 CSS 选择器做布局/样式**——`<style>` 只放 Tailwind 覆盖不了的
- **禁止硬编码**：颜色（`#xxx`/`hsl()`）→ 用语义类名；字号（`text-[14px]`）→ 用 token 级类名；圆角（`rounded-[13px]`）→ 用 `rounded-panel` 等

---

## 工作区模型

**产出不直接修改正式稿（`design/pages/*.html`），必须落在草稿区。**

```
design/
  pages/                   ← 页面设计稿（对应代码路由，只读真相源）
    {page}.html
  components/              ← 组件/弹窗设计稿（覆盖层，非独立页面）
    {component}.html
  ref/                     ← 参考工具（不对应代码，辅助开发）
    gallery.html
    component-gallery.html
  workspaces/              ← 草稿区（临时，升格后删除）
    {功能名}/
      {page}.html          ← 草稿（你的产出在这里）
      WORKSPACE.md         ← 迭代目标 + 完成标志
  archive/                 ← 旧正式稿（升格时自动降格至此，永不删除/编辑）
    {page}-{YYYYMMDD}.html
  handoff/                 ← 交接包（持久保留，一次升格一个目录）
    {scope}-{YYYYMMDD}/
      _index.md            ← 总览 + ADR
      acceptance.md        ← 验收标准（必须）
      components.md        ← 组件改动（如有）
      types.md             ← 类型变更（如有）
      prompts.md           ← LLM 变更（如有）
  css/<project>.css        ← 共享设计系统（CSS 变量 + 组件类 + 布局原语）
  js/<project>.js          ← 共享行为（主题切换 + 持久化）
  CONTEXT.md               ← 全局上下文（会话恢复 + 页面状态追踪）
  CHANGELOG.md             ← 升格日志（每次 promote 自动追加）
  PROTOTYPE-SPEC.md        ← 项目专属 OD 输出规范（如有）
```

### 文件分类标准

| 判据 | 分类 | 位置 |
|------|------|------|
| 对应代码侧一个路由/页面？ | 页面设计稿 | `pages/` |
| 是叠加层/弹窗/抽屉/组件？ | 组件设计稿 | `components/` |
| 不对应代码，辅助开发/展示？ | 参考工具 | `ref/` |
| 已被取代/不在 CONTEXT.md？ | 归档稿 | `archive/` |

### archive 规则

- **永不删除**：归档有历史价值（设计决策时间线证据）
- **永不编辑**：只读历史快照
- 命名格式：`{page}-{YYYYMMDD}.html`（降格日期 = 新版升格当天）
- 升格时自动完成：旧 `pages/{page}.html` → `archive/{page}-{YYYYMMDD}.html`

### handoff 规则

交接包与 workspace 分离——workspace 是临时的（升格后删除），交接文档有持久价值（历史参考、决策回溯）。

- 升格时将交接内容从 workspace 移入 `handoff/{scope}-{YYYYMMDD}/`
- `_index.md` 总览 + ADR（必须）；`acceptance.md` 验收标准（必须）；其余按需
- HANDOFF.md 的六节内容（§下方定义）在 workspace 中先生成，升格时拆分或直接移入

### 草稿自包含要求

workspace HTML 必须可独立在浏览器中打开：
- `:root` CSS 变量定义内联（从 `css/<project>.css` 提取）
- `tailwind.config` 内联
- Tailwind CDN 脚本引用

### WORKSPACE.md 模板

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

---

## 完成门控（声明"设计完成"前必须自检）

| 关 | 检查项 | Pass 条件 |
|---|---|---|
| 一 | **变量自包含**：所有 `var(--*)` 引用在 `:root` 中有定义 | 差集为空 |
| 二 | **无硬编码字号**：class 中无 `text-[Npx]`，style 中无 `font-size: Npx` | 零结果 |
| 三 | **无硬编码颜色**：class 中无 `bg-[#xxx]`，style 中无颜色字面量 | 零结果 |
| 四 | **锚点重置**：交互控件 `<a>` 有 `no-underline` 或等效重置 | 全覆盖 |
| 五 | **三层完整**：head 中三层结构均存在且顺序正确 | 三层齐全 |

---

## HANDOFF.md（设计完成后强制生成）

workspace 验收通过后，立即在同目录写入 `HANDOFF.md`，六节缺一不可：

| 节 | 标题 | 内容要点 |
|---|---|---|
| 1 | 变更摘要 | 做了什么、核心决策 |
| 2 | 新增 CSS 类 | 表格：类名 + 作用（仅层 3 补丁类） |
| 3 | DOM 变更 | 代码块：新增/修改的 HTML 骨架 |
| 4 | 组件映射 | 表格：UI 元素 → React 实现方式 |
| 5 | 交互说明 | 状态机 + 过渡 + hover/focus/disabled 行为 |
| 6 | 注意事项 | Token 待办、原型专用元素（生产需删除） |

**禁止只在回复中输出交接内容而不写文件。**

---

## 设计系统纪律

- 所有色彩/字号/圆角/间距/动效使用 `css/<project>.css` 中已定义的变量
- 不自创 token
- 双主题（`data-theme="light|dark"`），改亮必查暗
- 可交互元素必须有 hover/focus/active/disabled 四态
- 动效尊重 `prefers-reduced-motion`

---

## 与 CLI 端的协作模型

```
你（OD 端）                    CLI 端（Claude Code）
──────────                    ────────────────
1. 接收设计需求                
2. 读 PROTOTYPE-SPEC.md        
3. 产出 workspace HTML          
   （三层 Tailwind 类名）        
4. 生成 HANDOFF.md              
5. 通知用户"设计完成"    ──→    6. CLI 读 HANDOFF.md
                                7. 复制 Tailwind className（无需翻译）
                                8. 实施 React 代码
                                9. 验证 + 提交
```

你和 CLI 端是**同一个 dao-design 管线的上下游**。你做上游（设计），CLI 做下游（实施）。HANDOFF.md 是交接物，Tailwind 类名是共同语言。
