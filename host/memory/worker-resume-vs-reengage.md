---
name: worker-resume-vs-reengage
description: 工人「已完工闲置」才需新建任务卡续活；「任务中途被打断」直接 terminal send 一句继续，别重发任务书
metadata: 
  node_type: memory
  type: feedback
  originSessionId: de7e48d7-22ba-4963-95ba-353e4c49b07e
  modified: 2026-08-15T14:43:58.639Z
---

给工人续活分**两种情形**，处置不同，2026-08-15 用户当场纠正（我把两者混为一谈，在付费模型上把几千 token 的任务书重发了一遍换来零增量信息）：

| 情形 | 工人状态 | 正确做法 |
|---|---|---|
| **已完工闲置** | 发过 `worker_done`，回到 prompt 空转，dispatch 已 settle | `task-create` + `worker-start --task <新> --terminal <handle>`（handle 取 `worker-show --dispatch` 的 `worker.agent_terminal_handle`）。手册明写它送达的是 fresh preamble + TASK block as **new terminal input** |
| **任务中途被打断** | 报错/限流/余额耗尽后停在 prompt，任务书还在自己 scrollback 里，dispatch 仍 live | `orca terminal send --terminal <handle> --text "继续" --enter`。**够了**，别重发任务书 |

`orca orchestration send --to dispatch:<id>` 两种情形都**叫不醒**——它是收件箱不是推送，工人得自己跑 `orchestration check` 才看得到，而干活中和闲置中都不会主动 check。实测两条 high 优先级消息零送达且不报错。

**Why**：全局约定那条「给它续活的唯一路径是新建任务注入它那个终端」说的是**第一种**情形（已 settle 的 dispatch 需要新 dispatch 才能重新挂上生命周期）。「派工走 Orca 编排不混旁路」管的是**新派一件活**的通道与留痕，不管被打断的活怎么接上。`terminal send` 是原生命令，手册自己就写着 "use `terminal send` when an existing agent needs a free-form prompt"，不是旁路。

**How to apply**：续活前先判工人处在哪种状态——查 `task-list` 看卡是否还 `dispatched`、读屏看有没有发过完工报告。中途被打断就一句 `terminal send` 继续；只有 dispatch 真的 settle 了才新建卡。另：被打断那张卡会永远卡在 `dispatched` 不 settle，用 `task-update --status failed --result '{"reason":..., "superseded_by":...}'` 收口（手册允许手动 update 用于 explicit recovery），标 `completed` 是假账——那张卡下一行活都没干过。

相关：[[dispatch-regex-corpus-and-stall]]、[[orca-json-field-paths]]
