---
name: resume
description: 会话接力：查在途 draft PR、最近开放 issue 和 Orca 在途任务，汇报「上次干到哪、等你拍什么、建议下一步」。用户说"接力""我回来了""上次干到哪""继续上次""接着干""resume"时触发。
---

# 会话接力

按顺序查实况（都是只读）：

1. `gh pr list --draft --json number,title,updatedAt` 和 `gh pr list --state open` —— 在途的活。
2. `gh issue list --state open --limit 20 --json number,title,updatedAt,labels` —— 最近开放 issue。
3. `orca worktree ps --json` —— 本机在途工人（跨 worktree 汇总，不依赖当前终端绑定 Run；Orca 未装就跳过）。

任何来源查询失败（命令报错、Orca 未装等），汇报时必须写「未查到」，不许推断成「已收尾」或「一切正常」。

然后汇报，每件事三行：干到哪了 / 要你决定什么 / 我推荐哪个。本次查询未发现待拍板事项时，如实说明，并列出可选的下一步。
