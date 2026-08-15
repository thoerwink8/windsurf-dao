---
name: loop-go-gate-lesson
description: dao-loop 造线入口必须先切分支再动手——Go Gate 门控机制的来历和根因
metadata: 
  node_type: memory
  type: feedback
  originSessionId: c6195f04-b57a-4ec2-9cd7-40cb3778585b
---

造线入口必须走 Go Gate：切分支 → 写 dispatch.branch → 基线验证 → 才写 mode:executing。

**Why:** skill-slim loop 实战中，AI 更新了 STATUS.json 的 mode 但没有实际创建 feat/ 分支，直接在 master 上做了文件修改。根因是"环境准备"只是管线图里的一个文字标签，缺少可验证的 checklist，状态元数据转换与实际操作之间无绑定。

**How to apply:** dao-loop SKILL.md §5 已加入 Go Gate 四步门控。每次进入造线时，先检查当前分支是否 = dispatch.branch，不等就先切。session 恢复时也必验分支。相关改动：[[dao-claude-migration]]
