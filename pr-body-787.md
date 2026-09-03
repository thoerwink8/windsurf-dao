## 目标

#787 测试派单：走通工人闭环（撑分支 → draft PR → 验收核对 → dao-check → ready → worker-done）。实现面 `dao-commit` 已由 PR #789 合入 master；「每次 commit 维护版本号」半边已被发布列车 #800 取代（帅 2026-09-02 评论）。本单不重做已合代码，只核验收口、修掉挡交卷的仓外路径闸，并留下可审的 PR。署名 issue #787，关单交给 `scripts/close-issues.mjs`。

## 验收标准

- [x] `host/skills/dao-commit/` 在仓：`SKILL.md` 动作序列 + 纯函数 `bump.mjs`（无 IO、无仓内 import）
- [x] `bump.mjs` 单测全绿：`node --test tests/dao-commit-bump.test.js tests/version-carrier-check.test.js` → 156 pass / 0 fail
- [x] dao-commit skill 可独立使用：`node host/skills/dao-commit/bump.mjs 1.2.3 feat` → `{"shouldBump":true,"bumpType":"minor","from":"1.2.3","to":"1.3.0"}`；fix→1.2.4、breaking→2.0.0、docs 不 bump、feat+breaking 取 major、`01.2.3` 非法 semver exit 1。文件内无 `import` / `fs` / `scripts/`
- [x] `scripts/dao-check.mjs` ㉗ 版本号载体闸在：只拦乱 bump（非法/倒退），不判该不该 bump；dao-check 行「版本号载体闸样本红/绿/空各 1/1/1」
- [x] 故意违规样本当场拦下：`tests/fixtures/version-carrier/red/` 基线 `1.2.3` → 当前 `1.2.2`；`inspectVersionCarrierFixtures` kinds `{red:1,ok:1,empty:1}`
- [x] `CLAUDE.md` L9 有 dao-commit 按需指针，不常驻注入
- [x] 提交标题带宿主前缀（本跳 `[pi]`；原实现 #789 为 `[grok]`）
- [x] `node scripts/dao-check.mjs` 在工人树 head `76f93a5` 复跑：退出码 0，末行形态 `dao check: 好的（104 项，7 项跳过，…s）`（本轮实测 53.7s；时长每次会变，不��它当哈希）。`dao-mode.test.js` 97/0、`redact.test.js` 47/0。审官树同基线复跑同样退出码 0 / 104 绿 7 跳过。CI check 绿（run 33803575961，对应上一 SHA `a914026`）。审官当时在 `a914026` 上看到 `不好（2 项红 / 102 项绿 / 7 项跳过）`（`dao-mode` 8 红 + `redact` 1 红）；这两套用仓内 `_tmp/` 沙箱，dao-check 池宽 6 并行，偶发踩踏可解释当时红、现在绿。不以当时瞬时红冒充当前结果。

## 进展

- [x] 开工五步 1：空提交撑分支（`9bb5e6e` `[pi] chore: 起#787测试派单分支`，作者 `dao-worker[bot]`）
- [x] 开工五步 2：draft PR #863
- [x] 开工五步 3：卡切 `in-progress`
- [x] 开工五步 4：PR 打 `model/grok-4.6` + `type/写码`
- [x] 核对 #787 六条落地清单与三条验收（证据见上）
- [x] 顺手修挡交卷的既有红：`CHANGELOG.md` 历史路径 `~/.codex/skills` 未进 INDEX/ignore（master 同样红）。补 `host/machine/ignore.md` 一条 why，闸齐 50/39/12。这不是 #787 方向性改动，是 dao-check 交卷门。
- [x] dao-check 绿 → `gh pr ready` → 卡切 `in-review` → `worker-done`
- [x] 返工：审官红 1（验收写退出码 0，当时审官复跑为 2 红）。已在工人树 + 审官树同 SHA 复跑，当前均为退出码 0；CI 亦绿。PR 正文改为贴真实末行，并写明审官当时瞬时红与并行沙箱的关系，不以当时红冒充现在绿。

### 体系类改动三问（grill-me 拍板浓缩；本跳无新机制）

1. 谁提的 / 什么场景：AI 在任意项目提交时要遵守 commit 语义并维护版本号；跨项目、不绑 windsurf-dao。
2. 删哪一层能让问题不存在：删「提交阶段 bump」——#800 发布列车已删这层，版本号改由发布动作按 PR 标题汇总。
3. 从零重做今天还造吗：skill + 纯函数 `bump.mjs` 还造（发布列车复用）；提交时自动改版本号不造。

本跳不新增机制，只核已落地产物、修交卷门、走闭环。
