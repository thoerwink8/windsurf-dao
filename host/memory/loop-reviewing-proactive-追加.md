---
name: loop-reviewing-proactive
description: "Loop §7.2.5 reviewing 讨论中浮现新想法时,AI 必须主动提醒是否追加为当前 Task,不默默归类为\"未来话题\""
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 9c374d22-cc08-46f5-b7e1-7d15c7942f3b
---

Loop reviewing 阶段讨论中浮现新改进想法时，AI 必须主动评估规模并提醒用户是否追加。

**Why:** dao-ecosystem-cleanup Loop 中，memory+A+C 改造在 reviewing 讨论中浮现，AI 默默归类为"未来 Loop 话题"，用户确认归档后才发现没做。应该在讨论中就主动提醒。

**How to apply:** reviewing 对话中一旦识别到可执行的改进想法，立即估算规模（文件数/复杂度），提醒用户："这个改动约 N 个文件，要追加为 T<X> 当场做，还是记入 HANDOFF？" 已写入 [[dao-loop]] SKILL.md §7.2.5 主动追加提醒规则。
