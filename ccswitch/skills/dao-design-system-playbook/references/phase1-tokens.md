# Phase 1 · Token 架构规划（Token Architecture）

> 道生一（primitive），一生二（semantic），二生三（component），三生万物（页面）。

### 1.1 三层 Token 分层

业界共识的 token 分层架构（W3C DTCG 规范方向、Ant Design 5 实践验证）：

```
┌─────────────────────────────────────────────┐
│  Layer 3 · Component Tokens（组件级）         │
│  --button-bg, --card-radius, --input-border  │
│  ↑ 引用                                      │
├─────────────────────────────────────────────┤
│  Layer 2 · Semantic Tokens（语义级）          │
│  --primary, --foreground, --border,          │
│  --success, --warning, --danger,             │
│  --surface, --surface-raised                 │
│  ↑ 引用                                      │
├─────────────────────────────────────────────┤
│  Layer 1 · Primitive Tokens（原始值）         │
│  --blue-500: 222 100% 60%                    │
│  --gray-900: 220 16% 14%                     │
│  --radius-8: 8px                             │
└─────────────────────────────────────────────┘
```

**实际项目中的简化策略**：

对于中小型项目（如 TraceyU），Layer 1 和 Layer 2 合并为 CSS 变量 + Tailwind config 即可。完整的三层分离适合大型设计系统（100+ 组件、多主题、多品牌）。

```css
/* 实际项目中最常见的两层实现 */
:root {
  /* Semantic Tokens（直接写值，不走 primitive 层） */
  --primary: 222 100% 60%;        /* 品牌蓝 */
  --foreground: 220 16% 14%;      /* 正文色 */
  --border: 220 6% 87%;           /* 边框色 */
  --success: 142 71% 45%;         /* 成功绿 */
  
  /* Spacing/Shape Tokens */
  --radius-control: 8px;
  --radius-panel: 8px;
  --radius-dialog: 12px;
  
  /* Shadow Tokens（五层海拔） */
  --shadow-hairline: 0 0 0 1px hsl(var(--border));
  --shadow-raised: ...;
  --shadow-float: ...;
  --shadow-drag: ...;
  --shadow-overlay: ...;
}

.dark {
  /* 暗色覆盖——每个 semantic token 都有对应值 */
  --primary: 222 100% 65%;
  --foreground: 220 5% 90%;
  --border: 220 10% 26%;
  /* ... */
}
```

### 1.2 HSL 色彩空间与 Tailwind 集成

**为什么用 HSL 而不是 HEX/RGB**：HSL 的 H（色相）、S（饱和度）、L（明度）三轴正交，便于：
- 暗色模式映射（保持 H 不变，调 S 和 L）
- 透明度叠加（`hsl(var(--primary) / 0.1)` 不需要额外变量）
- 灰阶梯生成（固定 H 和 S，递增 L）

**Tailwind 集成模式**（CSS 变量存 HSL 三值，不含 `hsl()` 包裹）：

```css
:root { --primary: 222 100% 60%; }
```
```js
// tailwind.config.js
module.exports = {
  theme: {
    extend: {
      colors: {
        primary: 'hsl(var(--primary) / <alpha-value>)',
        // 这样 Tailwind 的 bg-primary/[.10] 就能正确工作
      }
    }
  }
}
```

**OKLCH 注意**：Tailwind v4 默认 OKLCH，但当前多数项目仍在 v3 + HSL。如果项目用 Tailwind v4，token 应改为 OKLCH 色彩空间（感知均匀性更好）。**不要在同一项目混用 HSL 和 OKLCH。**

### 1.3 Token 命名约定

| 类别 | 前缀 | 示例 |
|------|------|------|
| 颜色 | 无前缀 | `--primary`, `--foreground`, `--success` |
| 表面色 | `-surface` 后缀 | `--success-surface`, `--warning-surface` |
| 前景色 | `-foreground` 后缀 | `--primary-foreground`, `--card-foreground` |
| 圆角 | `--radius-` | `--radius-control`, `--radius-panel` |
| 阴影 | `--shadow-` | `--shadow-raised`, `--shadow-float` |
| 间距 | `--space-` | `--space-shell`, `--space-panel` |

**铁律：token 名反映语义而非视觉值。** `--primary` 不叫 `--blue-600`，`--radius-control` 不叫 `--radius-8px`。
