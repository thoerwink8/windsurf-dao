---
status: new
---

# 机制巡检：现役 grok 把 Claude 钩子扫描关掉了；问人闸 / 工具闸 / 派工闸 / 今天的动作写口都挂在那一层，⑬ 仍绿

## 结论

这台机器上指挥官、巡检、工人现役执行体是 mirasim 拉起的 `grok agent`。`~/.grok/config.toml` 从 08-23 起就是 `[compat.claude] hooks = false`——Grok 文档写明这会停掉对 `.claude/settings.json` 的钩子扫描。随仓 `.claude/settings.json` 上挂着派工闸、问人闸、工具使用闸，今天 04:24 又在同一条 PreToolUse 上加了 `action-writers-hook`（#897）。dao-check ⑬ 只验 Claude 面 + Cursor 面配置文件在、脚本在、喂夹具能拦，本轮绿。Grok 自己的挂载面 `~/.grok/hooks/` 和仓内 `.grok/hooks/` 都不存在。闸看的那一层是 Claude Code 的 PreToolUse，跑的那一层把那一层关了。

## 证据

本轮 2026-09-14 06:23–06:35 CST，身份 `uid=999(orca)`，未用 sudo。`HEAD=18a90d59`。本进程：`grok,3788140 agent --no-leader stdio`，父进程 `mirasim-server/0.0.310/server.cjs --port 4316`。`GROK_AGENT=1`。`CLAUDE_PROJECT_DIR` 未设。

### 1. 现役 grok 明确不扫 Claude 钩子，自己的钩子目录也没有

`~/.grok/config.toml` 全文（mtime `2026-08-23 00:32`）含：

```
[compat.claude]
hooks = false
```

Grok 用户手册 `~/.grok/docs/user-guide/10-hooks.md:67,77`：`.claude/settings.json` 是 Claude 兼容源，「要关掉某个厂商的扫描，在 `~/.grok/config.toml` 写 `[compat.<vendor>] hooks = false`」。同手册 `26-config-reference.md:120`：`compat.claude.hooks` 默认 `yes`，本机改成了 `false`。

Grok 自己的发现面（同页 62–69 行）：

```
$ ls -ld /home/orca/.grok/hooks /srv/projects/windsurf-dao/.grok /srv/projects/windsurf-dao/.grok/hooks
ls: cannot access '/home/orca/.grok/hooks': No such file or directory
ls: cannot access '/srv/projects/windsurf-dao/.grok': No such file or directory
ls: cannot access '/srv/projects/windsurf-dao/.grok/hooks': No such file or directory
```

仓内 `grep` `compat.claude` / `hooks = false` / `.grok/hooks` 于 `scripts/` `tests/` `docs/` `host/`：0 行。本轮 `ps -ef | grep -E 'ask-gate|tool-use-gate|dispatch-gate-hook|action-writers-hook'`：0 个钩子进程。

### 2. 闸和今天的写口都挂在被关掉的那一层；⑬ 绿

随仓 `.claude/settings.json` 本轮原文：PreToolUse 挂 `dispatch-gate-hook.mjs`、`ask-gate.mjs`、`action-writers-hook.mjs`、`tool-use-gate.mjs`；PostToolUse 再挂一次 `action-writers-hook.mjs`。`action-writers-hook` 是 `1007a314`（今天 04:24，#897）加进去的。matcher 是 `AskUserQuestion|mcp__mirasim__im_ask_user` 和 `^Bash$`——Grok 本会话的工具名是 `ask_user_question` / `run_terminal_command`，就算扫了 Claude 文件，matcher 也对不上。

`scripts/lib/dispatch-gate-check.mjs:3-5`：

```
// 闸门有两个挂载面，缺一即红：
//   A. 随仓 `.claude/settings.json` 的 PreToolUse
//   B. 随仓 `.cursor/hooks.json` 的 beforeShellExecution
```

全文 0 处 `.grok`、0 处 `compat.claude`。本轮直接调 `checkDispatchGate({ root })`：

```
{"green":"Claude 面派工闸 1 个已挂载且真拦得住（旁路 exit 2 / 逃生口放行 / 崩了 exit 2）；Cursor 面派工闸 1 个已挂载且真拦得住（deny JSON / allow JSON / 崩了 deny + failClosed:true）"}
```

⑬ 喂的是配置文件 + 自己 spawn 夹具，不问现役进程读不读这份文件。`.cursor/hooks.json` 的 `beforeShellExecution` 是 Cursor 协议；Grok 文档里 Cursor 兼容要另开 `[compat.cursor]`，本机 `config.toml` 没有这一节。没验证：Grok 默认是否仍扫 `.cursor/hooks.json`——就算扫，stdin 协议也不是 Cursor 那份。

`tests/ask-gate.test.js:540-548` 今天刚把「这一格 hooks.length === 1」改成「问人闸还在这一格」：因为 #897 在同一格加了邻居。测的仍是 `.claude/settings.json` 文本在，不是 grok 会不会跑它。

### 3. 不是已报过的那几条

| 已有观察 | 管的是 | 本条不是 |
|---|---|---|
| `2026-09-13-skills闸看claude现役agents被劫.md`（处置：#1226 部分） | ㉚ 看 `~/.claude/skills`，现役发现面是 `~/.agents/skills` | 对象是 skill 文件交付；本条是 **PreToolUse 钩子扫描被关掉**。skill 能进会话，钩子不会因此自己响 |
| `2026-09-07-mirasim劫走claude装载面.md` | mirasim 把技能目录整目录劫走 | 对象是技能装载；本条是 grok 配置把 Claude 钩子源关了 |
| `2026-09-06-cacheRead-injection-surface.md`（处置：#981） | 帅位 cacheRead 构成 | 查过 `settings.json` 体积；没立「grok 不跑这些 hook」 |
| `2026-09-05-mirasim巡检模型与身份.md`（处置：#944） | 巡检用哪个模型 | 对象是模型名，不是钩子挂载面 |

## 建议的最小改造

删掉「闸活着 = `.claude/settings.json` + `.cursor/hooks.json` 文本过夹具」这一层假设。⑬（以及问人闸 / 工具闸 / 动作写口的挂载检查）问的应是**现役执行体实际会跑的钩子目录**。这台机器上那是 `~/.grok/hooks/` 和仓内 `.grok/hooks/`（Grok 手册自己的发现面）。Claude 兼容源已经关掉，就不要再拿它当绿。不要再往 `.claude/settings.json` 加新 PreToolUse 当「现役执行体会响」——#897 今天刚加过一次，本会话 0 个钩子进程。
