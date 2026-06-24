---
name: dao-design-system
description: 设计系统基础层生成器——通过交互问答收集项目上下文，输出完整的设计系统提示词供 Open Design 消费。覆盖字号/色彩/间距/圆角/阴影/图标/动效/字体/布局/边框十类基础 token
---

# 设计系统基础层 · Design System Foundation

> 道生一，一生二，二生三，三生万物。
> 一即基础层——字号、色彩、间距、形状。基础不立，万物不生。

本 skill 生成**设计系统基础层提示词**，供 Open Design（或任何设计工具）消费。
提示词包含跨项目通用的结构规则（不变层）+ 项目特定的设计需求（可变层）。

---

## §1 · 触发与流程

### 触发方式

用户在 CLI 调用 `/dao-design-system`。

### 流程

```
调用 → 检测上下文 → AskUserQuestion → [有 design/] 加载设计文件到 OD → 审计 → 输出提示词
```

1. **检测上下文**：查 `design/css/*.css`、`**/index.css`、`tailwind.config.*`、`.claude/rules/design-*.md` 是否存在
2. **问用户**（见 §2）
3. **有 design/ 时 · 审计**：扫描当前 token，生成合规报告
4. **输出**：一份可直接复制给 OD 的完整提示词（含自适应文件感知指令，见 §1.5）

---

## §1.5 · OD 设计文件加载（提示词内置）

> 不知常妄作凶。OD 看不到现有设计 = 盲改。

### OD 的两个文件位置

OD 有两个独立的文件空间，理解这一点是正确加载的前提：

| 位置 | 性质 | 右侧面板可见？ | 可修改？ |
|------|------|--------------|---------|
| **项目工作目录** | OD 自己的存储 (`AppData/.../Open Design/.../projects/<id>/`) | ✅ 可预览 | ✅ Write/Edit |
| **链接代码目录** | 用户挂载的只读引用 (如 `D:\frank\TraceyU`) | ❌ 不可见 | ❌ 只读 |

**关键问题**：用户项目的 `design/` 目录在链接代码目录里，OD 能读但不能在右侧面板预览。必须先复制到项目工作目录。

### 提示词中内置的双向同步指令

以下两段写入每份输出提示词：`## 工作区准备`（顶部）和 `## 回写同步`（输出要求末尾）。

```markdown
## 工作区准备

开始设计任务之前，先确保设计文件在你的项目工作目录中（右侧面板可预览）：

1. **检查右侧「设计文件」面板**：是否已有 .html / .css / .js 文件？
2. **如果面板为空**：
   - 从链接的代码目录中读取 design/ 下的所有文件（.html、css/*.css、js/*.js）
   - 将它们写入到你的项目工作目录中（保持相同的目录结构）
   - 写入后右侧面板即可预览
3. **如果面板已有文件**：直接在现有文件基础上修改，不重建
4. **确认**：开始设计任务前，在右侧面板预览至少 1 个 HTML 页面，确认文件已就位
```

```markdown
## 回写同步

所有修改完成后，将改动过的文件同步回链接的代码目录（覆盖原文件）：

1. 对照你修改过的文件清单，逐个将项目工作目录中的最终版本写回链接代码目录的对应路径
2. 只回写**实际改动过的文件**，未动的不碰
3. 回写后报告：哪些文件已同步、每个文件的变更摘要
```

### skill 侧做的事

当检测到项目有 `design/` 目录时：

1. 在提示词的 `## 项目上下文` 段**列出完整文件清单**（文件名 + 页面描述 + 在代码目录中的完整路径），让 OD 知道要复制哪些文件
2. 标注哪些是核心文件（CSS 设计系统、最复杂的 HTML 页面），建议 OD 优先加载和预览这些

---

## §2 · 上下文收集（AskUserQuestion）

### 必问项

| # | 问题 | 选项 | 影响 |
|---|------|------|------|
| 1 | 项目类型 | B 端工具 / C 端消费 / 混合 | 视觉密度、色彩饱和度 |
| 2 | 目标平台 | 桌面 / 移动 / Web / 跨端 | 最小字号、间距基数、布局策略 |
| 3 | 语言环境 | 中文为主 / 英文为主 / 多语言 | 最小字号（中文 ≥12px） |

### 按需问

| # | 问题 | 触发条件 | 默认值 |
|---|------|---------|-------|
| 4 | 品牌色/主色 | 总是问 | 无 → OD 设计 |
| 5 | 字体已确定？ | 总是问 | 无 → OD 选 |
| 6 | 已有设计文件？ | 检测到 design/ 时跳过 | — |
| 7 | 审计范围 | 有项目时 | 全部 10 类 |

