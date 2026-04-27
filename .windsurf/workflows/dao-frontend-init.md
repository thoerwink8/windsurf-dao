---
description: 前端 Next.js 项目 UI/UX 初始化 — 新项目创建时自动执行设计系统生成 + 组件规范落地 + 验证全链路
---

# /dao-frontend-init · Next.js UI/UX 初始化管线

> **触发**：新建 Next.js 前端项目、首页/着陆页重构、`pnpm dlx shadcn@latest init` 之后。
> **硬依赖**：ui-ux-pro-max skill（`windsurf-skills-kit/skills/dev/ui-ux-pro-max`）。
> **规范文件**：`ui-ux-pro-max/data/nextjs-shadcn-standards.md` — 尺寸/色彩/字体铁律。

---

## Phase 0 · 读取规范（每次必做）

// turbo
1. 读取 `nextjs-shadcn-standards.md`（在 ui-ux-pro-max/data/ 下），将其中的按钮尺寸表、Type Scale、oklch chroma 约束、布局约束作为本次执行的硬门槛。**不读此文件不开工。**

---

## Phase 0.5 · 基建探测 + 创建（智能判定）

扫描目标目录，判定入口模式：

| 条件 | 模式 | 动作 |
|------|------|------|
| `web/package.json` 不存在 | **全量** | Phase 0.5a → 全部 Phase |
| `web/package.json` 存在，但 `components/ui/button.tsx` 不存在 | **增量** | 跳过 0.5a，从 Phase 2 开始 |
| `web/package.json` + `components/ui/button.tsx` + `globals.css` 含 oklch | **就绪** | 跳过全部，直接回到调用方 |

### Phase 0.5a · create-next-app（仅全量模式）

```bash
pnpm create next-app@latest web --typescript --tailwind --eslint=false --app --use-pnpm --skip-install
cd web
pnpm install
```

> - 始终用 `@latest`，确保最新 Next.js 版本
> - `--eslint=false`：项目用 Biome 替代 ESLint
> - `--app`：App Router（Next.js 标准）
> - 安装后删除 Google Fonts 导入（layout.tsx），改用系统字体栈（Phase 4 处理）

---

## Phase 1 · 项目信息收集

2. 确定以下维度（未指定则从项目文档/README 推断，仍不确定则问用户）：

| 维度 | 示例 |
|------|------|
| 产品类型 | SaaS / 电商 / 仪表盘 / 着陆页 |
| 行业 | 求职 / 金融 / 教育 / 医疗 |
| 风格关键词 | minimal / professional / playful |
| 项目名称 | "Resume Project" |

---

## Phase 2 · 设计系统生成

3. 运行 ui-ux-pro-max `--design-system`：

```powershell
& "C:\Users\Administrator\AppData\Local\Programs\Python\Python312\python.exe" `
  "<skills-root>\ui-ux-pro-max\scripts\search.py" `
  "<product_type> <industry> <keywords>" `
  --design-system -p "<Project Name>"
```

> `<skills-root>` = ui-ux-pro-max 所在的 skills 目录（可从任意 workspace 定位）。

4. 按需补充查询（有疑问才查，无疑问跳过）：
   - `--domain typography` → 字体配对
   - `--domain landing` → 页面结构
   - `--domain ux` → 动画/可访问性/字号
   - `--stack shadcn` → 组件用法
   - `--stack nextjs` → 框架最佳实践

---

## Phase 3 · shadcn/ui 初始化

5. 如果项目尚未初始化 shadcn：

```bash
pnpm dlx shadcn@latest init -d
pnpm dlx shadcn@latest add button card badge -y
```

6. **立即覆写 button/badge 组件尺寸**，按 `nextjs-shadcn-standards.md` 中的尺寸表修改 `components/ui/button.tsx` 和 `components/ui/badge.tsx`。这是最容易遗漏的步骤——shadcn 默认尺寸偏小，不覆写 = 视觉不合格。

---

## Phase 4 · 色彩系统落地

7. 编辑 `app/globals.css` 的 `:root` 和 `.dark` 块：
   - 将设计系统推荐色彩转换为 oklch CSS 变量
   - **强制检查 chroma**：primary ≥ 0.20，background ≥ 0.01，muted ≥ 0.02，border ≥ 0.02
   - oklch 数值不写尾零（Biome 会报错）
   - hue 统一在 ±15° 以内

8. 设置字体栈——在 `@theme inline` 中配置 `--font-sans`：
   - 默认：`"Inter", ui-sans-serif, system-ui, -apple-system, sans-serif`
   - 若需自定义字体：优先 `next/font/local`，避免 Google Fonts 网络依赖

---

## Phase 5 · 页面构建

9. 按设计系统的 Pattern（如 Hero + Features + CTA）构建页面，遵守以下铁律：
   - body 正文 ≥ `text-base` (16px)
   - `text-xs` (12px) 仅用于 badge / footer 辅助注释
   - h1 响应式：`text-4xl md:text-5xl lg:text-6xl`
   - Hero CTA 按钮 `size="lg"`（h-12, 48px）
   - 所有可点击元素 `cursor-pointer`
   - Lucide 图标，**禁止 emoji**
   - hover 过渡 `duration-200`
   - Navbar: `h-16 sticky top-0 z-40 backdrop-blur-md`

---

## Phase 6 · 验证（全部通过才算完成）

// turbo
10. 依次运行：

```bash
pnpm typecheck
pnpm format
pnpm lint
pnpm build
```

11. 启动 dev server，用以下方式之一验证视觉：
    - Chrome DevTools MCP 截图（如可用）
    - `curl -s` 验证 SSR 输出包含关键 UI 元素
    - 请用户贴截图确认

12. 验证清单：
    - [ ] typecheck 通过
    - [ ] lint 零错误
    - [ ] build 成功
    - [ ] 按钮 lg ≥ 48px 高度
    - [ ] 正文字号 ≥ 16px
    - [ ] primary 色彩肉眼可辨（非灰/黑）
    - [ ] 响应式 375px / 768px / 1024px / 1440px
    - [ ] 装饰图标 `aria-hidden="true"`
    - [ ] 用户确认截图满意

---

## Phase 7 · 持久化设计系统（可选）

13. 若项目较大（>5 个页面），用 `--persist` 写入 `design-system/MASTER.md`：

```bash
python search.py "<query>" --design-system --persist -p "<Project Name>"
```

后续页面用 `--page "dashboard"` 生成 override 文件。

---

## 常见踩坑

| 问题 | 原因 | 修复 |
|------|------|------|
| 按钮看起来像 tag | shadcn 默认尺寸太小 | 按规范覆写 button sizes |
| 颜色看起来灰/黑 | oklch chroma 太低 | primary chroma ≥ 0.20 |
| Biome 报 CSS 格式错 | oklch 尾零 `0.90` | 改为 `0.9` |
| Biome schema 版本不匹配 | `$schema` URL 过期 | 对齐到 `pnpm ls @biomejs/biome` 版本 |
| Google Fonts 下载失败 | 网络不可达 | 用系统字体栈或 next/font/local |
| `@theme`/`@apply` IDE 警告 | VS Code CSS 不识别 Tailwind 4 | 忽略，Biome + PostCSS 编译正常 |
