# ccswitch/workflows —— dao 级参数化 workflow 货架

> 这里放的是**跨项目可复用**的 workflow 脚本（`*.js`）。判据同 dao.md「知识归位」：
> 换个项目/换个技术栈还能跑 → 归这里；只在某个仓的具体形态下有意义 → 留在那个仓的
> `.claude/workflows/`。

## 部署方式（当前是手工复制，不是自动的）

**已验证可用的路径**：把脚本复制到目标项目的 `.claude/workflows/<name>.js`，重开会话后即
出现在可调用列表里（本仓 `incremental-review` / `code-quality-audit` / `outward-sweep`
三个就是这样在 mousse-cli 生效的）。

```powershell
Copy-Item "D:\frank\windsurf-dao\ccswitch\workflows\pr-history-postmortem.js" `
          "<目标项目>\.claude\workflows\" -Force
```

**尚未接上的**：`dao.ps1 link-claude` 目前只 symlink `ccswitch/{skills,commands,agents}`
三类，**没有** workflows 这一类；`~/.claude/workflows/` 是不是用户级发现路径也**未经本机
验证**（workflow 由 Agent SDK harness 装载，不在 `@anthropic-ai/claude-code` 的 cli.js 里，
无法靠读那个 bundle 判定）。所以本目录目前是**货架，不是部署源**——复制过去才生效，
复制出去的副本不会跟随本目录更新（这就是一个已知漂移面，用的时候心里有数）。
要消除漂移面得先验证用户级发现路径是否存在，那是另一次显式改动。

---

## `pr-history-postmortem.js` —— PR 全史复盘

### 它做什么

对一个「PR 大部分由 agent 产出」的仓库，从 PR/提交的**原始数据**里挖**执行缺陷**
（我们怎么干活出的问题），而不是产品缺陷（软件本身的 bug）。五路镜头并行挖掘 →
逐路对抗核验。

| 镜头 key | 问的问题 |
|---|---|
| `repair-chain` | 谁在修谁；有没有「B 修 A、C 又修 B」的三连；同一处被修 N 次 |
| `hotspot` | 哪些文件被反复改；功能扩张 vs 同一处返工；隐式耦合 |
| `debt-selfreport` | PR body 里如实写了欠账但没人接住；接住率多少 |
| `stall-trace` | 从时间戳读执行断点：异常空档、终审积压、赶工质量代价 |
| `clause-efficacy` | 已有的规则/条款入库之后，它要防的那类问题还发生过吗 |

`clause-efficacy` 通常是最高价值一路，也最容易出错——它的核验硬要求是
**「入库后归零」必须排除「没机会发生」**，未排除即判 `holds=false`。

### args 契约

| 参数 | 必填 | 缺省行为 |
|---|---|---|
| `repoPath` | **是** | 无默认，缺省即抛错。刻意如此——跨项目资产内置某个仓的路径，正是它上一版不可复用的根因 |
| `ghRepo` | 否 | 让 agent 在 `repoPath` 跑 `gh repo view --json nameWithOwner` 自取；取不到即降级为纯 git 分析 |
| `prRange` | 否 | `{from, to}`；缺省 = 全史（`#1` 起至今），先拉轻量元数据看实际有多少个 |
| `lenses` | 否 | 上表五个 key 的子集；缺省全跑。传入未知 key 会抛错并列出合法值 |
| `knownDefects` | 否 | 字符串数组，「不必重新发现」的已知缺陷清单，让镜头把预算花在增量上。**缺省时明确告诉镜头「无预设结论，凡判为模式的都要自证 2-3 例」** |
| `clauseFile` | 否 | 条款库相对路径（如 `docs/rules/dispatch-clauses.md`）。缺省时让 agent 自己 Glob 找；找不到则该镜头判「不适用」，不硬凑 |
| `ledgerFiles` | 否 | 热点统计要排除的账本类文件；缺省 `CHANGELOG.md` / `PROGRESS.md` / `TODO.md` |
| `goal` | 否 | 一句话重述「执行缺陷」在本项目里指什么 |
| `model` / `verifyModel` | 否 | 挖掘档位缺省由 harness 决定（`hotspot`/`stall-trace` 两路已内置降 sonnet）；核验缺省 sonnet |

调用示例：

```json
{
  "repoPath": "D:/frank/some-project",
  "ghRepo": "org/some-project",
  "clauseFile": "docs/rules/dispatch-clauses.md",
  "knownDefects": ["收尾漏发简报", "停摆型「等自后台」", "账实漂移/幽灵待办"],
  "lenses": ["clause-efficacy", "debt-selfreport"]
}
```

### 何时该跑

- 项目积累 **100+ PR** 且绝大部分由 agent 产出——样本量不够时五路都会返回「样本不足」，
  跑了也白跑
- 刚立了一批派单条款/流程规则，想验证**它们入库后到底防住了什么**（不是「有没有被
  携带」，是更硬的那个指标）
- 长窗排程选题见底时，从历史里找「越晚越贵」的建设件

**不该跑**：想找产品 bug（那是 `code-quality-audit` / `incremental-review` 的活）；
仓库还很新；或者只是想复盘一次具体事故（那用不着五路 fan-out）。

### 相对单次专用版改了什么

改造自 2026-07-27 mousse-cli 的单次专用版。**方法论骨架原样保留**（五路镜头、对抗核验、
「过度解读是头号靶子」、「入库后归零必须排除没机会发生」、「零发现是合格交付」）。改的是：

1. **去硬编码**：仓库路径 / GitHub 仓名 / PR 编号上限 / 该仓当日已知缺陷清单 / 该仓特有的
   检查脚本名与账本文件名，全部改为 args 驱动或「先探测再归类」的通用表述
2. **镜头可选子集**：`lenses` 参数，照 `code-quality-audit` 的惯例
3. **顺带修一处已知缺陷**：原版核验阶段用 `all.slice(0, 8)` 只递交前 8 条，并用一行 `log`
   交代截断——**但那行 log 核验官看不见**，被截掉的部分既没被核验、也没在核验产出里留
   痕迹。本版改为按 8 条一批**分批完整递交**并合并裁定，同时在 prompt 里告知本批是第
   几批/共几批（承重字段完整输入，见派单条款库对抗验证官节）
4. **核验多加一条硬要求**：「比较基线必须先验证它自己是活的」——已失效的东西当然「零问题」，
   拿它当基线会把真实代价误判成退化

### 已知弱点（用之前知道）

- 五路都依赖 `gh` CLI 可用且已登录；私有仓无权限时会静默退化成只有 git 数据的分析，
  镜头会说明但不会中止
- `hotspot` 的账本排除靠 `ledgerFiles` + agent 判断，**两个方向都可能出错**（漏排会让
  流水账文件占满 Top 15，错排会吞掉真实热点）
- 核验官抽验的是 instances 的**存在性与支持度**，不重跑挖掘——挖掘阶段系统性的取数偏差
  （例如只拉了近半数 PR 的 body）核验官通常看不出来
