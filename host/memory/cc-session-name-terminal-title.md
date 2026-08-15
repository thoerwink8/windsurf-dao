---
name: cc-session-name-terminal-title
description: Claude Code 用 --name / /rename 设会话名并进终端标题；外部 orca rename 会被 CC 的 OSC 序列盖掉，AI 可给自己终端 send /rename 且不打断会话
metadata: 
  node_type: memory
  type: reference
  originSessionId: d702bd60-19b9-4036-9ffc-973a75a4c0c8
  modified: 2026-08-15T15:55:27.680Z
---

Claude Code 内置会话显示名，会进终端标题：

```
-n, --name <name>   Set a display name for this session
                    (shown in the prompt box, /resume picker, and terminal title)
```

2026-08-15 三条实测（Windows / Orca 终端）：

| 方式 | 结果 |
|---|---|
| 启动 `reclaude --model X --name "帅·测试｜#505"` | 标题 = `✳ 帅·测试｜#505` ✅ |
| 会话中 `/rename 帅·测试｜#505 #501` | 标题即时更新 ✅ |
| AI 用 `orca terminal send --text "/rename ..." --enter` 发给**自己的终端** | 标题更新 ✅ **且当前会话未被打断** |

**关键反例**：`orca terminal rename`（从外部改）对跑着 CC 的终端**无效**——返回 `ok:true` 但标题不变，因为 CC 持续用 OSC 转义序列写标题、立刻盖回去。当天另一位主帅据此判定「终端标题写不了、方案证伪、停手」，把一条可行的路永久判死；实测区分「改不上」与「改上了又被盖掉」后才找到正解。

**How to apply:** 要让 CC 会话的终端标题显示自定义内容，用 CC 自己的机制（`--name` 启动 / `/rename` 运行时），不要用宿主的 rename。AI 需要自维护标题时，`orca terminal send` 发 `/rename` 给自己的终端是安全的。标题前缀的 `✳`/`◐` 是 CC 的状态图标，会随工作状态变，名字部分保留。另有 `CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1` 与 `terminalTitle` settings 键可关闭自动标题（本机未设、未验）。相关：[[report-requires-fresh-state]]（现象为真、归因为假；本例差点让成立的需求被标为不可能）。