---

## §3 · 不变层规则（跨所有项目）

以下规则写入每份输出的提示词中，OD 必须遵守，不可修改。

### 3.0 统一命名规范（Token Naming Convention）

> 名可名，非恒名。但 token 命名必须恒——跨项目统一命名，只有值不同。

**命名模式**：`--{category}-{role}[-{modifier}]`

OD 生成 CSS 变量时**必须使用以下类别前缀和角色名**，不可自创命名。值由项目决定，名字由 dao 统一。

#### 类别前缀总览

| 前缀 | 类别 | 示例 |
|------|------|------|
| `--color-` | 色彩 | `--color-bg`, `--color-fg`, `--color-accent` |
| `--text-` | 字号 | `--text-xs`, `--text-sm`, `--text-base` |
| `--font-` | 字体栈 | `--font-ui`, `--font-body`, `--font-mono` |
| `--radius-` | 圆角 | `--radius-sm`, `--radius-md`, `--radius-lg` |
| `--space-` | 间距 | `--space-1`, `--space-2`, `--space-4` |
| `--elevation-` | 阴影层级 | `--elevation-xs`, `--elevation-md`, `--elevation-xl` |
| `--duration-` | 动效时长 | `--duration-fast`, `--duration-base` |
| `--ease-` | 缓动函数 | `--ease-default` |

#### 色彩角色清单（完整 · 所有项目通用）

| 分组 | 变量名 | 角色说明 |
|------|--------|---------|
| **背景** | `--color-bg` | 最底层背景 |
| | `--color-surface` | 卡片/面板表面 |
| | `--color-surface-alt` | 备选表面 |
| | `--color-sunken` | 下沉/内凹区域 |
| **前景** | `--color-fg` | 主文字 |
| | `--color-fg-secondary` | 次要文字 |
| | `--color-fg-muted` | 弱化文字 |
| | `--color-fg-faint` | 最弱文字/占位符 |
| **边框** | `--color-border` | 默认边框 |
| | `--color-border-soft` | 柔和分隔线 |
| | `--color-border-strong` | 强调边框 |
| **强调** | `--color-accent` | 主品牌/操作色 |
| | `--color-accent-emphasis` | hover/active 加深 |
| | `--color-accent-fg` | 强调色上的文字 |
| | `--color-accent-subtle` | 强调色浅底 |
| **状态** | `--color-success` | 成功 base |
| ×3 组 | `--color-success-subtle` | 成功浅底 |
| success | `--color-success-border` | 成功边框 |
| warning | `--color-success-fg` | 成功前景 |
| danger | （warning / danger 同结构） | 每组 4 层 |
| **画布** | `--color-canvas` | 工作区/编辑器底色（可选） |

#### 字号阶梯（T-shirt）

| 变量名 | 典型值 | 角色 |
|--------|-------|------|
| `--text-xs` | 12px | badge、时间戳、tag、帮助文字 |
| `--text-sm` | 14px | 正文、输入框、按钮、列表 |
| `--text-base` | 16px | 区块标题、对话框标题 |
| `--text-lg` | 20px | 页面标题 |
| `--text-xl` | 24px | 统计数字、hero 指标 |
| `--text-2xl` | 30px | 报告大标题 |

#### 圆角阶梯（T-shirt）

| 变量名 | 典型值 | 角色 |
|--------|-------|------|
| `--radius-xs` | 4px | 微元素（badge、标签内） |
| `--radius-sm` | 6px | 小控件（tag、chip） |
| `--radius-md` | 9px | 默认控件（按钮、输入框） |
| `--radius-lg` | 13px | 面板、卡片 |
| `--radius-xl` | 18px | 大容器、对话框 |
| `--radius-full` | 999px | 药丸/圆形 |

#### 间距阶梯（N × 4px）

| 变量名 | 值 |
|--------|---|
| `--space-1` | 4px |
| `--space-2` | 8px |
| `--space-3` | 12px |
| `--space-4` | 16px |
| `--space-5` | 20px |
| `--space-6` | 24px |
| `--space-8` | 32px |

#### 阴影/层级阶梯

| 变量名 | 角色 |
|--------|------|
| `--elevation-xs` | 贴面微影（hairline） |
| `--elevation-sm` | 轻浮（卡片默认） |
| `--elevation-md` | 悬浮（下拉、弹出） |
| `--elevation-lg` | 弹窗（tooltip、通知） |
| `--elevation-xl` | 遮罩（模态框、抽屉） |

