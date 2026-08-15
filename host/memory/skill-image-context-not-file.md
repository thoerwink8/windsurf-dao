---
name: skill-image-context-not-file
description: Skill 调用时用户传入的截图在会话上下文中直接可见，不是文件系统中的文件——禁止用 Read/Bash 从磁盘读取
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 2748e227-cb96-44e8-9926-192cb0f3d8de
---

Skill 调用时用户传入的截图（[Image #1]）是会话上下文的一部分，直接可见，不需要从文件系统读取。

**Why:** 在 dao-design-sync 首次试跑中，AI 被 skill 内大量 git/文件操作指令引导，试图用 Read/Bash/Glob 从磁盘找用户贴的截图，连续三次失败后放弃，退化为全量检测——用户的图片锚点完全浪费。根因是 skill 指令全是文件操作语境，AI 没意识到图片就在对话里。

**How to apply:** 写 skill 时，如果用户可能传入图片/截图，必须显式说明"图片在会话上下文中可见，不要从文件系统读取"。已在 dao-design-sync §0.2 加了此规则。未来新增涉及视觉输入的 skill 时同样要加。

关联：[[evolution-patch-vs-loop]] — 本次修复是补丁（加显式禁止），若反复出现应考虑在 dao.md 全局层加通用规则。
