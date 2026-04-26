# windsurf-dao · Agent 指南

> 本文件是 windsurf-dao 的活体知识库。演化详情见 [docs/evolution.md](docs/evolution.md)。
> 项目概览见 `README.md`。

---

## 一、项目概览

**定位**：Windsurf AI 配对编程方法论——一套基于道德经哲学的 AI 行为规则体系，通过 Sidecar workspace 部署。

**核心架构**：

```
道（不变）→ 德（全局倾向）→ 法（操作流程）→ 术（具体技能）
                    ↕
              虚（层间流通之气）
```

**关键文件**：

| 文件/目录                      | 作用                                                   |
| ------------------------------ | ------------------------------------------------------ |
| `dao.ps1`                      | 工具脚本（status / link-global）                       |
| `global_rules.md`              | 元规则源文件（symlink 到 `~/.codeium/windsurf/memories/`，自动加载到所有项目） |
| `.windsurf/rules/`             | 9 文件 5 层架构（详见 `.windsurf/rules/README.md`）     |
| `.windsurf/workflows/dao-*.md` | 12 个工作流（dev/cycle/autopilot/distill/evolve/...）  |
| `.windsurf/skills/dao-*/`      | 15 个可复用技能（含 cycle 镜头 + 工具 skill）          |
| `references/道德经.md`         | 一切规则的推导源头，不可修改                           |
| `hooks/dao-*`                  | Git hooks 模板（安装到项目 `.git/hooks/`）             |
| `data/evolution-*.csv`         | 演化条目 + 教训库（`dao-evolution` skill 维护）        |

**部署原理**：将 windsurf-dao 作为 Sidecar workspace 与目标项目同时打开，rules/skills/workflows 自动跨 workspace 可见。元规则通过 `dao.ps1 link-global` symlink 到 `~/.codeium/windsurf/memories/`，自动加载到所有项目（无需 UI 操作）。

**Rules 架构（v2 · 2026-04-26 重构）**：废除"道德法术四层"概念，对齐 Windsurf 4 种 trigger 机制。详见 `.windsurf/rules/README.md`。

---

## 三、变更前自审门

> 修道先于传道。推广给别人的标准，自己先通过。

**每次编辑 dao-* 文件前，必须完成以下自审。**

### 自审清单

**1. 无为审视**（新改动是否引入了“法令滋彰”）

- 有没有新增“禁止 X”显式禁令？→ 改为原则表达
- 有没有新增“路径A/路径B”条件分支？→ 统一为单一流程
- 有没有新增平行追踪文件（plan.md / archive/ 类）？→ 路由到 TODO.md / AGENT_GUIDE.md

**2. 知识归位**（知识已落地）

- `data/evolution-entries.csv` / `data/evolution-lessons.csv` 已写入本次演化记录？
- TODO.md 已完成项已更新？

**3. 减法确认**（删掉了什么）

- 本次变更删掉了什么冗余？（删掉 = 信息熵减）
- 净增加了多少内容？净增加越少越好

### 约定优先级

自审门是**项目工作约定**，不是全局规则。它只约束在 windsurf-dao 项目中工作的 Agent。其他项目遵循各自的 AGENT_GUIDE.md。

---

## 二、演化索引
> 演化记录已迁移至 `data/evolution-entries.csv` + `data/evolution-lessons.csv`。
> 使用 `search.py` 搜索教训，使用 `search.py stats` 查看统计。

