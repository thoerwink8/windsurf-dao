# windsurf-dao

这个仓库装着四样东西，都是给「AI 和人一起干活」用的：

1. **AI 协作约定**：根目录的 `CLAUDE.md`，一页纸写清楚 AI 在这个仓库里怎么工作——从 draft PR 开始、正文写清目标与验收、改完跑自检、出问题先回退、全程说人话。新项目从 `templates/` 拷一套就能有同样的约定。
2. **项目模板库**：`templates/` 给新项目做起点——一份公共底座加三份薄层（Node 应用 / Expo 移动端 / 文档知识库），拷进新仓库按说明填空就开工。
3. **一条自检命令**：`node scripts/dao-check.mjs`，检查仓库现在好不好——测试跑不跑得过、技能能不能加载、密钥有没有不小心进 git。退出码 0 就是好，非 0 就是有要修的事。
4. **道德经源文本**：`docs/classics/` 存着《帛书老子》《道德经》《阴符经》的原文，是整套协作哲学的出处，留着零成本。

## 目录导览

| 路径 | 是什么 |
|---|---|
| `CLAUDE.md` | AI 协作约定，一页纸 |
| `templates/` | 新项目起点：`base/` 公共底座 + `node-app/` / `expo-mobile/` / `docs-vault/` 三份薄层。用法：把 `base/` 全部拷进新仓库根目录，再按项目类型拷一份薄层，按文件头部说明填空改名；详细说明见 `templates/README.md` |
| `scripts/dao-check.mjs` | 唯一的自检命令；配套 `scripts/lib/redact.js`（密钥脱敏库）与 `scripts/dao-redact.mjs`（脱敏命令行） |
| `tests/redact.tests.js` | 脱敏能力的回归测试，dao-check 每次都会跑它 |
| `docs/classics/` | 三部经文原文，精神源头 |
| `docs/decisions/` | 历史拍板记录，冻结的档案：想知道「当初为什么这么定」就来这翻 |
| `docs/research/` | 旧体系时期的调研报告存档（规则架构调研等），只读 |
| `docs/global-CLAUDE.md` | 用户级 `~/.claude/CLAUDE.md` 的真相源副本：换机时手动把内容放进 `~/.claude/CLAUDE.md`，git 不带机器配置 |
| `host/skills/grill-me/` | 一个拷问想法的技能：用户想被找茬时用它五步追问 |
| `host/styles/`、`host/themes/`、`host/statusline.js` | Claude Code 的界面定制（提示词样式 / 主题 / 状态栏） |
| `.github/workflows/` | 每个 PR 自动跑一遍 dao-check 扫描 |

## 新机器怎么用

1. `git clone` 拿仓库：约定、模板、经文、自检命令全在里面。装好 Node（20.11+）就能跑自检。
2. 把 `docs/global-CLAUDE.md` 的内容放进 `~/.claude/CLAUDE.md`——它是全局约定的真相源，换机手动放置，git 不带机器配置。
3. 不进 git 的密钥类文件（如有）手动带；pi / Codex 的模型配置照各自官方文档。
4. 完整步骤见 `NEW-MACHINE.md`。
