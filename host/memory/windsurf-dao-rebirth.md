---
name: windsurf-dao-rebirth
description: 2026-08-14 整套旧规则体系已退役重构，旧 memory 里关于 dao 部署/规则/hooks 的条目大多已过时
metadata: 
  node_type: memory
  type: project
  originSessionId: 2f4044f6-a111-4d36-94b2-73d14fa45b0c
  modified: 2026-08-13T19:23:09.991Z
---

2026-08-14 用户拍板（windsurf-dao issue #425）：旧规则体系整体退役，官方机制承重。现状：

- 仓库只剩：一页 CLAUDE.md（宪法）、templates/（项目模板库）、docs/（classics 经文、decisions 冻结档案、global-CLAUDE.md 全局约定真相源）、scripts/dao-check.mjs（唯一自检）、ccswitch/ 仅存 grill-me skill + persona/styles/themes/statusline.js。
- 工作方式：任务=draft PR（body 即任务书）；派工走 Orca 原生（task-create/worker-start/决策门）；体系类改动 PR 必答三问 + 异族模型对抗审。
- 模型通道：DeepSeek 走 pi（写码 flash / 判断 pro）；GPT 走 Codex（pqgpt 中转只认 Codex 签名，pi/裸 HTTP 会 403）。
- 机器侧：~/.claude/CLAUDE.md 内容以 docs/global-CLAUDE.md 为真相源；dao hooks 注册已摘除（备份 settings.json.bak-rebirth）；dao 命令/skill 悬空链接已清，仅存 grill-me。
- **旧 memory 条目失效警告**：[[dao-claude-migration]]、[[codex-claude-shared-skills]]、[[ccswitch-env-gap]] 等描述的部署/同步机制已不存在，勿再依据。
- 派工两纪律（已入全局 CLAUDE.md）：派工后必验开工（正证据）；监督信号独立于作业信道。