#### 动效

| 变量名 | 角色 |
|--------|------|
| `--duration-fast` | 微交互（100~150ms） |
| `--duration-base` | 过渡（200~300ms） |
| `--duration-slow` | 展开/折叠（400~600ms） |
| `--ease-default` | 主缓动（ease-out 为主） |

### 3.1 字号 Typography

| 规则 | 说明 |
|------|------|
| **≤ 8 级** | 日常 UI ≤5 级，display/hero 额外 2~3 级 |
| **最小 12px**（CJK） | Chrome 中文默认最小 12px |
| **最小 14px**（纯英文） | WCAG 可读性建议 |
| **对齐 Tailwind 内置尺寸** | 12/14/16/18/20/24/30/36px |
| **相邻级差 ≥ 1.5px** | 确保肉眼可辨 |
| **行高**：正文 1.4~1.6，标题 1.1~1.3 | 通用可读性标准 |
| **字重**：仅用 400/500/600 | 过多字重增加复杂度 |
| **命名**：`--text-{t-shirt}` | 见 §3.0 字号阶梯 |

### 3.2 字体 Font Family

| 规则 | 说明 |
|------|------|
| **三栈必备** | `--font-ui`（标题/按钮）、`--font-body`（正文）、`--font-mono`（代码） |
| **系统字体优先** | 减少加载，保持原生感 |
| **中文回退** | CJK 项目须含中文字体回退 |

### 3.3 色彩 Color

| 规则 | 说明 |
|------|------|
| **命名**：`--color-{role}[-{modifier}]` | 见 §3.0 色彩角色清单 |
| **语义状态 ×3** | success / warning / danger，每组 4 层 |
| **亮暗双主题** | CSS 变量 + `data-theme` 切换 |
| **对比度** | 文字/背景 ≥ 4.5:1（WCAG AA） |
| **表面层级** | bg → surface → surface-alt → sunken，至少 3 层 |
| **前景分级** | fg → fg-secondary → fg-muted → fg-faint，至少 3 级 |

### 3.4 间距 Spacing

| 规则 | 说明 |
|------|------|
| **基于 4px** | 所有间距为 4 的倍数 |
| **命名**：`--space-{N}` | N = 倍数（1=4px, 2=8px...），见 §3.0 |
| **Tailwind 内置** | 优先 Tailwind spacing scale |

### 3.5 圆角 Shape

| 规则 | 说明 |
|------|------|
| **命名**：`--radius-{t-shirt}` | xs→sm→md→lg→xl→full，见 §3.0 |
| **3~6 级** | 控件 → 面板 → 容器 → pill |
| **等差或倍数递增** | 不做 1px 微调 |

### 3.6 阴影 Elevation

| 规则 | 说明 |
|------|------|
| **命名**：`--elevation-{t-shirt}` | xs→sm→md→lg→xl，见 §3.0 |
| **3~5 层** | hairline → raised → float → overlay |
| **暗色模式** | 阴影减弱或用边框替代 |

### 3.7 图标 Iconography

| 规则 | 说明 |
|------|------|
| **单一图标库源** | 一个项目只用一个图标库 |
| **描边粗细一致** | 全局统一 stroke-width |
| **尺寸阶梯** | 与字号体系联动：3~4 个尺寸 |

### 3.8 动效 Motion

| 规则 | 说明 |
|------|------|
| **命名**：`--duration-{speed}` + `--ease-{style}` | 见 §3.0 |
| **三档时长** | fast / base / slow |
| **reduced-motion** | 必须有 `prefers-reduced-motion: reduce` 降级 |
| **不做无意义动画** | 动效为反馈服务 |

### 3.9 布局 Layout

| 规则 | 说明 |
|------|------|
| **三种策略** | Cap+Center / Stretch / Multi-column |
| **max-width 必须 mx-auto** | 有上限的内容区必须水平居中 |
| **三视口验证** | min / default / max 视口各截图一次 |

详见 `dao-design-layout` skill。

### 3.10 边框 Border

| 规则 | 说明 |
|------|------|
| **命名**：`--color-border[-{modifier}]` | soft / default / strong，归入色彩体系 |
| **宽度统一** | 1px 为主，不混用 2px/3px |

---

## §4 · 可变层设计清单（OD 的工作）

