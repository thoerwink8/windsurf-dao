# Phase 3 · 系统性实施（Systematic Implementation）

> 为学日益，为道日损。损之又损，以至于无为。

### 3.1 "改一处、级联全局" 原则

**设计系统改造的最高效策略是找到最高层级的修改点。**

```
效率金字塔（从高到低）：

     ╱╲
    ╱  ╲    CSS 变量值 → 改 1 行影响 N 个组件
   ╱────╲
  ╱      ╲   共享常量 → 改 styles.ts 影响 M 个组件
 ╱────────╲
╱          ╲  组件 variant → 改 CVA 影响该组件所有实例
╱────────────╲
             组件实例 → 改一处只影响一处（最后手段）
```

**实战示例**：
- 暗色模式红色系可读性差 → 改 `--danger: 0 70% 58%` 一处，所有用 `text-destructive` 的组件自动修复
- 三池表面色过饱和 → 改 `--success-surface`、`--warning-surface`、`--danger-surface` 三个 CSS 变量值
- hover 策略统一 → 改 `styles.ts` 中的 `focusRing` 常量

### 3.2 Hover 统一模式

**通用 hover 策略**（飞书系为代表的现代 product UI）：

```typescript
// 统一 hover 叠加色 = 前景色的极低透明度
// N900@4% — "看不见但能感知"的微妙变化
const HOVER_BG = 'hover:bg-foreground/[.04]'
const ACTIVE_BG = 'active:bg-foreground/[.08]'

// 语义色的 hover 用自身色的低透明度
const SUCCESS_HOVER = 'hover:bg-success/[.18]'
const WARNING_HOVER = 'hover:bg-warning/[.18]'
const DANGER_HOVER = 'hover:bg-destructive/[.18]'
```

**Tailwind 透明度语法注意**：
- Tailwind v3 用方括号：`bg-primary/[.90]` ✓
- `bg-primary/90` 是 Tailwind v4 语法，v3 中无效 ✗
- 始终检查项目的 Tailwind 版本确定语法

### 3.3 Shadow 清理模式

**现代 product UI 的阴影趋势**：

| 时代 | 阴影策略 | 代表 |
|------|---------|------|
| 2018-2020 | 大量 inset shadow + 多层 box-shadow | Material Design 1 |
| 2020-2023 | 克制外阴影 + hairline border | Linear, Notion |
| 2023-present | 极简阴影（仅 float/overlay）+ border/divide 替代 | 飞书, Vercel |

**清理步骤**：
1. `Grep` 搜索 `shadow-[inset` 找到所有 inset shadow
2. 逐个评估：inset shadow 的作用是什么？
   - 如果是"立体感" → 直接删除（现代 UI 不需要）
   - 如果是"分隔" → 改为 `border-b` 或 `divide-y`
   - 如果是"凹陷感"（如 input） → 改为 `border` + 微妙 `bg` 变化
3. 更新 contract 测试中对应的 `toContain('shadow-[inset')` 断言

### 3.4 Transition 规范化

```css
/* 飞书式过渡参数 */
/* Silk 级（默认） */
duration-200 ease-in-out

/* Snap 级（按钮 active） */  
duration-100 ease-out

/* Spring 级（弹窗入场） */
duration-200 ease-[cubic-bezier(0.34,1.56,0.64,1)]

/* 铁律：只动 transform 和 opacity，禁止动 width/height/margin/padding */
transition-[transform,opacity,background-color,border-color,box-shadow]
```

### 3.5 批量操作模式

**当同一类变更影响 5+ 个文件时，使用 Grep + 批量 Edit 模式**：

```
1. Grep 定位所有目标文件和行号
2. 按组件重要性排序（button > input > badge > ...）
3. 逐文件修改，每改完一个立即检查该文件的 contract 测试
4. 全部改完后跑全量测试
5. 一次 commit
```

**批量操作的反模式**：
- ✗ 全部搜索替换不检查上下文
- ✗ 改完不跑测试就进下一波
- ✗ 多波变更混在一个 commit
