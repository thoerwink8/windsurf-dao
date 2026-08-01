# 前端技术栈门控 · frontend-gate

> 规范写了但从未激活，等于没写。

**触发条件**：`package.json` 依赖含 `react` / `vue` / `svelte`，或存在 `src-ui/` / `apps/desktop/` 等前端目录。

## 检测点 A · 样式技术路线

1. 检查 `.claude/rules/frontend-style.md` 是否存在
2. 缺失 → 提醒：从 `stacks/` 对应处方（`frontend-react-vite.md` / `frontend-nextjs.md` 等）派生该 rule，声明样式技术路线（**Tailwind 优先，禁手写布局 CSS**），形式参考 TraceyU `code-to-prototype.md`（frontmatter 带 `description` + `paths:` 条件加载，避免全局无脑注入）
3. 缺项处置见 SKILL.md §缺项怎么处置。本条**无 canonical 可抄**（样式路线须按项目框架从 `stacks/` 处方合成，处方自陈只是处方库）⇒ 落**乙档**：可代写，但要说清依据的是哪一份处方的哪一句

## 检测点 B · UI 测试分层（处方 `stacks/frontend-ui-testing.md`）

1. 探测四层信号（处方定义：①逻辑/store ②组件语义 ③像素视觉回归 ④交互 E2E）：
   - **①②层**：`package.json` scripts 有测试入口（`test` / `test:run` 等），且存在组件/逻辑测试文件（`*.test.tsx` / `*.spec.tsx` / `*.test.ts` 等）
   - **③层**：有视觉回归脚本（如 `test:visual`），或存在截图基线目录（`__screenshots__/`）
   - **④层**：有 E2E 脚本或 `e2e/` 目录
2. **①②层信号全无** → 提醒 Read `stacks/frontend-ui-testing.md` 按四层处方选层建栈。这是本检测点的主要拦截目标——连组件冒烟都没有的前端项目，UI 改动没有任何自动回归面
3. **有①②、无③** → 只提示③层可选，**不判缺项**。处方自身的选择原则是「能用轻量层验证的不用重量层」，纯逻辑型前端不需要像素基线；仅当项目存在 `design/` 目录（设计稿为真相源、样式漂移代价高）时才建议补③
4. 缺项处置见 SKILL.md §缺项怎么处置。建测试栈要选层、要挑框架 ⇒ 同为**乙档**，不许照着一份模板套

**下游实践佐证**：mousse-cli 的 `pnpm test:visual`（vitest 4 Browser Mode `toMatchScreenshot()`）已进其 `scripts/verify-all.ps1` 验证清单，处方记录 12 基线连跑零抖动——③层形态可行、成本可接受。⚠️ 但处方同时标注③层**环境敏感**（基线绑定生成机器的字体/DPI/GPU 渲染环境，CI 跨环境需另验，否则假阳性）；建议③层时须一并说明这项代价，不要只报可行不报约束。

**为什么必须在 scaffold 阶段就位**：`stacks/` 下的技术栈处方（如 `frontend-react-vite.md` 强制 Tailwind、禁手写布局 CSS）是**按需加载**文件——没有项目开工时的门控触发，AI 不会主动去读它，规范形同虚设。2026-07-12 mousse-cli 血泪：从 v0.1 到 v1.23 手写 2000+ 行布局 CSS，`.claude/rules/` 目录全程为空，`stacks/frontend-react-vite.md` 的 Tailwind 铁律从未落地，23 个版本后才被发现——对照组 TraceyU 项目有 `.claude/rules/code-to-prototype.md`（paths 条件加载）全程合规。scaffold 阶段的存在性检查是唯一能拦住"规范写了但从未激活"这类断链事故的关卡。

**本门控为何在 2026-07-27 长出检测点 B**：`frontend-ui-testing.md` 此前是 `stacks/` 九个处方里**唯一没有强制执行触发点**的一个——只在 `stacks/README.md` 目录表里列着，其余八个分别由本文件、`desktop-debug-gate.md`、`ci-cost-gate.md`、`dao-dev.md`、`dao.md` 引用。用户签字把它补进门控，堵的是与上段 Tailwind 断链**同一个**「规范写了但从未激活」的洞。

## 检查清单

- [ ] 🤖 `.claude/rules/frontend-style.md` 存在（声明样式技术路线，从 `stacks/` 对应处方派生）
- [ ] 🤖（近似）UI 测试①②层就位（有测试入口 + 组件/逻辑测试文件）；全无则提醒 Read `stacks/frontend-ui-testing.md` 选层建栈。**清单只机器化了「有无测试入口脚本」这一半**——脚本存在但零测试文件、或只有③④层没有①②层，清单都放行，这两种形态仍需人判
- [ ] 项目含 `design/` 目录时，③层像素视觉回归已建，或已显式说明不建的理由（③层非普遍必需，见检测点 B 第 3 条）

缺项处置见 SKILL.md §缺项怎么处置（本文件各条均无 canonical ⇒ 一律乙档或丙档，**不存在甲档「零编辑物化」**）。
