---
name: static-gate-needs-runtime
description: "静态文本门控拦不住运行时失效(如脚本顺序错致config静默失效),门控体系须含渲染验证层"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 563132b5-c49d-4fa7-bfe2-526845482420
---

门控体系不能只有静态文本检查——模板写对≠渲染正确。已加 protocol-od.md 关六「渲染自检」堵此类漏洞。

**Why:** protocol-od.md 层 2 示意 tailwind.config 在 CDN 前，OD 照做 → ReferenceError → 自定义 config 静默失效，5 道文本门控全过但页面渲染破损。真相源模板 bug 经 symlink 传播到所有下游项目。

**How to apply:** 写规则/模板中的代码示例时，确认可执行正确（顺序/语法/依赖），不仅形式正确。设计门控时问"这套检查能拦住运行时失效吗"——不能则加运行时验证层。参见 [[evolution-patch-vs-loop]]。
