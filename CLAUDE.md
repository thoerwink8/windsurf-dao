# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> 本仓库的全局 dao 场域（`ccswitch/dao.md`）已经过 `~/.claude/CLAUDE.md` 的 `@import` 每条消息常驻——语言规则、commit 前缀、八句根基等不在此重复。（**Grep-first 自 2026-08-04 起不再是常驻文字**：那道硬闸已于 2026-08-12 随 hooks 三问梳理退役（issue #324 A 批），机器拦截只剩 `permissions.deny` 一层；`cat`/`head`/`tail`/`sed` 当前无机器拦截，收不收进 deny 已列成选项报用户拍板（#324 B 批）。背景见 `ccswitch/rules/dao-shell.md` 第三节。）本文件只补充**在 windsurf-dao 仓库内工作**才需要的大局与独有约定。

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

部署是 **symlink/Junction**，不是拷贝：编辑仓库内文件 → 已链接的宿主立即可见，无需重新部署。`dao check` 校验 ccswitch skills 的 frontmatter。

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
（前置：本机需有 `sqlite3` 命令行工具（`config-sync/lib/sqlite.mjs` 会按 `SQLITE3_PATH` → PATH → `vendor/sqlite/` 查找，缺了报错提示手动装）；`common-secrets.json` 含脱敏真实值不进 git，换机手动复制。）

底层工具 `dao.ps1`（一般不需直接调用，dao.bat 内部使用）：子命令 `link-claude`（部署，等效 `--deploy`）/ `unlink-claude` / `set-terminal`；Codex 侧只剩 `link-codex`（只读报告）/ `unlink-codex`（清 dao 旧链与悬空坟）/ `link-codex-prompts`（这个仍写 `~/.codex/prompts`，与 skills 无关）

自检与测试（**就一条命令**）：

```powershell
node scripts/dao-check.mjs                    # ★ 等价 `.\dao.bat check`：exit 0 = 好，非 0 = 坏，没有第三种；实测 2.7 秒
                                              #   检什么全靠扫描、无手维护清单：tests/ 全跑 · 注册的 hook 路径都在 ·
                                              #   SKILL.md 可解析 · git 追踪面无密钥。红了照它打的三行修，契约见脚本头注
py ccswitch/skills/dao-evolution/scripts/search.py <关键词>   # 搜档案层教训（用 py 不用 python；行为级教训在 dao.md/skill，记忆级在 memory/）

pwsh -NoProfile -ExecutionPolicy Bypass -File ccswitch/scripts/dao-claim.ps1 -Action selftest
                                              # 认领协议（两台机 / 两个 AI 抢同一张 issue 时「谁在干哪张单」）的纯函数自测。
                                              #   实际用法：-Action list | readback -Issue <n> | lease -Issue <n>
                                              #   退出码：0 正常 · 1 参数或环境错 · 2 = 回读发现自己该让位（readback 专用）

pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/dao-merge-cleanup.ps1 -WorktreePath <p> -Branch <b>
                                              # ★ 合并后的本地收尾：worktree remove + prune + pull + `git branch -d`
                                              #   **pull 必须排在删分支前面**：`-d` 的未合并核验参照本地主干，没追平
                                              #   就必然误判 —— 上一版为此自建差集核验再用 `-D` 强删，那一层连同它
                                              #   制造的风险已随 issue #325 删除。幂等可重跑；必须从主仓（不能从
                                              #   -WorktreePath 自己里面）跑；退出码契约见脚本头注 .NOTES。
                                              #   远端分支由仓库设置「合并后自动删 head 分支」负责，脚本不碰
                                              #   上面两条命令优先用 pwsh（issue #338）；机器没装 PS7 时把开头的 pwsh 换成 powershell，参数相同（5.1 回退全兼容）
```

**条款元数据链整体退役（2026-08-12，issue #324 B 批）**：解析器 `ccswitch/lib/clause-parser.mjs`、
渲染端 `render-clauses.mjs`、源清单出口 `clause-sources.mjs`、结构检查 `check-clauses-structure.ps1`
四件一并删除；它们的自动调用方（`dao-subagent-clauses.js` hook）已于同批 A 退役，管线整体没有消费方。
更早的 `clause-index.json` / `clause-ledger.json` 两个派生物已于 2026-08-11 删除。
条款行尾的 slug `[#<域>-<短名>]` 保留为稳定 ID，其字段史的归宿是 git 历史。
立法档案见 `docs/decisions/2026-08-11-*.md`。

## issue 派单中枢（2026-08-02 接入）

本仓自 2026-08-02 起用 **issue 做派单中枢**（当日实况：单日 20+ 单/PR 多官派单，事实中枢先行、基建随后补齐）。标签体系/三节点留痕/蓄水池纪律照 dao 的 `ccswitch/rules/dao-dispatch.md` §一，项目侧落地细则见 `docs/ops/DISPATCH-HUB.md`。用户只需记一件事：**筛 `待拍板` 标签（或看置顶单）即见所有等你的事**；观测看板 https://github.com/users/thoerwink8/projects/1 。
**issue/PR 正文说人话无条件生效**（人话领先、术语首现括注、技术证据折叠——没参与项目的人扫顶部就该知道发生了什么）。

## 改 dao-* 文件前的自审门（AGENT_GUIDE.md §三）

> 修道先于传道。这是**本仓库工作约定**，只约束在 windsurf-dao 内工作的 Agent。

1. **无为审视**：是否新增了"禁止 X"显式禁令 / "路径A/B"条件分支 / 平行追踪文件？→ 改为原则表达、单一流程、路由到 TODO.md/AGENT_GUIDE.md。
2. **知识归位**：教训走三层路由（行为层 dao.md/skill → 记忆层 memory/ → 档案层 CSV）？TODO.md 已完成项更新？
3. **减法确认**：本次删了什么冗余？净增越少越好。
4. **文档同步**：改动若涉及前置依赖 / 部署命令 / 进 git 的配置类别 / config-sync 行为 / 须手动复制的本机资产 → **必须在同一次提交里更新 `NEW-MACHINE.md`**（不确定就更新）。

## 本仓库工程注意

- **改完跑体检**：`node scripts/dao-check.mjs`（或 `.\dao.bat check`）。exit 0 才算过。
- **commit 前缀**：本宿主是 Claude Code，subject 必须以 `[cc] ` 开头（提交前自检宿主，详见 dao.md「言·名之则」）。
- **PowerShell 假错**：`dao.ps1` / `*.ps1` 用 `$LASTEXITCODE` 判成败，不看输出有无 "error"；中文「所在位置 行:X」是 ErrorRecord 非真错；禁 `2>&1`（混流致假错）。
- **bash 脚本 LF 行尾**：`.gitattributes` 强制 `*.sh eol=lf`，避免 Windows clone 后 CRLF 化导致 shebang 失效。
- **`config-sync/common-secrets.json` 不进 git**（含脱敏真实值），换机手动复制。
