闭环框架：工人读 `host/skills/dispatch/templates/soldier-book-mirasim.md`，审官读 `host/skills/dispatch/templates/reviewer-book-mirasim.md`。注入只给一行指针。orca 版任务书已退役。

GitHub Issue 写动作只走 `node scripts/issue-gateway.mjs`（#792）。身份由网关固定 `dao-marshal[bot]`，不许裸 `gh issue create|comment|close|edit`，不许自选 token。幂等账与审计落 `~/.dao/issue-gateway`（不进 git）。

Codex / 跨执行体常驻：改动在 git worktree 里做；交卷前跑 `node scripts/dao-check.mjs`；commit 前缀按执行体，取执行档的 agent（`[codex]`/`[cursor]`/`[grok]`/`[devin]`/`[claude]`/`[pi]`…）；出问题先回退。细则：`CLAUDE.md`。提问标推荐位：`host/skills/ask-gate/SKILL.md`。怎么跑测试：`README.md`。

本文件是 Codex 项目指令入口，只放跨执行体必须常驻的规则和指针。体积大的 Cursor Cloud / 云 VM 红项说明已迁出，不要搬回来。
