# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> 本仓库的全局 dao 场域（`ccswitch/dao.md`）已经过 `~/.claude/CLAUDE.md` 的 `@import` 每条消息常驻——语言规则、commit 前缀、八句根基等不在此重复。（**Grep-first 自 2026-08-04 起不再是常驻文字**：改由 `dao-hard-gates.js` G7 硬闸 + `permissions.deny` 两层承载，覆盖面与自验路见 `ccswitch/rules/dao-shell-search.md`。）本文件只补充**在 windsurf-dao 仓库内工作**才需要的大局与独有约定。

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

自检与测试（无 test runner 框架，**node 与 PowerShell 两侧都由同一个聚合入口代跑**，2026-08-08 · issue #179）：

```powershell
node scripts/run-tests.mjs                    # ★ 聚合入口（默认层）：扫 tests/*.tests.{js,ps1} 全跑 + 逐套真退出码汇总表
                                              #   ⚠ **默认层恒退 2，那是正常的**，不是失败：环境敏感断言被 defer 掉了，
                                              #     且标了 env 的那几套 .ps1 整套没跑（两条路各自都能把 2 顶起来，见下）
                                              #   ⚠ **墙钟大头是 node 侧全量，量级是分钟级不是秒级**（issue #300 实测：
                                              #     2026-08-11 默认层单跑，最慢一套 hard-gates ≈95s，全量合计约 6 分钟；
                                              #     PS 侧那几套只占其中几十秒）。**别拿任何单一数字当超时预算**——
                                              #     套数与耗时都随 tests/ 实况长，以 `--list` 与当次实测为准
node scripts/run-tests.mjs --env              # ★ 含环境敏感层 + **全部 .ps1 套** —— **只有这一条拿得到 exit 0**；合并前 / 收官前跑它
                                              #   比默认层更慢（PS 层串行追加百秒级）；要求串行环境（见下）。
                                              #   **当前有几套以 `--list` 为准，此处不记数**
node scripts/run-tests.mjs --list             # 只列清单不跑（带分层标注，js/ps 两侧都标）
                                              #   ⚠ 2026-08-11 重设计：断言条数基线（--write-baseline / assertion-baseline.json）
                                              #     已随「文字一致性检查全灭」删除（拷问局定案③）
node scripts/dao-smoke.mjs                    # dao 生态完整性自检（ccswitch skills frontmatter / 交叉引用）
powershell -NoProfile -ExecutionPolicy Bypass -File .\tests\<名>.tests.ps1   # 单跑一套 PS 测试（自带 Assert-*，独立可跑）
                                              #   ⚠ 这里**不手维护清单** —— 手维护的必过期（本行历史上只列过 5 套里的 2 套）；
                                              #   当前有几套、哪几套标了 env ⇒ `node scripts/run-tests.mjs --list` 会**扫全并逐条标注**，以那份为准
py ccswitch/skills/dao-evolution/scripts/search.py <关键词>   # 搜档案层教训（用 py 不用 python；行为级教训在 dao.md/skill，记忆级在 memory/）

node ccswitch/scripts/clause-sources.mjs      # 条款源清单的机器出口（一行 JSON）；PS 缺省全量模式向它要清单
                                              #   ⚠ 2026-08-11 重设计：clause-index.json 派生物与其生成器已消灭，
                                              #     渲染端（render-clauses.mjs）改运行时现算；clause-ledger.json 台账
                                              #     与双向对账同步删除（拷问局定案③）——这两把旧命令已不存在
powershell -NoProfile -File ccswitch/scripts/check-clauses-structure.ps1  # 条款结构检查（焊接签名 / 孤儿条款 / 扫描面自检）
                                              #   ⚠ **缺省已是全量模式**：不传 -TargetFile ⇒ 向上面那个
                                              #   出口要源清单，**逐份**检（每份用清单给的选择器；officer-clauses 是 AllTopLevel）。
                                              #   退出码**三态**：0 全绿 · 1 有结构违例 · **3 = 拿不到源清单（本次压根没查成）**。
                                              #   判「通过」写 `-eq 0`；3 刻意不与 1 合流——「没查成」不是「查出问题」。
                                              #   只检一份：加 `-TargetFile <路径>`（那条路径不依赖 node，行为与以前逐字一致）。
node ccswitch/scripts/render-clauses.mjs --role <官种>  # 按官种渲染条款集（2026-08-11 起运行时现算，无索引派生物）；**已接进派单流程**：
                                              #   `SubagentStart` hook `ccswitch/hooks/dao-subagent-clauses.js` 每次派官都调它
                                              #   本行此前写作「原型，尚未接进派单流程」，注册完成那一刻即为假而无人订正
                                              #   ⚠ 已证的是「响过」不是「每次都响」：注入率（派 N 个官、几个真收到）仍未审计，
                                              #     而那正是退役「派单令首行 Read」双通道的前置门（契约：≥20 次 100%）

node ccswitch/hooks/dao-glob-gate.js --selfcheck      # 那个 hook 此刻能不能算出被守护清单（2026-08-11 起运行时现算 + 指纹缓存，
                                              #   旧的 gen-guarded-files.mjs 派生物已消灭）

node scripts/dao-gates.mjs                    # ★ 交付前闸门聚合（issue #70 层2 件①）：dao-smoke / check-mutation-anchor /
                                              #   check-clauses-structure（全量）等收成一条命令，真退出码汇总表 +
                                              #   末行 DAO_GATES_SUMMARY；全绿才 exit 0（check-clauses-structure 的
                                              #   exit=3「没查成」计入 inconclusive 不计入 red，聚合退出码因此是 2 不是 1）
                                              #   ⚠ **此处刻意不写「共几道闸」**：当前有几道、各叫什么以 `--list` 的打印为准
                                              #   （2026-08-10 订正 · PR #252 对抗验证判词问题 8：这两行此前既写死「5 道闸」
                                              #   又声明「此行不用同步维护」——同一处自相矛盾，且加第 6 道闸时这里没有任何
                                              #   东西会红。本文件上一段自己就写着这个病在本仓被咬过三次）
node scripts/dao-gates.mjs --list             # 只列各道闸的名字与说明，不执行；改闸清单改的是脚本本身，此行不用同步维护

powershell -NoProfile -ExecutionPolicy Bypass -File scripts/dao-merge-cleanup.ps1 -WorktreePath <p> -Branch <b>
                                              # ★ 合并链收尾三连脚本化（issue #70 层2 件②，`dao-pr-merge.ps1` 合并后
                                              #   若跑在链接 worktree 里只打印这两行手工命令，本脚本把它们脚本化）：
                                              #   差集核验（只剩 merge 壳或空才准 -D，否则报错停）+ worktree remove +
                                              #   prune + 删分支 + pull；幂等可重跑。必须从主仓（不能从 -WorktreePath
                                              #   自己里面）跑；退出码契约见脚本头注 .NOTES
```

