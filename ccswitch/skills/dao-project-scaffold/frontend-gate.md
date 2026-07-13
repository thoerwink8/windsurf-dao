# 前端技术栈门控 · frontend-gate

> 规范写了但从未激活，等于没写。

**触发条件**：`package.json` 依赖含 `react` / `vue` / `svelte`，或存在 `src-ui/` / `apps/desktop/` 等前端目录。

## 检测逻辑

1. 检查 `.claude/rules/frontend-style.md` 是否存在
2. 缺失 → 提醒：从 `stacks/` 对应处方（`frontend-react-vite.md` / `frontend-nextjs.md` 等）派生该 rule，声明样式技术路线（**Tailwind 优先，禁手写布局 CSS**），形式参考 TraceyU `code-to-prototype.md`（frontmatter 带 `description` + `paths:` 条件加载，避免全局无脑注入）
3. 缺项不自动创建，建议用户创建并说明理由

**为什么必须在 scaffold 阶段就位**：`stacks/` 下的技术栈处方（如 `frontend-react-vite.md` 强制 Tailwind、禁手写布局 CSS）是**按需加载**文件——没有项目开工时的门控触发，AI 不会主动去读它，规范形同虚设。2026-07-12 mousse-cli 血泪：从 v0.1 到 v1.23 手写 2000+ 行布局 CSS，`.claude/rules/` 目录全程为空，`stacks/frontend-react-vite.md` 的 Tailwind 铁律从未落地，23 个版本后才被发现——对照组 TraceyU 项目有 `.claude/rules/code-to-prototype.md`（paths 条件加载）全程合规。scaffold 阶段的存在性检查是唯一能拦住"规范写了但从未激活"这类断链事故的关卡。

## 检查清单

- [ ] `.claude/rules/frontend-style.md` 存在（声明样式技术路线，从 `stacks/` 对应处方派生）

缺项不自动创建，建议用户创建并说明理由。
