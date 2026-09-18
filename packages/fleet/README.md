# fleet

持久任务闭环：一个 issue 的一代（`generation`）对应一个 Temporal 工作流 `fusionTaskWorkflow`。工作流内部按 `prepare → lead → execute → verify → review` 循环（审查不过或检查失败就返工），证据齐备后才 `integrate`（合 PR）、按契约可选 `deploy`，最后关单。CLI 只做参数解析与装配，判定在 `src/contract.mjs`，顺序在 `src/runner.mjs`，持久化与恢复在 `src/workflows.mjs`。

工作流 id：`dao/<owner/name 小写>/issue/<N>/g<G>`。

## 起任务

先起 worker（占着队列，否则 `start` 出去的工作流没人跑）：

```bash
cd packages/fleet
node src/cli.mjs worker [--queue dao-fleet]
```

`--queue` 可省略，默认 `DAO_FLEET_QUEUE`，再没有则是 `dao-fleet`。Temporal 地址、命名空间、仓库→本机目录映射**只认环境变量**，没有对应的 CLI 旗标（文件头注释里的 `--address` 实现未消费，不要当可用参数）：

| 变量 | 默认 | 用途 |
| --- | --- | --- |
| `DAO_FLEET_TEMPORAL` | `127.0.0.1:7233` | Temporal 地址 |
| `DAO_FLEET_NAMESPACE` | `default` | 命名空间 |
| `DAO_FLEET_QUEUE` | `dao-fleet` | 任务队列（`worker` / `start` 的 `--queue` 可覆盖） |
| `DAO_FLEET_PROJECTS` | `{}` | JSON：`{"owner/name":"/abs/path"}`。仓库没映射会 `UNSUPPORTED_CAPABILITY` |

再起任务。三个 profile **必填**，id 从仓库根 `docs/execution-profiles.json` 的 `profiles[].id` 取真实值。`normalizeTask` 要求 executor 与 reviewer 的 `modelFamily`（没有则 `provider`）必须不同，同厂会直接拒绝：

```bash
cd packages/fleet
node src/cli.mjs start \
  --repo owner/name \
  --issue N \
  --lead-profile grok-mirasim-native \
  --executor-profile cursor-acp-composer \
  --reviewer-profile codex-relay-gpt-5.6-luna
```

上例三档来自当前清单：`grok-mirasim-native`（`modelFamily=xai`）、`cursor-acp-composer`（`cursor`）、`codex-relay-gpt-5.6-luna`（`openai`）。换档前先对清单，过期 id 会 `unknown execution profile`。

`start` 实现里真实存在的可选参数：

| 参数 | 默认 | 含义 |
| --- | --- | --- |
| `--generation` | `1` | 同一 issue 的第几代 |
| `--wait` | 关（旗标） | 等运行结束；终态 `completed` 退出 0，否则 1 |
| `--checks` | `check` | 契约必查项，逗号分隔、去空、不可重复 |
| `--rounds` | `3` | 审查轮次预算 |
| `--deploy` | 关（旗标） | 合并后还要核部署健康 |
| `--timeout` | `1800` | 单步超时（秒） |
| `--base` | `master` | 目标分支 |
| `--queue` | 同 worker | 工作流任务队列 |

## 查状态 / 发信号

查状态走 query `status`：

```bash
cd packages/fleet
node src/cli.mjs status --repo owner/name --issue N [--generation G]
```

返回 JSON：`taskId`、`state`、`phase`、`round`、`head`、`reason`、`failureClass`。`--generation` 默认 `1`。

发信号：

```bash
cd packages/fleet
node src/cli.mjs signal --repo owner/name --issue N [--generation G] --name resume
node src/cli.mjs signal --repo owner/name --issue N [--generation G] --name cancel
```

`--name` **只能**是 `resume` 或 `cancel`。`resume` 仅当当前 `state === 'blocked'` 时生效（其它态信号会被丢掉）。`cancel` 取消当前 scope，进入收尾。

## 故障与恢复

Activity 自身 `retry.maximumAttempts = 1`，瞬时故障不靠 Temporal activity 重试。工作流看到 `state === 'blocked'` 后按 `failureClass` 决定自己退还是等人：

- `pending`：最多自动退 10 次，每次睡 `60s`。
- `retryable`：最多自动退 5 次，依次睡 `4s / 8s / 16s / 32s / 64s`。
- 预算用尽，或其它 `failureClass`：`condition` 等到 `resume`（成功后再把退避计数清零）。

`failureClass` 从 `runner` / `contract.classifyStepFailure` 来，含义：

| 档 | 典型来源 | 怎么办 |
| --- | --- | --- |
| `retryable` | `RATE_LIMITED` / `TRANSPORT_CLOSED` / `SERVICE_UNAVAILABLE` / `DEADLINE_EXCEEDED`；回环 ws（`MirasimUnavailableError`、`busy`）；ACP 启动超时（`AcpRuntimeError` 且 reason 含 timeout）；背压/窗口（`lease-held`、`channel-full`、`maintenance`、`launch-uncertain`） | 自动退后再试 |
| `pending` | 检查未齐（`checks-running`）、PR 未合（`pr-not-merged`） | 自动等 |
| `unscanned` | 证据未扫清或身份未核（工作区/产物/检查/审查/合并/关单对不上；审查 `identityVerified` 缺、同厂、family 对不上；未知错误码默认也落这里） | **人查清**再 `resume`，不要盲点 |
| `blocked` | `AUTH_REQUIRED` / `PERMISSION_DENIED` / `INVALID_CONTRACT` / `INVALID_MODEL` / `UNSUPPORTED_CAPABILITY` / `WAITING_USER`；以及 `deployment-unhealthy`、`review-budget-exhausted` 等 | **必须人介入**（补权限、改契约、答会话、加审查预算或换代） |

检查结论失败（`checks-failed`）不在这里等人：runner 把它当成返工输入，烧掉一轮审查预算再走 lead/execute，预算用尽才 `review-budget-exhausted`。

`cancel` 之后会最多 5 次、间隔 5s 做 `cleanup`。`verified !== true` 则停在 `state=blocked`、`reason=cancel-cleanup-unconfirmed`（并带 `cancelRequested`），必须人核收尾再决定。

## 已知边界

- **不改 Temporal workflow 文件。** 本包接手只操作 CLI / 信号 / 环境变量，不改 `src/workflows.mjs` 的编排。
- **不自动买资源。** 队列、本机目录、账号池、部署目标都要事先在环境或契约里给好；缺映射就失败，不会去开机器或买额度。
- **会话不碰凭据。** lead / executor / reviewer 会话拿不到 token。git push 用的 `GH_TOKEN` / `GITHUB_TOKEN` 只由系统 `pushEnv`（`resolveToken('worker')`）注入；GitHub 写动作走 `gh-as`，关单走 `issue-gateway.mjs`。