`ccswitch/clause-index.json` 与 `ccswitch/clause-ledger.json` **已于 2026-08-11 重设计时双双删除**
（派生物消灭 + 拷问局定案③「文字一致性检查全灭」）。条款行尾的 slug `[#<域>-<短名>]` 保留为稳定 ID，
其字段史（复发次数/首次入库等）的归宿是 git 历史。立法档案见 `docs/decisions/2026-08-11-*.md`。

新增测试**不必**登记到本文件——`run-tests.mjs` 按 `tests/*.tests.{js,ps1}` 扫目录，两侧都不维护清单
（**2026-08-08 · issue #179 起 `.ps1` 那侧也由它代跑**；此前括号里写的是「它只列不跑，清单仍是全的」——
「清单是全的」当时为真，但**被列出来 ≠ 被跑到**，那 6 套一套都没进合并链拿到的那个 exit 0 里）。
（此前本段只列了两个 .ps1 测试，三套 JS 测试从未被枚举 ⇒ 写了没人跑，与 D5 修的「写了没挂」同病；
故改为扫目录而非手维护清单——手维护的清单本仓已被咬过两次。）

⚠️ **2026-08-04 第三次被咬，就在同一段里**（issue #109）：上面那句只治了 JS 侧，**`.ps1` 侧仍留着
手维护的两行**，而盘上已有 **4** 套 —— `clause-structure` 与 `pr-body-scan` 两套**从未被列进来**，
本文件因此连续两天把「跑全套」教成只跑一半。已改为指向 `run-tests.mjs` 的末尾打印（它扫目录、
不会过期）。**教训不是「再补一次清单」**：同一段里手维护的清单被咬三次，说明**凡是需要人记得同步的
枚举都会过期**，正路是让它指向一个自己会更新的东西。
**为什么这一处特别贵**：本文件是**派单令让官去查验证入口的那个落点**（见 `ccswitch/rules/dao-dispatch.md`
的开工第二步）——**指针指对了，被指的那份内容却是旧的**，官照做反而拿到一个更权威的错答案。

### 测试分层：默认层 / 环境敏感层（2026-08-04 · issue #116）

