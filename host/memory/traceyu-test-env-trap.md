---
name: traceyu-test-env-trap
description: "TraceyU 全量 vitest 因环境配置有大量 pre-existing 失败,验收 pencil 任务只看四关"
metadata: 
  node_type: memory
  type: project
  originSessionId: a916aaa1-2bbf-4eee-a52c-52230548bb89
---

TraceyU(`D:/frank/TraceyU`)里直接跑 `pnpm --filter desktop exec vitest run`(全量)会有 ~30 个失败,报 `ReferenceError: document is not defined` —— React hook/e2e 测试需要 jsdom 环境但裸跑用了 node 环境。**这是 pre-existing 的测试环境配置问题,与设计稿改动无关**(在任何 commit 基线上都一样失败)。

**Why:** 验收 `/dao-pencil`(设计稿↔代码对齐)任务时,若被全量测试的红误导,会去修不属于本任务范畴的测试环境配置,违反反扩散边界。

**How to apply:** pencil/设计稿类任务的验收锚点是 `docs/design/pencil-review-process.md` 定义的四关:① JSON 合法 ② `vitest run src/design-contract.spec.ts`(只这一个文件,28 tests)③ `pnpm design:verify` ④ 防回归 grep(`$radius` 残留 / Governance·SpecLock / toContain 规则文字 全为 0)。这四关绿即达标,不跑全量。设计契约测试 `design-contract.spec.ts` 不需要 document 所以单独跑能过。相关 [[dao-claude-migration]]。
