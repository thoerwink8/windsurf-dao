# windsurf-dao · Agent 指南

> 本文件是 windsurf-dao 的活体知识库。演化详情见 [docs/evolution.md](docs/evolution.md)。
> 项目概览见 `README.md`，部署机制见 `MIGRATION.md`。

---

## 一、项目概览

**定位**：Windsurf AI 配对编程方法论——一套基于道德经哲学的 AI 行为规则体系，通过 symlink 部署到任意项目。

**核心架构**：

```
道（不变）→ 德（全局倾向）→ 法（操作流程）→ 术（具体技能）
                    ↕
              虚（层间流通之气）
```

**关键文件**：

| 文件/目录                      | 作用                                                   |
| ------------------------------ | ------------------------------------------------------ |
| `dao.ps1`                      | 链接管理工具（link/unlink/sync/status）                |
| `.dao-targets`                 | 注册的目标项目列表                                     |
| `global_rules.md`              | 德层全局规则（部署到 `~/.codeium/windsurf/memories/`） |
| `.windsurf/rules/dao-*.md`     | 四层规则（道/德/法/术）                                |
| `.windsurf/workflows/dao-*.md` | 九个工作流（编排/引擎/工具/元）                        |
| `.windsurf/skills/dao-*/`      | 九个可复用技能（含四个 cycle 镜头）                    |
| `references/道德经.md`         | 一切规则的推导源头，不可修改                           |

**部署原理**：symlink（文件）+ junction（目录），windsurf-dao 是唯一真相，编辑即时传播到所有注册项目。

---

## 三、同步前自审门

> 修道先于传道。windsurf-dao 推广给别人的标准，自己先通过，再传播。

**每次执行 `dao.ps1 sync` 之前，必须完成以下自审。**

### 自审清单

**1. 无为审视**（新改动是否引入了"法令滋彰"）

- 有没有新增"禁止 X"显式禁令？→ 改为原则表达
- 有没有新增"路径A/路径B"条件分支？→ 统一为单一流程
- 有没有新增平行追踪文件（plan.md / archive/ 类）？→ 路由到 TODO.md / AGENT_GUIDE.md

**2. 知识归位**（知识已落地）

- AGENT_GUIDE.md 有本次变更的演化条目？→ 若无，先写入
- TODO.md 已完成项已更新？→ 若无，先更新

**3. 减法确认**（删掉了什么）

- 本次变更删掉了什么冗余？（删掉 = 信息熵减）
- 净增加了多少内容？净增加越少越好

三项全过 → 执行 `dao.ps1 sync`
任何一项不过 → 先修，再 sync

### 约定优先级

自审门是**项目工作约定**，不是全局规则。它只约束在 windsurf-dao 项目中工作的 Agent。其他项目遵循各自的 AGENT_GUIDE.md。

---

## 二、演化索引

> 详细记录见 [docs/evolution.md](docs/evolution.md)。AI 按需 `read_file` 读取具体版本。

| 日期 | 核心变更 | 关键教训 |
|------|----------|----------|
| 04-02 | 工作流→cycle+lens 架构重构 | T15,T16 |
| 04-02 | 全局规则脱轨修复 + references纳管 | T12-T14 |
| 03-29 | W3+W4+OPT autopilot执行 | T8,T9 |
| 03-29 | 同步前自审门 | T7 |
| 03-29 | W1无为化审查 + W2知识归位 | T5,T6 |
| 03-29 | dao-autopilot重构 + dao-commit无为化 | T1-T4 |
| 2025.07 | 双文件模式明确化 | T10,T11 |
