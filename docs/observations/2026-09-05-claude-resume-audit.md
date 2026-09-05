# Claude resume 流程观察记录

观察目标：验证以 `claude --resume <session>` 恢复既有会话时，帅位是否仍能可靠接管、观测和审计执行过程。

证据来源：2026-09-05 在仓库根目录执行的命令输出、恢复会话终端快照，以及当前工作树状态。

复现步骤：

1. 在 `D:\frank\windsurf-dao` 执行 `claude --resume b5c06933-b102-4a7d-98ef-e15322725e7a`。
2. 恢复会话继续运行，并在终端显示 `Thought for 6s, read 1 file, ran 6 shell commands`、`全绿 119 项。推上去并部署`。
3. 同一会话随后显示 `Remote Control disconnected — Session creation failed (server 400)`，并提示 `run /remote-control to reconnect`。
4. 恢复过程没有给出可供帅位核验的任务身份、当前阶段、变更范围或结果文件；仓库根目录仍有未跟踪的 `.mirasim/`。

观察到的问题：

- **控制问题（已证实）**：会话可以继续执行，但 Remote Control 建立失败（HTTP 400），导致“执行活着”和“帅位可接管/审计”没有共同的成功判据。恢复命令本身不能证明控制链已恢复。
- **证据问题（已证实）**：终端只显示自然语言进度和汇总数字，没有绑定的 `task_id`、`dispatch_id`、commit/PR、结果路径或可核对的退出态；“全绿 119 项”无法单独证明当前恢复任务完成。
- **边界问题（待帅位确认）**：恢复会话继续执行并出现“推上去并部署”字样，但没有先展示本轮授权、变更清单或外部副作用闸门。需确认恢复会话是否可能在控制链断开时继续执行推送/部署。

改良假设：

1. `claude --resume` 后增加硬闸：必须同时拿到 Remote Control/session 绑定和结构化任务身份；任一失败即标记 `resume-uncontrolled`，只允许只读观测，不得把自然语言“完成”当作收口。
2. 恢复首屏写入结构化快照：`session_id`、`task_id`、`dispatch_id`、当前 commit、dirty files、最近命令、结果文件和外部副作用状态。
3. Remote Control 返回 400 时记录原始错误并停止“推送/部署”类动作，向帅位发出 fail-visible 通知；重连成功后再恢复写操作。

验收方式：恢复同一会话后，控制链失败时能看到明确的 `resume-uncontrolled` 状态和阻断原因；控制链成功时能读到结构化身份、变更与结果证据，并能由帅位单独复核。

上报记录：已按仓内约定尝试执行 `node scripts/dao.mjs ask` 通知帅位；发送失败，原始错误为 `run-current 没查成: orca 报错 runtime_unavailable: Could not read Orca runtime metadata at C:\\Users\\Administrator\\AppData\\Roaming\\orca\\orca-runtime.json. Start the Orca app first.` 因此本记录已落盘，但帅位的机器信箱尚未确认收到，不能把“已通知”当成成功。

处置：Remote Control 400 导致「会话在跑 ≠ 帅位可接管」这条已确认属实，落成 issue（见下）。收件箱机制本身由本轮 dao-inbox skill 落地。
