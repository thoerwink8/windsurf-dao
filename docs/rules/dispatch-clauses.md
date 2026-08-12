<!-- dao-clause-pointer: 本档是指针档，不含条款正文；条款正文在 dao 官侧档 ccswitch/rules/dao-officer-clauses.md -->

# windsurf-dao 项目侧派单条款库

> 📌 **上面那行 HTML 注释是给机器读的，别删**（用户 2026-08-07 拍板 · issue #174）。
> `ccswitch/hooks/dao-subagent-clauses.js` 探到项目侧条款库后会**有界读它的头部**找
> `<!-- dao-clause-pointer` 这个标记：**有标记 ⇒ 判为指针档**，条款正文源退回 dao 官侧档，
> 注入末尾另附一行「项目侧（指针档）：<路径>」；**没标记 ⇒ 行为一个字不变**（别的项目那份
> 装的就是条款正文，不受影响）。
>
> **同型仓照此办理**：凡「自己就是规则源」的仓（条款正文住在仓内的 dao 内核里，项目侧那份
> 只做指针），在项目侧档**头部**放一行同样的标记即可 —— 这不是给 windsurf-dao 开的特例。
> **为什么用自声明而不是让机器猜**：「这份文件里有没有条款正文」是近似判断、两个方向都构造
> 得出反例；而「作者自己声明它是指针档」是**结构决定的**，零近似。标记必须落在**头部**
> （有界读窗口内）且**行首**是 `<!--`，正文里提到这个词不会被误判。
>
> 🔴 **被注入指到这里的官**：本文件**没有条款正文、没有官种分节**。你要读的通用节 + 你那一节在
> `ccswitch/rules/dao-officer-clauses.md`（帅侧的在 `ccswitch/rules/dao-dispatch.md`）。
> 协议是**两份都读**：那两份回答「怎么判」，本份回答「在这个仓里跑哪个命令」。

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

（条款的台账与索引两个派生物已于 2026-08-11 删除，字段史归 git 历史；
行尾 slug `[#<域>-<短名>]` 保留为稳定 ID。）

**只扫 `dao.md` 会漏掉整段判据**——这是本仓已实测的形态，不是假想。
一次把全部条款正文摊平来读（含官种分节）：

**`<官种>` 只认这六个取值**（写错一个字它就渲染不出东西，而「零条」与「本来就没这一节」在输出上长得一样）：
`general` / `reviewer` / `implementer` / `adversary` / `scout` / `dogfood`。
⚠️ **对抗验证官那一格叫 `adversary`，不叫 `verifier`** —— 本仓 2026-08-07 收割批的四路收割官通篇用
`clause-verifier` 称呼它，读者最自然猜的 `verifier` **恰好是非法值**。当前词表随时可查：
`node ccswitch/scripts/render-clauses.mjs --list-roles`（它同时打印每个官种今天有几条）。

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

1. **就一条命令**：`node scripts/dao-check.mjs`（等价 `.\dao.bat check`），实测 2.7 秒。
   **exit 0 = 过，非 0 = 不过，没有第三种。** 别再写 `-le 2` 那类放行谓词——它放行的那个 `2`
   属于已经删掉的六态分层协议（issue #325）。契约正文在 `scripts/dao-check.mjs` 头注。
2. **合并链跑的是同一条**：`ccswitch/scripts/dao-pr-merge.ps1` 的 `-VerifyCommand` 缺省即它，
   不需要传任何开关。env 标记、串行环境要求、断言基线**全已删除**，读到旧说法以盘上为准。
3. **检查面不手维护**——dao check 扫 `tests/` 目录、扫 hook 注册配置、扫 git 追踪面算出来，
   新增一套测试不必登记到任何地方。**本仓的手维护枚举已被咬过三次**，凡是需要人记得同步的都会过期。

PowerShell 脚本判成败**看 `$LASTEXITCODE`**，不看输出里有没有 "error"；中文「所在位置 行:X」
是 ErrorRecord 不是真错；**禁 `2>&1`**（混流致假错）。

