# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> 本仓库的全局 dao 场域（`ccswitch/dao.md`）已经过 `~/.claude/CLAUDE.md` 的 `@import` 每条消息常驻——语言规则、Grep-first、commit 前缀、八句根基等不在此重复。本文件只补充**在 windsurf-dao 仓库内工作**才需要的大局与独有约定。

## 项目类型（必答题 · 用户 2026-08-02 答）

本仓是**内部工具型项目**。

（这一行由项目主人回答，AI 不代答。答「内部工具型」⇒ dao 体检不查产品型那一档：PR 真机证据三态 / PR 模板 / issue 模板三件。判据是纯子串匹配，勿改措辞。）

## 这是什么（先读这一段）

这**不是代码库，是一套 AI 行为规则系统**——用《道德经》《阴符经》哲学定义 AI 如何思考/行动/协作的规则、技能、命令、子代理。没有 `package.json`、没有构建产物、没有应用入口。"产物"就是 Markdown 规则文件 + 把它们部署到各宿主（Claude Code / Codex）的 PowerShell/Node 链接脚本。

判断改动是否合理的尺子不是"能不能跑"，而是 dao 场域八句根基（尤其**为道日损**：删 > 改 > 增，新建文件门槛高于删除）。

## 核心架构（最重要的大局）

dao 内核全部在 `ccswitch/`，通过 symlink/Junction 部署到各宿主，**git 单一真相源**：

| 目录 | 宿主 | 加载机制 |
|---|---|---|
| `ccswitch/` | Claude Code CLI | `dao.ps1 link-claude` → symlink 到 `~/.claude/` + `dao.md` 的 `@import` |
| （不由 dao 部署） | Codex | `~/.codex/skills` 的写入方是 **cc-switch store**（用户 2026-07-27 拍板）；`dao.ps1` 已退出该目录的写入业务——`link-codex` 只剩只读报告（不建链），`unlink-codex` 是仅存的写动作且只删（清 dao 早年自建链 + 悬空坟） |

部署是 **symlink/Junction**，不是拷贝：编辑仓库内文件 → 已链接的宿主立即可见，无需重新部署。`scripts/dao-smoke.mjs` 校验 ccswitch skills 的 frontmatter 与交叉引用一致性。

> 历史：`.devin/`（Windsurf 侧）已于 2026-06-29 退役删除，内容早已迁移至 ccswitch。需要时可从 git 历史恢复。

## 知识归位（改之前先确认写到哪）

| 知识类型 | 归属文件 |
|---|---|
| 不变原则 / 哲学场域 | `ccswitch/dao.md`、`docs/classics/{帛书老子,道德经,阴符经}.md`（源文本不可改） |
| 项目铁律 / 本仓库约定 | 本 `CLAUDE.md` |
| 项目活体知识（架构/模式/决策） | `AGENT_GUIDE.md` |
| 任务清单（唯一载体） | `TODO.md`（**不要新建 plan.md / archive/ 等平行追踪文件**） |
| 教训（行为级） | `dao.md` / 对应 skill 正文（直接改变 AI 行为的铁律） |
| 教训（记忆级） | `memory/`（跨会话模式/坑，MEMORY.md 索引每轮可见） |
| 教训（档案级） | `docs/evolution/*.csv`（完整因果链，Obsidian 数据源） |
| 换机部署变更 | `NEW-MACHINE.md`（见下方自审门第 4 条） |

## 常用命令

统一入口（`dao.bat`，双击即用，融合配置同步 + 部署 + 状态）：

```powershell
.\dao.bat                    # 交互菜单（推荐，覆盖所有操作）
.\dao.bat --direction=down   # origin → 本机 DB + 部署（恢复/换机，默认安全）
.\dao.bat --direction=up     # 本机 DB → origin（发布，落后即拒；可加 --dry-run）
.\dao.bat --deploy           # 仅重新部署 skills/commands/hooks 到 ~/.claude（不动 DB/git）
.\dao.bat --status           # dao 双栈链接健康矩阵
.\dao.bat --doctor           # 配置一致性体检
.\dao.bat --inventory        # 只读盘点
.\dao.bat --persona          # 系统提示词人设切换（dao / fable5 / off）
```
（前置：首次需 `.\config-sync\setup-sqlite.ps1` 装 sqlite3；`common-secrets.json` 含脱敏真实值不进 git，换机手动复制。）

底层工具 `dao.ps1`（一般不需直接调用，dao.bat 内部使用）：子命令 `link-claude`（部署，等效 `--deploy`）/ `unlink-claude` / `set-terminal`；Codex 侧只剩 `link-codex`（只读报告）/ `unlink-codex`（清 dao 旧链与悬空坟）/ `link-codex-prompts`（这个仍写 `~/.codex/prompts`，与 skills 无关）

自检与测试（无 test runner 框架，node 测试有聚合入口，PowerShell 测试仍各自跑）：

