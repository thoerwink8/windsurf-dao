---
name: dao-claude-migration
description: "【已证伪 2026-08-15】dao.ps1 已随 #425 退役不存在；现行部署=逐个 SymbolicLink 直连仓内 host/skills/"
metadata: 
  node_type: memory
  type: reference
  originSessionId: 8deda73d-55b1-4bdc-bef0-b3826dad855f
  modified: 2026-08-15T07:27:47.217Z
---

2026-08-15 实证更正：dao.ps1、link-claude、status 自愈等旧部署机制已随 #425 规则体系退役**全部不存在**（全盘搜索无 dao.ps1）。现行机制：`~/.claude/skills/<name>` 逐个 SymbolicLink 指向 `D:\frank\windsurf-dao\host\skills\<name>`，无自愈检查（断链暴露面存在，处置见 memory 入仓单的五步法核验）。memory 部署同构：目录 Junction 指向仓内 `host/memory/`（部署命令见 NEW-MACHINE.md）。旧条目提及 dao.ps1 行号的记述一律视为历史，勿引用。
