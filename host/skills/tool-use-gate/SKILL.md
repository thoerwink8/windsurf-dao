---
name: tool-use-gate
description: 工具使用闸——Bash 命令文本上的两条确定性判据（heredoc 吞转义、python 是 stub）。想知道这个闸怎么判、为什么某次 Bash 被注了字、或要改判据时读；日常不用调，它挂在 PreToolUse 上自己会响。
---

# 工具使用闸

**承重的不是这一页字，是 PreToolUse hook。** 这页只在被调用的那一轮进上下文；真正在「正要跑 Bash 的那一刻」起作用的，是 `hooks/tool-use-gate.mjs`。

## 判据

真相源是命令文本本身，不靠意图：

| 命中条件 | 注什么 |
|---|---|
| heredoc（`<<EOF` / `<<'EOF'`）+ 目标是 `.mjs`/`.js`/`.ts` + 命令文本里有反斜杠转义（`\n` `\s` `\d` `\[` 之类） | shell 会吞掉转义，改用 Edit 或写成 raw 文件再 splice |
| 命令词是 `python` / `python.exe`（不是 `py`、不是 `python3`） | 本机 `python` 是 stub，exit 49 静默失败，用 `py` |

判定代码在 `scripts/lib/tool-use-gate.mjs`（纯函数，`tests/tool-use-gate.test.js` 单测）。

## 怎么触发

调 Bash 时自动跑，命中就注入一句。它**不拦**：拦错了会挡住正常工作，而这两条本来就有误报面。与 ask-gate 同口径。

- 命中 ⇒ 注判据，放行。
- 不命中 ⇒ 闭嘴，连空 JSON 都不吐。
- 崩了 ⇒ 也不注入，退回没有本闸时的样子。

## 起因

2026-09-05 一轮对话里，两条已经存在的 memory 被踩三次：`heredoc-eats-backslash-escapes` ×2（其中一次把 3 个真 NUL 写进测试文件）、`python-stub-use-py` ×1（WindowsApps stub，exit 49，命令「成功」一个字没写进去）。根因：memory 每轮只注入索引行，敲下那条命令的那一刻没有任何东西把判据推到眼前。用户经 admit-push 选「做成闸」。

与同日 ask-gate 同型不同事——那边是提问那一刻，这边是 Bash 那一刻。

## 挂在哪：实证结论（沿用 ask-gate，别再走一遍插件那条路）

**挂随仓 `.claude/settings.json` 的 PreToolUse——插件目录那条路不响。** 详见 `host/skills/ask-gate/SKILL.md`「挂在哪」。本 skill 的 `hooks/hooks.json` 是 A 类声明（onboard Junction / CI 建链），承重墙是随仓 settings。`~/.claude/settings.json` 是红线文件，onboard 不能动。
