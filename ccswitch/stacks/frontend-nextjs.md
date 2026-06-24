---
name: dao-stack-frontend-nextjs
description: 前端技术栈处方:Next.js + shadcn + Tailwind 初始化。/dao-dev 基建审计发现"需要前端"时加载。
---

# Next.js 前端处方

> 卅辐同一毂，当其无有，车之用也。——脚手架是空，设计系统填空为用。

**职责边界**：此文件只做编排（调度什么、什么顺序）。
所有具体标准（尺寸、色彩、字体）由 `ui-ux-pro-max` skill 维护，此处不重复。

## 触发

- `/dev` 基础设施审计发现"需要前端 + 前端未就绪"
- 用户显式调用

## 依赖

- **脚本**：`ui-ux-pro-max/scripts/scaffold-nextjs.mjs` — 确定性脚手架
- **Skill**：`ui-ux-pro-max` — 设计系统生成 + 创意层
- **规范**：`ui-ux-pro-max/data/nextjs-shadcn-standards.md` — 铁律参考

---

## 阶段 A · 脚手架（脚本执行，确定性）

脚本自动完成所有机械操作，内置探测逻辑（全量/增量/就绪自动判定）。

1. 运行脚手架脚本：

```bash
node <skills-root>/ui-ux-pro-max/scripts/scaffold-nextjs.mjs <project-root> [--name web]
```

> `<skills-root>` = `windsurf-skills-kit/skills/dev`（从 workspace 定位）
>
> 脚本自动完成：
> - 探测入口模式（无 web/ → 全量 | 有 web/ 无 UI → 增量 | 全就绪 → 退出）
> - `create-next-app@latest`（仅全量）
> - Biome 安装 + 配置（替代 ESLint）
> - `shadcn init` + 基础组件（button / card / badge）
> - 按 `nextjs-shadcn-standards.md` 覆写组件尺寸
> - Google Fonts 清理 → 系统字体栈
> - `globals.css` oklch 模板结构
>
> 脚本输出 `✅ 脚手架完成` 后进入阶段 B。

---

## 阶段 B · 设计系统（AI + Skill，需要判断力）

2. **收集项目信息**（未指定则从项目文档推断，仍不确定则问用户）：
   - 产品类型 / 行业 / 风格关键词 / 项目名称

3. **生成设计系统**：

```bash
python <skills-root>/ui-ux-pro-max/scripts/search.py "<product_type> <industry> <keywords>" --design-system -p "<Project Name>"
```

4. **按需补充查询**（有疑问才查）：`--domain typography` / `--domain ux` / `--stack shadcn`

5. **落地色彩**：根据设计系统输出，编辑 `globals.css` 的 oklch 值。
   校验标准见 `nextjs-shadcn-standards.md`（AI 读取该文件获取 chroma 下限等约束）。

6. **构建页面**：按设计系统的 Pattern 构建。
   页面构建标准见 `nextjs-shadcn-standards.md`（Type Scale / 布局约束）。

---

## 阶段 C · 验证

7. 依次运行：`pnpm typecheck` → `pnpm format` → `pnpm lint` → `pnpm build`

8. 视觉验证（三选一）：浏览器 MCP 截图（遵循 dao.md 目·观门控选择工具）/ curl SSR 输出 / 用户贴截图

9. 若项目大（>5 页面），用 `--persist` 持久化设计系统到 `design-system/MASTER.md`。
