---
name: resume
description: 会话接力：查在途 draft PR、最近拍板记录和 Orca 在途任务，汇报「上次干到哪、等你拍什么、建议下一步」。用户说"接力""我回来了""上次干到哪""resume"时触发。
---

# 会话接力

按顺序查实况（都是只读）：

1. `gh pr list --draft --json number,title,updatedAt` 和 `gh pr list --state open` —— 在途的活。
2. `gh issue list --state open --limit 20` —— 拍板记录、backlog 和规则违例单。
3. `orca orchestration task-list --brief --json` 与 `orca worktree ps`（Orca 不在就跳过）—— 本机在途工人。

然后汇报，每件事三行：干到哪了 / 要你决定什么 / 我推荐哪个。没有等拍板的事就说明当前一切已收尾，列出可选的下一步。
