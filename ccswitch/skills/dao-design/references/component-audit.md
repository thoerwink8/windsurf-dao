# §6 · 组件审计详细步骤（Component Audit）

> 不知常妄作凶。改 token 不审计组件 = 妄作。

**本节解决的核心问题：token 改了但组件没跟。** 每次 token 变更后、每次设计语言升级后，必须走组件审计。

## 审计六步法

**一、盘点**（Inventory）
- 列出项目 `ui/` 目录下所有组件
- 每个组件标注：variant 数量、size 数量、当前引用的 token 列表
- 产出：组件清单表

**二、硬编码扫描**（Hardcode Scan）
- 用 Grep 搜索 `ui/` 目录下所有硬编码的设计值：
  - `rounded-[Npx]` — 应引用 `--radius-*` token
  - `text-[Npx]` — 应走 Tailwind 字号体系（禁 `text-[<12px]`）
  - `gap-[N]` / `p-[N]` / `m-[N]` 中的非标准值
  - `hsl(...)` / `rgb(...)` / `#xxx` — 应引用 CSS 变量
  - `shadow-[...]` — 应引用 `--shadow-*` token
- 产出：硬编码违规清单

**三、一致性检查**（Consistency Check）
- 同类组件（如所有按钮 variant）的间距、圆角、字号是否遵循同一套刻度
- 同级元素的间距是否一致（不出现 8/12/8 跳跃）
- 颜色引用是否都走语义 token（不直接引用 `--primary` 做状态色）

**四、四态覆盖检查**
- 对照 §4.4，每个组件是否覆盖了 loading/empty/error/success 四态
- 重点检查：空态有没有引导 CTA、错误态是不是只弹 toast

**五、a11y 扫描**
- 对比度：所有 foreground/background 组合过 WCAG AA（4.5:1）
- 焦点环：所有可交互元素有 `focus-visible` 样式
- 字号底线：正文 ≥ 12px
- 按钮：有 `aria-label` 或可见文字

**六、产出实施清单**
- 每个违规项标注：文件路径 + 行号 + 当前值 + 应改为的值
- 按优先级排序：a11y 红线 > 硬编码 > 一致性 > 四态

## 暗色模式同步检查

**铁律：改 `:root` 必改 `.dark`。** 审计时专门检查：
- 每个 `:root` 下的 token 在 `.dark` 中是否有对应值
- dark 模式下的对比度是否仍满足 WCAG AA
- 阴影在暗色下是否还能看见（暗色下阴影需加深或换用 border）
