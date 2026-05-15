# dao-ui-mockup · 调用示例

> 见诸行而知诸言。例子永远比定义有说服力。

## 调用模板

### 完整流程（v0.2 · 六步法 · 推荐）

```
用户："帮我重设计 TraceyU 的主题，目前的样式太丑"
     ↓
AI（在 /dao-superpowers 第 2 步前）：
  1. 加载 dao-ui-mockup
  2. 一·察 → 读 d:/frank/TraceyU/AGENT_GUIDE.md + TODO.md + src/index.css + src/App.tsx
            产出：项目画像（追问式 brainstorm 工具 / 桌面端 / 4 个主要场景 / 长文阅读 + 卡片操作并重）
  3. 二·援 → fetch https://github.com/VoltAgent/awesome-design-md
            按画像（Productivity/SaaS + AI Platforms）筛 4 候选 + 附原描述：
            ┌────────────────────────────────────────────────────────┐
            │ # │ 项目     │ awesome-design-md 原描述                │
            ├────────────────────────────────────────────────────────┤
            │ 1 │ Notion   │ Warm minimalism, serif headings, soft  │
            │ 2 │ Claude   │ Warm terracotta accent, editorial      │
            │ 3 │ Linear   │ Ultra-minimal, precise, purple accent  │
            │ 4 │ Raycast  │ Dark gradient, command-bar aesthetics  │
            └────────────────────────────────────────────────────────┘
            主动给推荐组合：
              - 组合 α：Notion 字体骨 + Claude terracotta 彩（fusion）
              - 组合 β：以 Linear 为骨（single · 工具系标杆）
              - 组合 γ：四个各 1 套并列（parallel · 选择疲劳但全景对比）
            🔒 ask_user_question 等用户拍板 refCombo
  4. 三·拟 → 基于拍板的 refCombo 合成方向（color/typography/spacing 都从参考 DESIGN.md 抽取）
            如选「组合 α」→ 主推 1 套 + 微调 1 个深色变体
            如选「组合 γ」→ 4 套各自独立
  5. 四·显 → 生成 _tmp/ui-mockup-traceyu-theme-2026-05-16.html
            含方向标签页切换 / 暗色切换 / 5 层组件 / 4 个真实场景
  6. 五·择 → "请在浏览器打开 file:///.../_tmp/ui-mockup-traceyu-theme-2026-05-16.html
            选定方向 或 告诉我微调"
            🔒 等用户响应
  7. 六·固 → 用户选定后导出 3 个文件喂给 dao-plan
            _tmp/design-tokens-traceyu-theme.json
            _tmp/index-css-draft.css
            _tmp/component-deltas.md
```

### 快速对比模式（Mode A · Style Tile）

用户场景：「先快速看几个方向，不要细节」

```
用户："给我 2 个风格快速对比一下，先看大方向"
     ↓
AI 简化流程：
  - 二·援 仍走（这步不可省略，源头不可凭空发明）但候选压到 2-3 个
  - 三·拟 → 四·显（生成简化版 HTML，仅 Foundations + 1 个场景）
  - 跳过 Atoms/Molecules/Organisms 的完整组件库
  - 让用户在 1-2 分钟内拍板大方向
  - 选定后再启完整流程做细化（Mode B · Style Guide）
```

### refCombo 拍板对话样板

```
AI（援步骤末尾必走 ask_user_question）：

  从 awesome-design-md 60+ 真实项目里，按 TraceyU 画像（思考工具 / 桌面端 /
  长文 + 卡片并重）筛了 4 候选：Notion / Claude / Linear / Raycast。

  我主动给三个推荐组合：

    α  Notion 字体骨 + Claude terracotta 彩（fusion · 温暖编辑器气质）
    β  以 Linear 为骨（single · 极简工具气质）
    γ  四个各 1 套并列（parallel · 选择疲劳但全景对比）

  您选哪个？或者推翻重选（请告诉我什么气质方向）。

  [选项]
    1. 走 α
    2. 走 β
    3. 走 γ
    4. 都不对，我想要 <气质>
```

## 真实任务

### 任务 1 · TraceyU 主题改造

> 2026-05-16 创建本 skill 的源任务。

- **触发语**：「目前主题样式太丑，需要有设计感」
- **项目**：[d:/frank/TraceyU](file:///d:/frank/TraceyU)
- **走完整流程**：察 → 援 → 拟 → 显 → 择 → 固
- **预期产出**：`_tmp/ui-mockup-traceyu-theme-<ts>.html`

更多任务实战会在使用过程中累积写入此处。

## 反例（什么时候不调用）

| 场景 | 为什么不调用 |
|---|---|
| "把按钮颜色改成蓝色" | 单组件级微调，直接做 |
| "新增一个 React Hook" | 纯逻辑，无视觉决策 |
| "修复测试" | 不涉及 UI |
| "已经有 design tokens 文件了" | 跳过本 skill 直接 dao-plan |
| "做一个全新页面" | 走 /dao-dev（含基建审计/前端处方/文档生成全管线），dao-dev 在视觉阶段会自动调本 skill |

## 与 /dao-dev 的协作示意

```
/dao-dev 启动（新功能/页面）
  ↓
一 · 谋
  ├─ 析（需求分析）
  └─ 设（架构设计）
      └─ 设计阶段含 UI？是 → 调用 dao-ui-mockup（本 skill）
                              ↓
                         产出 design tokens
                              ↓
                         回到 /dao-dev 继续
  ↓
二 · 造（编 → 筑 → 部）
  └─ 编码引用 _tmp/design-tokens-*.json 作 ground truth
  ↓
三 · 成（试 → 验 → 书）
```

## 与 /dao-superpowers 的协作示意

```
/dao-superpowers 启动（核心改动）
  ↓
第 1 步 · 隔（worktree）
  ↓
第 2 步 · 谋
  ├─ 2.0 · 形（dao-ui-mockup · UI 任务专用·六步法）⭐
  │   ├─ 一·察　→ 项目画像
  │   ├─ 二·援　→ awesome-design-md 筛 3-5 候选 + 拍板 refCombo 🔒
  │   ├─ 三·拟　→ 基于 refCombo 合成 N 套方向
  │   ├─ 四·显　→ 生成 _tmp/ui-mockup-<topic>-<ts>.html
  │   ├─ 五·择　→ 用户拍板方向 🔒
  │   └─ 六·固　→ 导出 design tokens / index-css-draft / component-deltas
  └─ 2.1 · 写 plan（plan 第一句话引用 tokens 路径）
  ↓
第 3 步 · 造（implementer 拿 tokens + mockup HTML 作 ground truth）
  ↓
第 4 步 · 审（reviewer 对照 mockup 验收视觉一致性）
  ↓
第 5 步 · 归
```
