# fleet

一个 GitHub issue 对应一条 Temporal 工作流（`fusionTaskWorkflow`）。工作流内部按序跑 lead 计划、executor 实现、异厂 review；系统自己取检查证据、推分支、开/合并 PR、关单。证据齐备才进入下一态，缺证据或同厂自审一律不放行。

命令入口是本目录下的 `src/cli.mjs`。先起 worker，再 `start` / `status` / `signal`。Temporal 地址、队列、命名空间、本地仓映射走环境变量，不要照抄文件头里的 `--address`——那个旗标没有接到 `main()`。

| 变量 | 默认 | 用途 |
|---|---|---|
| `DAO_FLEET_TEMPORAL` | `127.0.0.1:7233` | Temporal 地址 |
| `DAO_FLEET_QUEUE` | `dao-fleet` | 任务队列 |
| `DAO_FLEET_NAMESPACE` | `default` | Temporal namespace |
| `DAO_FLEET_PROJECTS` | `{}` | JSON：`{"owner/name":"/abs/path"}`，活动用它找本地检出 |

```bash
# 在 packages/fleet 下
node src/cli.mjs worker --queue dao-fleet
```

`--queue` 可省略，缺省即 `DAO_FLEET_QUEUE`。地址只认 `DAO_FLEET_TEMPORAL`。

## 起一个任务

profile 必须是仓根 `docs/execution-profiles.json` 里已有的 `id`。CLI 用该条目的 `modelFamily`（没有就退回 `provider`）填角色 family；`normalizeTask` 要求 **executor 与 reviewer 的 family 不同**，同厂会当场拒。

下面三个 id 是文档写成时目录里的真条目：`grok-mirasim-native`（xai）、`cursor-acp-composer`（cursor）、`codex-relay-gpt-5.6-luna`（openai）。换仓或换代时自己再对一次目录。

```bash
cd packages/fleet

node src/cli.mjs start \
  --repo thoerwink8/windsurf-dao \
  --issue 1454 \
  --lead-profile grok-mirasim-native \
  --executor-profile cursor-acp-composer \
  --reviewer-profile codex-relay-gpt-5.6-luna
```

可加的旗标（名字与 `specFromArgs` / `main` 一致；括号里是缺省）：

| 旗标 | 缺省 | 含义 |
|---|---|---|
| `--generation` | `1` | 同一 issue 的代次；工作流 id 为 `dao/<仓小写>/issue/<号>/g<代>` |
| `--wait` | 关（须写成裸旗标） | 阻塞到工作流结束；终态不是 `completed` 则进程退出 1 |
| `--checks` | `check` | 契约必查项，逗号分隔、去空、须互不重复 |
| `--rounds` | `3` | 审查轮次上限（`limits.reviewRounds`） |
| `--deploy` | 关（裸旗标） | 合并后还要部署健康证据 |
| `--base` | `master` | 目标枝（`contract.targetBranch`） |
| `--timeout` | `1800` | 单步秒数（`limits.stepTimeoutSeconds`） |
| `--queue` | `DAO_FLEET_QUEUE` 或 `dao-fleet` | 工作流任务队列 |

`--repo owner/name` 与 `--issue N`（正整数）以及三个 `--*-profile` 都是必填。`--wait` / `--deploy` 只有写成独立旗标才为真（后跟另一个 `--…` 或到参数末尾）。

成功时 stdout 一行 JSON：`{"started":true,"workflowId":"…","runId":"…"}`。带 `--wait` 时再打印终态对象。

## 查状态

```bash
node src/cli.mjs status \
  --repo thoerwink8/windsurf-dao \
  --issue 1454
```

可加 `--generation`（缺省 `1`）。实现是 `handle.query('status')`，打印：

`taskId`、`state`、`phase`、`round`、`head`、`reason`、`failureClass`。

`state` 常见值：`running` / `blocked` / `completed` / `cancelled`。`phase` 来自 runner：`queued`、`preparing`、`planning`、`executing`、`verifying`、`reviewing`、`integrating`、`deploying`、`closing`。

## 发信号

```bash
node src/cli.mjs signal \
  --repo thoerwink8/windsurf-dao \
  --issue 1454 \
  --name resume

node src/cli.mjs signal \
  --repo thoerwink8/windsurf-dao \
  --issue 1454 \
  --name cancel
```

`--name` 只能是 `resume` 或 `cancel`。`--generation` 同样缺省 `1`。

- `resume`：仅当当前 `state === 'blocked'` 时生效，工作流从 checkpoint 再跑一轮。
- `cancel`：取消当前轮；收尾会 `cleanup`。清理连续 5 次都未核实，终态变成 `blocked`，`reason` 为 `cancel-cleanup-unconfirmed`，仍要人看过再 `resume` 或另作处置。

## 故障与恢复

工作流看到 `state === 'blocked'` 时，按 `failureClass` 决定自动退还是等人。

**可重试（`retryable`）**：自动睡 4 / 8 / 16 / 32 / 64 秒，最多 5 次。来源包括 `RATE_LIMITED`、`TRANSPORT_CLOSED`、`SERVICE_UNAVAILABLE`、`DEADLINE_EXCEEDED`、回环不可用 / `busy`、ACP 启动超时、以及 `lease-held` / `channel-full` / `maintenance` / `launch-uncertain`。

**等待外部进度（`pending`）**：每 60 秒一次，最多 10 次。常见 `reason`：`checks-running`（契约检查还没跑完）、`pr-not-merged`（PR 尚未合并）。

**必须人介入，然后 `signal --name resume`：**

- 自动预算用尽：`retryable` 已 5 次或 `pending` 已 10 次，工作流停在 `blocked` 等 `resume`。
- `failureClass` 为 `blocked`：认证/权限（`AUTH_REQUIRED`、`PERMISSION_DENIED`）、会话在问人（`WAITING_USER`）、契约/模型不合法（`INVALID_CONTRACT`、`INVALID_MODEL`、`UNSUPPORTED_CAPABILITY`）、检查结论失败（`checks-failed`）、部署不健康（`deployment-unhealthy`）。
- `failureClass` 为 `unscanned`：证据没扫全或不信任（审查身份未核实、检查未扫到目标 HEAD、合并/关单回读对不上等）。`closure-unconfirmed` 也落在这一档。
- 审查轮次用尽：`reason` 为 `review-budget-exhausted`（没有自动档，直接等人）。
- 取消后清理未核实：`reason` 为 `cancel-cleanup-unconfirmed`。

`status` 里同时看 `reason` 和 `failureClass`，再决定是等检查、补权限、换 profile，还是发 `resume`。

## 已知边界

- **不改 workflow 文件。** 本包不改 `.github/workflows/*`，也不在运行时改写 Temporal 工作流源文件；持久顺序以仓内 `src/workflows.mjs` 为准。
- **不自动买资源。** 不起云主机、不续订阅、不代购额度；没映射的仓、没配好的 Temporal / profile 会失败并按上节分类，不会去下单。
- **会话不碰凭据。** 执行会话拿不到 token。`git push` 的 `GH_TOKEN` / `GITHUB_TOKEN` 只由系统 `pushEnv`（`resolveToken('worker')`）注入；GitHub 写动作走 `gh-as` / `issue-gateway`，不让模型自己选身份或读密钥。
