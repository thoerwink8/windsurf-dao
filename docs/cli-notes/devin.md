# CLI 踩坑教学：Devin（`devin` CLI，模型 deepseek-v4-flash-max）

> 每条都是实测踩出来的，不是推理。改代码/派工前先读本页 + `docs/model-routing.toml [providers.devin]`。

## 一句话特性

Devin CLI 是 **command 型** TUI（`start = "command"`）：`terminal create --command` 起，TUI 就绪很慢（加载 MCP/skills），**没就绪就送任务书必丢**。

## 正确起法（#753 拍板，2026-08-25 实战验证）

```
terminal create --command "devin --model deepseek-v4-flash-max --permission-mode dangerous --respect-workspace-trust false"
terminal wait --for tui-idle          # 等就绪问句出现，就绪即返回（不是固定睡满）
worker-start --terminal <handle>      # 就绪后再送任务书
```

## 踩过的坑（按时间顺序）

### 坑 1：detached 执行体自开 Run → worker-start 必 `consumer_fenced`（#762 根因）

- **现象**：`worker-start` 报 `consumer_fenced: worker-start requires the coordinator terminal currently bound to the Task Run`。
- **原因**：async-launch 派工执行体是 detached 进程，`run-create` 自开 Run 没有 coordinator 终端。orca 硬性要求 worker-start 的 Task Run 绑定一个活终端。
- **正解**：照 #682 微通道——在工人卡上起「派工协调（勿关）」哑终端，`run-create --from 哑终端`，worker-start 用这个 Run + `--from 哑终端`。
- **验证**：2026-08-25 实战假测验，派工全链跑通，工人真实开工。

### 坑 2：没等 TUI 就绪就 worker-start → `agent_prompt_stalled`

- **现象**：worker-start 9 秒返回 `agent_prompt_stalled`（dispatch 标 failed，capability 吊销），屏面停在 Devin 启动画面，任务书没到。
- **原因**：Devin TUI 冷启动慢（MCP/skills 加载），worker-start 的 dispatch_input 落在启动窗口，devin 没接受。
- **正解**：worker-start **之前** `terminal wait --for tui-idle`——**就绪即返回**（实测已就绪终端 wait 立即 `satisfied: true`），不是等满超时。就绪后再送字必成功。
- **反例**：把 wait 做成"等 2 分钟超时"是错的（用户两次点破：worker-start 快，不是等的问题）——wait 的 timeoutMs 只是上限兜底，正常路径就绪即放行。

### 坑 3：任务书注入后屏面稳定 ≠ 开工（#661/#679/#762 升级）

- **现象**：worker-start 返回成功、dispatchId 存在，但 devin 停在 "Ask Devin to build..."，工人卡无 git 提交——**任务书没进 devin**。
- **原因**：屏面"3 轮稳定"判绿是伪证据（PS 提示符也稳定）。proofUnavailable（session_not_reported）降级判绿前必须见任务书指纹。
- **正解**：开工验证带 `expect`（任务书指纹），屏面出现任务书内容才算注入成功；没出现 → fail-close，不许报 ok=true。

### 坑 4：重派/重试前不销毁旧卡

- **现象**：多次 attach 失败重试，旧审官卡/终端残留，干扰新卡（误读旧 handle）。
- **正解**：重派前先 `worktree-rm` 销毁该 PR 已有审官卡（`collectReviewerCardsForPr` 查 + 删），查不成不许当 0 张。

## 判活

- 开工证明：worker-read 官方 transcript（source≠terminal）→ 真证明；source=terminal → 降级屏面 + **必须见任务书指纹**。
- 完工：worker-done 发 issue comment 首行「完工」+ 开 PR；PR 存在是裁决器。

## 相关

- 启动模板唯一真源：`docs/model-routing.toml [providers.devin]`
- 派工链路修复：#762
- 微通道哑终端方案：#682
