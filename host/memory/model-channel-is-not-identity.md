---
name: model-channel-is-not-identity
description: 同一模型的不同计费通道别拆成两个 model id，会把战绩记成两本账并触发探索期抢别人的活
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 2168fe79-54c9-4d63-98dc-919a30ddef72
  modified: 2026-08-15T19:39:00.992Z
---

同一个模型走不同计费通道（如 ds-flash 既能直连 DeepSeek 也能走 opencode Go 额度池）时，**模型条目只留一条，通道信息放 provider + cli_model**，不要用 `og-` 之类的前缀拆成两个 id。

**Why:** 2026-08-16 我先按前缀拆了，用户一句「没区别，算法记录要互通」推翻。拆开的实际代价有两层：① 战绩/返工率记成两本账，同一个模型的历史学不到一起；② 新 id 无历史样本会触发点将台的 `quota_explore`，实测直接抢下查证/审查/UI 三类活的 A 位——新模型拿真实任务当第一次实验。改回单一 id 后，`routes` 和 `bans` 里的引用一行都不用改，历史战绩天然继承。

**How to apply:**
- 判据一句话：模型能力变了才是新模型，只有计费/线路变了就是同一个模型换通道。
- 通道差异写在 `[providers.*]` 的 launch/launch_note 和条目的 `cli_model` 上。
- 运行时的通道降级（限流切另一条线）不能靠 `[[routes]].fallback` 表达——那个字段只在**选型时**主选被门闩剔除才生效，救不了跑到一半撞额度顶。真降级要在 pi 扩展层做，见 issue #520。

相关：[[pi-opencode-go-provider]]、[[roles-is-ghost-field]]
