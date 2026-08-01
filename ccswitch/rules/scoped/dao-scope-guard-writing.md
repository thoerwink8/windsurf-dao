---
paths:
  - "**/check-*.ps1"
  - "**/verify-*.ps1"
  - "**/scripts/check-*.mjs"
  - "**/scripts/check-*.js"
  - "**/eslint.config.*"
  - "**/.eslintrc*"
---

# 你正在碰守卫 / 检查器 / 阈值护栏

改动或新建这类文件之前，先 Read 全文：

`D:/frank/windsurf-dao/ccswitch/rules/dao-guard-writing.md`

那里是四条判据的正文（建护栏前先摸全域分布 / 自检那一半不许复用被守对象的解析逻辑 /
检查器的输出不能落在自己的扫描面内 / 规则集只增不减须专门给退役造触发器），
本文件**只是触发器，不复制正文**——副本会漂移，而这条规则的形态还在演进。