以下是 OD 需要根据项目上下文做出的设计决策。在输出提示词中，这些以**设计任务**的形式交给 OD。

| # | 设计任务 | B 端倾向 | C 端倾向 |
|---|---------|---------|---------|
| 1 | 字号：在 ≤8 级约束内定义具体阶梯 | 紧凑（12→14→16→20→24→30） | 宽松（14→16→20→24→32→40） |
| 2 | 字体：选择三栈的具体字体 | 工具感（Inter / SF Pro） | 个性化（品牌字体） |
| 3 | 色彩：品牌色、主题色、语义色具体值 | 低饱和、克制 | 高饱和、鲜明 |
| 4 | 间距：基数和密度 | 紧凑（4px 基数为主） | 宽松（8px 基数为主） |
| 5 | 圆角：风格和具体值 | 锐利（4→6→8→12） | 圆润（8→12→16→24） |
| 6 | 阴影：深度和风格 | 轻薄（hairline 为主） | 分明（多层阴影） |
| 7 | 图标：选择图标库和风格 | 线条（Lucide / Phosphor Light） | 填充（Material Filled） |
| 8 | 动效：时长和风格 | 快速、克制 | 丰富、表现力强 |

---

## §5 · 已有项目审计

当检测到项目已有设计资产时，执行审计。

### 审计路径

| 检查目标 | 读取路径 | 方法 |
|---------|---------|------|
| 设计侧 token | `design/css/*.css` | 提取 CSS 变量和 font-size 值 |
| 代码侧 token | `**/index.css` + `tailwind.config.*` | 提取 CSS 变量和 theme.extend |
| 已有规范 | `.claude/rules/design-*.md` | 读取已沉淀的规范文件 |
| **命名合规** | 所有 CSS 变量定义 | 对照 §3.0 统一命名规范，标记不合规命名 |
| 字号合规 | 全局 grep `font-size` / `text-` | 统计 token 使用率 vs 硬编码率 |
| 色彩合规 | grep 硬编码色值 `#[0-9a-f]` / `rgb(` | 应全部走 CSS 变量 |

### 命名迁移映射

已有项目的旧命名需迁移到 §3.0 统一规范。审计时自动生成迁移映射表：

| 类别 | 旧命名模式 | 新命名模式 | 示例 |
|------|-----------|-----------|------|
| 色彩 | `--bg`, `--fg-2`, `--muted` | `--color-bg`, `--color-fg-secondary`, `--color-fg-muted` | `--accent-on` → `--color-accent-fg` |
| 字号 | `--fs-xs`, `--fs-base` | `--text-xs`, `--text-sm` | `--fs-lg` → `--text-base` |
| 圆角 | `--r-sm`, `--r-md` | `--radius-md`, `--radius-lg` | `--r-pill` → `--radius-full` |
| 间距 | `--sp-1`, `--sp-2` | `--space-1`, `--space-2` | 前缀改变 |
| 阴影 | `--shadow-xs`, `--shadow` | `--elevation-xs`, `--elevation-md` | `--shadow-pop` → `--elevation-lg` |
| 动效 | `--t-fast`, `--ease` | `--duration-fast`, `--ease-default` | 前缀改变 |

**迁移策略**：设计侧（`design/css/*.css`）和代码侧（`index.css` + `tailwind.config`）同步迁移。OD 改设计文件命名，AI 改代码侧命名，确保双向一致。

### 合规判定

| 级别 | 含义 | 处理 |
|------|------|------|
| ✅ 合规 | 完全符合不变层规则 | 无需改动 |
| ❌ 违规 | 不符合不变层规则 | **必须改造**，生成改造提示词 |
| ⚠️ 建议 | 可变层有优化空间 | 建议改善，用户决定 |

### 违规必须改造（硬规则）

不合规项不存在"先这样"的选项。必须生成改造提示词交给 OD 执行。

### 豁免机制

仅以下场景可豁免，且必须用户确认后记录：

| 豁免条件 | 记录位置 |
|---------|---------|
| 第三方 UI 库内置样式不可改 | `.claude/rules/design-system-exemptions.md` |
| 遗留系统逐步迁移（标注截止日期） | 同上 |
| 平台强制约束（如 iOS 系统字号） | 同上 |

豁免 ≠ 免改，是标记了有计划改。

---

## §6 · 输出格式

Skill 最终输出一份 Markdown 格式的提示词，结构如下：

