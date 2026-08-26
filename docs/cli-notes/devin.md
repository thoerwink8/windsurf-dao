# CLI 踩坑教学：Devin（`devin` CLI，模型 deepseek-v4-flash-max）

> 每条都是实测踩出来的，不是推理。改代码/派工前先读本页 + `docs/model-routing.toml [providers.devin]`。

## 一句话特性

**2026-08-26 实测：非交互形态可用**（`devin -p --prompt-file`，任务书走文件送达，不依赖 TUI 粘贴）。devin CLI 已登录（Devin Pro）。dispatch 会报 `agent_prompt_stalled`（假 stalled，工人实际在跑），worker-done 起审官需补 `reviewer-attach --skip-wait`（#631 路径）。

## 本机三件套（2026-08-26 查实）

- **CLI**：`C:\Users\Administrator\AppData\Local\devin\cli\bin\devin.exe`（PATH 上这个）——**已登录**（`devin auth status` → Logged in (via Devin)，Devin Pro，credentials.toml 在 devin 用户配置目录）。
- **桌面端**：`D:\Windsurf\Devin.exe`（Windsurf 内置，v1.126.0，user-data-dir `%APPDATA%\Devin`）——已登录 Pro 账户，默认模型 GLM-5.2 Max。
- **Windsurf 集成**：Windsurf IDE 用 `devin acp`（ACP 协议 stdio server）驱动 Devin——那是 IDE 自己的集成，Orca 的 agent schema 里没有 devin/ACP。

## 正确起法（2026-08-26 #771 全链实测拍板）

```
devin -p --prompt-file <任务书文件> --model deepseek-v4-flash-max --permission-mode dangerous --respect-workspace-trust false
```

- **任务书走 `--prompt-file`**：派单时把任务书写成 `_prompt.txt` 放进工人卡，devin 启动即读文件，不依赖 TUI 粘贴。
- **`-p`（非交互）**：devin 干完活进程退出，完工=git 产出 + PR。
- **模型**：`--model deepseek-v4-flash-max` 显式指定（路由意图生效，实测工人按此模型干活）。
- **实测全链**：派单 → 开工（读任务书、设 bot 身份、推分支）→ 写码 → 开 PR → 完工 comment → 补审官 → 审官判绿合并，全通。

## 踩过的坑

### 坑 1：agent 型 `worker-start --agent devin` 任务书不提交（假阳性）

- **现象**：Orca 起 Devin TUI + stdin 粘任务书，**不提交**——任务书停在输入框（`[Pasted text #N +M lines]`），worker-start 返回 ok:true 是**假阳性**。
- **正解**：不走 agent 型，走 command 型 `devin -p --prompt-file`（任务书文件送达）。
- **识别**：屏面见 `[Pasted text #N +M lines]` = 粘贴没提交，不是开工证据。

### 坑 2：dispatch 报 `agent_prompt_stalled` 是假 stalled（工人实际在跑）

- **现象**（2026-08-26 实测）：devin 非交互形态的 dispatch 会被 Orca 判 `failed`（`agent_prompt_stalled`），但工人实际在跑（屏面有输出、git 有产出）。worker-done 起审官时按「已结算」找不到活的士兵 dispatch。
- **正解**：`isLiveDispatchRecipient` 对 `last_failure=agent_prompt_stalled` 的 failed 放宽为活（2026-08-26 直改）；`findDispatchForWorktree` 对 failed + `terminalState=retained` 保留为候选。worker-done 起审官失败时走 `reviewer-attach --skip-wait` 补审官（#631 设计）。
- **识别**：worker-read 屏面有输出但 dispatch 状态 failed = 假 stalled，不是工人死了。

### 坑 3：`--agent codex` 的任务书 `[Pasted Content]` 停在输入框（审官通道）

- **现象**（2026-08-26 实测）：`worker-start --agent codex` 的任务书显示 `[Pasted Content N chars]` 停在输入框（codex 不自动 enter），120s 后 `agent_prompt_stalled`。
- **正解**：worker-start 返回 stalled 且 provider 是 gpt（codex）时，补一记回车提交（2026-08-26 直改 startOrcaWorker）。devin 不补（任务书已由 --prompt-file 送达，补回车会误触发）。
- **识别**：屏面见 `[Pasted Content N chars]` = 粘贴没提交，补回车后任务书全文显示、codex 开始干活。

## 教训

- 上一版结论「派工通道不可用」只验证了 TUI 起不来/不提交，没试 **CLI 非交互形态**（`-p --prompt-file`）。CLI 登录后（Devin Pro）非交互形态全链可用。
- worker-start 返回 ok:true ≠ 开工。开工只认：任务书指纹消失 + 官方 transcript（source≠terminal）/ token 增长 / git 产出。
- 不许在 Devin TUI 里手补回车提交任务书（2026-08-26 拍板：派单直接拍到 Orca，不在 Devin Desktop 手派）。codex 的补回车是注入修复，不是手派。

## 相关

- 启动模板唯一真源：`docs/model-routing.toml [providers.devin]`（start=command，launch 用 `-p --prompt-file`）
- 选型：`docs/model-routing.json` 写码模型 devin-deepseek-v4-flash-max（#771 实测后恢复可用）
- 派工链路修复：#762；#771 全链实测拍板非交互形态
