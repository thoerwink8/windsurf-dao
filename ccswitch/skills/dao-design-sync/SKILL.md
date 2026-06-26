---
name: dao-design-sync
description: 设计变更结构提取——当 design/*.html 变更时，从 HTML+CSS 源码自动提取结构化实施规格（DOM 层级、CSS 属性值、Tailwind 映射、高度链约束），将"按设计稿对齐"降维为机械 diff 任务。design-open 谋线/造线中自动触发
---

# Design Sync · 设计变更结构提取

> 天下之至柔，驰骋天下之至坚。无有入无间。
> ——《道德经》第 43 章

**AI 不该"解读"设计意图，应该"提取"设计结构。**

本 skill 解决的核心问题：设计稿是 HTML+CSS 源码（不是图片），但 AI 在执行 design-to-code 时仍在做视觉解读——猜测设计师想要什么效果，而不是精确读取 CSS 属性值和 DOM 结构。这导致多轮迭代仍无法对齐，直到人工提取精确规格才成功。

**流水线位置**：Design Pipeline **Phase 1.5（结构提取）**。上游是 `dao-design-open` §1 Read（读取设计资产），下游是 `dao-design-open` §3 Translate（用本 skill 产出的结构化规格执行翻译）。

---

## §0 · 核心原则

1. **读 CSS 源码，不看截图猜**——`design/*.html` 的 `<style>` 块和链接的 CSS 文件是精确数据源
2. **提取属性值，不描述视觉效果**——输出 `padding: 10px 26px` 而不是"增加一些内边距"
3. **映射 DOM 结构，不只映射样式**——sibling/child 关系决定布局行为（sticky vs flex）
4. **追踪约束链，不只看单个元素**——overflow-scroll 依赖从 root 到容器的完整 min-height:0 链

---

## §1 · 触发条件

| 场景 | 触发方式 | 输入 |
|------|---------|------|
| Loop 谋线（design/ 变更） | `dao-loop` §4 步骤 2 → `dao-design-open` §1.5 自动调用 | git diff 范围 |
| 单次设计对齐任务 | 用户显式调用或 AI 检测到 design/ 变更 | 指定文件 |
| 造线中发现结构偏差 | `dao-design-open` §4.3 偏差处理中调用 | 偏差元素选择器 |

---

## §2 · 变更检测

### 2.1 识别变更范围

```bash
# 设计文件变更
git diff [base]..HEAD -- design/*.html design/css/*.css

# 或指定文件
git diff HEAD~1 -- design/workspace.html
```

### 2.2 变更分类

| 变更类型 | 判据 | 提取深度 |
|---------|------|---------|
| 新增元素 | diff 中有新选择器或新 DOM 节点 | 完整提取（§3 全流程） |
| 属性修改 | diff 中现有选择器的属性值变化 | 属性级提取（§3.2） |
| 结构重组 | DOM 层级变化（父子→兄弟、拆分/合并容器） | 结构级提取（§3.1 + §3.3） |
| CSS 变量重命名 | `--var-old` → `--var-new` | 全局搜索替换范围（§3.4） |

---

## §3 · 结构提取（核心）

### 3.1 DOM 层级提取

从 design HTML 源码提取元素层级关系，输出为结构树：

```
.main                          ← 对应 React: WorkspaceMain
├── .topbar                    ← 对应: TopBar (sibling, 不在滚动区内)
├── .dim-nav                   ← 对应: DimNav (sibling, 不在滚动区内)
│   ├── .dn-no                 ← badge: 维度序号
│   ├── h2                     ← 维度标题
│   ├── .dn-count              ← pill: 候选数
│   ├── .pager                 ← 分页文字
│   ├── button.prev            ← 上一维度
│   └── button.next            ← 下一维度
└── .board                     ← 对应: candidate-feed (flex:1, overflow:auto)
    └── .card-list             ← 卡片列表
```

**关键输出**：
- 每个元素的**父子/兄弟关系**（这决定了布局行为）
- 与 React 组件的**映射关系**
- 布局角色标注（`shrink-0` / `flex-1` / `overflow:auto` / `min-height:0`）

### 3.2 CSS 属性提取

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

.dn-no {
  height: 22px;                → h-[22px]
  min-width: 22px;             → min-w-[22px]
  border-radius: var(--radius-sm);  → rounded-control (6px)
  font-family: monospace;      → font-mono
  font-size: 12px;             → text-xs
  /* ... */
}
```

**输出格式**：选择器 → CSS 属性 → Tailwind 等效类名（三列对照表）。

### 3.3 约束链分析

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

**关键输出**：
- 链中每一层的 `min-height` / `height` / `flex` 约束
- 标记缺失的必要约束（如 `min-h-0`）
- 标记滚动容器的位置和哪些元素在其内/外

### 3.4 CSS 变量变更提取

检测 CSS 变量的重命名或新增：

```
CSS 变量变更：
  --color-fg         → --fg          (重命名)
  --color-fg-secondary → --fg-2      (重命名)
  --color-border-light → --color-border-soft (重命名)
  --radius-button    → (删除，合并到 --radius-sm)

