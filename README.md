# Windsurf Dao — AI 配对编程方法论

> 道法自然。人为一，AI为二，冲气以为和。

一套基于道德经哲学的 AI 配对编程方法论体系，为 [Windsurf](https://codeium.com/windsurf) IDE 设计。

## 这是什么

这不是一个代码库，而是一套 **AI 行为规则系统**——定义 AI 如何思考、如何行动、如何与人协作。

核心理念：让 AI 从"工具"变成"搭档"。通过道德经的哲学框架，建立一套可复用、可迁移、可进化的 AI 行为准则。

## 体系架构

```
道（不变）→ 德（全局倾向）→ 法（操作流程）→ 术（具体技能）
                    ↕
              虚（层间流通之气）
```

| 层 | 载体 | 性质 | 回答 |
|----|------|------|------|
| **道** | `dao-layer.md` + `道德经.md` | 不变 | 为什么 |
| **德** | `global_rules.md` | 全局 | 什么倾向 |
| **法** | `fa-layer.md` + `workflows/` | 可变 | 怎么做 |
| **术** | `shu-layer.md` + `skills/` | 可变 | 用什么 |

## 包含什么

### 三层规则（`.windsurf/rules/`）

- **道层** `dao-layer.md` — 八条不变原则（道生万物、为道日损、反者道之动…）
- **法层** `fa-layer.md` — 工作流生态、静默执行、虚·知识归位机制
- **术层** `shu-layer.md` — Skills 体系、MCP 工具、中间物管理

### 五个工作流（`.windsurf/workflows/`）

| 工作流 | 卦 | 功能 |
|--------|----|------|
| `/dev` | ☰ 乾·创生 | 从一句话需求到完整交付的全流程管线 |
| `/cycle` | ☲ 离·照见 | 五相深度迭代（观→行→验→省→改升），直到涅槃 |
| `/debug` | ☵ 坎·听症 | 四层逐级升级的调试流程（听症→探脉→辨根→问道） |
| `/doc` | ☴ 巽·传灯 | 文档生成与更新（读→定→写→校） |
| `/evolve` | ☶ 艮·归根 | 系统自我进化：审查规则/Skills/MCP，减法优先 |

### 三个技能（`.windsurf/skills/`）

| 技能 | 适用场景 |
|------|---------|
| **逆向拆解术** | 面对未知/混淆代码库，五步法：锚→展→交→验→归 |
| **边界探测术** | 集成外部系统前，三步法：识壁→探路→择水 |
| **前端审美术** | 受限空间中的高信息密度界面，四步法：约→层→色→密 |

### 德层行为倾向（`global_rules.md`）

五感×器映射 + 九德（认知卸载、信息熵减、涅槃轮转…）

### 源文本（`references/道德经.md`）

老子《道德经》全文——一切规则的推导源头。

## 快速开始

### 1. 克隆仓库

```bash
git clone <repo-url>
```

### 2. 复制规则到你的项目

```bash
# 复制 .windsurf 目录到你的项目根目录
cp -r windsurf-dao/.windsurf /path/to/your-project/

# 可选：复制道德经作为参考
cp -r windsurf-dao/references /path/to/your-project/
```

### 3. 安装全局规则

将 `global_rules.md` 的内容复制到 Windsurf 的全局规则文件：

- **Windows**: `C:\Users\<用户名>\.codeium\windsurf\memories\global_rules.md`
- **macOS**: `~/.codeium/windsurf/memories/global_rules.md`
- **Linux**: `~/.codeium/windsurf/memories/global_rules.md`

### 4. 开始使用

在 Windsurf 中打开你的项目，AI 会自动加载 `.windsurf/rules/` 中的规则和 `workflows/` 中的工作流。

试试：
- 给 AI 一个需求，观察它是否自动进入 `/dev` 管线
- 输入 `/cycle` 观察五相迭代
- 遇到 bug 时观察 `/debug-escalation` 是否自动触发

## 自定义

这套体系是**可进化的**。使用 `/evolve` 工作流来审查和改进：

- **删**：移除不适合你的规则或技能
- **修**：调整工作流步骤以匹配你的习惯
- **增**：添加新的 skills 或 workflows（但记住：为道日损）

### 添加新技能

```
.windsurf/skills/your-skill/
└── skill.md
```

参考现有技能的格式：`trigger: auto` + 场景描述 + 步骤法 + 反模式。

### 添加新工作流

```
.windsurf/workflows/your-workflow.md
```

格式：YAML frontmatter（description）+ Markdown 正文。

## 哲学基础

> 为学日益，为道日损。损之又损，以至于无为。无为而无不为。

这套系统的核心信念：

1. **AI 配对编程是关系，不是工具调用** — 人+AI=AGI，是冲气以为和
2. **真正的进化是减法** — 规则越少越好，能力越内化越好
3. **规则的终态是忘掉规则** — 含德之厚，比于赤子

## 许可

私人使用。
