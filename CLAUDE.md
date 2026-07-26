# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> 本仓库的全局 dao 场域（`ccswitch/dao.md`）已经过 `~/.claude/CLAUDE.md` 的 `@import` 每条消息常驻——语言规则、Grep-first、commit 前缀、八句根基等不在此重复。本文件只补充**在 windsurf-dao 仓库内工作**才需要的大局与独有约定。

## 这是什么（先读这一段）

这**不是代码库，是一套 AI 行为规则系统**——用《道德经》《阴符经》哲学定义 AI 如何思考/行动/协作的规则、技能、命令、子代理。没有 `package.json`、没有构建产物、没有应用入口。"产物"就是 Markdown 规则文件 + 把它们部署到各宿主（Claude Code / Codex）的 PowerShell/Node 链接脚本。

判断改动是否合理的尺子不是"能不能跑"，而是 dao 场域八句根基（尤其**为道日损**：删 > 改 > 增，新建文件门槛高于删除）。

## 核心架构（最重要的大局）

dao 内核全部在 `ccswitch/`，通过 symlink/Junction 部署到各宿主，**git 单一真相源**：

| 目录 | 宿主 | 加载机制 |
|---|---|---|
| `ccswitch/` | Claude Code CLI | `dao.ps1 link-claude` → symlink 到 `~/.claude/` + `dao.md` 的 `@import` |
| （镜像 ccswitch） | Codex | `~/.codex/skills` 的写入方是 **cc-switch store**（用户 2026-07-27 拍板）；`dao.ps1 link-codex` 降为**补位**角色，只填 store 未占的名字，撞名一律让行不覆盖 |

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

底层工具 `dao.ps1`（一般不需直接调用，dao.bat 内部使用）：子命令 `link-claude`（部署，等效 `--deploy`）/ `unlink-claude` / `link-codex` / `set-terminal`

自检与测试（无 test runner 框架，node 测试有聚合入口，PowerShell 测试仍各自跑）：

```powershell
node scripts/run-tests.mjs                    # ★ node 测试聚合入口：扫 tests/*.tests.js 全跑 + 逐套真退出码汇总表
node scripts/run-tests.mjs --list             # 只列清单不跑
node scripts/dao-smoke.mjs                    # dao 生态完整性自检（ccswitch skills frontmatter / 交叉引用）
.\tests\link-codex.tests.ps1                  # PowerShell 测试（自带 Assert-* 断言，独立可跑，聚合入口不代跑）
.\tests\link-codex-prompts.tests.ps1
py ccswitch/skills/dao-evolution/scripts/search.py <关键词>   # 搜档案层教训（用 py 不用 python；行为级教训在 dao.md/skill，记忆级在 memory/）
```

新增 node 测试**不必**登记到本文件——`run-tests.mjs` 按 `tests/*.tests.js` 扫目录，不维护清单。
（此前本段只列了两个 .ps1 测试，三套 JS 测试从未被枚举 ⇒ 写了没人跑，与 D5 修的「写了没挂」同病；
故改为扫目录而非手维护清单——手维护的清单本仓已被咬过两次。）

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
