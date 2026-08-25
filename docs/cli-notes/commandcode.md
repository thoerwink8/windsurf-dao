# CLI 踩坑教学：Command Code（`cmdc`，非交互查证/测速专用）

> 提炼自 `docs/model-routing.toml [providers.commandcode]`。

## 一句话特性

command 型，**只做非交互查证/测速**（2026-08-16 裁定：不能承载需进 git 的 Orca 工人，`worker-start --terminal` 必返 `agent_unconfigured`）。

## 坑

- **可执行文件是 `cmdc`**，不是 `cmd`（撞 Windows cmd.exe）。
- **登录必须真 TTY**（Ink raw mode），无 TTY 报 "Raw mode is not supported"；只能用户跑 `command-code login`。
- **自动化一律 `--skip-onboarding`**，否则撞 onboarding 静默挂住。
- **命令发出后需补一记空回车才执行**；约 20 秒 TUI 就绪（`probe_wait_ms = 45000`）。
- **GOAT 档（$10/月）只有开源模型**：claude-opus-5 / claude-sonnet-5 / gpt-5.6-sol 一律 `MODEL_NOT_IN_PLAN`。Gemini 全系本机不可用（403 region）。
- **pi 接不上 commandcode**：provider 是代码注册的，写 models-store.json 会被静默忽略。插件方案已拍板不采用。

## 非交互契约

`command-code -p "问" --max-turns N --skip-onboarding` → 纯文本、exit 0；`--output-format json` → NDJSON 事件流 + 末尾 result 行。