影响范围搜索：
  grep --include="*.tsx" --include="*.css" --include="*.js" \
    "color-fg\b" apps/ packages/
```

---

## §4 · 输出规格

### 4.1 结构化实施规格（标准输出）

每次提取产出一份**实施规格**，格式与 OD 精确提示词同构：

```markdown
## 实施规格：<组件名> (<design-file>)

### 1. DOM 结构
<§3.1 的结构树>

### 2. CSS → Tailwind 映射
<§3.2 的三列对照表>

### 3. 约束链
<§3.3 的约束链（仅涉及滚动时）>

### 4. CSS 变量变更
<§3.4 的变更列表（仅有变更时）>

### 5. 验证检查点
- [ ] <从结构中推导的关键检查点>
- [ ] <例：dim-nav 是 board 的 sibling 不是 child>
- [ ] <例：MainPanel div 有 min-h-0>
```

### 4.2 消费方式

| 消费者 | 如何使用 |
|--------|---------|
| `dao-design-open` §3 翻译 | 直接按规格写代码，不需要"理解设计意图" |
| `dao-loop` 造线 worker | 规格作为 Task 的输入 spec |
| `dao-design-fidelity` L2 | 验证检查点用于结构验证 |
| 人工 review | 规格即 diff 说明，reviewer 可逐条对照 |

---

## §5 · 提取流程

### 5.0 前置：读取项目 Token 映射

提取前先读项目的 token 配置（CSS 变量 → Tailwind 类名映射）：

1. `index.css`（或等效）：CSS 变量定义
2. `tailwind.config.*`：自定义 theme extend
3. 项目 `.claude/rules/design-tokens.md`（如有）：token 速查表

这些是翻译 CSS → Tailwind 的必要上下文。

### 5.1 Diff 驱动提取

```
1. git diff 获取变更范围
2. 对变更的每个选择器：
   a. 提取完整 CSS 属性（不只是 diff 行，包含该选择器的所有属性）
   b. 映射到 Tailwind 类名
3. 对变更的 DOM 结构：
   a. 提取前后层级对比
   b. 标注布局角色变化
4. 对涉及滚动/overflow 的变更：
   a. 追踪完整约束链
5. 对 CSS 变量变更：
   a. 列出所有引用位置
6. 组装实施规格
```

### 5.2 全量提取（新页面/首次对齐）

对整个设计页面做完整提取，不依赖 diff：

```
1. 读取页面完整 <style> 块 + 链接 CSS
2. 逐选择器提取 CSS 属性并映射
3. 提取完整 DOM 结构树
4. 分析所有约束链
5. 组装实施规格
```

---

## §6 · 与其他 skill 的关系

| Skill | 关系 |
|---|---|
| `dao-design-open` | **上下游**。open §1 Read 后调用本 skill 提取规格，open §3 Translate 按规格执行 |
| `dao-design-fidelity` | **验证端**。本 skill 的验证检查点是 fidelity L2 的输入 |
| `dao-loop` | **谋线集成**。Loop 检测 design/ 变更时自动调用 |
| `dao-design-layout` | **布局知识源**。约束链分析引用 layout 策略 |
| `dao-code-to-prototype` | **反向互补**。本 skill 是 Design→规格，prototype 是 Code→Design |

---

## §7 · 反模式

> 不知常妄作凶。

1. **只读 diff 行不读完整选择器**——CSS 属性有上下文依赖（`display:flex` + `gap` 组合），只看变更行会丢失组合语义
2. **用自然语言描述结构**——"导航栏应该固定在顶部"有歧义（sticky? fixed? flex sibling?），结构树没有歧义
3. **跳过约束链分析**——单个元素的 `overflow:auto` 写对了也不滚动，因为父级缺 `min-height:0`
4. **忽略 CSS 变量重命名的传播范围**——变量名改了但引用处没改 = 运行时静默失败
5. **只翻译 CSS 值不翻译 DOM 结构**——`position:sticky` 和 `flex sibling + shrink-0` 视觉相似但行为不同，结构决定行为

---

## §8 · 演化记录

| 日期 | 事件 | 决策 |
|------|------|------|
| 2026-06-27 | TraceyU design-fidelity-sweep Loop 中发现：多轮设计对齐迭代失败，直到 OD 提供精确 CSS 属性值+DOM 结构才成功 | 创建本 skill，填补 design-open Read 和 Translate 之间的结构提取缺口 |
