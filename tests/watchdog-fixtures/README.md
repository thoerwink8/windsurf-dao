# tests/watchdog-fixtures —— 正式看门狗（issue #442）快照语料

给 `node scripts/watchdog.mjs --snapshot-dir <目录>` 用的录制/样本 JSON。全部字段结构来自 orca
真实输出（`orca worktree ps --json` / `orca terminal list --json` / `orca terminal read --json`）。

2026-08-15 融合改造（fusion-verdict.md）后判据口径：

- 指纹**两连同才报警**（单发即唤醒的宽指纹 'Error:'/'terminated'/'Connection error' 已退役）；
- 报警前**活证否决**（输出 cursor 在前进 → 降级观察行不唤醒）；
- 停摆**主判据 = 输出 cursor 三轮不前进**（整屏哈希会被 TUI 计时器动画骗过），无 cursor 数据时回退哈希；
- `--exclude-pane` 改为**分级排除**（豁免指纹/停摆，保留 exited/waiting 死活判据）。

语料分两类，看门狗测试对它们一视同仁地跑，但语义必须分清楚：

## 一、现场实录（real-incidents/）——上线生效证据

2026-08-15 实录，ps / terminal-list / read 字段未改写；改写处逐样本在表格里列全
（at-capacity 与 read-error 的 ps 各改**两处** state，at-capacity 的 read 校正
returnedLineCount 与 tail 行数自洽），其余字段零改写。时间、工位、触发动作记录如下：

| 目录 | 实录内容 | 检测结果 |
|---|---|---|
| `real-incidents/at-capacity-450/` | #450 点将台综合稿 codex 工人（gpt-5.6-sol）**正在现场卡在** `⚠ Selected model is at capacity. Please try a different model.`——全量未改写 ps + read（60 行，报错在底部窗口内）。watchdog live 实跑当场抓到。**2026-08-15 裁定书后：指纹两连同才报警——单轮不唤醒，两轮同屏（同事故第二次轮询）第二轮到** | 单轮退出码 0；两轮同屏退出码 1，第二轮 `[#450 - 点将台综合稿] fingerprint: 「at capacity、try a different model」` |
| `real-incidents/at-capacity/` | #452 审官工位（codex）同一事故的**真实终端保留输出**。全量 146 行原样存 `evidence-全量原始read.json` 留档；fixture 的 read 取事故当时屏面前 22 行**连续切片**（起点 0，行文本零改写），`returnedLineCount` 从 146 **校正为 22** 与 tail 行数自洽。ps 相对底稿 `ps-0815.json` 改**两处** `state`（逐字段比对确认，其余零改写）：① #452 codex 事故 agent `state` done→working 反映事故当时；② 同 worktree 的 pi agent `state` working→done 做隔离（#452 只留一个 working 工位） | 两轮同屏退出码 1，第二轮 `fingerprint: 「at capacity、try a different model」` |
| `real-incidents/read-error/` | 真实 orca 错误响应原样：`orca terminal read` 对轮换后的手柄返回 `terminal_handle_stale`（真实发生过：终端重启后手柄失效），错误响应零改写。ps 相对底稿 `ps-0815.json` 与 at-capacity 相同地改**两处** `state`：① #452 codex `state` done→working；② 同 worktree 的 pi agent `state` working→done 做隔离 | 退出码 1，首轮 `read-failed: …terminal_handle_stale…`（read-failed 单发即报，不吃两连同） |

> 2026-08-15 实录背景（issue #442 新指纹语料）：GPT/codex 报
> `⚠ Selected model is at capacity. Please try a different model.` 后当轮中断、TUI 落回空闲、屏面静止。
> 该报错当时不在指纹清单里，靠哈希三轮慢通道（3×90s≈4.5 分钟）才报警；本次指纹补进清单后，
> 上面两起实录 + 一次 live 实跑都当场命中。

## 二、手工变异单元样本（其余目录）——补充单元测试，不当现场实录

在真实录制（`ps-0815.json` / `terminal-list-0815.json` / `live/`）基础上改字段改出来的，
每个样本只动一处违规、其余工位隔离。**它们证明的是「匹配器能拦住故意构造的违规」，不是现场实录。**

