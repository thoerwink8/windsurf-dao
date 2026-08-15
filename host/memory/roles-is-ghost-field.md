---
name: roles-is-ghost-field
description: 模型条目的 roles 字段不参与选型门闩，真正拦人的只有 policy/bans.yml
metadata: 
  node_type: memory
  type: project
  originSessionId: 2168fe79-54c9-4d63-98dc-919a30ddef72
  modified: 2026-08-15T19:38:45.467Z
---

`policy/models.yml` 和 `docs/model-routing.toml` 里每个模型都有 `roles`（写码/判断/审查…），读起来像是限定了这个模型能接哪类活。**`scripts/lib/dianjiangtai-core.mjs` 里 grep 不到一次 `roles`**——它不参与门闩、不参与评分。真正决定谁能接哪类活的只有 `policy/bans.yml`。

**Why:** 2026-08-16 给 glm-5.3 写了 `roles: [写码, 判断]` 就以为限定住了，跑真实选型脚本一问，它把查证/审查/UI 的 A 位全抢了（新模型 → `quota_explore` 优先派）。这个字段长得就像会生效，先信它再被实测打脸。

**How to apply:**
- 要限定模型的适用工种，改 `policy/bans.yml`，不是改 `roles`。
- 加模型后**必须跑判别性实测**，不能只看测试绿：`node scripts/dianjiangtai-select.mjs --role <工种> --ts <ISO> --job-id <id>`，逐个工种看 `options.A.model` 是不是预期的人。见 [[green-tests-vs-goal-met]]。
- 修这个坑的单在 issue #521（接成真门闩 or 删掉）；在那之前 `bans.yml` 里的 `ban-glm-未验证工种` 是垫片。

相关：[[model-channel-is-not-identity]]
