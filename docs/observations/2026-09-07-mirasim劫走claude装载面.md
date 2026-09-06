---
date: 2026-09-07
status: new
from: 服务器帅位（cc，值守）
---

# mirasim 把 `~/.claude/skills` 换成了自己的目录——dao 全家从 orca 的装载面上消失了 2.5 小时

## 结论

2026-09-07 **01:59**，orca 的 `~/.claude/skills` 从真目录变成了符号链接：

```
lrwxrwxrwx 1 orca orca 18 Sep  7 01:59 /home/orca/.claude/skills -> ../.mirasim/skills
```

`~/.mirasim/skills` 里只有 30 个 lark/mirasim 系 skill（`lark-*`、`mirasim-guide`、`eval`），**仓内 20 个 dao skill 一个都不在**。也就是说自 01:59 起：

- `dao-mode`（每轮态注入的 UserPromptSubmit hook）
- `ask-gate`（问人闸的 PreToolUse hook）
- `tool-use-gate`（Bash 判据的 PreToolUse hook）
- `dispatch` / `worker-brief` / `dao-commit` / `dao-inbox` …

对**所有以 orca 身份跑的工人与审官会话**全部失效。派工链上的会话都是 orca 起的。

同一时刻 `~/.claude/backups/.claude.json.backup.1788717549733` 也被写出，`~/.mirasim/` 下 `agenda` / `mcp` / `search` 同批更新——是 mirasim 自己在启动/升级时做的接线，不是人手改的。

## 检查器抓到了，但报告写错了原因

`dao-check` 第 ㉚ 项当场报红两条：

```
X  ~/.claude/skills 不是目录
X  态注入 hook 没被任何装载面点到 1 个
```

**判据是对的，红也是真的。** 但 PR #1057 与 #1096 两轮审查记录都把它写成「本机缺装载面的环境差异，不算本 PR 回归」——把一次真实的机制失效读成了噪音。这正是本仓反复禁止的那一形：把「真红」降格成「环境问题」，和把「没查成」当成「查过没事」是同一个错。

`scripts/lib/skill-link-check.mjs:145` 用 `lstatSync` 判，所以符号链接形态直接算「不是目录」——判据严格，这次严格是对的。

## 已做的止血（帅位值守自拍，2026-09-07 04:22）

两层，都不删任何东西：

1. 把仓内 20 个 dao skill 逐个链进 `/home/orca/.mirasim/skills/`（mirasim 原有条目一个没动）。**这层是兜底**：就算 mirasim 下次启动再劫一次 `~/.claude/skills`，dao skills 也还在它指向的目录里。
2. 把 `~/.claude/skills` 恢复成真目录，里面 50 个逐个链——20 个 → 仓内 `host/skills/`，30 个 → `~/.mirasim/skills/`。两边都在，形态回到 NEW-MACHINE §11。

修完 `dao-check` 该项转绿，且第 ⑧ 项实跑四形可辨。

回退命令（如判定该让位给 mirasim）：

```
rm -rf /home/orca/.claude/skills && ln -s ../.mirasim/skills /home/orca/.claude/skills
```

## 没解决的（等拍板）

**这次是我手工重链的，没有任何东西阻止 mirasim 下次启动再劫一次。** `scripts/onboard.mjs` 把这一形归类为 `skills-elsewhere` 并明确「只报不修 —— 手动重链」，也就是说仓里早就知道这一形存在、且刻意不自动修（大概是怕删掉 mirasim 需要的链接）。

要问的是：

1. `~/.claude/skills` 的 owner 到底是谁？现在是**两个系统都认为是自己的**，谁后启动谁赢。
2. 如果结论是「归本仓」，那 `onboard.mjs` 的 `skills-elsewhere` 是不是该从「只报不修」升级成「合并式修复」（保留对方条目、补回自己的）——就是我这次手工做的事。
3. 如果结论是「让给 mirasim」，那 dao skills 应当由谁装进 `~/.mirasim/skills`，以及 `dao-check` ㉚ 的判据要跟着改。

**这一形会再犯**（mirasim 每次启动/升级都可能重做接线），所以按 `CLAUDE.md`「出错后的制度化」，它需要一道会报警的闸，不是一次手工修复。现在这道闸其实已经有了——`dao-check` ㉚ 抓到了——真正缺的是**没人把它的红当真**。

## 落点

- `/home/orca/.claude/skills`（本机接线，不在 git 里）
- `scripts/onboard.mjs` 的 `fixSkills()` 与 `skills-elsewhere` 分类
- `scripts/lib/skill-link-check.mjs:145`
- 判例 memory：`evolution-live-settings-volatile`、`codex-claude-shared-skills`
