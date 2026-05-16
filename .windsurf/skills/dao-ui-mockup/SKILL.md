---
name: dao-ui-mockup
description: UI 高保真 mockup 生成术——先从 VoltAgent/awesome-design-md 收录的真实项目视觉哲学中筛贴近候选(Notion/Linear/Claude/Figma 等)让用户拍板参考源，再生成单 HTML 文件含 N 套完整设计方向(色板/字体/组件库/真实页面)，让用户在浏览器对比拍板，然后导出 design tokens 喂给 dao-plan。涉及主题/色板/视觉重设计/UI 重构/换肤等任务时自动加载。融入 /dao-superpowers 第 2 步前置「2.0 · 形」。
---

# 形 · UI Mockup Lens

> 无状之状，无物之象，是谓惚恍。——《道德经》第 14 章
>
> 大象无形。——第 41 章
>
> 让无形的设计语言显形，让用户看见之后再决策。

设计稿先于代码。AI 描述的"暖米白 + 深墨蓝 + 金箔"再生动，不如让用户在浏览器里直接看见一套完整的 mockup。**形**这一步把抽象设计语言翻译成可视的高保真 mockup，让选择基于"看见的"而不是"想象的"。

**关键改进 · v0.2**：方向不凭空发明——先从 [VoltAgent/awesome-design-md](https://github.com/VoltAgent/awesome-design-md) 收录的 60+ 真实公司视觉系统中筛贴近候选给用户拍板，再合成 mockup。借力业内已验证的设计哲学，胜过 AI 闭门造车。

## 适用场景

**自动激活**：

- 任务关键词含：主题/样式/色板/视觉/重设计/换肤/UI 重构/首屏改版/界面优化/Theme/Style
- 用户说"看不同方案/给我画几个版本/生成设计稿/对比下/style tile/mockup"
- 在 `/dao-superpowers` 工作流中，第 2 步「谋」激活前，任务被识别为 UI 视觉决策类
- 项目根存在前端入口（`package.json` 含 React/Vue/Svelte/Vite/Tailwind 等）

**不激活**：

- 纯逻辑/数据/后端任务
- 已有明确视觉方向（用户提供完整 design tokens 或 mockup 图）
- 单组件级微调（"改这个按钮的颜色"）→ 直接做

## 铁律

```
不让用户看见 mockup，不进 dao-plan。
mockup 不是图，是真实可运行的 HTML。
mockup 用项目真实文案 + 真实数据结构 + 项目可实现的 CSS。
mockup 选定后必导出 design tokens，作为 dao-execute 的 ground truth。
```

**HARD-GATE**：用户未审定 mockup 之前，**不**写实施 plan、不动样式代码。

> 防止"设计稿漂亮但代码走样"——业界公认 AI 生成 UI 的头号失败模式。对治：**mockup 即实施 ground truth**，导出 tokens 文件供 dao-plan/dao-execute 引用。

## 六步法

### 一、察（☲视 · 项目上下文分析）

> 知人者智，自知者明。先认识项目本身。

不读项目就生成 mockup = 闭门造车。**必须**完成以下扫描：

| 扫描项 | 文件 | 提取什么 |
|---|---|---|
| 产品定位 | `README.md` / `AGENT_GUIDE.md` 第一段 | 一句话本质 + 目标用户 |
| 当前阶段 | `TODO.md` / `docs/specs/*-plan.md` | 已完成 / 进行中 / 未来要做的功能 |
| 技术栈 | `package.json` + `tailwind.config.*` + `components.json` | React/Vue 版本、CSS 方案、shadcn 风格 |
| 现有视觉 | `src/index.css` / `src/App.tsx` / 主题文件 | 当前 design tokens、字体、布局 |
| 关键场景 | `src/components/` + 主入口组件 | 用户最常看到的 2-3 个界面 |
| 现状截图（可选） | chrome MCP 跑 dev server | 当前 UI 真实长相 |

**产出**：`项目画像`——一段文字描述项目调性 + 主要场景列表。

**反模式**：跳过这步直接生成 mockup → 出来的是通用模板，不像这个项目。

### 二、援（☱兑 · 借鉴业内已验证视觉哲学）

> 善用人者为之下。借力已验证的设计系统，胜过凭空发明。

**核心动作**：从 [VoltAgent/awesome-design-md](https://github.com/VoltAgent/awesome-design-md) 收录的真实项目 DESIGN.md 中按「察」画像 + 用户审美锚点筛 3-5 个候选，附**原描述**给用户拍板参考源。

**为何必须**：上一代「拟」基于 AI 凭空发明 N 套方向——失之表面、易跑偏。awesome-design-md 收录 60+ 经过大规模生产验证的真实公司视觉系统，借它们起步比凭空想象可靠。这是 v0.2 的核心改进。

**资源入口**：

| 入口 | 内容 |
|---|---|
| `https://github.com/VoltAgent/awesome-design-md` | 主索引 + 分类 README |
| `https://getdesign.md/<slug>/design-md` | 单项目完整 DESIGN.md + preview.html + preview-dark.html |
| `https://stitch.withgoogle.com/docs/design-md/format/` | DESIGN.md 标准格式（Google Stitch 规范） |

**8 个分类速查**（节选旗舰，完整清单先 fetch 仓库 README）：

- **AI & LLM Platforms**：Claude（warm terracotta editorial）· Mistral（French minimalism purple）· VoltAgent（void-black emerald terminal-native）· xAI（stark monochrome）· Ollama（terminal-first monochrome）
- **Developer Tools & IDEs**：Vercel（B&W precision Geist）· Raycast（dark gradient）· Cursor（AI-first gradient dark）· Warp（block-based terminal）· Superhuman（premium dark purple glow）
- **Productivity & SaaS** ⭐：Linear（ultra-minimal purple）· **Notion**（warm minimalism serif soft）· Cal.com（clean neutral）· Mintlify（reading-optimized green）· Intercom（friendly blue conversational）
- **Design & Creative Tools** ⭐：**Figma**（vibrant multi-color playful pro）· Framer（black-blue motion-first）· Clay（organic soft gradients）· Airtable（colorful friendly data）· Miro（bright yellow infinite canvas）
- **Backend / DB / DevOps**：Supabase（dark emerald code-first）· Sanity（dark editorial coral 112px display）· Sentry（dark data-dense pink-purple）· ClickHouse（yellow technical docs）
- **Fintech & Crypto**：Stripe（purple gradient weight-300）· Coinbase（clean blue trust）· Wise（bright green clear）· Mastercard（warm cream orbital pill）
- **E-commerce & Retail**：Airbnb（warm coral photography）· Shopify（dark cinematic neon green）· Starbucks（earth-green cream proprietary）· Nike（monochrome Futura full-bleed）
- **Media / Consumer Tech / Auto**：Apple（white SF Pro premium）· Spotify（vibrant green dark）· Tesla（radical subtraction）· WIRED（paper-white broadsheet serif）· Runway（cinematic dark editorial）

**筛选流程**：

1. **按项目类型映射** → 「察」步骤画像决定主分类（如 brainstorm 工具 → Productivity/SaaS + AI Platforms 优先）
2. **按用户审美锚点过滤** → 如用户表达"喜欢 Figma + Notion 这种"则锁定同审美的项目
3. **保留多样性** → 3-5 候选含至少 2 种气质差异（如"温暖编辑器" vs "工具克制"）
4. **必附原描述** → awesome-design-md 的 one-liner 是"已验证"的浓缩，缺则失锚点

**推荐表格模板**（必含 4 列）：

```markdown
| # | 项目 | awesome-design-md 原描述 | 为何推荐 <项目名> | 匹配度 |
|---|---|---|---|:---:|
| 1 | Notion | Warm minimalism, serif headings, soft surfaces | 同领域思考工具 | ⭐⭐⭐⭐⭐ |
| 2 | Claude | Warm terracotta accent, clean editorial layout | LLM 同源审美 | ⭐⭐⭐⭐⭐ |
| 3 | Figma | Vibrant multi-color, playful yet professional | 多彩三池色参考 | ⭐⭐⭐⭐ |
| 4 | Linear | Ultra-minimal, precise, purple accent | 工具型用户标杆 | ⭐⭐⭐⭐ |
```

**推荐组合策略**（AI 主动给至少 2 个推荐组合）：

- **单参考**：以某项目为唯一骨架（如 "以 Notion 为骨"）
- **组合 2 · 骨+彩**：A 为骨架（字体/布局） + B 为彩（accent 色）—— 如 "Notion 字体骨 + Claude terracotta 彩"
- **并列 N**：N 个候选各自出 1 套独立 mockup 让用户对比挑

**用户拍板模式**（必走 `ask_user_question`）：

- 选某个推荐组合 → 进「拟」
- 微调（选定 + 换色/字体）→ 进「拟」时带 override
- 推翻（候选都不满意）→ 带新偏好回本步重筛（必问"什么气质方向才是你想要的？"）

**产出**：`refCombo` 内存对象，形如：

```json
{
  "strategy": "fusion" | "single" | "parallel",
  "refs": ["notion", "claude"],
  "role": { "notion": "skeleton", "claude": "accent" },
  "overrides": { "accent": "#10B981" },
  "userNote": "..."
}
```

**反模式**：

- ❌ 跳过本步直接「拟」→ 凭空发明，失之表面（v0.1 的病根）
- ❌ 推荐 awesome-design-md 未收录的项目 → 失"已验证"价值
- ❌ 不附原描述 → 用户没法判断为什么推荐
- ❌ >5 候选 → 选择疲劳，不如精选 3-4
- ❌ 不给推荐组合（只丢一张候选表）→ 用户得自己拼，违背 AI 应主动思考

### 三、拟（☶艮 · 设计方向拟定）

> 治之于未乱。多个方向先在脑里过一遍，再落到 HTML。

基于「援」拍板的 `refCombo` + 「察」得到的项目画像，合成 N 套设计方向。N 与 strategy 同步：

- `single` 或 `fusion` 策略 → N=1（合成 1 套主推方向 + 可选 1-2 个微调变体）
- `parallel` 策略 → N=用户选定的参考数（每个参考独立 1 套）

**关键**：方向不再是 AI 凭空命名，而是直接借用参考项目的视觉哲学（color/typography/spacing/radius/elevation 都从参考 DESIGN.md 抽取）+ 项目调性微调。每个方向必含：

```yaml
direction:
  id: a | b | c
  name: 方向名（如"学院派纸感" / "极简空气流" / "暗夜思绪"）
  inspiration: 灵感参考（如"Typora" / "Linear" / "Raycast"）
  vibe: 一句话气质（如"克制、阅读舒适、学者气质"）
  fit: 适合谁（如"深度写作型用户" / "工具型用户"）
  tokens:
    colors:
      light: { background, foreground, primary, accent, muted, success, warning, danger, surface, border }
      dark:  { 同上 }
    typography:
      display: { family, size, weight, lineHeight, letterSpacing }
      h1: { ... }
      h2: { ... }
      body: { ... }
      caption: { ... }
      mono: { ... }
    spacing: [4, 8, 12, 16, 24, 32, 48, 64]
    radius: { sm, md, lg, xl, full }
    elevation: { flat, low, mid, high }   # box-shadow 4 级
    motion: { duration_fast, duration_normal, duration_slow, easing }
```

**多样性原则**：N 个方向之间必须**显著不同**（不只是色相微调）：

- 至少 1 个明亮系 + 1 个深色系
- 至少 2 种字体气质（衬线 vs 无衬线 vs Mono 主导）
- 至少 2 种 elevation 哲学（flat 极简 vs 多层堆叠）
- 给用户**真选择**，不是"3 个相似方向"

**产出**：N 套 design tokens（结构化 YAML/JSON 在内存中，不落盘）。

### 四、显（☳触 · 生成 mockup HTML）

> 大象无形，转其形而显之。让设计在浏览器里活过来。

读模板 `templates/mockup.html`，注入 N 套 tokens 和项目场景，生成单 HTML 文件。

**输出位置**：`_tmp/ui-mockup-<topic>-<timestamp>.html`

**HTML 必含结构**（按 Atomic Design 5 层 + 项目场景）：

```
顶栏（sticky）：
  ├─ 方向标签页 [A 名字] [B 名字] [C 名字]    → 切换激活方向
  ├─ 暗色切换 ☼/☾                              → 全方向同步切换
  └─ "导出选定方向"按钮                        → 触发 tokens JSON 复制

每个方向的 panel（标签页激活时显示）：
  
  ┌─ 元信息卡 ────────────────────────────────────────┐
  │ 名字 · 灵感 · 一句话气质 · 适合谁 · 关键 4 色样   │
  └────────────────────────────────────────────────────┘
  
  ┌─ Foundations ─────────────────────────────────────┐
  │ Colors（含 hex/hsl 标注 + WCAG 对比度徽章）       │
  │ Type scale（每级配真句子，覆盖中英文）            │
  │ Spacing（横条带数值标注）                         │
  │ Radius（5 个圆角矩形示例）                        │
  │ Elevation（4 级 shadow 立体卡）                   │
  │ Motion（hover 真实动效演示）                      │
  └────────────────────────────────────────────────────┘
  
  ┌─ Atoms ───────────────────────────────────────────┐
  │ Button: primary/secondary/outline/ghost/destructive│
  │         × default/hover/disabled/loading 4 态      │
  │ Input · Label · Badge · Icon · Avatar · Switch    │
  └────────────────────────────────────────────────────┘
  
  ┌─ Molecules ───────────────────────────────────────┐
  │ Form field / Search bar / Menu item / Toast /     │
  │ Dropdown / Tooltip                                 │
  └────────────────────────────────────────────────────┘
  
  ┌─ Organisms ───────────────────────────────────────┐
  │ Navigation bar / Card with actions / Dialog /     │
  │ Sidebar / Empty state / Toolbar                    │
  └────────────────────────────────────────────────────┘
  
  ┌─ Live Scenes（项目真实场景）─────────────────────┐
  │ 场景 A: 主界面（用项目实际文案 + 实际数据结构）   │
  │ 场景 B: 次要界面                                   │
  │ 场景 C: 即将做的功能（从 TODO 推断）              │
  └────────────────────────────────────────────────────┘
  
  ┌─ Design Tokens 一览（折叠） ─────────────────────┐
  │ 完整 JSON 形式，"复制"按钮                         │
  └────────────────────────────────────────────────────┘
```

**技术约束**（避免落地走样）：

- ✅ **单文件**：所有 CSS / JS / 字体 fallback 内嵌，无外部 CDN（防离线/网络）
- ✅ **CSS variables 切换**：方向切换用 `:root[data-direction="a"] { --bg: ... }` 模式
- ✅ **暗色模式**：`:root[data-theme="dark"][data-direction="a"]` 双维度
- ✅ **真实文案**：从 TODO/AGENT_GUIDE 摘录，不用"Lorem Ipsum"
- ✅ **真实组件结构**：用项目的 React 组件层级（sidebar/main/dialog），不用通用模板
- ✅ **可实现性自检**：所有视觉效果必须能用项目现有 CSS 方案（Tailwind/styled）实现

**反模式**：

- ❌ 用 CDN 拉 Tailwind/Lucide → 离线打不开
- ❌ 用复杂 SVG 滤镜/3D 变换 → 落地实现成本高
- ❌ 通用占位文案 → 失去"这是我项目"的代入感

### 五、择（🔒 关卡 · 用户审视并选定）

> 知止不殆。让用户在浏览器看完，做出决定。

打开 mockup HTML（chrome MCP 或告知路径让用户手开），等用户审视。

**给用户的提示模板**：

```
✅ mockup 已生成：file:///<absolute-path>/_tmp/ui-mockup-<topic>-<ts>.html

请在浏览器打开后，审视：
- N 个方向的色板是否符合项目调性
- 字体是否易读（覆盖中英文混排）
- Live Scenes 里的真实场景是否好看
- 暗色模式下是否仍然舒适

审视完告诉我：
1. 选定哪个方向（A / B / C）？
2. 有什么微调？（如"B 但 accent 换紫色" / "A 但圆角更大"）
3. 有完全推翻的方向吗？（推翻 → 我重新生成）
```

**🔒 用户必须**：明确说"选 X"或"用 B + 调 Y"。
**AI 不可**：自己替用户选 / 跳过这步进 plan。

如用户要微调 → 修改对应方向的 tokens → 重新生成 mockup HTML（同名覆盖或新版本）→ 再审。

如用户要重新出方向 → 回第三步「拟」；如要重新选参考源 → 回第二步「援」。

### 六、固（☴巽 · 导出 + 验证闭环）

> 慎终如始。把已选方向固化成可被消费的产物。**实施完必回头对照——闭环才能涅槃**。

#### 档 0 · 默认行为（肌肉记忆 · 无需思考）

> 道法自然。这些不是「检查项」，是 AI 写代码时的呼吸。

UI 实施前 AI 已内化的默认动作（不需每次想起）：

- **跟 spec 走，不靠估算** —— mockup 写啥就实施啥。判断「实际渲染像素」「字体表现」「对比度」「视觉密度」必跑 chrome MCP / playwright 量 computed style，禁 calculator 思维（如 `rem × 16 = 12.8 ≈ 合规`）
- **a11y 是底线** —— 写字号 < 12px 直接不写（无论 mockup 给啥）。`text-xs` 是最小，不用 `text-[10px]`/`text-[11px]`
- **shadcn 项目里写 form element 第一查 `ui/`** —— `<select>`/`<textarea>`/`<input>`/`<button>` 须先看 `components/ui/<name>.tsx`，无则用项目已用的 Primitive 库（`@base-ui/react` / `@radix-ui`）创建 wrap，**不写原生**
- **任何前端项目 `index.css` / `globals.css` 必显式 `html { font-size: 16px }`** —— 不依赖浏览器默认（防用户改 chrome://settings 默认字号 / 防 DPI 异常）。1rem = 16px 显式锚定 Tailwind step 基准

**这些是「行为」不是「规则」**——若哪天 AI 又写出 `text-[10px]` 或原生 `<select>`，根因不在「忘了看规则」，而在「肌肉记忆没建立」。修法：实战中犯一次 + lesson 沉淀 + 这段强化（如本段当前 4 条肌肉记忆来自 lessons T35/T36/T37）。

#### 档 1 · AI 必自决（不问）

> 道常无为而无不为。技术决策由 AI 自决，不再增用户负担。

- shadcn/ui 标准 token 名映射（`--primary` / `--accent` / `--ring` 等）按"含义对齐"映射——mockup 里 `--accent`（CTA 主色）映射到 shadcn 的 `--primary`，而不是字面同名的 shadcn `--accent`（hover 浅底色）
- HSL 三分量字符串转换（hex → `H S% L%`）：直接算
- 生态色（`success` / `warning` / `danger` 及 `-surface`）：沿用项目现有色系微调，参考源未提供则不强行套
- 项目特有装饰（如 `workspace-grid`、`surface-raised`）：跟随主色族变调，在 `component-deltas.md` 标注"如要保留历史色记忆请告知"作为 followup
- letter-spacing / shadow 风格 / radius scale 等"超出 shadcn token 表"的项：AI 自决合理值，落到 `component-deltas.md` 与 `index-css-draft.css`

**档 2 · AI 默认偏好（不问，按以下原则）**

- **改动量最小**：项目现有字体/radius/字距与参考源差异 < 5% 可辨度时，沿用现状（fallback 链可加参考源字体作 graceful enhancement）
- **含义对齐**：mockup token 的"角色"（CTA / hover 底 / 边线 / 文字）映射到 shadcn 同角色 token，不按字面相同 token 名硬塞
- **装饰沿用**：项目自加的装饰 utility（radial gradient / 特殊阴影）跟随主色族变调，保留装饰结构本身

**档 3 · 必问用户（仅这两种情况）**

- 用户在「察 / 援 / 择」阶段未表达过的**根本性气质决定**（如"全套换字体"——若用户在「择」已选定方向 = 已默许该方向气质，不再问）
- 多个相互排斥的**不可逆决策**（如"删除项目独有 utility 还是保留"），且 AI 无法从已知信息推断默认偏好

**反模式**

| 病 | 症状 | 对治 |
|---|---|---|
| 决策上抛 | 把 hex→HSL / 含义对齐这种自决项做成决策面板 | 对照三档表，档 0 / 档 1 / 档 2 全自决 |
| 字面对齐 | 把 mockup 的 `--accent` 直接填到 shadcn 的 `--accent` | 含义对齐：mockup `--accent`（CTA）→ shadcn `--primary` |
| 强套参考源 | 参考源没给 success 色就强行造一个 | 沿用项目现有 success，仅微调饱和度匹配新主色族 |
| 决策面板 ≥ 4 项 | "请选 ABCD" 把活甩回用户 | 重新对照三档表——大概率档 0 / 档 1 / 档 2 项被误归到档 3 |
| 加补丁式铁律 | 每发现一次 a11y/体系问题就在档 1 加 🔒 铁律段 | 反——内化为档 0 默认行为 + 6.2 验证闭环捕获，**为道日损** |

#### 产出 4 文件

用户选定后，AI 必须导出以下 4 个文件（喂给 dao-plan / dao-execute / 6.2 验证）：

```
_tmp/design-tokens-<topic>.json        # 结构化 tokens（JSON Schema 见 templates/design-tokens.schema.json）
_tmp/index-css-draft.css               # CSS variables 草稿（可直接替换项目 index.css 的 :root + .dark 段）
_tmp/component-deltas.md               # 哪些组件需要改 + 改什么（按当前项目代码库扫描出 diff 清单）
_tmp/selector-mapping-<topic>.json     # mockup selector ↔ impl data-slot 映射表（v0.3 加 · 喂给 6.2 验证 · schema templates/selector-mapping.schema.json）
```

**selector-mapping 是什么**：6.2 验证脚本要量「mockup 上 `.btn-primary` vs impl 上 `button[data-slot="button"]`」这种映射。这件事手工成分有点重——你要走过 mockup HTML + 项目代码库两边才能准确对上。作为第五选抩后的给付成果，这个工作勢势唯一。schema 示例：

```json
{
  "meta": {
    "topic": "<topic>",
    "direction": "<linear|notion|claude|raycast>",
    "mockupHtml": "_tmp/ui-mockup-<topic>-<ts>.html",
    "implUrl": "http://localhost:1420"
  },
  "scopes": {
    "homepage": {
      "checks": [
        { "name": "brand-mark", "mockSel": ".brand-mark", "implSel": "header [data-slot=\"logo\"]", "notes": "32x32 logo" },
        { "name": "btn-primary", "mockSel": ".btn.btn-primary", "implSel": "aside button[data-slot=\"button\"]", "skipDims": ["padding", "height"] }
      ]
    },
    "dialog-byok": {
      "openBy": { "click": "button[aria-label*='LLM']", "wait": 500 },
      "checks": [ ... ]
    }
  }
}
```

`skipDims` 是跳过「已接受体系差异」的法宝——如 spacing 用 Tailwind step 不要求与 mockup px 任意值一致，标 `"skipDims": ["padding", "height"]` 让 6.2 不报 ⚠️。

#### 6.2 · 验（实施后必跑 · 道法自然的反向闭环）

> 大象无形（41 章）。无形的 spec 须有形的验证。**没有 6.2，整个 dao-ui-mockup 是开环的**——mockup 写得再美，实施可走样而无人察觉。

实施代码完成后（`pnpm typecheck` 通过、commit 前），**必跑 mockup-vs-impl diff**：

```javascript
// _tmp/verify-visual-<topic>.mjs（模板见 templates/verify-visual.mjs）
import { chromium } from '@playwright/test'

const browser = await chromium.launch({ headless: true })
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } })

// 1. 截 mockup HTML（用户已选定方向）
const mockupPage = await ctx.newPage()
await mockupPage.goto('file://' + path.resolve('_tmp/ui-mockup-<topic>-<ts>.html'))
await mockupPage.evaluate(() => document.documentElement.dataset.direction = '<selected>')

// 2. 截 dev server
const implPage = await ctx.newPage()
await implPage.goto('http://localhost:1420')

// 3. 量同名元素的 computed style
const checks = [
  { name: 'Button.primary',   mockSel: '.btn-primary',          implSel: 'button[data-slot="button"][data-variant="default"]' },
  { name: 'Input',            mockSel: '.qa-textarea',           implSel: 'input[data-slot="input"]' },
  { name: 'Dialog',           mockSel: '.scene-window',          implSel: '[data-slot="dialog-content"]' },
  { name: 'SelectTrigger',    mockSel: '.dir-tabs button',       implSel: '[data-slot="select-trigger"]' },
  // ... 关键组件全列
]

for (const c of checks) {
  const mock = await mockupPage.locator(c.mockSel).first().evaluate(getComputedStyleSubset)
  const impl = await implPage.locator(c.implSel).first().evaluate(getComputedStyleSubset)
  // diff borderRadius / fontSize / padding / boxShadow / fontFamily / height
}
```

**输入**：`_tmp/selector-mapping-<topic>.json`（第六步固已产出·验证脚本本身只是薄运行器）。

**输出 `_tmp/visual-diff-<topic>.md`**：

```markdown
| 元素 | 维度 | mockup | 实施 | Δ | 处置 |
|---|---|---|---|---|---|
| Button.primary | fontSize | 13px | 14px | +1 | ✅ 设计噪音 |
| Dialog | borderRadius | 8px | 6px | -2 | ❌ 修 `--radius` |
| SelectTrigger | fontFamily | Inter | -webkit-system | -- | ❌ 用 ui/Select wrap |
| StatusBadge | fontSize | 12px | 10px | -2 | ❌ a11y 改 text-xs |
```

**通过条件**（unanimously）：

- 关键 token 差异 ≤ 1px = 设计噪音可接受
- 任何 fontSize < 12px = ❌ 必修（a11y 红线）
- shadcn 项目内 form element fontFamily 与 `ui/*` wrap 一致 = ❌ 否则用 wrap
- borderRadius / boxShadow / padding 差异 > 2px = ❌ 必修

**6.3 关卡**：visual-diff 报告全绿 → 进 dao-finish 归根；任一 ❌ → 回炉（修代码或修 mockup）。

**这一步是 dao-ui-mockup 的灵魂**——没有 6.2，前面五步都是开环。有了 6.2，T35（< 12px）/ T37（shadcn 裂痕）/ radius 偏紧 等问题**自动捕获**，无需在档 1 加补丁铁律。

**为道日损**：每加一次 6.2 自动捕获，可考虑减一条档 1 铁律段（lesson 入 csv 留备忘）。

**`design-tokens-<topic>.json` 结构**：

```json
{
  "meta": {
    "name": "极简空气流",
    "inspiration": "Linear · Arc · Vercel",
    "topic": "<topic>",
    "createdAt": "<ISO-8601>",
    "selectedAt": "<ISO-8601>"
  },
  "colors": {
    "light": { "background": "#FAFAFA", "foreground": "#0A0A0A", ... },
    "dark":  { "background": "#0A0A0A", "foreground": "#FAFAFA", ... }
  },
  "typography": { ... },
  "spacing": [4, 8, ...],
  "radius": { ... },
  "elevation": { ... },
  "motion": { ... }
}
```

**`component-deltas.md` 内容**：

```markdown
# 组件改动清单 · <topic>

## 必改（违反新 tokens）
- `src/components/card-option.tsx:35-87` — 硬编码 emerald/amber/rose，改走 success/warning/danger tokens
- `src/index.css:7-36` — 替换 :root 全段为 _tmp/index-css-draft.css 的 :root 段
- ...

## 建议改（提升一致性）
- ...

## 不改（保持现状）
- ...
```

**铁律**：这 3 个文件必产，缺一不成。`dao-plan` 第一句话必须 `读 _tmp/design-tokens-<topic>.json`。

## 双模式（可选）

默认六步走完整流程。复杂项目可拆成两次会话：

| 模式 | 触发 | 产出 |
|---|---|---|
| **Mode A · Style Tile** | 用户说"先看大方向"或"快速对比"或方向数 ≤ 2 | 简化版 HTML（仅 Foundations + 1 个 Live Scene） |
| **Mode B · Style Guide** | 用户说"细化看组件库"或方向已选定 | 完整 HTML（5 层 + 全部 Live Scenes） |

模式名借用 Samantha Warren · Style Tile（2011 A List Apart）+ Brad Frost · Atomic Design（2013）行业标准术语。

## 与 /dao-superpowers 的整合

**插入位置**：`/dao-superpowers` 第 2 步「谋」的前置子步骤 `2.0 · 形`。

**触发**：第 1 步 worktree 完成后，AI 自评：

```
任务关键词含 UI 视觉决策？
├─ 否 → 跳过 2.0，直接进 2.1 写 plan
└─ 是 → 激活 2.0 · 形（本 skill）
       ├─ 六步走完（察→援→拟→显→择→固）
       ├─ 产出 _tmp/design-tokens-<topic>.json + index-css-draft.css + component-deltas.md
       └─ 进 2.1 写 plan，plan 第一句话 "读 _tmp/design-tokens-<topic>.json"
```

**不替代 /dao-dev**：`/dao-dev` 是从需求到交付全管线，含基建审计/前端处方/文档生成；本 skill 是**视觉决策工具**，专注 mockup 生成。两者可叠加（dao-dev 在 UI 阶段调本 skill）。

## 文件结构

```
.windsurf/skills/dao-ui-mockup/
├── SKILL.md                            # 本文件
├── templates/
│   ├── mockup.html                     # HTML 骨架（含标签页 + 暗色 + 5 层结构）
│   └── design-tokens.schema.json       # tokens JSON schema（dao-plan 也用作输入格式）
└── examples/
    └── README.md                       # 调用示例引用
```

## 反模式表

| 病 | 症状 | 道德经诊断 | 对治 |
|---|---|---|---|
| 不察就显 | 跳过项目分析直接生成 mockup | 不知人 | 必走第一步「察」，提取项目画像 |
| 不援就拟 | 跳过 awesome-design-md 凭空发明方向 | 自见者不明 | 必走第二步「援」，从已验证项目筛参考再合成 |
| 通用占位 | mockup 用 Lorem Ipsum + 通用组件 | 失其魂 | 必用项目真实文案 + 真实组件结构 |
| 方向同质 | 3 个方向都是浅色 + 蓝绿 | 多言数穷 | 多样性原则：明/暗、衬/无衬、flat/堆叠 至少各 1 |
| AI 替选 | 没等用户选就进 plan | 妄作 | 🔒 用户审定门，等明确"选 X" |
| 设计稿漂亮代码走样 | mockup 用 backdrop-filter + 3D，落地实现不出来 | 企者不立 | 可实现性自检，用项目现有 CSS 方案 |
| 不导 tokens | mockup 选完就忘，dao-plan 还得猜颜色 | 慎终不如始 | 第六步「固」必产 3 个文件 |
| CDN 依赖 | 内嵌 CDN 链接，离线打不开 | 失自然 | 单文件零外部依赖 |
| 组件清单空 | component-deltas.md 写"按需改" | 不慎重 | 必走 grep 项目代码扫出 diff 清单 |

## 与其他 dao-* 的关系

```
dao-empathy       (用户视角共情)        ← 输入：项目用户是谁
dao-research      (前置研究)            ← 输入：行业最佳实践参考
dao-frontend-aesthetics (前端审美方法论) ← 平级：HOW 设计好（受限空间）
dao-ui-mockup     (本 skill · 决策工具) ── 输出：design tokens
dao-plan          (实施计划)            ← 输入：tokens + component-deltas
dao-execute       (落地)                ← 输入：tokens + mockup HTML 作 ground truth
dao-review        (审视)                ← 对照 mockup 验收
```

**与 ui-ux-pro-max（kit skill）的关系**：

- `ui-ux-pro-max` 提供具体规范（67 styles / 96 palettes / 57 fonts）
- 本 skill 在第二步「援」可作为 awesome-design-md 之外的补充候选源（特别是股价期、虚业、小众小领域在 awesome-design-md 未收录时）；本 skill 在第三步「拟」可消费 ui-ux-pro-max 的色板/字体资源作为微调补充

## 涅槃门（进 dao-plan 前）

- [ ] 项目画像已写出
- [ ] 已从 awesome-design-md 筛 3-5 候选并用户拍板 `refCombo`
- [ ] 至少 N 个方向（与 refCombo.strategy 同步）+ 多样性符合
- [ ] mockup HTML 已生成在 `_tmp/`
- [ ] 用户已显式选定方向（含可能的微调）
- [ ] `_tmp/design-tokens-<topic>.json` 已导出
- [ ] `_tmp/index-css-draft.css` 已导出
- [ ] `_tmp/component-deltas.md` 已导出（含必改文件清单）

任一未通 = 不进 dao-plan。

## 反原则（保留 dao 风格）

- **简则简**——单页/小组件视觉改动可只生成 Style Tile（Mode A）跳过完整 Style Guide
- **不为流程而流程**——已有明确 design tokens 时跳过本 skill 直接 dao-plan
- **mockup ≠ 实施**——mockup 是决策工具，最终代码以 design tokens 为准（mockup 内的字符细节可不一致）
- **_tmp/ 是临时区**——产出文件用完归档到 `docs/specs/<topic>/` 或丢弃，不留散落

法不违德，德不违道，道法自然。
