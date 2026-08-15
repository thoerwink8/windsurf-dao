---
name: ralph-loop-disabled
description: "ralph-loop 插件的 Stop hook 曾卡死会话,已在全局 settings.json 禁用"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 32703690-6fc3-4203-bcfd-bf3ae9510198
---

Claude Code 官方 marketplace(`officialMarketplaceAutoInstalled: true`)默认启用 `ralph-loop` 插件,它注册一个无 matcher 的 Stop hook:每个会话结束都空跑一次;一旦项目下存在 `.claude/ralph-loop.local.md` 状态文件,就进入 `"decision":"block"` 硬循环,把同一句 prompt 无限塞回——这正是 2026-05-31 卡死 `f397c08e` 会话(目标=迁移 windsurf-dao 到 Claude Code)的元凶。Windows 上 jq 输出带 CRLF 还会间歇触发 `JSON validation failed`,让续力信号失效,会话陷入"结束不了又推不动"死锁。

**Why:** 自动续力硬循环是 Windsurf(不主动续就停)环境的神器,但 Claude Code CLI 本身回合制,这个硬循环只会添乱、卡死。

**How to apply:** 已在 `~/.claude/settings.json` 加 `"enabledPlugins": {"ralph-loop@claude-plugins-official": false}` 禁用(可逆、更新无虞、保留文件)。注意 hooks/插件状态**仅会话启动时加载**,改完必须**重启 claude** 才生效。禁用单插件的正确机制:用户级 settings.json 的 `enabledPlugins` 对象,key 用全限定名 `<plugin>@<marketplace>`,值 `false`;不要删 marketplace 目录(git 会重装并报警告)。dao 自己的"持续推进/delegated-continuous"不是循环,与此无关,勿误删。
