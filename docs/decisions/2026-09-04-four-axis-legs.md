# 四轴腿表落地进度（族/供应商/执行侧/模型 → 腿；本会话直落，2026-09-04）

> 拍板与依据：ai-gateway-stack `docs/DECISIONS.md` §73（四轴模型 + 三条轴间约束 + reclaude 并存不兼容，全部实测）。
> 执行方式：用户 2026-09-04 拍板「直接在本会话全落地，直到能正常运转」——不走派单；
> 与本活相撞的在途 PR（#884/#885/#886/#887）让步（合并时它们变基到新 master）；
> 还需要的 issue 等本页全绿再继续。
> 本页是这条线的唯一进度真相源，做一步勾一步。接手人从上往下读即可。

## 目标形状（§73 拍板的三步，本轮落 ① 和 ③）

- ① 腿表 + 校验器：`docs/model-routing.json` 新增 `腿` 节（每腿 = 模型/族/供应商/执行侧 + 状态 + 拍板），
  合法组合校验 + 与职责树交叉核对（在役职责条目 ⇔ 在役腿），进 dao-check。
- ③ `dao.mjs leg` 动词：status / drop / restore。drop 按腿或按轴，先算影响面（哪个工种会全黑，全黑拒
  除非 --force），**同时把职责树里靠这条腿的条目打禁用**（现引擎只读职责树，不禁树条目 drop 就是空话）；
  restore 只解开「因这条腿而禁」的条目。
- ②（角色从模型列表改成引腿 id）**本轮不做**：等 #880 卡 B（executor-binding）合并后再动，
  否则跟 #884 的树对撞。在此之前腿表与职责树双源并存，交叉核对保一致。

## 步骤

- [x] 0. §73 写进 ai-gateway-stack DECISIONS 并提交（dd18f9f）
- [x] 1. 本进度页立骨架 + #880 挂指针
- [x] 2. `scripts/lib/legs.mjs`：纯函数（读腿表 / 四轴合法性 / 与职责树交叉核 / drop 影响面 / N+1 报告）
- [x] 3. `docs/model-routing.json` 加 `轴` 枚举 + `腿` 节（从现役职责树逐条迁出，人工核对；新腿
      `claude-opus-5@mirasim`、`claude-opus-5@reclaude/cc-local`、帅位两腿一并登记，未接线的标停用）
- [x] 4. `dao.mjs leg` 动词接线（status / drop / restore，drop 联动职责树禁用）
- [x] 5. dao-check 新检查对（样本红/绿/空 + live：合法性 + 交叉核；N+1 单轴裸奔以警告行报，不判红——
      现状全部腿 executor=orca、多数 supplier=gw，判红会立即全红且当下无腿可补）
- [x] 6. 测试（tests/legs.test.js + 夹具）+ 全套 node --test + dao-check 绿
- [x] 7. 提交 + land；本页勾完 + #880 进度表回写
- [x] 8. 试效果：`leg status` / `leg drop --dry-run`（按轴看影响面）/ 真 drop 一条再 restore

## 命名约定（先钉死，防两个「供应商」打架）

- **厂** = 模型背后的真实厂商（OpenAI/xAI/Anthropic…），判据在 `reviewer-vendor-gate.mjs` 的
  `vendorFamilyOf`（#843），审查换厂商用它——本轮不动。
- **供应商** = 出额度/凭据的（gw、pqgpt、reclaude、mirasim、windsurf…）——腿表新增的轴。
- **族** = CLI 协议族（claude/codex/pi/gemini/kimi/dsh）——决定完工证据形态。
- 职责树条目的 `provider` 字段是**网关落地 id**（launch 用），照旧；腿表用 `落地` 字段对齐它做交叉核。

## 轴间约束（全部实测，见 §73）

1. `执行侧=mirasim ∧ 族=claude ⇒ 供应商=mirasim`（accessMode 不让位）
2. `供应商=reclaude ⇒ 族=claude`
3. `执行侧=cc-local ⇒ 族=claude`
4. `供应商=mirasim ⇒ 执行侧=mirasim`（反代已被官方否，§71）
5. 一条请求路径只挂一个供应商（env 注入与代理+CA 互斥）

## 记录

- 2026-09-04 深夜：步骤 2–6、8 全过。实测记录：坏夹具/手改真表两次变异 dao-check 均翻红（检查有牙）；
  `leg drop --executor orca --dry-run` 七工种全黑、不带 --force 被拒；真拆 gemini 腿 → 树条目联动禁用
  （查证/UI 两处，禁用来源=leg:...）、引擎顺位实测跳过 gemini；restore 往返无残留。
  legs 测试 24 绿、dao.test 639 绿、dao-check 106 绿（3 红为本机存量，stash 对照验证）。
  纠了上一轮草稿两处：旧设计三节（腿默认/帅位/N+1豁免）删除并入显式腿表；sol 供应商 pqgpt→pqapi（#843 熔断 key 为证）。

- 2026-09-04 深夜（收口）：master 已推（feat ea35cce 变基后 + 测试可移植性修复），dao-check 110 项全绿——顺手清了本机三项存量红：worktree-rm 测试 Windows 盘符坑（修测试）、4 个 skill 缺发现面链（已建 SymbolicLink）、reviewer-fallback-luna 记忆缺闸（gate=scripts/lib/legs.mjs 的 N+1 单腿点名）。
- 2026-09-04 深夜：§73 提交（ai-gateway-stack dd18f9f）；本页建立。
