# CLI 踩坑教学：Claude（`reclaude` CLI，模型 opus）

> 提炼自 `docs/model-routing.toml [providers.claude]`。

## 一句话特性

command 型（`start = "command"`）。凭据挂在 reclaude 链上，**裸 claude 会 login rejected**。启动有一段配置同步期，**抢跑注入必被吞**。

## 坑

- **`--agent` 起不了 reclaude 链**（已知 agent 枚举会漂）——Claude 族终端必须 `orca terminal create --command` 读 launch。
- **启动有配置同步期**：抢跑注入必被吞。要等 TUI 就绪（同 devin 的 `wait --for tui-idle` 教训，见 README 通用教训 2）。
- **Fable 只留帅位**：派工须用户点名（拍板 2026-08-14，issue #443）。

## 正确起法

`reclaude --model opus`（launch 模板），command 型走 `terminal create --command` + `wait tui-idle` + `worker-start --terminal`。
