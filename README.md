# windsurf-dao

这个仓库装一样东西：**AI 和人一起干活的协作机制**——约定、自检，以及（停派工态冻结中的）派工闭环与守卫。

1. **AI 协作约定**：根目录的 `CLAUDE.md`，一页纸写清楚 AI 在这个仓库里怎么工作——停派工态下帅直接在 master 提交推送、改完跑自检、出问题先回退、全程说人话；编排态的流程规矩收在 dispatch skill。
2. **一条自检命令**：`node scripts/dao-check.mjs`，检查仓库现在好不好——测试跑不跑得过、技能能不能加载、密钥有没有不小心进 git。退出码 0 就是好，非 0 就是有要修的事。

历史文档（调研底稿、证据稿、旧拍板档案、项目模板、道德经源文本）已归档到私有仓 `thoerwink8/windsurf-dao-memory` 的 `docs-archive/`（2026-08-22 清零收口）；本机接上 memory Junction 后即可随时翻阅，见 `NEW-MACHINE.md`「接上 memory」节。

## 目录导览

| 路径 | 是什么 |
|---|---|
| `CLAUDE.md` | AI 协作约定，一页纸 |
| `scripts/dao-check.mjs` | 唯一的自检命令；配套 `scripts/lib/redact.js`（密钥脱敏库）与 `scripts/dao-redact.mjs`（脱敏命令行） |
| `scripts/dao.mjs` | 派工闭环的命令入口；盘面子命令 `board-archive` / `board-reset`（重测派单前的存档与清盘）：`board-archive` 全量存档卡片/终端/workers/Run/信箱到本机 `~/.dao/board-archive/`（不进 git），`board-reset` 默认 dry-run 只列将删的卡，加 `--apply` 先存档再删盘 |
| `scripts/watchdog.mjs` | 事故路径停摆看门狗（issue #442）：轮询 `orca worktree ps` 自动枚举 working/waiting 工位，检测终端 exited / ps waiting / 屏面错误指纹 / 整屏哈希三轮不变。结构性排除主工作区（master）、监视器自己的工作区与稳定 pane ID，不对协调者/审官自误报。**2026-08-31 起冻结不跑**（本机守卫栈随停派工归零，见 `docs/decisions/2026-08-31-local-guards-retire-with-server.md`）。`--once` 跑单轮；`--snapshot-dir` 用快照复现/测试；`--exclude-pane` 排除控制端会话 |
| `scripts/guard-keepalive.mjs` | 守卫保活（冻结中，同上；挂点已从随仓 settings.json 与 .cursor/hooks.json 摘掉，代码留仓等服务器落地后删） |
| `tests/redact.test.js` | 脱敏能力的回归测试，dao-check 每次都会跑它 |
| `tests/watchdog.test.js` | 看门狗回归网：真实语料负向对照 + 真实事故实录（at-capacity 两起 / terminal_handle_stale）+ 违规样本逐一被拦（语料在 `tests/watchdog-fixtures/`）。跑法（写死，别按直觉敲 `node --test tests/`）：单套回归 `node --test tests/watchdog.test.js`；全仓自检（自发现 `tests/*.test.js` 逐套跑）`node scripts/dao-check.mjs`。⚠️ `node --test tests/` 在 Node 24 下把 `tests/` 当模块报 MODULE_NOT_FOUND，不要用它 |
| `docs/decisions/` | 历史拍板记录，冻结的档案：想知道「当初为什么这么定」就来这翻 |
| `docs/global-CLAUDE.md` | 用户级 `~/.claude/CLAUDE.md` 的真相源副本：换机跑 `node scripts/onboard.mjs` 自动同步（漂移由 SessionStart 哨兵报），git 不带机器配置 |
| memory 独立仓 | Claude 项目 memory（教训/坑/拍板，一条一个文件）住在独立仓 `thoerwink8/windsurf-dao-memory`，主仓不再持有；本机目录由 `node scripts/onboard.mjs` 接上（落点有内容时拒绝并指路人工并回，见 NEW-MACHINE §10），换机不丢；历史文档归档也在那的 `docs-archive/` |
| `host/skills/grill-me/` | 一个拷问想法的技能：用户想被找茬时用它五步追问 |
| `host/styles/`、`host/themes/`、`host/statusline.js` | Claude Code 的界面定制（提示词样式 / 主题 / 状态栏） |
| `.github/workflows/` | 每个 PR 自动跑一遍 dao-check 扫描 |

## 新机器怎么用

1. `git clone` 拿仓库：约定、自检命令全在里面。装好 Node（20.11+）就能跑自检。
2. `node scripts/onboard.mjs`：同步全局约定、接 skills 链接、接 memory（幂等，坏了重跑即修）。
3. 不进 git 的密钥类文件（如有）手动带；pi / Codex 的模型配置照各自官方文档。
4. 完整步骤见 `NEW-MACHINE.md`。
