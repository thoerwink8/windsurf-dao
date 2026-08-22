# windsurf-dao

这个仓库装一样东西：**AI 和人一起干活的协作机制**——约定、派工闭环、守卫与自检。

1. **AI 协作约定**：根目录的 `CLAUDE.md`，一页纸写清楚 AI 在这个仓库里怎么工作——从 draft PR 开始、正文写清目标与验收、改完跑自检、出问题先回退、全程说人话。
2. **一条自检命令**：`node scripts/dao-check.mjs`，检查仓库现在好不好——测试跑不跑得过、技能能不能加载、密钥有没有不小心进 git。退出码 0 就是好，非 0 就是有要修的事。

历史文档（调研底稿、证据稿、旧拍板档案、项目模板、道德经源文本）已归档到私有仓 `thoerwink8/windsurf-dao-memory` 的 `docs-archive/`（2026-08-22 清零收口）；本机接上 memory Junction 后即可随时翻阅，见 `NEW-MACHINE.md`「接上 memory」节。

## 目录导览

| 路径 | 是什么 |
|---|---|
| `CLAUDE.md` | AI 协作约定，一页纸 |
| `scripts/dao-check.mjs` | 唯一的自检命令；配套 `scripts/lib/redact.js`（密钥脱敏库）与 `scripts/dao-redact.mjs`（脱敏命令行） |
| `scripts/watchdog.mjs` | 事故路径停摆看门狗（issue #442）：轮询 `orca worktree ps` 自动枚举 working/waiting 工位，检测终端 exited / ps waiting / 屏面错误指纹 / 整屏哈希三轮不变。结构性排除主工作区（master）、监视器自己的工作区与稳定 pane ID，不对协调者/审官自误报。生产保活走帥位触发（#693：随仓 SessionStart hook + board-hook 兜底，幂等调 `scripts/guard-keepalive.mjs --once`），不要靠人记得 Monitor 挂载。`--once` 跑单轮；`--snapshot-dir` 用快照复现/测试；`--exclude-pane` 排除控制端会话 |
| `scripts/guard-keepalive.mjs` | #693 帥位触发：主树 master 会话启动（SessionStart hook）与每轮提示（board-hook 兜底）时幂等检查 watchdog + flow，不在则从 `~/.dao/guard-mirror` 拉起。唯一入口 `--once`；进程列表没查成不许当 0 个。 |
| `tests/redact.test.js` | 脱敏能力的回归测试，dao-check 每次都会跑它 |
| `tests/watchdog.test.js` | 看门狗回归网：真实语料负向对照 + 真实事故实录（at-capacity 两起 / terminal_handle_stale）+ 违规样本逐一被拦（语料在 `tests/watchdog-fixtures/`）。跑法（写死，别按直觉敲 `node --test tests/`）：单套回归 `node --test tests/watchdog.test.js`；全仓自检（自发现 `tests/*.test.js` 逐套跑）`node scripts/dao-check.mjs`。⚠️ `node --test tests/` 在 Node 24 下把 `tests/` 当模块报 MODULE_NOT_FOUND，不要用它 |
| `docs/decisions/` | 历史拍板记录，冻结的档案：想知道「当初为什么这么定」就来这翻 |
| `docs/global-CLAUDE.md` | 用户级 `~/.claude/CLAUDE.md` 的真相源副本：换机时手动把内容放进 `~/.claude/CLAUDE.md`，git 不带机器配置 |
| memory 独立仓 | Claude 项目 memory（教训/坑/拍板，一条一个文件）住在独立仓 `thoerwink8/windsurf-dao-memory`，主仓不再持有；本机目录用 NEW-MACHINE「接上 memory」节那条 Junction 命令接上，换机不丢；历史文档归档也在那的 `docs-archive/` |
| `host/skills/grill-me/` | 一个拷问想法的技能：用户想被找茬时用它五步追问 |
| `host/styles/`、`host/themes/`、`host/statusline.js` | Claude Code 的界面定制（提示词样式 / 主题 / 状态栏） |
| `.github/workflows/` | 每个 PR 自动跑一遍 dao-check 扫描 |

## 新机器怎么用

1. `git clone` 拿仓库：约定、自检命令全在里面。装好 Node（20.11+）就能跑自检。
2. 把 `docs/global-CLAUDE.md` 的内容放进 `~/.claude/CLAUDE.md`——它是全局约定的真相源，换机手动放置，git 不带机器配置。
3. 不进 git 的密钥类文件（如有）手动带；pi / Codex 的模型配置照各自官方文档。
4. 完整步骤见 `NEW-MACHINE.md`。
