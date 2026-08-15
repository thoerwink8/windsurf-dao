---
name: claude-multisession-blocks-autoupdate
description: "多个 claude.exe 同时跑会卡死 auto-update 困在旧版,旧版长思考+工具调用会触发 \"tool call could not be parsed\";附会话 jsonl 诊断法"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: cd27564b-5cf8-4283-94f5-eef0c5c4ef1c
---

长期开多个 `claude.exe` 会话(本机一次实测 5 个实例 + 62 个 node 进程)会让 Claude Code 的 auto-update 永远失败(右下角红字 `Auto-update failed: claude.exe in use`),客户端卡死在旧版(本次=2.1.177)。旧版在 extended thinking(思考 5~20 分钟)+ tool use 组合下会吐出**损坏响应**:assistant message 里 thinking block 长度为 0 但带 signature、缺 tool_use block、stop_reason 却=tool_use → 客户端报 `The model's tool call could not be parsed (retry also failed)`,且确定性复现(重试也失败)。

**Why:** 这个报错表象极像 MCP 工具坏了(当时正排查 codegraph mcp fail),实际与 MCP / persona(dao 模式 22KB 纯人设,已排除)/ 上下文撑爆(仅用 15%)全都无关,根在客户端版本卡死。误诊会在错方向反复重试浪费几小时(那次脏会话烧了 7h45m / $9.5)。

**How to apply:**
- 见到 `parse` 报错 + 右下角 `Auto-update failed` → 先怀疑卡在旧版,别在脏会话里反复重试(同一手段失败 2 次即换,执者失之)。
- 根治:关掉所有多余 `claude.exe` 会话(关前必确认别的会话无未保存进度,勿误伤)→ 让它 auto-update / `claude update` / npm 重装 → 重启终端 → 干净会话带结论续作。脏会话放弃。
- 诊断 Claude Code 会话内部:读 `~/.claude/projects/<proj-encoded>/*.jsonl`,看 `stop_reason` 序列(异常会从 tool_use/end_turn 突变出 stop_sequence)+ content block 结构(**空 thinking + signature + 无 tool_use = 响应损坏铁证**)。
- **loop/无人值守场景最高危**:`loop` / `dao-autopilot` + `ScheduleWakeup` 每轮派 subagent 做 web 横向研究,是「extended thinking + 长链 tool use」的极端组合,最易触发损坏响应。一旦某轮 subagent 报 `[Tool result missing due to internal error]`,旧版主循环会在损坏响应上无限重试/空等——实测卡死 4h40m(wall-clock)而 API 仅 8155s,2h+ 纯空转无人发现。健壮化:loop 内派重 web 研究的 subagent 用 `run_in_background`+Monitor 不阻塞主循环;单轮加熔断(subagent 内部错误即跳过记一笔,不死等重发)。loop 的神是持续推进,不是卡在一个点上无限重试。
- 关联 [[dao-claude-migration]]、[[ralph-loop-disabled]]。