```powershell
node scripts/run-tests.mjs                    # ★ node 测试聚合入口：扫 tests/*.tests.js 全跑 + 逐套真退出码汇总表
node scripts/run-tests.mjs --list             # 只列清单不跑
node scripts/dao-smoke.mjs                    # dao 生态完整性自检（ccswitch skills frontmatter / 交叉引用）
powershell -NoProfile -File .\tests\<名>.tests.ps1   # PowerShell 测试：自带 Assert-* 断言、独立可跑，★ 入口**不代跑**
                                              #   当前有几套、各叫什么 ⇒ 看 run-tests.mjs 末尾那段打印，本文件刻意不枚举
py ccswitch/skills/dao-evolution/scripts/search.py <关键词>   # 搜档案层教训（用 py 不用 python；行为级教训在 dao.md/skill，记忆级在 memory/）

node ccswitch/scripts/gen-clause-index.mjs    # 条款机器面索引：改完 dao.md / ccswitch/rules/*.md 后重新生成
node ccswitch/scripts/gen-clause-index.mjs --check      # 索引与真相源对不上 ⇒ exit 1（tests/clause-index.tests.js 每次跑它）
node ccswitch/scripts/gen-clause-index.mjs --reconcile  # 与 check-clauses-structure.ps1 两套独立解析对数（条款数 / 触发:无 / slug 数）
powershell -NoProfile -File ccswitch/scripts/check-clauses-structure.ps1  # 条款结构 + 正文 slug↔台账双向对账（另一套独立实现）
node ccswitch/scripts/render-clauses.mjs --role <官种>  # 按官种渲染条款集（原型，**尚未**接进派单流程）
```

`ccswitch/clause-index.json` 是**派生物**（真相源是那些 Markdown），手改无效、会被下次生成覆盖。

`ccswitch/clause-ledger.json` **不是**派生物，它是**台账字段的真相源**（复发次数 / 首次入库 /
触发点 / 基线 / 自定标记 / 出处 / 状态）；正文只在条款行尾持一个 slug `[#<域>-<短名>]` 与它关联。
两边由**双向孤儿检测**夹住（正文有 slug 而台账无此条、台账有条目而正文找不到 ⇒ 都判红），
node 与 PowerShell 两个守卫各查一遍。**双轨期**：旧元字段仍原位保留、逐字段与台账对账，
不等即红 —— 那份对账全绿是后续删旧字段的前置门。**改了正文就要同步改台账，反之亦然。**

新增测试**不必**登记到本文件——`run-tests.mjs` 按 `tests/*.tests.{js,ps1}` 扫目录，两侧都不维护清单
（`.ps1` 那侧它只列不跑，清单仍是全的）。
（此前本段只列了两个 .ps1 测试，三套 JS 测试从未被枚举 ⇒ 写了没人跑，与 D5 修的「写了没挂」同病；
故改为扫目录而非手维护清单——手维护的清单本仓已被咬过两次。）

⚠️ **2026-08-04 第三次被咬，就在同一段里**（issue #109）：上面那句只治了 JS 侧，**`.ps1` 侧仍留着
手维护的两行**，而盘上已有 **4** 套 —— `clause-structure` 与 `pr-body-scan` 两套**从未被列进来**，
本文件因此连续两天把「跑全套」教成只跑一半。已改为指向 `run-tests.mjs` 的末尾打印（它扫目录、
不会过期）。**教训不是「再补一次清单」**：同一段里手维护的清单被咬三次，说明**凡是需要人记得同步的
枚举都会过期**，正路是让它指向一个自己会更新的东西。
**为什么这一处特别贵**：本文件是**派单令让官去查验证入口的那个落点**（见 `ccswitch/rules/dao-dispatch.md`
的开工第二步）——**指针指对了，被指的那份内容却是旧的**，官照做反而拿到一个更权威的错答案。

## issue 派单中枢（2026-08-02 接入）

本仓自 2026-08-02 起用 **issue 做派单中枢**（当日实况：单日 20+ 单/PR 多官派单，事实中枢先行、基建随后补齐）。标签体系/三节点留痕/蓄水池纪律照 dao 的 `ccswitch/rules/dao-workitem.md`，项目侧落地细则见 `docs/ops/DISPATCH-HUB.md`。用户只需记一件事：**筛 `待拍板` 标签（或看置顶单）即见所有等你的事**；观测看板 https://github.com/users/thoerwink8/projects/1 。
**issue/PR 正文说人话无条件生效**（人话领先、术语首现括注、技术证据折叠——没参与项目的人扫顶部就该知道发生了什么）。

## 改 dao-* 文件前的自审门（AGENT_GUIDE.md §三）

> 修道先于传道。这是**本仓库工作约定**，只约束在 windsurf-dao 内工作的 Agent。

1. **无为审视**：是否新增了"禁止 X"显式禁令 / "路径A/B"条件分支 / 平行追踪文件？→ 改为原则表达、单一流程、路由到 TODO.md/AGENT_GUIDE.md。
2. **知识归位**：教训走三层路由（行为层 dao.md/skill → 记忆层 memory/ → 档案层 CSV）？TODO.md 已完成项更新？
3. **减法确认**：本次删了什么冗余？净增越少越好。
4. **文档同步**：改动若涉及前置依赖 / 部署命令 / 进 git 的配置类别 / config-sync 行为 / 须手动复制的本机资产 → **必须在同一次提交里更新 `NEW-MACHINE.md`**（不确定就更新）。

## 本仓库工程注意

- **改规则后跑 smoke test**：改完跑 `node scripts/dao-smoke.mjs` 验证 ccswitch skills frontmatter 与交叉引用。
- **commit 前缀**：本宿主是 Claude Code，subject 必须以 `[cc] ` 开头（提交前自检宿主，详见 dao.md「言·名之则」）。
- **PowerShell 假错**：`dao.ps1` / `*.ps1` 用 `$LASTEXITCODE` 判成败，不看输出有无 "error"；中文「所在位置 行:X」是 ErrorRecord 非真错；禁 `2>&1`（混流致假错）。
- **bash 脚本 LF 行尾**：`.gitattributes` 强制 `*.sh eol=lf`，避免 Windows clone 后 CRLF 化导致 shebang 失效。
- **`config-sync/common-secrets.json` 不进 git**（含脱敏真实值），换机手动复制。
