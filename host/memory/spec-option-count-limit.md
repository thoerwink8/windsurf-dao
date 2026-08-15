---
name: spec-option-count-limit
description: Skill spec 里写动态选项列表时必须对照 AskUserQuestion 硬限(2-4)交叉校验，不能只顾 spec 逻辑自洽
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 0b0f04b3-d45a-4bf9-b878-2cd055cbc25f
---

写 skill spec 中的动态选项列表时，不能只从"逻辑上应该有几个选项"出发——必须交叉校验 AskUserQuestion 工具的硬限制（minItems: 2, maxItems: 4）。

**Why:** dao-design SKILL.md 模式 A 写了 5 个选项，后来又加 od-sync 导致 B/D 也超 5 个。spec 看着合理但执行时工具会拒绝。dao.md 续力节已经写了"2-4 个"但 spec 编写时没有交叉验证。规则存在≠被执行——缺的是 spec 编写时的校验动作。

**How to apply:** 
- 写 skill spec 含选项列表时，数一遍，超 4 个就砍。低频功能走参数触发（§P.1 意图识别），不塞首屏选项
- 「持而盈之，不如其已」——选项槽位是稀缺资源，高频操作优先，低频靠参数入口
- 相关：[[evolution-skill-value-formula]]（调度频率决定是否占位）
