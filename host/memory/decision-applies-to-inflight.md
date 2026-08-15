---
name: decision-applies-to-inflight
description: 用户拍板换工具/换通道默认立即含在途活；协调者不得自行解释为「下一单起」
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 6d32fb06-c548-4268-83cc-fc1c15654662
  modified: 2026-08-14T14:30:42.546Z
---

2026-08-14 用户拍板「grok 单统一改走 Grok Build」，协调者自作主张让在跑的 pi-grok 臂继续跑完，被用户当场纠正（「帅令既下就该当场换灶」）。

**Why:** 「拍板生效边界」若无死默认，协调者每次都有解释空间，同类偏差会反复发生。五步法「删除」层的解法是删掉解释空间本身。

**How to apply:** 用户拍板换 X（工具/通道/模型/流程），默认立即对所有在途活生效——正在跑的也当场切换；只有用户明说「跑完这单再切」才保留在途。相关：[[pi-universal-harness]]、windsurf-dao issue #443。
