# CLI 踩坑教学（cli-notes）

每个 CLI 一份踩坑教学 md。**改代码/派工前先读对应文件 + `docs/model-routing.toml` 对应 `[providers.*]` 段**。

| CLI | 文件 | 一句话特性 |
|---|---|---|
| Devin | [devin.md](devin.md) | command 型，TUI 就绪慢，必须先 `wait --for tui-idle` 再送字 |
| Codex (gpt) | [codex.md](codex.md) | agent 型，必须 `--agent codex`，粘贴 `[Pasted Content]` 永不发送 |
| Grok | [grok.md](grok.md) | agent 型（regrok shim），push 硬拦要授权词「推」 |
| pi / opencode-go (deepseek) | [pi.md](pi.md) | agent 型，og 主通道，额度顶报 402 不许自切直连 |
| Cursor | [cursor.md](cursor.md) | agent 型，`[Pasted text]` 是提交后残留不算未提交 |
| Command Code | [commandcode.md](commandcode.md) | command 型，只做非交互查证，需补空回车 |
| Claude (reclaude) | [claude.md](claude.md) | command 型，必须 `--command` 读 launch，抢跑注入必被吞 |

## 跨 CLI 通用教训（#762 实战，2026-08-25）

1. **detached 进程调 worker-start/task-create 必须带 `--from 活终端`**（哑终端 coordinator），否则 `no_active_sender_terminal` / `consumer_fenced`。照 #682 微通道：起「派工协调（勿关）」哑终端 + `run-create --from`。
2. **command 型 TUI（devin/claude）必须先 `wait --for tui-idle` 就绪再送字**，否则 `agent_prompt_stalled`；wait 就绪即返回，不是等满超时。
3. **屏面稳定 ≠ 开工**：开工验证带任务书指纹（expect），见指纹才算注入成功；`[Pasted Content]` / `[Pasted text]` 停在输入框 = 未提交（#661）。
4. **重派/重试前先销毁旧卡**（`collectReviewerCardsForPr` 查 + `worktree-rm`），残留卡干扰新卡。
5. **worker-start 快**：stalled 是"送达失败"不是"等不够久"，别加长超时硬等——修送达（等就绪/走 agent 协议）。

## 原材料

各 CLI 的启动模板与选型坑唯一真源：`docs/model-routing.toml`（本目录只做教学提炼 + 本次实战新增，不复制会过期的值）。