有一小撮断言**对别人拥有的机器级可变状态做不变量断言**（真实 `~/.claude/settings.json`、
cc-switch GUI 的库）—— **它不制造污染，它被别人的正常活动污染**，于是多官并行期偶发红。
「红了先重跑」会训练所有人无视这道闸，故改为分层：

**2026-08-08（issue #179）起这套分层同时管着 PowerShell 那一侧**，机制同构但粒度不同：
`.tests.ps1` 头部写 `# @dao-test-tier: env` ⇒ **整套**只在 `--env` 起进程（JS 侧那个标记是
「文件内部分断言 defer」，文件照跑——**两者语义不同，别当同一个东西读**）。

| 跑法 | 跑什么 | 退出码 |
|---|---|---|
| `node scripts/run-tests.mjs` | 全部 `.tests.js`（环境敏感断言被 defer）+ **无标记的 `.tests.ps1`** | **恒 2**（「本次没跑完」） |
| `node scripts/run-tests.mjs --env` | 全部，含环境敏感断言 + **全部 `.tests.ps1`** | 全过 **0** |

**退出码六态**：`0` 全跑全过 · `1` 有测试红（node 侧或 PS 侧）**或某套断言条数跌破基线** ·
`2` 无红但有 defer / 有 PS 套没跑 ·
`3` 用法错（一套都没跑）· `4` 分层自检失败（静态声明与运行期计数对不上，或某 PS 套 exit 0 却零输出，
**或断言条数基线没读成 / 一套都没对上**）·
`5` 找不到 tests/ 目录（一套都没跑，刻意不与 2 合流）。**判「通过」写 `-eq 0`，别写 `-le 2`。**
（此处此前写「五态」而漏了 `5` —— 代码与回归网从一开始就有它，是头注与本文件两处同时漏记；2026-08-08 订正。
**2026-08-10 · issue #268 给 1 与 4 各加了一个来源，态数没变**：加的是「一条断言都没红，但这一套
比基线少跑了 N 条」——那种情形下没有任何断言失败，不并进 1 就会掉进 0 或 2，与「全跑全过」不可区分。）
契约正文在 `scripts/run-tests.mjs` 头注（唯一真相源），回归网 `tests/run-tests-tier.tests.js`
与 `tests/assertion-baseline.tests.js`。
末行 `RUN_TESTS_SUMMARY` 尾部另有 `psfiles=` / `psred=` / `psskip=` 三个字段（跑了几套 / 红几套 / 没跑几套），
再往后是 `baselow=`（几套跌破基线）/ `basegate=`（`on` 查了 · `off` 没启用 · `fail` 想查却没查成 ·
`write` 这一跑是去重写基线的）—— **三种「没查」刻意不合流成一个 0**。

🔴 **别把 2 当成绿**。写 `@(0,2)` 这种放行谓词，分层就退化成「接受偶发红」的另一种形态。
**当前哪些文件有环境敏感层** ⇒ `node scripts/run-tests.mjs --list` 会逐条标注，以那份为准
（此处刻意不点名、不写条数——同一段里手维护的枚举已被咬过三次）。

**`--env` 什么时候跑**：合并前（`dao-pr-merge.ps1` 的 `-VerifyCommand` 必须传 `--env`，
否则合并链在验证那一步当场停）· 窗口收官 · 任何以「run-tests 全绿」为验收的场合。
**要求串行环境**：没有别的官在跑测试 · cc-switch GUI 没在写库 · 没人在改 `~/.claude/settings.json`。
（issue #179 之后这条串行要求又多了一个来源：标了 env 的 PS 套里有用**固定** `_tmp/` 路径当沙盒的，
并行跑必互踩 —— 那也正是它们被标 env 而不是留在默认层的理由之一。
🔴 **2026-08-08 · issue #187 把这句话改小了一半，别按旧版读**：`dao-pr-merge` 与 `pr-body-scan`
两套的沙盒已随机化（`%TEMP%/…-$(Get-Random)`）、env 标记已摘、回到默认层；实测 4 个并发实例
全绿，而同一份代码把路径改回固定共享路径 ⇒ 4 个实例里 3 个非零退出（`origin.git does not
appear to be a git repository` —— 后开跑的把先开跑那个的沙盒整棵删了）。
⚠️ **同一句话原本就漏了一套**：`dao-secrets` 也用固定 `_tmp/dao-secrets-test`，它是第三套。
它**不下放**，理由与沙盒无关：它对真 `%USERPROFILE%`/`%APPDATA%` 做机器级不变量断言，
随机化治不了那一格。⇒ 串行要求仍然成立，只是理由换了。）

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
