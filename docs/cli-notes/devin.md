# CLI 踩坑教学：Devin（`devin` CLI，模型 deepseek-v4-flash-max）

> 每条都是实测踩出来的，不是推理。改代码/派工前先读本页 + `docs/model-routing.toml [providers.devin]`。

## 一句话特性

**2026-08-26 实测：交互 TUI 形态可用**（`worker-start --agent devin` + startOrcaWorker 补粘任务书 + 回车）。devin CLI 已登录（Devin Pro）。Orca 的 stdin 注入对 devin **不送达**（任务书没进输入框），dispatch 报 `agent_prompt_stalled` 是假 stalled（工人实际在跑）；worker-done 起审官需补 `reviewer-attach --skip-wait`（#631 路径）。

## 本机三件套（2026-08-26 查实）

- **CLI**：`%LOCALAPPDATA%\devin\cli\bin\devin.exe`（PATH 上这个；用户名因机而异，别写死）——**已登录**（`devin auth status` → Logged in (via Devin)，Devin Pro，credentials.toml 在 devin 用户配置目录）。
- **桌面端**：`D:\Windsurf\Devin.exe`（Windsurf 内置，v1.126.0，user-data-dir `%APPDATA%\Devin`）——已登录 Pro 账户，默认模型 GLM-5.2 Max。
- **Windsurf 集成**：Windsurf IDE 用 `devin acp`（ACP 协议 stdio server）驱动 Devin——那是 IDE 自己的集成，Orca 的 agent schema 里没有 devin/ACP。

## 正确起法（2026-08-26 交互形态拍板）

```
worker-start --agent devin（launch 模板 = devin --permission-mode dangerous --respect-workspace-trust false，agent 型拒收 --model）
- **无头 Linux**：`--agent devin` 可能落成裸 bash（#802 与 pi 同晚现场）。dispatch 读屏见裸 shell 就回退送 launch 命令，不要改 toml `start=command`（Windows 上 command+`--terminal` 会 `agent_unconfigured`）。
```

- **交互 TUI**：Orca 起 Devin CLI TUI（v3000.5.20，bypass permissions on），工人可交互式干活、实时看屏。
- **注入不送达**：Orca 的 stdin 注入对 devin 无效（任务书没进输入框，屏面停在 Ask Devin to build...）——`startOrcaWorker` 对 devin 补粘任务书 + 回车提交（2026-08-26 实测：`terminal send` 文本 + 回车 = 提交成功，devin 响应开工）。
- **模型**：agent 型拒收 `--model`（`invalid_argument`，2026-08-26 复测确认）→ 模型 = Devin 账户默认（路由意图在 agent 型上失效，选型只锁厂商）。
- **完工契约**：devin 不认 Orca worker 协议，dispatch 的 failed 状态不影响干活；完工 = git 产出 + PR + comment。
- **备用通道**：非交互形态（`-p --prompt-file`，可指定 `--model deepseek-v4-flash-max`）2026-08-26 凌晨全链验证过（PR #776 MERGED），需要指定模型时切回它。

## 踩过的坑

### 坑 1：agent 型 `worker-start --agent devin` 注入不送达（假 stalled）

- **现象**（2026-08-26 复测）：Orca 起 Devin TUI，但任务书**根本没进输入框**（屏面停在 Ask Devin to build...，无 `[Pasted text]`），worker-start 返回 `agent_prompt_stalled`。昨晚记录过 `[Pasted text #N +M lines]` 停在输入框（注入时机差异），同样不提交。
- **正解**：`startOrcaWorker` 对 devin 补粘任务书（`terminal send --text <任务书>`）+ 回车提交（2026-08-26 直改，与 codex 的补回车并列）。补回车单独无效（输入框无内容），必须补粘 + 回车两步。
- **识别**：屏面停在 Ask Devin to build... = 注入没送达；手动 send 文本后回车 = 提交成功（devin 响应）。

### 坑 2：dispatch 报 `agent_prompt_stalled` 是假 stalled（工人实际在跑）

- **现象**（2026-08-26 实测）：devin 的 dispatch 会被 Orca 判 `failed`（`agent_prompt_stalled`），但工人实际在跑（屏面有输出、git 有产出）。worker-done 起审官时按「已结算」找不到活的士兵 dispatch。
- **正解**：`isLiveDispatchRecipient` 对 `last_failure=agent_prompt_stalled` 的 failed 放宽为活（2026-08-26 直改）；`findDispatchForWorktree` 对 failed + `terminalState=retained` 保留为候选。worker-done 起审官失败时走 `reviewer-attach --skip-wait` 补审官（#631 设计）。
- **识别**：worker-read 屏面有输出但 dispatch 状态 failed = 假 stalled，不是工人死了。

### 坑 3：`--agent codex` 的任务书 `[Pasted Content]` 停在输入框（审官通道）

- **现象**（2026-08-26 实测）：`worker-start --agent codex` 的任务书显示 `[Pasted Content N chars]` 停在输入框（codex 不自动 enter），120s 后 `agent_prompt_stalled`。
- **正解**：worker-start 返回 stalled 且 provider 是 gpt（codex）时，补一记回车提交（2026-08-26 直改 startOrcaWorker）。devin 不补回车（注入没送达，补了也无效，要补粘+回车）。
- **识别**：屏面见 `[Pasted Content N chars]` = 粘贴没提交，补回车后任务书全文显示、codex 开始干活。

### 坑 4：launch 没带权限旗标 → 工人每跑外部命令弹窗，帅被绑在终端前（#782）

- **现象**：launch 裸 `devin` 时，Devin TUI 对每个外部工具调用（gh/git/python 等）弹权限确认窗，帅得逐个手动放行——工人无法无人值守。
- **正解**：`docs/model-routing.toml [providers.devin].launch` 带 `--permission-mode dangerous --respect-workspace-trust false`（#782 拍板）：前者自动批准所有工具（与 codex `--dangerously-bypass-approvals-and-sandbox` 对齐），后者跳过工作区信任弹窗。
- **识别**：TUI 起来后不再弹权限窗 = 旗标生效；仍弹 = launch 没带上，或被桌面覆盖吞掉（看 `droppedFlags`/`desktopFlagDiffs` 提示）。

## 教训

- 上一版结论「派工通道不可用」只验证了 TUI 起不来/不提交，没试 **补粘 + 回车**。CLI 登录后（Devin Pro）交互 TUI 形态实测可用。
- worker-start 返回 ok:true ≠ 开工。开工只认：任务书指纹消失 + 官方 transcript（source≠terminal）/ token 增长 / git 产出。
- 不许在 Devin TUI 里手补回车提交任务书（2026-08-26 拍板：派单直接拍到 Orca，不在 Devin Desktop 手派）。startOrcaWorker 的补粘+回车是注入修复，不是手派。

## 相关

- 启动模板唯一真源：`docs/model-routing.toml [providers.devin]`（start=agent，launch 带 dangerous+trust 旗标，#782）
- 选型：`docs/model-routing.json` 写码模型 devin-deepseek-v4-flash-max（#771 实测后恢复可用）
- 派工链路修复：#762；#771 全链实测拍板交互形态
