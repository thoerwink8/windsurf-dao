---
name: evolution-grep-after-refactor
description: "重大重构(删/改核心文件)后必须 grep 全项目同步引用,门面文档(README/MIGRATION)优先"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 54958f16-8057-4087-9e28-72c3efd87573
---

删除或重命名核心文件后，必须立即 grep 全项目同名引用，同步更新所有引用点。

**Why:** 多次重构中遗漏过时引用——废除 5 个文件后 6 个文件 25 处引用未清理，直到用户手动追查才发现。门面文档（README/MIGRATION）对外影响最大，优先修。

**How to apply:** `edit_or_delete <核心文件>` 后立即 `Grep <文件名>` 全项目。skill 精简 38→7 时用 smoke test 自动验证交叉引用零断裂，是更好的自动化方式。
