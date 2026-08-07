# windsurf-dao 项目侧派单条款库

> 🔴 **被 `SubagentStart` 注入指到这里的官，先读这三行再往下**：那段注入的末尾写着
> 「条款库正文（含各官种分节）：`docs/rules/dispatch-clauses.md`」——**这句话在本仓不准确**。
> 本文件是**指针档**，里面没有条款正文、也没有官种分节。**你要读的通用节 + 你那一节在**
> `ccswitch/rules/dao-officer-clauses.md`（帅侧的在 `ccswitch/rules/dao-dispatch.md`）。
> **成因照直写**：那个 hook 的逻辑是「按 cwd 探到项目侧条款库就指它、探不到才退官侧档」，
> 而本仓 2026-08-07 起有了这个文件 ⇒ 探到了、于是指了过来。**这是本文件落盘的已知代价**，
> 账在下面「已知弱处」一节，未修（修它属改 hook + 改回归网，另一个批次的事）。

> **这份文件是「项目侧那一半」**，与 dao 层的两份条款库配套：
> `ccswitch/rules/dao-officer-clauses.md`（官侧，与技术栈无关的判据）与
> `ccswitch/rules/dao-dispatch.md`（帅侧，写派单令那一刻读）。
> **那两份回答「怎么判」，本份回答「在 windsurf-dao 这个仓里具体跑哪个命令、写进哪个文件」。**

> ⚠️ **本仓的特殊之处，先读这一段再往下**：windsurf-dao **就是 dao 仓本身**。别的项目里
> `ccswitch/` 是一份 symlink 过来的只读投影，而在这里它是**源**。所以本文件**刻意不复制任何
> dao 层条款正文**——同一个仓里放一份副本，那副本从落笔那一刻起就开始漂移
> （为道日损：**写指针不写副本**）。本文件只装两样东西：**①判重面去哪儿**（下一节）
> **②本仓独有的落地坐标**（验证入口 / 台账文件 / 命令序 / 部署机制）。

> **本文件的来历（2026-08-07）**：`ccswitch/scaffold-manifest.json` 的 `dispatch-clauses`
> 条目把本路径列为「多 agent 派单型项目」的必备件，理由是**三处共享 dao 机制把它当硬编码缺省**，
> 而**文件不在时它们不报错、是静默假通过**（`dao-harvest` 的判重步 Grep 一个不存在的文件
> ⇒ 恒不命中 ⇒ 每条候选都被判 `is_new=true`）。这个缺口在元仓库自己身上挂了一段时间——
> **立法者豁免于自己立的必答题**，2026-08-07 收割批入库时一并补上。
> **照直写它的分档**：该条目**没有 `canonical`**，故它是脚手架的**乙档（代做）不是甲档（物化）**，
> 本文件的内容是现场写的、不是零编辑复制来的——**可靠性不是一回事，读的时候按「有人写的」读**。

---

## 一、判重面：收割/立法前要 Grep 哪几份（本仓最要紧的一节）

`dao-harvest` workflow 的判重步与核验步都会 Grep「条款库全文」，在别的项目里那指的就是本文件。
**在 windsurf-dao 里不是**——本仓的条款正文住在下面这几份，**判重必须扫它们，扫本文件等于没扫**：

| 扫描面 | 装什么 |
|---|---|
| `ccswitch/dao.md` | 常驻场域正文。**很多节只剩一行存根**，正文在下面那行指出去的细则档里 |
| `ccswitch/rules/*.md` 全部 | 存根指出去的细则正文（dispatch / officer-clauses / guard-writing / legislation / longwindow / powershell / …） |
| `ccswitch/clause-ledger.json` | 台账字段（`n` / 首次入库 / 触发点 / 基线 / 自定 / 出处）的**唯一真相源** |

**只扫 `dao.md` 会漏掉整段判据**——这是本仓已实测的形态，不是假想。
一次把全部条款正文摊平来读（含官种分节）：

```
node ccswitch/scripts/render-clauses.mjs --role <官种>
```

**元字段（`[n= @ 触发:]` / `[基线:]` / `[自定@]` / `[仅判据·无触发]`）的判据真相源**是
`ccswitch/rules/dao-legislation.md` 的 `## 📌 条款元字段` 节——**不在本文件**，别在这里找。
立一条新条款或改一条已有条款之前，Read 那份文件全文（作用域档会把这句话送到眼前，
它的 `paths:` 里就有本文件的路径）。

---

## 二、验证入口（本仓独有，派单令里「去哪查」指的就是这里）

**唯一真相源是仓根 `CLAUDE.md` 的「常用命令」段**，本节只说三件最容易被写错的：

1. **`node scripts/run-tests.mjs` 默认层恒退 `2`，那是正常的**，不是失败——环境敏感断言被 defer 掉了。
   **判「通过」写 `-eq 0`，别写 `-le 2`**；拿得到 `exit 0` 的只有 `--env` 那一条。
   退出码五态与契约正文在 `scripts/run-tests.mjs` 头注。
2. **`--env` 要求串行环境**（没有别的官在跑测试、cc-switch GUI 没在写库、没人在改
   `~/.claude/settings.json`）。合并链 `ccswitch/scripts/dao-pr-merge.ps1` 的 `-VerifyCommand`
   必须传 `--env`。