## 三、改条款之后的命令序

```
powershell -NoProfile -File ccswitch/scripts/check-clauses-structure.ps1   # 条款结构检查（**缺省即全量**）
node ccswitch/scripts/check-alwayson-budget.mjs                            # 只在改了 ccswitch/dao.md 时跑（常驻注入字节预算）
node scripts/dao-check.mjs                                                 # 体检，exit 0 才算过
```

结构检查的**退出码三态**：`0` 全绿 · `1` 有结构违例 · **`3` 拿不到源清单（本次压根没查成，
fail-closed，绝不回落到只查 dao.md）**。判「通过」写 `-eq 0`，别把 3 当"跑了没事"。
它的源清单来自 `node ccswitch/scripts/clause-sources.mjs`（一行 JSON 的机器出口）。
⚠️ 它**没有挂在 dao check 上**，是手动闸——原先转调它的聚合入口已随 issue #325 删除。

- **新建一份带条款的 `ccswitch/rules/*.md` 时，记得把它加进
  `ccswitch/lib/clause-parser.mjs::defaultSources()`**：不在里面 = 结构检查看不见它。
  会替你出声的只有 SessionStart hook（`dao-scaffold-check.js` 扫目录，发现未登记打一行 ⓘ）——
  **那只是纵深，不是全覆盖**。

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
| 收割记录与待批候选索引 | ~~`docs/ops/harvest-log.md` + `docs/ops/harvest/*.json`~~（2026-08-12 零清理删除，git 历史可找回） |
| 用户拍板「这件事刻意不做」（编号 / owner / 解冻条件） | `docs/ops/nogo-ledger.json`；代码注释里**只留** `[NOGO:<编号>]` 一行指针（**双向对账机检已随 PR #307 退役，台账为归档记录**；判据 `ccswitch/rules/dao-comment.md`） |
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

## 已知弱处（照直写）

**㈠ 它落盘曾经打坏一道回归网 —— 已修（issue #174，用户 2026-08-07 裁定「指针档自声明」）。**
留下经过，因为它是这套标记为什么存在的唯一出处：`dao-subagent-clauses.js` 原本「按 cwd 探到
项目侧条款库就指它」，于是本仓每个官收到的注入末尾从 `ccswitch/rules/dao-officer-clauses.md`
变成了本文件，而那句话自称「条款库正文（含各官种分节）」——**本文件两样都没有**。
`tests/subagent-clauses.tests.js` 里那条**前提断言**明写「dao 仓自己没有项目侧条款库
（**哪天有了，下面那条该期望的就不是官侧档**）」，本文件落盘后该套 **14 条红**
（无本文件时 PASS=102 FAIL=0，实测归因）。**没有静默**：那是上一个人特意留下的触发器，它响了。
**现在的形态**：头部标记 ⇒ hook 有界读头部认出指针档 ⇒ 正文源退官侧档 + 附一行项目侧路径；
前提断言已翻面为「本仓项目侧档在**且带标记**」，并配了「恒判非指针」的反向 mutation 钉住判别力。

**㈡ 它是指针档，不属条款库扫描面**——`check-clauses-structure.ps1` 的源清单里没有它，
所以**这里写错一句，没有任何闸会红**。
**头部那行标记现在也一样**：曾经守着它的那条前提断言随 issue #325 的测试收敛一起删了，
删掉标记不会有任何东西变红。这份文件的正确性只由读它的人负责。

**㈢ 标记只治「指针指对了没有」，不治别的两件事**：注入率（派 N 个官几个真收到）仍未审计；
官种筛选仍因 `agent_type` 不含官种信息而空转。别把这道修法读成那两格也好了。
它的正确性只由读它的人负责。要往这里加**判据**（而不是坐标）之前先问一句：
**换个项目还成立吗**——成立就该写进 `ccswitch/`，不该留在本文件。
