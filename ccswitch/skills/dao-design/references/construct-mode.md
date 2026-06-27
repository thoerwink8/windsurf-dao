# §7C · Construct 模式：设计系统构建流程（S1→S5）★

> 朴散则为器。先造器，再用器造物。**禁止跳过组件直接画页面。**

**铁律：先资产后页面。** 这是设计师的基本工作流——tokens → 组件 → 页面，每层只引用上一层，不越级。跳过组件层直接用原始矩形/文字画页面 = 产出线框级垃圾，不是设计稿。

## S1 · Design Tokens（基础设施）

在设计工具中建立完整的 token 体系，与代码 CSS 变量一一对应：

| token 类型 | 设计工具产物 | 代码对应 |
|---|---|---|
| 颜色 | Library Colors（语义命名） | CSS `--primary` 等 HSL 变量 |
| 字体排版 | Library Typographies（字族/字重/字号/行高/字间距） | Tailwind 字号体系 |
| 间距 | Design Tokens（spacing 类型） | Tailwind spacing scale |
| 圆角 | Design Tokens（borderRadius 类型） | `--radius-control` 等 |
| 阴影 | Design Tokens（shadow 类型） | `--shadow-*` |

**验收**：设计工具中的 token 数量 ≥ 代码中 CSS 变量数量。每个代码 token 有设计工具对应物。

## S2 · 图标库（原子视觉元素）

将项目使用的所有图标导入设计工具：

1. **审计代码**：`grep` 所有 Lucide import，产出完整图标清单
2. **获取 SVG**：从图标库官方获取每个图标的 SVG 源码
3. **导入设计工具**：每个图标做成可复用组件（SVG 导入 → 转组件）
4. **命名规范**：`Icon/<图标名>`（如 `Icon/Layers3`、`Icon/Plus`）
5. **尺寸标准化**：默认 16×16，通过 resize 适配不同 size variant

**验收**：设计工具图标组件数 = 代码 Lucide import 去重数。

## S3 · 原子组件（基础 UI 元素）

将代码 `ui/` 目录下的每个组件在设计工具中创建为 Library Component：

1. **逐个组件创建**：Button、Input、Card、Badge、Dialog 等
2. **含所有 variant**：用设计工具的 Variants 系统（或按 variant 命名）创建每个变体
   - Button：primary / secondary / tertiary / danger / icon × default / sm / lg
   - Card：default / sm
   - Alert：danger / info / success / neutral
3. **引用 S1 token**：颜色、圆角、阴影全部引用 Library Color 和 Design Token，不硬编码
4. **引用 S2 图标**：需要图标的组件使用图标 Library Component 实例
5. **四态覆盖**（§4.4）：loading / empty / error / success 各画一版

**命名规范**：`UI/<组件名>` 或 `UI/<组件名>/<Variant>`

**验收**：每个代码 ui/ 组件在设计工具中有对应 Library Component；variant 覆盖率 ≥ 80%。

## S4 · 复合组件（业务组件）

用 S3 原子组件的**实例**组合成业务级组件：

1. **组合而非重造**：SidebarHeader = BrandMark 实例 + Text + Icon 实例 × 3
2. **不引入新样式值**：颜色/间距/圆角全来自 S1 token 和 S3 组件，不新增裸值
3. **含真实内容**：用代表性文案和数据，不用 lorem ipsum

**典型复合组件**：AppShell（Sidebar + Workspace）、WelcomeCard、ProjectListItem、BrainstormCard、OptionCard、StatusBar、各 Dialog 内容

**命名规范**：`Block/<组件名>`

## S5 · 页面组合（最终交付）

用 S3/S4 组件**实例**拼装完整页面：

1. **每个页面一个画板**：尺寸与应用窗口一致
2. **只用实例不用原始形状**：页面里不出现裸矩形/裸文字（除了页面级背景和布局容器）
3. **覆盖所有状态**：每个页面的关键状态各画一版（空态/有数据/loading/error）

**验收**：页面中 90%+ 元素是组件实例（可回溯到 Library Component）。
