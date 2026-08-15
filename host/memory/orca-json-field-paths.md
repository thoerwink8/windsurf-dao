---
name: orca-json-field-paths
description: orca --json 返回的字段路径别猜别写 || 串，实证清单在此；写解析必配真实返回夹具
metadata: 
  node_type: memory
  type: reference
  originSessionId: de7e48d7-22ba-4963-95ba-353e4c49b07e
  modified: 2026-08-15T15:43:22.945Z
---

`orca ... --json` 各命令的返回形状**实测清单**（2026-08-15 逐条实跑核对）：

| 命令 | 取值路径 |
|---|---|
| `orchestration task-create` | `result.task.id` ← **不是** `result.id`（那是 RPC 层 id 且在顶层） |
| `orchestration task-list` | `result.tasks`（数组），另有 `result.count` |
| `orchestration dispatch-show` | `result.dispatch.id` ← `result.dispatchId` 为 undefined |
| `orchestration worker-start` | `result.dispatchId`、`result.state`、`result.stage`、`result.effects[]` |
| `orchestration worker-show` | `result.worker.agent_terminal_handle`（`result` 顶层键：dispatch/worker/terminal/observation/terminalResource） |
| `orchestration check` | `result.deliveryId`、`result.messages[]`、`result.count`；`--wait` 期间每 15s 吐一行 `{"_keepalive":true}` |
| `terminal read` | `result.terminal.tail`（字符串数组）、`.status`、`.nextCursor`、`.returnedLineCount` |
| `worktree list` | `result.worktrees[]`，含 `comment`（**人在用的自由文本，会被覆写，别当机器真相源**） |

**同一天两次实咬**：`dao-cmd.mjs extractTerminalText` 认 `result.text/output/preview/lines` 全不匹配 → `dao.mjs dispatch` 整条派工通道从合并起就死（#499）；`flow.mjs` 取 `result.id || json.task.id` 全不匹配 → `taskId` 恒 null，红项闭环一行跑不起来（#500 记于 #499 评论）。两处**测试全绿**，因为夹具全是自造 JSON。

**How to apply**：
- 写解析前先真跑一次拿真实返回，别凭记忆写。
- **禁止写一串 `||` 猜字段**——它能掩盖「不知道真实形状」，绿了也不等于知道对在哪（`dispatch-show` 那行就是靠兜底蒙对的）。
- 解析外部工具输出的函数，测试必须存**该工具真实输出的原样存档**（仓内落点 `tests/fixtures/orca-returns/`，注明采集命令与日期），并配一条「把夹具字段改错必红」的上线证据。
- **`--peek` 不返回 `deliveryId`**（不消费就没有交付批次）。想 `--ack` 必须先用消费式 `check` 拿到 `deliveryId`。拿 `undefined` 去 ack 会得到 `stale_delivery`，而且**整条 `check --ack ... --wait` 会立刻退出**——门铃看似挂上实则没挂，静默失效（2026-08-15 实咬）。
- `check --wait` **禁止接 `head`/`grep`** 等会提前关管道的命令——`head -80` 收满 80 行 keepalive 就关管道，3000 秒的等待实际只等 1200 秒**且退出码为 0**，伪装成正常返回。直接重定向到文件。
- 用 Node `spawnSync(cmd, argsArray)` 调 orca 不会丢引号（本机 orca 是原生 PE32 exe 不是 .cmd 包装，且没有 `shell: true`）；但转发已拆开的 argv 会丢（`dao.mjs raw` 实咬）。

相关：[[dispatch-regex-corpus-and-stall]]、[[worker-resume-vs-reengage]]