```markdown
# [项目名] 设计系统基础层

## 工作区准备

开始设计任务之前，先确保设计文件在你的项目工作目录中（右侧面板可预览）：

1. **检查右侧「设计文件」面板**：是否已有 .html / .css / .js 文件？
2. **如果面板为空**：
   - 从链接的代码目录中读取 design/ 下的所有文件（.html、css/*.css、js/*.js）
   - 将它们写入到你的项目工作目录中（保持相同的目录结构）
   - 写入后右侧面板即可预览
3. **如果面板已有文件**：直接在现有文件基础上修改，不重建
4. **确认**：开始设计任务前，在右侧面板预览至少 1 个 HTML 页面，确认文件已就位

## 项目上下文
- 类型：[B端/C端]
- 平台：[桌面/移动/Web]
- 语言：[中文/英文/多语言]
- 品牌色：[已确定值 / 待设计]
- 字体：[已确定 / 待选]

[有 design/ 时追加]
### 现有设计文件（在链接代码目录中）
| 文件路径 | 页面描述 | 核心？ |
|---------|---------|-------|
| [逐个列出 design/ 下的文件完整路径] | [页面说明] | [CSS 系统/主页面 标 ⭐] |

> 以上文件在链接的代码目录中。如果右侧面板为空，请按「工作区准备」步骤将它们写入项目工作目录后再开始。

### 现状审计
[每类 token 的合规状态 + 具体数据]

## 命名规范（铁律）

所有 CSS 变量必须使用以下标准命名，不可自创。值由你设计，名字不可改。

| 类别 | 前缀 | 命名模式 | 示例 |
|------|------|---------|------|
| 色彩 | `--color-` | `--color-{role}[-{modifier}]` | `--color-bg`, `--color-fg-secondary`, `--color-accent` |
| 字号 | `--text-` | `--text-{t-shirt}` | `--text-xs`(12px), `--text-sm`(14px), `--text-base`(16px) |
| 字体 | `--font-` | `--font-{role}` | `--font-ui`, `--font-body`, `--font-mono` |
| 圆角 | `--radius-` | `--radius-{t-shirt}` | `--radius-sm`, `--radius-md`, `--radius-full` |
| 间距 | `--space-` | `--space-{N}` (N×4px) | `--space-1`(4px), `--space-4`(16px) |
| 阴影 | `--elevation-` | `--elevation-{t-shirt}` | `--elevation-xs`, `--elevation-md` |
| 动效 | `--duration-` / `--ease-` | `--duration-{speed}` | `--duration-fast`, `--ease-default` |

色彩完整角色清单：bg / surface / surface-alt / sunken / fg / fg-secondary / fg-muted / fg-faint / border / border-soft / border-strong / accent / accent-emphasis / accent-fg / accent-subtle / success×4 / warning×4 / danger×4

[有旧命名时追加]
### 命名迁移
| 旧变量 | 新变量 |
|--------|--------|
| [逐个列出旧→新映射] |

## 规则（必须遵守）
[从 §3 不变层规则中输出与本项目相关的规则]

## 设计任务
[从 §4 可变层中输出本项目需要 OD 设计的任务清单]

## 输出要求
1. 新 token 表：每类给出 token 名 / 值 / CSS 变量 / 适用角色（**变量名必须符合命名规范**）
2. 迁移映射（有现有 token 时）：旧变量名 → 新变量名 + 新值对照表
3. 在设计文件中应用新体系（工作区有文件时）
4. 审计报告（有改动文件时）：每个文件的变更摘要

## 回写同步

所有修改完成后，将改动过的文件同步回链接的代码目录（覆盖原文件）：

1. 对照你修改过的文件清单，逐个将项目工作目录中的最终版本写回链接代码目录的对应路径
2. 只回写**实际改动过的文件**，未动的不碰
3. 回写后报告：哪些文件已同步、每个文件的变更摘要
```

---

## §7 · 设计流水线（Design Pipeline）

> 道生一，一生二，二生三，三生万物。
> 五个 skill 是一条流水线，不是五个孤岛。

### 全生命周期

```
                    ┌─────────────────────────────────────────────┐
                    │            Design Pipeline                   │
                    │                                              │
  Phase 0           │  Phase 1          Phase 2         Phase 3    │
  ┌──────────┐      │  ┌──────────┐     ┌──────────┐   ┌────────┐ │
  │ design-  │──OD──│→ │ design-  │──→  │ design-  │──→│ comp-  │ │
  │ system   │ 提示词│  │ open     │代码  │ fidelity │   │ radar  │ │
  │ (基础层) │      │  │ (翻译)   │     │ (验证)   │   │ (健康) │ │
  └──────────┘      │  └──────────┘     └──────────┘   └────────┘ │
       │            │       │                                      │
       │            │  ┌──────────┐                                │
       └───────────────│ design-  │ (布局子系统，任何 Phase 可调用) │
                    │  │ layout   │                                │
                    │  └──────────┘                                │
                    └─────────────────────────────────────────────┘
```

