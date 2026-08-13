# windsurf-dao

这个仓库装着四样东西，都是给「AI 和人一起干活」用的：

1. **AI 协作约定**：根目录的 `CLAUDE.md`，一页纸写清楚 AI 在这个仓库里怎么工作——从 draft PR 开始、正文写清目标与验收、改完跑自检、出问题先回退、全程说人话。新项目从 `templates/` 拷一套就能有同样的约定。
2. **项目模板库**：`templates/` 给新项目做起点——一份公共底座加三份薄层（Node 应用 / Expo 移动端 / 文档知识库），拷进新仓库按说明填空就开工。
3. **一条自检命令**：`node scripts/dao-check.mjs`，检查仓库现在好不好——技能能不能加载、密钥有没有不小心进 git。退出码 0 就是好，非 0 就是有要修的事。
4. **道德经源文本**：`docs/classics/` 存着《帛书老子》《道德经》《阴符经》的原文，是整套协作哲学的出处，留着零成本。

## 目录导览

| 路径 | 是什么 |
|---|---|
| `CLAUDE.md` | AI 协作约定，一页纸 |
| `templates/` | 新项目起点：`base/` 公共底座 + `node-app/` / `expo-mobile/` / `docs-vault/` 三份薄层。用法：把 `base/` 全部拷进新仓库根目录，再按项目类型拷一份薄层，按文件头部说明填空改名；详细说明见 `templates/README.md` |
| `docs/classics/` | 三部经文原文，精神源头 |
| `docs/decisions/` | 历史拍板记录，冻结的档案：想知道「当初为什么这么定」就来这翻 |
| `docs/global-CLAUDE.md` | 用户级 `~/.claude/CLAUDE.md` 的真相源副本，改这里再同步到机器上 |
| `ccswitch/skills/grill-me/` | 一个拷问想法的技能：用户想被找茬时用它五步追问 |
| `scripts/dao-check.mjs` | 唯一的自检命令 |
| `.github/workflows/` | 机器人自动审阅：每个 PR 都会自动跑一遍自检 |

## 新机器怎么用

1. `git clone` 拿仓库，直接就能用：约定、模板、经文、自检命令全在里面，没有额外的安装步骤。
2. 只有不进 git 的密钥类文件要手动带（API key、脱敏前的真实配置等），照 `NEW-MACHINE.md` 里的说明复制。
3. 换机、环境搭建等更多细节都在 `NEW-MACHINE.md`。
