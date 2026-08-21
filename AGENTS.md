闭环框架：工人读 `host/skills/dispatch/templates/soldier-book.md`，审官读 `host/skills/dispatch/templates/reviewer-book.md`。注入只给一行指针；pi/codex 未测，指针仍是兜底。

## Cursor Cloud specific instructions

这是一个**纯 Node.js 工具仓**：没有 `package.json`、没有 `node_modules`、无第三方依赖（所有 import 都是 `node:` 内置模块）。只要 Node ≥ 20.11（CI 用 22，云 VM 已装 22）即可跑，**无需 `npm install`**——更新脚本因此是空跑。

- **跑「应用」（自检）**：`node scripts/dao-check.mjs`，退出码 0 = 环境健康。它自发现并逐套跑 `tests/*.test.js`，外加脱敏 / skill / git 等关卡。
- **跑测试**：`node --test tests/*.test.js`。**别用 `node --test tests/`**（Node 24 会把 `tests/` 当模块报 MODULE_NOT_FOUND，见 README）。单套复现：`node --test tests/<name>.test.js`。
- **「lint」**：本仓没有传统 linter；等价物是密钥扫描 `node scripts/dao-redact.mjs --scan <路径>`（命中即 exit 1）与上面的 `dao-check.mjs`。

### 云 Linux VM 上「注定红/跳过」的项（非代码回归，别去修）

`dao-check.mjs` 和完整测试套是给**操作者的 Windows 机**（装了 orca CLI、Claude `~/.claude/skills` 软链、`~/.dao` 账本、带 issues 权限的 gh）设计的；CI 也跑在 `windows-latest`。在干净的云 Linux VM（仓库 checkout 在 `/workspace`）上，以下红/跳过是环境差异造成的，**改代码解决不了**：

- `dao.test.js`：`live orca --help 可跑`（缺 `orca` 二进制，ENOENT）、`真实目录+git：pi 假活 → fake-alive`（用 `powershell` 回填文件时间戳，Linux 无 powershell）。
- `ledger.test.js`：`resolveMainWorktreeRoot 认出本仓主树`（断言 checkout 目录名以 `windsurf-dao` 结尾，云上是 `/workspace`）。
- `dao-check.mjs` 另会红「命令库 --help 自检没查成（orca ENOENT）」「态注入 hook 一个装载面都没点到（无 `~/.claude/skills` 软链）」「账本断流（无 `~/.dao` 历史账本）」，并把依赖 `gh issue list` 的项标 SKIP（云上 gh token 无 issues 权限）。

判断真回归：先在**未改动**基线上 `node --test tests/*.test.js`，只有上述 3 条 leaf 红（会连带 2 个父套 + 顶层套共约 6 条）；多出的红才是你引入的。

### 坑

- `scripts/event-write.mjs` 的 `--dir` 是**相对仓库根**解析，不是相对 cwd——相对路径会写进 `/workspace/ledger/` 污染工作树。测试/演示写事件请给**绝对路径**。
- 工人跑 git 前建议 `git config core.editor true` + `git config core.pager cat`（NEW-MACHINE §8b），避免 `git commit`（无 `-m`）/`rebase --continue` 拉起编辑器挂死。