### 阶段说明

| Phase | Skill | 职责 | 输入 | 输出 | 触发条件 |
|-------|-------|------|------|------|---------|
| 0 | **dao-design-system** | 定义基础层 + 生成 OD 提示词 | 用户上下文 | OD 提示词 | 新项目 / 设计体系缺失 / 用户调用 |
| 1 | **dao-design-open** | 读 OD 产出 → 翻译为 React | `design/` 目录 | 代码 + project token | UI 任务涉及 design/ |
| 2 | **dao-design-fidelity** | L1~L5 逐层验证 | 代码 + 设计截图 | 偏差报告 | UI 变更完成后 / Loop 归档前 |
| 3 | **dao-component-radar** | 组件提炼 + token 冲突 | 代码 | 健康报告 | 编辑 tsx 文件时 |
| — | **dao-design-layout** | 布局行为规约 | 页面列表 | 布局策略 + layout token | 任何 Phase 需要布局决策时 |

### 编排规则（AI 必须遵循）

**Phase 0 → Phase 1 衔接**：
- design-system 输出提示词后，用户将提示词交给 OD
- OD 产出落入 `design/` 目录后，自动触发 dao-design-open
- design-system 的不变层规则成为 design-open 翻译时的合规基线

**Phase 1 → Phase 2 衔接**：
- design-open 翻译完成后，必须跑 dao-design-fidelity L1（token 合规）
- 声明完成前必须至少通过 L1+L2

**Phase 2 → Phase 3 衔接**：
- fidelity 验证发现组件级问题（原生 HTML 应组件化）→ 触发 component-radar
- component-radar 发现 token 冲突 → 反馈回 design-system 的豁免列表

**dao-design-layout 横切**：
- Phase 0：layout 是 10 类基础之一，design-system §3.9 引用 layout skill 的方法论
- Phase 1：design-open 翻译布局时，查 layout skill 的三种策略
- Phase 2：fidelity 验证需含三视口检查（layout skill 定义的 min/default/max）

### 用户入口（只有 2 个）

用户日常只需接触两个 skill，其余自动运行：

| 入口 | 何时用 | 频率 |
|------|-------|------|
| `/dao-design-system` | 新项目建基础层 / 设计体系升级 | 低频 |
| `/dao-design-open` | 日常 Design→Code 翻译 | 高频 |

`dao-design-fidelity` 和 `dao-component-radar` 由 design-open §4.5 auto-gate 自动触发，无需手动调用。独立调用仅限全面审计场景（Loop 归档、设计体系大改）。

`dao-design-layout` 是横切子系统，被 design-system §3.9 和 design-open 内部引用。

### 典型场景

**场景 A：新项目从零开始**
```
用户: /dao-design-system  → AskUserQuestion → 输出 OD 提示词
用户: 复制给 OD           → OD 产出 design/
用户: /dao-design-open    → 翻译为代码
                          → §4.5 auto-gate 自动跑 fidelity L1 + radar 检查
                          → 声明完成
```

**场景 B：已有项目设计体系升级**
```
用户: /dao-design-system  → 审计现有 token → 输出改造提示词
用户: 复制给 OD           → OD 更新 design/
用户: /dao-design-open    → 增量翻译 + auto-gate
```

**场景 C：日常 UI 开发**
```
用户编辑 tsx 文件  → design-open 按需触发（涉及 design/）
                   → §4.5 auto-gate 自动验证
                   → 声明完成
```

**场景 D：全面审计（Loop 归档 / 版本发布）**
```
独立调用 /dao-design-fidelity   → L1~L5 全金字塔验证
独立调用 /dao-component-radar   → 全项目组件健康扫描
```

---

## §8 · 演化

本 skill 的不变层规则基于 2026 年行业共识：

- Ant Design 字号阶梯（12→14→16→20→24→32）
- Material Design 3 token 三层架构（Reference → System → Component）
- W3C Design Tokens Specification v1（2025.10）
- WCAG 2.1 AA 对比度标准

规则随行业演化更新，但保持**减法原则**——只在有充分理由时增加规则。
