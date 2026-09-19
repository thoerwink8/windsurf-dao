---
name: reclaude-wins-over-mirasim-env
description: 2026-09-19 实测补完——reclaude 在 mirasim 已注入 env 的子进程里会把 ANTHROPIC_BASE_URL 清空，所以叠上去不会静默退回 mirasim 中继；agentLaunch 是热加载的，改完不用重启
status: done
---

# 那一格补完了：reclaude 盖得过 mirasim 注入的 env

2026-09-19。用户要求「装 reclaude + mirasim 本机要能启动」，顺带把
`2026-09-05-mirasim与reclaude结构互斥.md` §四留的空格填上。

## 一、结论（两条，都是实测）

**① reclaude 会把 mirasim 注入的 `ANTHROPIC_BASE_URL` 清空。**

判法：用本会话（`CLAUDE_CODE_ENTRYPOINT=mirasim`，上游 `http://127.0.0.1:43871/…`）
的那组 env 去起 reclaude，让子进程自己 `printenv ANTHROPIC_BASE_URL`：

```
`ANTHROPIC_BASE_URL` 未设置（`printenv` 无输出，退出码 1）
```

reclaude 靠 CA 拦截 + 自己的 daemon 走上游，不靠 BASE_URL，所以它不是「也设一个」
而是**把这个变量删掉**。⟹ 叠上去之后请求确实从 reclaude 出去，不会出现
「以为吃 reclaude 额度、其实还在吃 mirasim 中继」的静默退回。

这条只订正 §四那一格，**不动 §二/§三的结论**：mirasim 仍然没有 `reclaude` 这个
agent 类型，`claudeBin` 仍然只是收 OAuth token 的钩子。「让 mirasim 起 reclaude」
依旧没有入口；能用的是反过来——`agentLaunch` 把 claude 的启动程序换成 reclaude。

**② `agentLaunch` 是热加载的，改完 setting.json 不用重启。**

server.cjs 里读键的是 `lVt(agentId) → rs().agentLaunch?.[agentId]`，外面套着一个
settings 变更监听（`JAe((_,keys)=>{ keys.includes('agentLaunch') && …})`）。
0.0.310（orca）与 0.0.336（root）两个版本都有。

这条有实际用处：**root 那台的 mirasim-remote 宿着帅位会话本身，重启就是自杀**
（判例 `cleanup-cuts-the-floor-under-coordinator`）。热加载意味着不必付这个代价。

## 二、本机接线现状（2026-09-19）

| | root | orca |
|---|---|---|
| reclaude | v1.4.0，已登录 | v1.4.0（从 v1.3.0 升），已登录 |
| daemon | 起过，`gateway_healthy` 抖 | 起过，healthy |
| `-p` 实跑 | `RECLAUDE_OK` | `RECLAUDE_OK` |
| `agentLaunch.claude.command` | `reclaude` | `reclaude` |

setting.json 都留了 `.bak-20260919-reclaude` 备份。

## 三、还没实测的一格（别当已验收）

**没有起过一个真的 mirasim 会话去看它 exec 的是不是 reclaude。**
已验的是：键被 server.cjs 读、热加载监听在、reclaude 单跑能出活、reclaude 盖得过
mirasim 的 env。这四条连起来推得出结论，但那最后一跳是**推的不是看的**。

要看，最省的判法：在 mirasim 里开一个 Claude 会话，然后
`tail ~/.reclaude/logs/daemon.log` —— 走了 reclaude 会有 cc-client 的流量记录；
`reclaude event: non-cc-client` 那种是别的东西在撞 daemon 口，不算。

## 四、代价（官方写明的，不是 bug）

这些会话在 mirasim 的**用量统计里显示「未知」**——reclaude 自行改写模型地址，
绕过 mirasim 的路由与计数。会话追踪、互联、录制都还在。

## 五、网络面的一个观察

reclaude 的 gateway 自动选到 `https://la.route.reclaude.ai`（RTT 300–650ms，探了
5 个候选）。起 daemon 后头两分钟 `account sync` / `intercept sync` 连续
context deadline exceeded 与 500 `gateway_unavailable`，之后自己 recovered。
第一次 `reclaude -p` 卡在 `Syncing config…` 180 秒超时，daemon 先起好再跑就通了。
⟹ **第一次跑给够时间，别把「同步期慢」判成「装坏了」**（同形状判例：
`docs/cli-notes/claude.md` 的「启动有一段配置同步期，抢跑注入必被吞」）。
