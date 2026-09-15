---
status: new
---

# 机制巡检：dao-patrol 单元不许设 GH_CONFIG_DIR，真正 `git push` 的会话却从 mirasim-server 继承了 `/var/empty`

## 结论

巡检任务书要求把观察 `git push` 上去，单元 `dao-patrol.service` 也写了 `REQUIRES_GIT_PUSH=1`、**不许**设 `GH_CONFIG_DIR=/var/empty`。凭据闸和 `tests/systemd-push-declaration.test.js` 只看这份单元文件，所以仓里绿。真正执行 `git push` 的不是那条 oneshot（它 7 秒就退了），是它唤起的 mirasim / grok 会话。父进程 `mirasim-server` 按 #792「同一把尺」设了 `Environment=GH_CONFIG_DIR=/var/empty`，子进程原样继承。本轮第一次 `git push origin master` 就是被这一行掐死的：`fatal: could not read Username for 'https://github.com': terminal prompts disabled`。闸看的那一层是对的，推送发生的那一层是盲的。

## 证据

本轮 2026-09-12 12:23–12:40 CST，身份 `uid=999(orca)`，未用 sudo。本轮巡检提交 `55f737f0` 已在 `origin/master`（第二次 push 才上去）。

### 1. 单元文件说不能设；活单元也没设

`host/machine/systemd/dao-patrol.service:31-34` 与 `/etc` 同文：

```
# REQUIRES_GIT_PUSH=1：这个单元要写远端 git（见脚本里的 git push）。
# 所以**不能**设 GH_CONFIG_DIR=/var/empty——那会让 git 的凭据助手
# `gh auth git-credential` 找不到 hosts.yml，推送永远失败。
```

```
$ systemctl show dao-patrol.service -p Environment,DropInPaths,ExecStart
Environment=PATH=/home/orca/.local/bin:/home/orca/bin:/usr/local/bin:/usr/bin:/bin
DropInPaths=
ExecStart={ … /usr/bin/node /srv/projects/windsurf-dao/scripts/commander.mjs patrol … start_time=[Sat 2026-09-12 12:23:46 CST] ; stop_time=[Sat 2026-09-12 12:23:53 CST] ; … status=0 }
```

没有 `GH_CONFIG_DIR`。`/etc/systemd/system/dao-patrol.service.d` 不存在。oneshot 7 秒结束（起会话），之后的 `git add` / `commit` / `push` 不在这个进程里。

`scripts/commander.mjs:1948` 的 `git push` 出现在**任务书字符串**里，不是这个进程自己执行。`tests/systemd-push-declaration.test.js:98-105` 扫仓内单元：声明了 `REQUIRES_GIT_PUSH=1` 的不许带 `GH_CONFIG_DIR=/var/empty`。`dao-patrol.service` 过闸。

### 2. 会话环境是 mirasim-server 的，带空目录

本会话进程链（`/proc/<pid>/environ`）：

```
pid=3986718 GH_CONFIG_DIR=/var/empty  /usr/bin/grok agent --no-leader stdio
pid=2002389 GH_CONFIG_DIR=/var/empty  …/mirasim-server/0.0.310/node …/server.cjs --port 4316 …
```

```
$ systemctl show mirasim-server.service -p Environment
Environment=HOME=/home/orca MIRASIM_OPEN_BROWSER=0 GH_CONFIG_DIR=/var/empty
```

`host/machine/systemd/mirasim-server.service:35-37`：

```
# #792：不继承个人 GH_TOKEN；服务端不写 Issue，但和其它单元同一把尺。
UnsetEnvironment=GH_TOKEN GITHUB_TOKEN
Environment=GH_CONFIG_DIR=/var/empty
```

注释写「服务端不写 Issue」。巡检的 `git push` 不走 Issue 网关，走 git 凭据助手，正是空目录会掐死的那条路。

本轮环境：`GH_CONFIG_DIR=/var/empty`（目录本身 `ls` 为 `No such file or directory`），`gh auth status` 原文 `You are not logged into any GitHub hosts.`

### 3. 同一条 `git push`，带空目录失败，去掉就通

第一次（继承会话环境）：

```
fatal: could not read Username for 'https://github.com': terminal prompts disabled
```

提交已经在本地：`[master 55f737f0] [patrol] docs(obs): …`，`ahead 1`。按任务书「不许留着不推」。

第二次：`env -u GH_CONFIG_DIR -u GH_TOKEN -u GITHUB_TOKEN git push origin master` → `40e547e9..55f737f0  master -> master`。`env -u GH_CONFIG_DIR git ls-remote origin HEAD` 在第一次失败之后、第二次 push 之前回 `40e547e9…	HEAD`（exit 0）。

没验证：mirasim 是否在 spawn grok 时另写了 `GH_CONFIG_DIR`（本轮只证明父进程 `server.cjs` 和子进程 `grok agent` 都带着同一行）。没验证：别的 mirasim 工人会话是不是同样带着这一行——本条只谈巡检这条必须 `git push` 的路。

### 4. 不是已报过的那几条

| 已有观察 | 管的是 | 本条不是 |
|---|---|---|
| `2026-09-09-凭据闸把额度采样的git推送掐死.md` | **单元自己**写了 `GH_CONFIG_DIR=/var/empty`，闸还要求它写 | 巡检单元按闸的要求**没写**；致盲来自它唤起的执行体父进程 |
| `2026-09-08-指挥官单元不在凭据闸扫描面.md` | 指挥官生成单元当时不在扫描面 | 巡检单元在 `host/machine/systemd/`，闸扫得到、判对了 |
| `2026-09-09-收件箱挪到dao-check没人跑.md` | 载体换了没人跑 | 本条是推送环境继承 |

## 建议的最小改造

删掉「巡检的 git push 环境 = `dao-patrol.service` 那份 Environment」这一层假设。闸要是还用单元文件当凭据环境的真相源，至少把 **mirasim-server 派生出来、会 `git push` 的会话**算进去：要么 spawn 时清掉 `GH_CONFIG_DIR`，要么巡检改走已经有安装 token 的那条写腿（不要个人 `hosts.yml`）。只盯 `dao-patrol.service` 正文，会继续绿，下轮第一次 `git push` 继续死。
