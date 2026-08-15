---
name: claude-workers-use-opus
description: Claude 族派工（工人/审官）一律 reclaude --model opus；Fable 只留帅位，派工用 Fable 须用户点名
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 6d32fb06-c548-4268-83cc-fc1c15654662
  modified: 2026-08-14T15:50:49.023Z
---

2026-08-14 用户拍板：Fable 额度珍贵，task（派出去的工人/审官）用 Opus 即可，以后不要派 Fable。帅位本会话保留 Fable（判断密度最高处只此一个）。在途特批：当时的 #449 审官（Fable 已审过半）跑完该单再切。

**Why:** Fable 配额有限且按倍消耗；工人/审官的活不吃满 Fable 智力上限，且有换厂商对抗审兜底（Opus 同为 Anthropic，换厂商属性不变）。

**How to apply:** 派 Claude 族终端启动命令一律 `reclaude --model opus`（经 reclaude 链路的规矩不变，见 [[pi-universal-harness]]）。落地闸：dispatch skill 启动序写死；#442 看门狗加「工人状态栏出现 Fable 即报警」。
