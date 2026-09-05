---
name: resume
description: 会话接力：查在途 draft PR、最近开放 issue 和 Orca 在途任务，汇报「上次干到哪、等你拍什么、建议下一步」。用户说"接力""我回来了""上次干到哪""继续上次""接着干""resume"时触发。
---

# 会话接力

按顺序查实况（都是只读）：

1. `node scripts/dao.mjs now` —— 现状盘面三段（已落地 / 在途 / 待你拍）。在途 PR 的判定状态、
   过期票、审官是谁、审官会话在不在、审官树 head 对不对得上、open issue 的消歧态都在这一条里，
   本页不再自己拼 gh 查询（判据只留一处，见 `scripts/lib/now-board.mjs`）。要全量细节加 `--json`。
2. `orca worktree ps --json` —— 本机在途工人的 agent 态（working/waiting；跨 worktree 汇总，
   不依赖当前终端绑定 Run；Orca 未装就跳过）。`dao now` 只看 git 树与分支，不看 agent 态，这一步不重复。

任何来源查询失败（命令报错、Orca 未装等），汇报时必须写「未查到」，不许推断成「已收尾」或「一切正常」。
`dao now` 每段末尾会列出哪些源没查成——原样带进汇报，别把它折算成「没有」。

然后汇报，每件事三行：干到哪了 / 要你决定什么 / 我推荐哪个。本次查询未发现待拍板事项时，如实说明，并列出可选的下一步。
