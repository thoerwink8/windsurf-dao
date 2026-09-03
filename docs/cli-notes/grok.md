# CLI 踩坑教学：Grok（`grok` CLI，模型 grok-4.6，写码首选 / 查证主选）

> 提炼自 `docs/model-routing.toml [providers.grok]`。

## 一句话特性

agent 型（`start = "agent"`），经 regrok shim（~/.local/bin，内置 HTTPS_PROXY + 默认 `-m grok-4.6`）。Grok Build auto 模式会硬拦 git push（对外发布闸），**授权词 = 往终端回一句「推」**。

## 坑

- **push 硬拦**：Grok Build auto 模式硬拦 `git push`。假拦（网络抖动）重试即过；真拦（宿主策略）需授权词「推」。
- **`--permission-mode auto` ≠ 免确认框**：每执行一次外部命令弹一次 3 选 1，要帅手工放行。`--always-approve` 才是真 auto（launch 模板已带）。
- **TUI 把 terminal send 当用户消息**：8s 探针等不到真执行标记（#499/#502 实测），`probe_wait_ms = 45000`。

## 正确起法

`grok -m grok-4.6 --effort xhigh --always-approve`（launch 模板），agent 型走 `worker-start --agent grok`。
