# CLI 踩坑教学（cli-notes）

每个 CLI 一份踩坑教学 md。**改代码/派工前先读对应文件 + `docs/model-routing.toml` 对应 `[providers.*]` 段**。

| CLI | 文件 | 一句话特性 |
|---|---|---|
| Devin | [devin.md](devin.md) | command 型，TUI 就绪慢，必须先 `wait --for tui-idle` 再送字 |
| Codex (gpt) | [codex.md](codex.md) | agent 型，必须 `--agent codex`，粘贴 `[Pasted Content]` 永不发送 |
| Grok | [grok.md](grok.md) | agent 型（regrok shim），push 硬拦要授权词「推」 |
| pi / gw-dspool / opencode-go (deepseek) | [pi.md](pi.md) | agent 型，flash 走 gw-dspool，og 顺位 2（403 RegionError），额度顶报 402 不许自切直连 |
| Cursor | [cursor.md](cursor.md) | agent 型，`[Pasted text]` 是提交后残留不算未提交 |
| Command Code | [commandcode.md](commandcode.md) | command 型，只做非交互查证，需补空回车 |
| Claude (reclaude) | [claude.md](claude.md) | command 型，必须 `--command` 读 launch，抢跑注入必被吞 |
| 飞书 (`lark-cli`) | [feishu.md](feishu.md) | 运维 CLI，不是工人；`--as bot` 发消息，话题群≠线性群 |

## 跨 CLI 通用教训（#762 实战，2026-08-25）

1. **detached 进程调 worker-start/task-create 必须带 `--from 活终端`**（哑终端 coordinator），否则 `no_active_sender_terminal` / `consumer_fenced`。照 #682 微通道：起「派工协调（勿关）」哑终端 + `run-create --from`。
2. **command 型 TUI（devin/claude）必须先 `wait --for tui-idle` 就绪再送字**，否则 `agent_prompt_stalled`；wait 就绪即返回，不是等满超时。
3. **屏面稳定 ≠ 开工**：开工验证带任务书指纹（expect），见指纹才算注入成功；`[Pasted Content]` / `[Pasted text]` 停在输入框 = 未提交（#661）。
4. **审官单例（#575 一 PR 一审官）**：已有审官卡复用，不销毁重建、不反复 attach。残留卡多了说明在反复重试——停下来查根因（注入/就绪），不是继续换卡。
5. **worker-start 快**：stalled 是"送达失败"不是"等不够久"，别加长超时硬等——修送达（等就绪/走 agent 协议）。
6. **`--agent` 回的 handle ≠ agent 终端**（#802）：无头 Linux 上 agent 起在另一张终端（`agentIdentity`），记账 handle 常是空壳，任务书打进 bash。派工按 `agentIdentity` 校准再注入；title 不可靠。

## 原材料

各 CLI 的启动模板唯一真源：`docs/model-routing.toml`；选型（谁干什么、顺位、禁令）唯一真源：`docs/model-routing.json`（本目录只做教学提炼 + 本次实战新增，不复制会过期的值）。
