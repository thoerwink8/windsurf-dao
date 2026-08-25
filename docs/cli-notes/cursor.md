# CLI 踩坑教学：Cursor（`cursor-agent` CLI，模型 composer-2.5 / kimi / gemini / glm，UI 主选）

> 提炼自 `docs/model-routing.toml [providers.cursor]`。

## 一句话特性

agent 型（`start = "agent"`）。`[Pasted text #N]` 是**提交后显示残留**（实测 Working 后残留不消失），开工探针在 cursor 通道**忽略它**，改认 Working / 输出在动（#680）。

## 坑

- **`--force` 只管放行命令，不管 Workspace Trust**：新 worktree 弹 Trust 让 Orca 报 agent_unconfigured（#649）。launch 模板已带 `--trust`。
- **`[Pasted text]` 是残留不是未提交**：与 Codex 的 `[Pasted Content]`（真未提交）相反。cursor 通道判开工看状态行（行首 Running:/Reading:/Thinking:/Working:），不看粘贴块（#651 审红 2）。
- **Windows shim 禁止 `for /f in ('dir')` / `findstr`**（#633：会弹可见 cmd）。
- **CLI 不支持命令行传 prompt**（`--single-use` 是 worker pool 别名），任务靠 Orca 注入；注入收不到（只贴不发）就诚实失败回滚。

## 正确起法

`cursor-agent --model {model} --force --trust`（launch 模板），agent 型走 `worker-start --agent cursor`。