| 目录 | 变异点 | 期望 |
|---|---|---|
| `live/` | 2026-08-14 实录（master + 看门狗正式版 两工位，含真实 read 与 cursor） | 退出码 0，OK 扫完 1 个工位（master 被结构性排除）；带 `--self-worktree` 则 NO_TARGETS |
| `exited/` | read `status` 改 `"exited"` | 退出码 1，`[#452 - 看门狗正式版] exited:` |
| `fingerprint/` | read 底部窗口写入**已退役宽指纹**（`Error:`/`terminated`/`Connection error`，故意不含保留指纹 `Retry failed`/`Reconnecting 5/5`——否则两连同会命中保留项，退不退役分不出） | 两轮同屏退出码 0，无 `fingerprint:`（两连同也不报）；判别力自检：把退役指纹加回清单必须变红 |
| `wide-fp-deleted/` | 基于 live/，底部窗口写入 `Error: ...` 与 `Connection error: ...`（退役宽指纹） | 两轮同屏退出码 0，不报 fingerprint |
| `waiting/` | ps `state` 改 `"waiting"` | 退出码 1，`waiting:` |
| `selector-freeze/` | **#569 ④（权限确认框）**：屏面底部写入 `1/3:select` 选择器提示（grok 审官实证形态），进程活着、屏面冻结 | 两轮同屏退出码 1，第 2 轮 `selector:`（持续超阈轮才报，不自动替它选） |
| `hash-stable/` | 真实干净屏面三轮同屏（updatedAt/incarnation 冻结，无 cursor 字段） | 第 3 轮退出码 1，`stall:`（非 spinner 内容三轮不变） |
| `hash-stable-activity/` | 同屏四轮，updatedAt 第 2 轮推进一次——**#500 判别力：ps updatedAt 前进不算活性**（转圈挂死时 ps 也可能在动） | 第 3 轮报（第 2 轮必须 OK；判别力：把 updatedAt 接回 epoch 会第 4 轮才报 → 断言变红） |
| `hash-stable-restart/` | 同屏五轮、第 3 轮 incarnationId 变（同 pane 重启、屏面不变）——重启轮重新起算 | 第 5 轮才报（第 3/4 轮必须 OK；判别力：epoch 去 incarnation 会第 3 轮就报） |
| `hash-stable-screenchange/` | 屏面 X,X,Y,Y | 永不报，退出码 0 |
| `spinner-hang/` | **#500 判别性实验：转圈假工人**——三轮真实内容完全不动，spinner 帧轮换（⠸→⠼→⠴）+ cursor 前进 + ps updatedAt 前进 | 第 3 轮退出码 1，`stall:`（旧判据 cursor/哈希/updatedAt 全放行=瞎）；判别力：改坏 spinner 剔除 → 永不报 → 断言变红 |
| `real-advance/` | 健康工人负对照：真实内容逐轮变化 + spinner 也在转 | 永不报，退出码 0 |
| `idle/` | 空转：ps working + git-evidence 显示 30 分钟无 git 活动（#471） | 首轮退出码 1，`idle:` 带分钟数 |
| `idle-fresh/` | 5 分钟内有 git 活动 | 退出码 0，不报 idle |
| `idle-reviewer/` | **#569 降噪①（角色判据）**：同 idle/ 但卡名改为子卡 `#455 - 审官·grok-4.6`（带 ·）——git 空转判据不适用 | 退出码 0，`观察: 子卡…不判 git 空转`；不报 idle（审官产出是 review comment 与 notify 不是 commit） |
| `idle-pr-exempt/` | **#569 降噪②（在途 PR 豁免）**：同 idle/ 但 ps 改卡名/树 id，pr-evidence 显示关联 PR OPEN 非 draft（reviewDecision=APPROVED） | 退出码 0，`观察: 在途 PR #999…等着别人`；不报 idle（已交付等下一环） |
| `idle-pr-rework/` | 同 idle-pr-exempt 但 reviewDecision=CHANGES_REQUESTED（PR 要返工，责任仍在本工位） | 退出码 1，`idle:` 照报（真阳不减） |
| `idle-veto/` | **#569 降噪③（活性否决）**：三轮同 git 空置，真实内容第 2 轮变化、第 3 轮冻结 | 第 1 轮 idle；第 2 轮 `观察: 空转豁免…活性否决`（不算空转）；第 3 轮 idle 再报 |
| `orphan-closed/` | 真孤儿：无活跃执行者（终端已关）+ 关联 issue 已关 | 退出码 1，`orphan:` 带判断依据（#492 关条件 4）；默认快照再打 `动作: 将执行 worktree-rm`（#630，不真删） |
| `orphan-open/` | 关联单还开着（#492 v3：任一开着就不算孤儿） | 不报 orphan；不打 worktree-rm 动作（#630 负控） |
| `orphan-active/` | 另一位主帅的活跃工位（working agent + 合规名） | 退出码 0，不报 orphan（#492 关条件 3） |
| `orphan-noassoc-stale/` | 无关联 + 静置超 60 分钟 | 退出码 1，`orphan:` 带静置分钟数；默认快照同样只打印将执行 worktree-rm（#630） |
| `orphan-noassoc-fresh/` | 无关联 + 静置 5 分钟（未超阈值） | 不报 orphan（命名不合规另报 naming） |
| `orphan-pr-merged/` | **#652**：工人卡 linkedPR=652，gh-evidence prState=MERGED，无活跃执行者 | 退出码 1，`orphan:` 打 worktree-rm 动作；可归档只认 MERGED |
| `orphan-pr-open/` | **#652**：同上去 prState=OPEN | 不报 orphan、不打 rm（不是 MERGED 不删） |
| `orphan-pr-closed/` | **#652**：同上 prState=CLOSED（未合） | 不报 orphan、不打 rm（CLOSED 不算 MERGED） |
| `orphan-pr-unscanned/` | **#652**：gh-evidence 缺 prState（查不动） | `PR_STATE_UNSCANNED` note，不删（fail-closed） |
| `orphan-pr-nameonly/` | **#652**：审官子卡 linkedPR=null 但卡名 `PR-#777`，gh prState=MERGED | 退出码 1，`orphan:`（卡名/路径 PR-#N 也算 PR 关联） |
| `orphan-pr-parent-open-child-merged/` | **#652**：父树 PR OPEN + 子树 PR MERGED，无活跃执行者 | 只报子卡 orphan 并只对子卡打 rm，父树不删（父树挂未合 PR 只拆已合子卡） |
| `naming-bad/` | 卡名 `审官·GPT`（另一主帅的卡，终端在跑） | 退出码 1，`naming:`；不报 orphan（活跃执行者判据优先） |
| `naming-skip/` | **#569 降噪**：基于 idle/，加一条 live 实录形态的 `windsurf-dao` 卡（review-566：0 agent、1 活终端、无 #N 前缀） | 退出码 0，不报 naming（无 agent 且无 #N 前缀的树不是任务卡；有 agent 的误命名卡仍会报，见 naming-bad） |
| `blind/` | **#569 垫片并进（BLIND，2026-08-17 判据订正）**：加一条 `#555 - 隐形工人测试` 卡，liveTerminalCount=2，worker-list-evidence.json 的记账集合里不含它（从没走 worker-start/dispatch） | 退出码 1，`blind:`（有活终端且查不到 dispatch 记账 = 编排层看不见，只能人工盯） |
| `blind-tracked/` | 同 blind/ 但 #555 出现在记账集合里（2026-08-17 帅实证形态：agents=0 的审官 worker-read 读得到、token 在涨） | 退出码 0，不报 blind（有记账 = 编排层看得见，agents=0 不算数） |
| `heartbeat-stale/` | flow 心跳 ts 10 分钟未更新（#497 契约） | 退出码 1，`flow-stalled:` |
| `heartbeat-pending/` | 心跳新鲜但 PR state=approved 停留 40 分钟 | 退出码 1，`stagnation:`（该发生而没发生） |
| `heartbeat-fresh/` | 心跳新鲜 + 无停滞 PR | 不报 flow-stalled/stagnation；打印「心跳新鲜」；心跳缺失样本（如 live/）显形 HEARTBEAT_MISSING |
| `heartbeat-absent-pending/` | **#580**：无 heartbeat.json + flow-signals 有完工未起审官 | 退出码 1，`flow-absent:` 心跳从未存在（有待流转却无人流转） |
| `heartbeat-absent-idle/` | **#580**：无 heartbeat.json + 已绿待帅（不是流转器活） | 不报 flow-absent/flow-stalled；note「心跳从未存在——无待流转对象，不报」 |
| `heartbeat-absent-ticket-pending/` | **#580 审官红 2**：PR #582 署名 issue #580，完工在 issue 评论 | 报 flow-absent |
| `heartbeat-absent-ticket-idle/` | **#580 审官红 2**：完工只在 PR 会话、issue 上没有 | 不报 |
| `retry-503/` | **#580 追加**：三轮 503 重试、cf-ray/retry 在变、无 git 产出 | 第 3 轮 `retry-loop:`；不报 stall |
| `retry-503-progress/` | **#580 追加**：同样 503 重试但 git lastActivity 新鲜 | 不报 retry-loop |
| `model-change/` | **#569 ②（pi 静默换 provider）**：`sessions/` 下一条手写 jsonl——会话开头初始选型（model_change 前无 message）→ 随后 assistant 报错（errorMessage="503 status code (no body)"）→ 紧接着 model_change 切到 deepseek | 退出码 1，`[pi] model-change: …诱因：503 status code (no body)`；初始选型那条不报（那是正常选型号不是静默切换） |
| `fp-loss/` | **非 capacityRetry** keepalive 指纹（no serving account）连续 5 轮 | 第 2 轮 fingerprint + 动作行，第 5 轮 `报帅:`（#471 连败阈值，通用 fpLoss 路径） |
| `capacity-keepalive/` | **#633**：at capacity 连续 6 轮，时间戳 T0 / T0 / +10s / +70s / +250s / +550s | 第 2 轮续命 #1；之后未见 token/Working，残留 at capacity 不连发；第 6 轮等满四档 `报帅:` |
| `capacity-token-reset/` | **#633**：同屏 at capacity，outputTokens 100/100/200/200/200；第 3 轮（+10s）token 涨了 | 第 2 轮续命 #1；第 3 轮观察「次数清零」不续命；第 4 轮再卡住仍是第一次续命 |
| `stall-ignores-tokens/` | **#633**：spinner-hang 同源，outputTokens 100→200→300，屏面真实内容不动 | 第 3 轮 `stall:`（停摆主判据不用 token） |
| `capacity-unsent/` | **#633**：at capacity 两连同，但屏上有 Pasted Content / 等待发送 | 第 2 轮 fingerprint，不发续命（框里有未发出内容禁止 send） |
| `leftover-rework/` | **#633**：agent=done，框里躺着【返工指令 | 退出码 1，`leftover-inject:`，不回车 |
| `veto/` | 两轮底部窗口写入 at capacity 指纹，**真实内容逐轮变化** | 第 2 轮仍 `fingerprint:` + 续命（#633：at capacity 状态行不算活证否决） |
| `veto-other-fp/` | 同结构但指纹是 `no serving account`（非 capacityRetry） | 退出码 0，第 2 轮 `观察:` 活证否决，无 fingerprint |
| `veto-stall/` | 两轮底部窗口写入 at capacity 指纹，真实内容两轮相同 | 第 2 轮退出码 1，`fingerprint:`（两连同 + 无活证 → 报警） |
| `read-malformed/` | read 成功响应缺 `result.terminal` | 首轮 `read-failed:`（fail-closed） |
| `read-error-livefallback/` | 基于 read-malformed，read 文件换成 **runOrca 回落形态**（`{ok:false, error:"exit 1"}` 字符串错误，模拟 orca stdout 非 JSON / spawn 失败时 runOrca 返回的形态，不是原始 orca 响应） | 首轮 `read-failed:` 且回落字符串进详情（live 字符串分支的自动化覆盖） |
| `exclusion/` | master(主,指纹屏面) + #452(自,指纹屏面) + #999(工人,干净屏面) | 见 tests/watchdog.tests.js ⑭（--exclude-pane 已是分级排除：豁免指纹/停摆、保留死活判据） |
| `no-targets/` | 全部 agent `state=done`，任务卡均为 in-review | 退出码 2，`NO_TARGETS`（待合并盘面不是全员卡死） |
| `all-idle/` | 同 no-targets，但 `#453` 改为 `in-progress` | 退出码 1，`all-idle:`（有在途卡却零活工位） |
| `pasted-content/` | **#575/#633**：working 工位屏面写成 `[Pasted Content 5711 chars]`（无返工/复核字） | 不报 `pasted-content:`，不补回车 |
| `pasted-idle/` | **#575/#633**：in-progress 卡、agent=done、屏面 Pasted Content（无返工/复核字） | 不报 `all-idle:` / `pasted-content:` |
| `stale-completion/` | **#586**：agent=done 的工人卡 + completion-evidence（head 比最后完工 comment 新） | 退出码 1，`stale-completion:` |
| `stale-completion-fresh/` | 同结构但完工 comment 不早于 head | 不报 `stale-completion` |

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

## 快照轮里的证据文件（可缺省；缺 = 对应判据显式「没查成」note，不是查过没事）

- `git-evidence.json`：`{ capturedAt, worktrees: { <worktreeId>: { lastActivityTs } } }`（idle 用）
- `pr-evidence.json`（#569）：`{ <worktreeId>: { number, open, isDraft, reviewDecision } }`（idle 的
  在途 PR 豁免用；`"CHANGES_REQUESTED"` = PR 要返工，不豁免）
- `gh-evidence.json`：孤儿判据的关联单状态
- `heartbeat.json`：flow 心跳（#497 契约）
- `sessions/` 子目录（#569）：pi 会话 jsonl 树，model_change 检测用（快照默认读 `<轮目录>/sessions`）
- `worker-list-evidence.json`（#569 BLIND，2026-08-17 判据订正）：`{ worktrees: [ <worktreeId>, ... ] }`——
  dispatch 记账集合（镜像 live 的 `orca orchestration worker-list` 的 resource.worktreeId）。
  缺省 = BLIND 判据显式「没查成」（查不到记账 ≠ 查过没事）；出现在集合里 = 编排层看得见，不报
