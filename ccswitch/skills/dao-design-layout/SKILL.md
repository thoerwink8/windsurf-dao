---
name: dao-design-layout
description: 桌面端自适应布局方法论——三种布局策略分类 + Layout Behavior Spec + 三视口验证。静态设计稿不包含布局行为时触发
---

# 自适应布局 · Adaptive Layout

> 天下之至柔，驰骋天下之至坚。无有入无间。
> ——《道德经》第 43 章

静态设计稿不包含"窗口变化时什么拉伸、什么固定、什么折叠"。本 skill 在设计与代码之间插入**布局行为规约**（Layout Behavior Spec）补全这个缺口。

**流水线位置**：Design Pipeline **横切层**——布局是 `dao-design-system` 10 类基础之一（§3.9），任何 Phase 需要布局决策时调用本 skill。详见 `dao-design-system` §7。

---

## §1 · 三种布局策略

每个页面/面板的内容区域，必须声明属于以下三种策略之一。混用是常态——一个页面可以有 Stretch 的头部 + Cap 的正文。

### Cap + Center（封顶居中）

内容有 max-width，水平居中，两侧对称留白。

**适用**：阅读型内容（报告/文档/历史时间线）、表单型内容（设置/偏好/对话框）。

**准则**：
- max-width 按内容密度选择：表单 640~720px，阅读 680~900px
- **必须 mx-auto 居中**——左对齐 + max-width 是最常见的错误，造成不对称空洞
- 留白是有意的——它是设计的一部分，不是浪费

**参考**：Linear Settings、GitHub Settings、Notion 页面正文

### Stretch（流式拉伸）

内容跟随容器宽度变化，充分利用可用空间。

**适用**：仪表盘/概览（卡片可重排）、表格/数据列表、项目列表。

**准则**：
- 设置合理上限 max-width（1100~1400px），防止超宽屏下内容过于稀疏
- 超过上限后居中（mx-auto）
- 内部用 CSS Grid `auto-fill` / `auto-fit` 实现自动列数调整
- 卡片元素设 min-width（如 280~360px），防止过窄

**参考**：Linear Issues 列表、Figma 文件浏览、VS Code 设置

### Multi-column（多栏结构）

页面有固定结构区域（侧栏/面板）+ 流式主内容。

**适用**：工作区（侧栏+内容+详情面板）、主从视图（列表+详情）。

**准则**：
- 结构区域用固定宽度 + shrink-0
- 主内容区 flex-1 填满剩余空间
- 当窗口缩小到阈值时，次要面板折叠或隐藏
- 主内容区内部可嵌套 Cap 或 Stretch 策略

**参考**：VS Code（侧栏+编辑器+面板）、Linear 工作区、Notion 侧栏+正文

---

## §2 · Layout Behavior Spec（布局行为规约）

静态设计稿的必要补充——描述每个结构区域在窗口尺寸变化时的行为。

### 格式

每个有布局复杂度的页面，在项目 `.claude/rules/design-layout.md` 中声明：

```markdown
## <页面名>

| 区域 | 策略 | 默认尺寸 | 缩小行为 | 放大行为 |
|------|------|---------|---------|---------|
| 侧栏 | 固定 | 240px | 不变 | 不变 |
| 主内容 | Cap+Center | max 860px | min 600px | 居中，上限不变 |
| 右面板 | 固定 | 260px | <1100px 折叠 | 不变 |
```

### 什么时候需要写

- **首次实现**有布局的页面（不是单组件）
- 设计原型是**固定尺寸**，没有标注自适应行为
- 发现**大屏空洞**或**小屏溢出**问题时

### 不需要写的场景

- 设计稿本身已标注响应式行为
- 单组件/原子组件（由容器策略决定）
- 纯弹窗/对话框（固有 max-width + 居中）

---

## §3 · Layout Tokens

项目 design token 体系应包含布局类 token，分为三类：

| 类别 | 含义 | 命名建议 | 示例值域 |
|------|------|---------|---------|
| 结构区域尺寸 | 固定结构区域的宽度 | `layout-sidebar` / `layout-detail-panel` | 64~300px |
| 内容区域约束 | 各策略的 max-width | `layout-content-sm` / `layout-content-lg` / `layout-content-prose` | 620~1200px |
| 适配阈值 | 触发折叠/隐藏的窗口宽度 | `layout-collapse-at` | 1000~1200px |

token 值由项目定义，本 skill 只规定分类。具体语法（CSS 变量 / Tailwind extend / JS 常量）随项目技术栈而定。

---

## §4 · 三视口验证

取代单视口截图验证。每个页面至少在三个视口下通过视觉检查：

| 视口 | 尺寸 | 验证重点 |
|------|------|---------|
| **min** | 项目定义的最小窗口 | 无溢出、无截断、折叠态正确 |
| **default** | 设计稿的参考尺寸 | 像素对齐设计稿（现有 L3） |
| **max** | 常见大屏（如 1920×1080） | 无空洞、居中合理、拉伸自然 |

### 与 dao-design-fidelity 的集成

- L3 视觉验证扩展为三视口
- 设计原型基线仍在 default 视口建立
- min/max 视口只验证布局行为（无溢出/无空洞），不做像素对比

### 常见问题检查清单

- [ ] max-width 区域是否有 mx-auto 居中？
- [ ] Stretch 区域在超宽屏下是否有合理上限？
- [ ] min 视口下内容是否完整可见？
- [ ] 可折叠面板在阈值附近是否平滑过渡？
- [ ] 表格/列表在窄屏下是否有水平滚动或截断处理？

---

## §5 · 与其他 skill 的关系

| skill | 关系 |
|-------|------|
| **dao-design-open** | 翻译设计稿时，若设计是固定尺寸，需同时产出 Layout Behavior Spec |
| **dao-design-fidelity** | L3 验证扩展为三视口；新增"无空洞/无溢出"检查项 |
| **dao-code-to-prototype** | 代码反向生成原型时，原型固定在 default 视口即可 |
| **dao-component-radar** | 组件级不涉及页面布局策略，但组件应接受 className 以适应容器 |

---

## §6 · 实施步骤

首次为项目引入自适应布局时：

1. **盘点**：列出所有页面，标注当前 max-width 和居中状态
2. **分类**：每个页面/区域选择三种策略之一
3. **写 Spec**：在 `.claude/rules/design-layout.md` 中写 Layout Behavior Spec
4. **加 Tokens**：在 CSS 变量和 tailwind config 中新增 layout tokens
5. **改代码**：按 Spec 修改各页面的布局约束
6. **三视口验证**：min / default / max 截图确认

步骤 1-3 是谋，4-6 是造。谋清楚了再动手。