3. **测试清单不手维护**——`run-tests.mjs` 按 `tests/*.tests.{js,ps1}` 扫目录，
   「当前有几套、各叫什么」以它末尾的打印为准。**本仓的手维护枚举已被咬过三次**，
   凡是需要人记得同步的清单都会过期。

PowerShell 脚本判成败**看 `$LASTEXITCODE`**，不看输出里有没有 "error"；中文「所在位置 行:X」
是 ErrorRecord 不是真错；**禁 `2>&1`**（混流致假错）。

## 三、改条款之后的命令序（四道，全绿才提交）

```
node ccswitch/scripts/gen-clause-index.mjs                 # ① 重新生成机器面索引
node ccswitch/scripts/gen-clause-index.mjs --check          # ② 索引与真相源对不上 ⇒ exit 1
node ccswitch/scripts/gen-clause-index.mjs --reconcile      # ③ 与 PS 侧两套独立解析对数
powershell -NoProfile -File ccswitch/scripts/check-clauses-structure.ps1   # ④ 结构 + 正文↔台账双向对账
```

- `ccswitch/clause-index.json` 是**派生物**，手改无效、下次生成即被覆盖。
- `ccswitch/clause-ledger.json` **不是**派生物，它是台账字段的真相源。
  **改了正文就要同步改台账，反之亦然**——双向孤儿检测两侧各查一遍，缺一边即红。
- **改 `ccswitch/dao.md` 后另跑一次** `node ccswitch/scripts/check-alwayson-budget.mjs`
  （常驻注入的字节预算闸）。
- **改 `tests/` 后另跑** `node ccswitch/scripts/gen-guarded-files.mjs`（`--check` 防漂移）。
- 改任何 ccswitch skill 后跑 `node scripts/dao-smoke.mjs`。

**一个已实测的坑，写在这里省下一次返工**：条款行**一行只能有一个 slug**——正文里引用别的条款时
把它写进反引号（`` `[#官通-先读后写]` ``），否则解析器判「一行两个 slug」、该条会整条落在
台账对账之外。

## 四、落地坐标（写进哪个文件）

| 要记的东西 | 归哪 |
|---|---|
| 行为级教训（直接改变 AI 行为的铁律） | `ccswitch/dao.md` 或对应 `ccswitch/rules/*.md` |
| 记忆级教训（跨会话模式/坑） | `memory/` |
| 档案级教训（完整因果链） | `docs/evolution/*.csv` |
| 任务清单（**唯一**载体，别新建平行追踪文件） | `TODO.md` |
| 项目活体知识（架构/模式/决策） | `AGENT_GUIDE.md` |
| 收割记录与待批候选索引 | `docs/ops/harvest-log.md` + `docs/ops/harvest/*.json` |
| 换机部署变更 | `NEW-MACHINE.md` |

- **临时文件**一律放**被操作的目标项目**根下 `_tmp/`（本仓 `.gitignore` 已含 `**/_tmp/`）。
- **commit 前缀**：本宿主是 Claude Code ⇒ subject 必须以 `[cc] ` 开头，提交后 `git log -1` 核对。
- **部署是 symlink/Junction 不是拷贝**：编辑 `ccswitch/` 下的文件，已链接的宿主立即可见，
  无需重新部署（`.\dao.bat --deploy` 只在增删文件时需要）。

## 五、派单中枢与合并链

- **issue 是派单中枢**（2026-08-02 起）：标签体系与三节点留痕照
  `ccswitch/rules/dao-workitem.md`，项目侧落地细则见 `docs/ops/DISPATCH-HUB.md`。
  用户只需筛 `待拍板` 标签即见所有等他的事。
- **issue / PR 正文说人话无条件生效**：人话领先、术语首现括注、技术证据折叠。
- **合并走 `ccswitch/scripts/dao-pr-merge.ps1`**（先 `-DryRun`）。裸手跑 `gh pr merge`
  只有 nudge，**那是提醒不是守卫**。
- **判据类 / 护栏类改动先过对抗验证官再合并，不得先合后审**——实现官止步 `gh pr create`。

---

## 已知弱处（照直写，两条都未修）

**㈠ 它落盘这件事本身打坏了一道回归网，且改变了注入行为。** `ccswitch/hooks/dao-subagent-clauses.js`
按 cwd 探到项目侧条款库就把指针指过来，于是本仓每个官收到的注入末尾从
`ccswitch/rules/dao-officer-clauses.md` 变成了本文件，而那句话自称「条款库正文（含各官种分节）」
——**本文件两样都没有**。`tests/subagent-clauses.tests.js` 里有一条**前提断言**明写
「dao 仓自己没有项目侧条款库（**哪天有了，下面那条该期望的就不是官侧档**）」，本文件落盘后
该套 **14 条红**（无本文件时 PASS=102 FAIL=0，实测归因）。**没有静默**：那条断言是上一个人
特意留下的触发器，它响了。**处置不在本批**（改 hook 判据 + 改回归网期望属判据类改动，
须走对抗前置），本文件顶部的红字横幅是**缓解不是修复**——它只保证读到这里的人被一跳路由对，
不改变那句注入文案仍然不准确这件事。

**㈡ 它是指针档，不属条款库扫描面**——`gen-clause-index.mjs` 与
`check-clauses-structure.ps1` 的源清单里都没有它，所以**这里写错一句，没有任何闸会红**。
它的正确性只由读它的人负责。要往这里加**判据**（而不是坐标）之前先问一句：
**换个项目还成立吗**——成立就该写进 `ccswitch/`，不该留在本文件。
