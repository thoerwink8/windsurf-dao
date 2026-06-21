# Phase 0 · 参考产品分析（Reference Product Analysis）

> 知人者智，自知者明。先读懂目标产品的设计 DNA，再动手。

### 0.1 目标产品解剖

**不是截图然后模仿——是提取设计决策背后的系统性规律。**

对目标产品（如飞书/Linear/Notion）做以下维度的系统性分析：

| 维度 | 具体观察点 | 提取方法 |
|------|-----------|---------|
| **色彩体系** | 主色相环位置、中性灰色温（冷/暖）、灰阶梯级数、强调色数量 | DevTools 取色 / 截图取色 |
| **圆角刻度** | 控件圆角、面板圆角、对话框圆角、pill 标签是否 full | DevTools 检查 border-radius |
| **阴影策略** | 是否用 inset shadow、外阴影层级数、阴影色的染色策略 | DevTools 检查 box-shadow |
| **hover 模式** | 悬停时背景变化方式（色叠加 vs 边框变化 vs 无变化）、透明度值 | 鼠标悬停 + DevTools |
| **过渡动画** | 默认 duration、easing 曲线、是否用 transform | DevTools Performance |
| **间距节奏** | 基础间距单位（4px/8px）、内容与容器的呼吸感 | DevTools 量测 |
| **字体策略** | 字族选择、字重层级、字号梯度、letter-spacing | DevTools 检查 font |
| **边框策略** | 边框可见度（透明度值）、是否用 divide 替代 border | DevTools 检查 border |
| **交互反馈** | 按下效果（translate vs 色变 vs scale）、focus ring 样式 | 实际操作 + DevTools |
| **加载模式** | 骨架屏 vs spinner vs shimmer、位置和尺寸策略 | 触发加载态观察 |

### 0.2 差异矩阵

分析完后产出一张**当前 vs 目标**的差异矩阵表，这是后续波次规划的唯一输入。

```markdown
| 维度 | 当前值 | 目标值 | 影响范围 | 优先级 |
|------|--------|--------|---------|--------|
| 控件圆角 | 6px | 8px | 全局 token，0 测试影响 | P0 |
| hover 叠加 | bg-accent / bg-foreground/8% | bg-foreground/4% (N900@4%) | ~8 组件 | P1 |
| inset shadow | 10 处 | 全部移除 | ~10 组件，~3 测试 | P1 |
| 过渡时长 | 150ms | 200ms | 全局 | P2 |
| ... | ... | ... | ... | ... |
```

**优先级判定**：
- **P0**：改 1 处 token 级联全局的变更（圆角、主色）
- **P1**：需要逐组件修改但有明确模式的变更（hover、shadow）
- **P2**：影响小或纯增强的变更（过渡时长、边框透明度）
- **P3**：可选优化（readonly 态、微动效）

### 0.3 参考产品的设计系统文档

如果目标产品有公开的设计系统文档（如 Semi Design、Ant Design、Material Design），**优先读文档**而不是逆向工程。

常见公开设计系统及其文档：

| 产品/公司 | 设计系统 | 核心特征 |
|----------|---------|---------|
| 飞书/Lark | Semi Design | N900@4% hover、无 inset shadow、pill 标签、8px 控件圆角 |
| Ant Design | Ant Design 5 | 三层 token（Seed→Map→Alias）、CSS-in-JS、主题算法 |
| Google | Material Design 3 | Dynamic Color、Tonal Palette、Shape Scale |
| Apple | Human Interface Guidelines | Vibrancy、SF Symbols、Semantic Colors |
| Linear | 自有系统 | 极简工具美学、深灰基底、克制动效 |
| Vercel | Geist | 几何无衬线、高信息密度、monospace 数据 |
| Notion | 自有系统 | 暖灰系、圆润手感、内容优先 |
