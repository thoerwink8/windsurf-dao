# tests/watchdog-fixtures —— 正式看门狗（issue #442）快照语料

给 `node scripts/watchdog.mjs --snapshot-dir <目录>` 用的录制/样本 JSON。全部字段结构来自 orca
真实输出（`orca worktree ps --json` / `orca terminal list --json` / `orca terminal read --json`）。

语料分两类，看门狗测试对它们一视同仁地跑，但语义必须分清楚：

## 一、现场实录（real-incidents/）——上线生效证据

2026-08-15 实录，ps / terminal-list / read 字段未改写；改写处逐样本在表格里列全
（at-capacity 与 read-error 的 ps 各改**两处** state，at-capacity 的 read 校正
returnedLineCount 与 tail 行数自洽），其余字段零改写。时间、工位、触发动作记录如下：

| 目录 | 实录内容 | 检测结果 |
|---|---|---|
| `real-incidents/at-capacity-450/` | #450 点将台综合稿 codex 工人（gpt-5.6-sol）**正在现场卡在** `⚠ Selected model is at capacity. Please try a different model.`——全量未改写 ps + read（60 行，报错在底部窗口内）。watchdog live 实跑当场抓到 | 退出码 1，`[#450 - 点将台综合稿] fingerprint: 「at capacity、try a different model」` |
| `real-incidents/at-capacity/` | #452 审官工位（codex）同一事故的**真实终端保留输出**。全量 146 行原样存 `evidence-全量原始read.json` 留档；fixture 的 read 取事故当时屏面前 22 行**连续切片**（起点 0，行文本零改写），`returnedLineCount` 从 146 **校正为 22** 与 tail 行数自洽。ps 相对底稿 `ps-0815.json` 改**两处** `state`（逐字段比对确认，其余零改写）：① #452 codex 事故 agent `state` done→working 反映事故当时；② 同 worktree 的 pi agent `state` working→done 做隔离（#452 只留一个 working 工位） | 退出码 1，`fingerprint: 「at capacity、try a different model」` |
| `real-incidents/read-error/` | 真实 orca 错误响应原样：`orca terminal read` 对轮换后的手柄返回 `terminal_handle_stale`（真实发生过：终端重启后手柄失效），错误响应零改写。ps 相对底稿 `ps-0815.json` 与 at-capacity 相同地改**两处** `state`：① #452 codex `state` done→working；② 同 worktree 的 pi agent `state` working→done 做隔离 | 退出码 1，首轮 `read-failed: …terminal_handle_stale…` |

> 2026-08-15 实录背景（issue #442 新指纹语料）：GPT/codex 报
> `⚠ Selected model is at capacity. Please try a different model.` 后当轮中断、TUI 落回空闲、屏面静止。
> 该报错当时不在指纹清单里，靠哈希三轮慢通道（3×90s≈4.5 分钟）才报警；本次指纹补进清单后，
> 上面两起实录 + 一次 live 实跑都当场命中。

## 二、手工变异单元样本（其余目录）——补充单元测试，不当现场实录

在真实录制（`ps-0815.json` / `terminal-list-0815.json` / `live/`）基础上改字段改出来的，
每个样本只动一处违规、其余工位隔离。**它们证明的是「匹配器能拦住故意构造的违规」，不是现场实录。**

| 目录 | 变异点 | 期望 |
|---|---|---|
| `live/` | 2026-08-14 实录（master + 看门狗正式版 两工位，含真实 read） | 退出码 0，OK 扫完 1 个工位（master 被结构性排除）；带 `--self-worktree` 则 NO_TARGETS |
| `exited/` | read `status` 改 `"exited"` | 退出码 1，`[#452 - 看门狗正式版] exited:` |
| `fingerprint/` | read 底部窗口写入盲考·Grok 真实报错原文 | 退出码 1，`fingerprint:` 含 terminated |
| `waiting/` | ps `state` 改 `"waiting"` | 退出码 1，`waiting:` |
| `hash-stable/` | 真实干净屏面三轮同屏（updatedAt/incarnation 冻结） | 第 3 轮退出码 1，`hash-stable:` |
| `hash-stable-activity/` | 同屏四轮，updatedAt 第 2 轮推进一次 | 第 4 轮才报（新序列第 3 个同屏轮） |
| `hash-stable-restart/` | 同屏五轮、第 3 轮 incarnationId 变（同 pane 重启、屏面不变）——重启轮重新起算 | 第 5 轮才报（第 3/4 轮必须 OK；判别力：epoch 去 incarnation 会第 3 轮就报） |
| `hash-stable-screenchange/` | 屏面 X,X,Y,Y | 永不报，退出码 0 |
| `read-malformed/` | read 成功响应缺 `result.terminal` | 首轮 `read-failed:`（fail-closed） |
| `read-error-livefallback/` | 基于 read-malformed，read 文件换成 **runOrca 回落形态**（`{ok:false, error:"exit 1"}` 字符串错误，模拟 orca stdout 非 JSON / spawn 失败时 runOrca 返回的形态，不是原始 orca 响应） | 首轮 `read-failed:` 且回落字符串进详情（live 字符串分支的自动化覆盖） |
| `exclusion/` | master(主,指纹屏面) + #452(自,指纹屏面) + #999(工人,干净屏面) | 见 tests/watchdog.tests.js ⑭ |
| `no-targets/` | 全部 agent `state=done` | 退出码 2，`NO_TARGETS` |

## 原始录制底稿（根目录）

- `ps-0815.json` / `terminal-list-0815.json`：2026-08-15 实时录制（未改写）。
- `worker-list-live.json`：`orca orchestration worker-list` 历史账本实录（说明当前派工走裸注入、
  orchestration 元数据不可枚举——结构性排除因此用主工作区/自身/稳定 pane ID 实现）。

## 改出新样本的规矩

1. 先 `orca worktree ps --json` + `orca terminal list --json` + `orca terminal read --limit 60 --json`
   录真实语料（read 文件名 `read-<句柄>.json`，句柄从 JSON 里 `result.terminal.handle` 取，须与
   terminal-list 映射一致）。
2. 现场实录直接入库 `real-incidents/`；从实录改违规的样本只动一处，其余工位 `state=done` 隔离。
3. 跑 `node scripts/watchdog.mjs --snapshot-dir <新目录>`，被拦下才算数；再把新样本加进
   `tests/watchdog.tests.js` 的断言。
