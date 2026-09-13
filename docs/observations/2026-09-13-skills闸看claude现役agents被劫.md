---
status: new
---

# 机制巡检：㉚ / skills-heal 只看 ~/.claude/skills；现役 grok 发现面 ~/.agents/skills 仍是整目录劫持

## 结论

#1146 要拦的病是「mirasim 把技能发现面整目录劫走」。自愈钟这台机器上已经在跑，dao-check ㉚ 本轮绿：「20 个已接」。它问的是 `~/.claude/skills`。本巡检是 mirasim-server 拉起的 `grok agent`，技能发现面是 `~/.agents/skills` + `~/.grok/skills`。`~/.agents/skills` 从 09-07 起就是指向 `~/.mirasim/skills` 的**整目录链接**——正是 `classifySkillsMount` 会判成 `hijacked` 的那种。`~/.grok/skills` 是真目录，里面 0 个仓内 `host/skills`。skills-heal 每 5 分钟对 `.claude` 说「无事可做」后 exit 0。闸绿的那一层不是现役执行体在用的那一层。

## 证据

本轮 2026-09-13 18:23–18:34 CST，身份 `uid=999(orca)`，未用 sudo。`HEAD=5b1cfa8b`，与 `origin/master` 相同。

### 1. 现役会话不读 ~/.claude/skills

```
$ pstree -asp $$
systemd,1
  `-MainThread,2693348 /home/orca/mirasim-server/0.0.310/server.cjs --port 4316 ...
      `-grok,1127563 agent --no-leader stdio
```

`/proc/1127563/environ` 有 `GH_CONFIG_DIR=/var/empty`（已报，不另报）。本会话系统提示里的 skill 路径是 `/home/orca/.agents/skills/*`、`/home/orca/.grok/skills/*`、`/home/orca/.grok/bundled/skills/*`，没有 `~/.claude/skills`。

### 2. .agents 整目录被劫；.claude 已是真目录；.grok 没有仓内 skill

```
$ ls -ld /home/orca/.claude/skills /home/orca/.agents/skills /home/orca/.mirasim/skills /home/orca/.grok/skills
drwxr-xr-x  2 orca orca 4096 Sep 13 04:16 /home/orca/.claude/skills
lrwxrwxrwx  1 orca orca   18 Sep  7 01:59 /home/orca/.agents/skills -> ../.mirasim/skills
drwxr-xr-x 32 orca orca 4096 Sep  9 23:59 /home/orca/.mirasim/skills
drwxrwxr-x  2 orca orca 4096 Sep  3 02:02 /home/orca/.grok/skills
```

本轮直接调 `classifySkillsMount`：

```
claude {"kind":"directory","face":"/home/orca/.claude/skills",...}
agents {"kind":"hijacked","face":"/home/orca/.agents/skills","target":"/home/orca/.mirasim/skills"}
grok   {"kind":"directory","face":"/home/orca/.grok/skills",...}
```

`checkSkillLinks({ root, home: $HOME, isCi: false })`：

```
{"green":"skill 发现面符号链接 20 个已接（~/.claude/skills/<名> → host/skills/<名>）"}
```

`host/skills` 20 个名字在 `~/.grok/skills` 里全是 MISSING。仓内 skill 能进本会话，只是因为 grok 另外读了被劫的 `~/.agents/skills`（落到 `~/.mirasim/skills/<名>` 的逐个链接）。`~/.mirasim/skills` 里此刻碰巧还有指向仓内的链——没验证 mirasim 下次启动会不会改那一目录。

`scripts/lib/skill-link-check.mjs:142`：`const face = join(home, '.claude', 'skills');`。全文 0 处 `.agents`、0 处 `.grok`。`scripts/lib/skills-mount.mjs:9-10,42,127`：`dir = '.claude'`，「本文件只动 ~/.claude/skills 这一层」。`scripts/onboard.mjs:45` 同样只接回 `~/.claude/skills`。`scripts/dao-check.mjs:80-83,977-979` 把 ㉚ 写成「扫 ~/.claude/skills」。

### 3. 自愈钟在跑，修的是闸在看的那一层

```
$ systemctl list-timers --no-legend --no-pager | grep skills-heal
Sun 2026-09-13 18:28:00 CST  ... dao-skills-heal.timer  dao-skills-heal.service
```

上一响 18:23:39，`Result=success` `ExecMainStatus=0`，起止同一秒。本轮 `node scripts/skills-heal.mjs --dry-run` 原文：`[skills-heal] 装载面已是逐个链接，无事可做`。`~/.claude/skills` 每个仓内 skill 的链接 mtime 是 `2026-09-13 04:16:01`（钟装上之后重建过）；`~/.agents/skills` 整目录链接 mtime 仍是 `2026-09-07 01:59`。

### 4. 不是已报过的那几条

| 已有观察 | 管的是 | 本条不是 |
|---|---|---|
| `2026-09-12-skills-heal自愈钟没装.md` | 当时 timer 没装，㉚ 只问 claude 链接所以仍绿 | 钟已经装上、在跑、对 .claude 说无事可做；本条是**现役发现面不在它扫的那条路上** |
| `2026-09-05-mirasim巡检模型与身份.md`（处置：#944） | 巡检用哪个模型 | 对象是技能装载路径，不是模型名 |
| `2026-09-09-收件箱挪到dao-check没人跑.md`（处置：#1170/#1171） | 收件箱载体 | 正文提过工人 skill 来自 `~/.agents/skills`，没有把 ㉚ 扫错面立成一条 |

## 建议的最小改造

删掉「技能发现面 = `~/.claude/skills`」这一层假设。㉚ 和 skills-heal 问的应是**现役执行体实际加载的目录**（这台机器上至少包括 `~/.agents/skills`；整目录链接按现在的 `hijacked` 判红）。只把 Claude Code 的发现面修好，不能证明 grok / mirasim 工人看得到仓内 skill。
