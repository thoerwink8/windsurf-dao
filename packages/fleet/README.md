# fleet

fleet 是 windsurf-dao 的持久任务闭环：一个 GitHub issue 对应一条 Temporal 工作流（`fusionTaskWorkflow`），在 `prepare → lead → execute → verify → review → integrate → [deploy] → closeIssue` 各阶段依次推进——主脑出计划、执行体改代码并提交、独立审查者审 PR、系统拉取检查证据；只有证据齐备（检查全绿、异厂审查通过、PR 已合并）才关单。

## 起任务

### 1. 先起 worker

worker 消费 Temporal 队列并执行活动（git、gh、会话等）。Temporal 地址**只认环境变量**，CLI 没有 `--address` 旗标。

```bash
cd packages/fleet
node src/cli.mjs worker [--queue dao-fleet]
```

| 环境变量 | 默认值 | 含义 |
|---|---|---|
| `DAO_FLEET_QUEUE` | `dao-fleet` | 任务队列名；`worker` 与 `start` 的 `--queue` 未给时用此值 |
| `DAO_FLEET_TEMPORAL` | `127.0.0.1:7233` | Temporal 前端地址 |
| `DAO_FLEET_NAMESPACE` | `default` | Temporal 命名空间 |
| `DAO_FLEET_PROJECTS` | `{}` | JSON 对象，仓库 → 本地路径映射 |

### 2. 再 start 一条任务

`start` 会启动 `fusionTaskWorkflow`，`workflowId` 形如 `dao/<repo小写>/issue/<N>/g<G>`（`G` 来自 `--generation`，默认 `1`）。

**三档 profile 必须齐备才开工**（也可省略三档、改由 `--selection auto` 按腿表自动选，但 `executor` 与 `reviewer` 必须异厂）。档定义见仓库根 `docs/execution-profiles.json`。

```bash
cd packages/fleet
node src/cli.mjs start \
  --repo thoerwink8/windsurf-dao \
  --issue 1454 \
  --lead-profile grok-mirasim-native \
  --executor-profile grok-mirasim-native \
  --reviewer-profile codex-relay-gpt-5.6-luna
```

### start 可选参数

| 旗标 | 默认 | 说明 |
|---|---|---|
| `--generation G` | `1` | 同 issue 的第几代任务（重开单时递增） |
| `--wait` | 否 | 阻塞到工作流结束，打印最终结果；退出码：完成 `0`、否则 `1` |
| `--checks a,b` | `check` | 契约要求的 CI 检查名，逗号分隔 |
| `--rounds N` | `3` | 审查/返工轮次上限 |
| `--deploy` | 否 | 布尔旗标：合并后还需验证部署健康 |
| `--timeout N` | `1800` | 单步活动超时（秒） |
| `--base BRANCH` | `master` | 集成分支 |
| `--queue NAME` | 见上表 | 覆盖默认队列 |
| `--selection auto\|ask` | `auto` | `auto`：缺档时自动选腿；`ask`：只打印三张候选腿表后 **exit 3**，不启动工作流 |

显式指定三档时 `--selection` 被忽略。`ask` 模式打印完候选后，需人工选定并带上 `--lead-profile` / `--executor-profile` / `--reviewer-profile` 重新 `start`。

## 查状态与发信号

### 查状态

```bash
node src/cli.mjs status --repo thoerwink8/windsurf-dao --issue 1454 [--generation 1]
```

通过 Temporal query `status` 返回 JSON，字段：

| 字段 | 含义 |
|---|---|
| `taskId` | 工作流 ID |
| `state` | `running` / `blocked` / `completed` / `cancelled` |
| `phase` | 当前阶段：`queued`、`preparing`、`planning`、`executing`、`verifying`、`reviewing`、`integrating`、`deploying`、`closing` |
| `round` | 已消耗的审查/返工轮次 |
| `head` | 当前接受的或进行中的 commit SHA |
| `reason` | 阻塞或终止原因（如有） |
| `failureClass` | 故障分类（见下节） |

### 发信号

```bash
node src/cli.mjs signal --repo thoerwink8/windsurf-dao --issue 1454 [--generation 1] --name resume
node src/cli.mjs signal --repo thoerwink8/windsurf-dao --issue 1454 [--generation 1] --name cancel
```

| 信号 | 行为 |
|---|---|
| `resume` | **仅当** `state === blocked` 时生效；人工处理完根因后发送，工作流从检查点继续 |
| `cancel` | 取消当前 scope 并触发 cleanup；若 5 次 cleanup 均未核实，任务变为 `blocked`，`reason=cancel-cleanup-unconfirmed` |

## 故障与恢复

工作流在 `blocked` 时会先看 `failureClass` 能否自动重试：

| `failureClass` | 自动重试 | 策略 |
|---|---|---|
| `pending` | 最多 10 次 | 每次睡 60s（如 CI 还在跑、PR 尚未合并） |
| `retryable` | 最多 5 次 | 退避 4 / 8 / 16 / 32 / 64 秒（传输故障、限流、执行体瞬时不可用等） |

重试耗尽后，或 `failureClass` 为其它值时，工作流**停等** `resume` 信号，必须人工介入。

### `blocked` 常见态

| 场景 | `failureClass` | 是否自动重试 | 人该做什么 |
|---|---|---|---|
| CI 检查还在跑 | `pending` | 是 | 通常等自动重试；久等可查 GitHub Checks |
| CI 检查失败 | （无，`reason=checks-failed`） | 否 | 看 PR 检查日志，修代码或改契约后 `resume` |
| 审查轮次用尽 | （无，`reason=review-budget-exhausted`） | 否 | 评估是否加 `--rounds` 重开一代，或人工收尾 |
| 证据无法判定 | `unscanned` | 否 | 查 `reason`（如 `reviewer-not-independent`、`closure-unconfirmed`），修根因后 `resume` |
| 等人回答 / 缺权限 / 契约无效 | `blocked` | 否 | 处理 `WAITING_USER`、`AUTH_REQUIRED`、`PERMISSION_DENIED`、`INVALID_*` 等，再 `resume` |
| cancel cleanup 未核实 | （无，`reason=cancel-cleanup-unconfirmed`） | 否 | 人工确认工作区/分支已清理，再 `resume` 或重开 |

`cancel` 是人主动停任务，不是故障恢复路径。

## 已知边界

fleet **不做**以下事情：

- **不改 workflow 文件**——工作流逻辑在 `src/workflows.mjs`，日常运维只通过 CLI 起停与发信号。
- **不自动买/扩资源**——账户池、算力、Temporal 集群容量需运维预先备好。
- **会话不碰凭据**——lead / executor / reviewer 的 AI 会话只改代码、写计划、出审查 JSON；git 身份、push token、issue 正文读写等由系统活动（`activities.mjs` + `gh-as.mjs`）在会话外完成。

## 源码索引

| 文件 | 职责 |
|---|---|
| `src/cli.mjs` | 命令入口（本 README 参数以此为准） |
| `src/contract.mjs` | 任务身份、审查/检查/交付判定 |
| `src/runner.mjs` | 阶段编排与返工循环 |
| `src/workflows.mjs` | Temporal 工作流、重试退避、信号处理 |
| `src/activities.mjs` | 与 git / gh / 执行体的真实接缝 |
