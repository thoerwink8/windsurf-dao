---
name: dispatch
description: 派工手册：协调者要把活派给 Orca 工人终端、起新工人、续活或判断「派不派/走哪条通道」时读。含启动序四步、开工判据、判断工人是否完成的四个信号、Orca 完整命令链、命名规矩与通道判据。
---

# 派工手册

## 启动序（四步）

1. 注入前先证终端就绪：终端活着、能收输入。
2. 注入任务书。
3. 注入后回读，确认任务书完整显示在屏上，不是被吞。
4. 补一记回车（manual 态先切 auto 再回车）。

## 开工判据

token 计数在增长才算开工——启动返回成功不等于已开工。

## 判断工人是否完成的四个信号

1. 产物出现（该出现的文件/输出出现）。
2. 屏上失败信号：选不会命中正常提示的短错误码——正例 `econnect`（真断线），反例 `Reconnecting`（正常的重连提示，会误报成失败）。
3. 去掉数字后的终端文字连续静止（数字总在变，先剔掉再比静止）。
4. 兜底超时。

## 一条完整命令链

任务书先写进文件，再逐条跑（PowerShell 下读文件用 `Get-Content -Raw` 而不是 `cat`）：

```bash
# 1) 建任务：spec 从文件读，避免 shell 改写文本
orca orchestration task-create --spec "$(cat 任务书.md)" --json

# 2) 起工人：task 用上一步 JSON 里的 id；worktree 与 agent 按现场选
orca orchestration worker-start --task <task_id> --worktree <选择器> --agent <agent> --json

# 3) 取 dispatch id：从 JSON 里取，不解析人读文本
orca orchestration dispatch-show --task <task_id> --json

# 4) 验开工：读回输出，token 计数在涨才算开工
orca orchestration worker-read --dispatch <dispatch_id> --json
```

## 三条命令级铁律

- 多行或含反引号文本先落文件，再 `--spec "$(cat 文件)"`——禁双引号裸拼（反引号裸拼吞字符 2 例）。
- 命令只信 `--json` 出口：例：`orca orchestration dispatch-show --task <task_id> --json`——字段一律从 JSON 取，不解析人读文本。
- 路径从 PR 反查，禁手抄：例：`gh pr view <PR号> --json headRefName -q .headRefName`——分支名从 PR 的 JSON 取，不手抄。

## 命名规矩

终端 / 工作副本名字：角色·模型（如「审官·GPT」）；副本名带 PR 号。

## 通道判据（同全局约定）

产出要进 git（commit/PR）⇒ 必走 Orca 编排；只读不落盘的查证类 ⇒ 会话内子代理。
