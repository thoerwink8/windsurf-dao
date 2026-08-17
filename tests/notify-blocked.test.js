// tests/notify-blocked.tests.js —— 前置解除提醒逻辑回归网（issue #526）
//
// 覆盖：
//   ① 写法收敛：只认 `Blocked-by: #N` 一种；「前置」「等 #N」等其他写法不算；
//      词边界防 #497 误吞 #4970；大小写/全角冒号都不算。
//   ② 评论措辞：必须含「请先确认这单还成不成立」，不得出现「可以开工了」。
//   ③ #532 口径（本单第一个用上）：搜索失败（gh 起不来）≠ 搜到 0 条——
//      失败返回 ok:false/reason:search_failed 并写报错，0 条是 ok:true 的成功结果。
//   ④ 等待者按编号排序、评论体逐张生成。
//
// 不依赖真实 GitHub：搜索/评论的 gh 调用用假 gh（node shim 发 JSON）注入；
// #544：等待者可能同时是 issue 与 PR（gh issue list / gh pr list 各查一面，合并去重），
// 任一面的失败都走 search_failed 报红，不得退化成「0 条」。
// #554 审官返工：默认回归测试全部用固定 fixture，不再直查线上 GitHub——
// 线上冒烟（真实 gh 召回验证）移出到 scripts/notify-blocked-smoke.mjs，显式跑，不进回归。

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  findWaiters, buildComment, markerPattern, runNotify,
} = require("../scripts/notify-blocked.mjs");

describe('notify-blocked', () => {
  it('前置解除提醒逻辑回归', async (t) => {
    // ── ① 写法收敛 ─────────────────────────────────────────────────────────

    const ok497 = { number: 501, body: "前置做完再动。\nBlocked-by: #497" };
    const ok497Reason = { number: 502, body: "**Blocked-by: #497**（该文件被它占用中）" };
    const wrong4970 = { number: 503, body: "Blocked-by: #4970 的事" };
    const oldStyle = { number: 504, body: "前置：#497 合并后动" };
    const waitStyle = { number: 505, body: "等 #497 落地后再做" };
    const lowercase = { number: 506, body: "blocked-by: #497" };
    const fullwidth = { number: 507, body: "Blocked-by：#497" };
    const noBody = { number: 508, body: "没写依赖" };
    const noBodyField = { number: 509 };

    await t.test('markerPattern(#497) 不吞 #4970', () => {
      assert.ok(!markerPattern(497).test("Blocked-by: #4970"), 'markerPattern(#497) 不吞 #4970  →  词边界失效');
    });
    await t.test('findWaiters 命中「Blocked-by: #497」正文', () => {
      assert.ok(findWaiters([ok497], 497).map(i => i.number).join(",") === "501", 'findWaiters 命中「Blocked-by: #497」正文');
    });
    await t.test('findWaiters 命中加粗/带理由的写法', () => {
      assert.ok(findWaiters([ok497Reason], 497).map(i => i.number).join(",") === "502", 'findWaiters 命中加粗/带理由的写法');
    });
    await t.test('findWaiters 不命中 #4970', () => {
      assert.ok(findWaiters([wrong4970], 497).length === 0, 'findWaiters 不命中 #4970');
    });
    await t.test('findWaiters 不命中「前置：#497」旧写法', () => {
      assert.ok(findWaiters([oldStyle], 497).length === 0, 'findWaiters 不命中「前置：#497」旧写法');
    });
    await t.test('findWaiters 不命中「等 #497」旧写法', () => {
      assert.ok(findWaiters([waitStyle], 497).length === 0, 'findWaiters 不命中「等 #497」旧写法');
    });
    await t.test('findWaiters 不命中小写 blocked-by', () => {
      assert.ok(findWaiters([lowercase], 497).length === 0, 'findWaiters 不命中小写 blocked-by');
    });
    await t.test('findWaiters 不命中全角冒号', () => {
      assert.ok(findWaiters([fullwidth], 497).length === 0, 'findWaiters 不命中全角冒号');
    });
    await t.test('findWaiters 不命中无标记正文', () => {
      assert.ok(findWaiters([noBody, noBodyField], 497).length === 0, 'findWaiters 不命中无标记正文');
    });
    await t.test('findWaiters 按编号排序', () => {
      assert.ok(findWaiters([ok497, { number: 2, body: "Blocked-by: #497" }, { number: 100, body: "Blocked-by: #497" }], 497).map(i => i.number).join(",") === "2,100,501", 'findWaiters 按编号排序');
    });

    // ── ② 评论措辞 ─────────────────────────────────────────────────────────

    const c = buildComment(497, { title: "等它的一单" });
    await t.test('评论含「请先确认这单还成不成立」', () => {
      assert.ok(c.includes("请先确认这单还成不成立"), '评论含「请先确认这单还成不成立」  →  ' + c);
    });
    await t.test('评论不含「可以开工了」', () => {
      assert.ok(!c.includes("可以开工了"), '评论不含「可以开工了」  →  ' + c);
    });
    await t.test('评论引用被依赖的 #号', () => {
      assert.ok(c.includes("#497"), '评论引用被依赖的 #号  →  ' + c);
    });
    await t.test('评论含默认动作=重估的措辞', () => {
      assert.ok(/还做|重估|确认后/.test(c), '评论含默认动作=重估的措辞  →  ' + c);
    });

    // ── ③ #532 口径：搜索失败 ≠ 搜到 0 条 ────────────────────────────────
    // 假 gh：一个永远退出非 0 的 shim（模拟搜索失败），和一个回 [] 的 shim（模拟搜到 0 条）。

    const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), "notify-blocked-fake-"));
    const failGh = path.join(fakeDir, "fail-gh.mjs");
    fs.writeFileSync(failGh, "process.stderr.write('gh: could not resolve to a Repository\\n'); process.exit(1);\n");
    const emptyGh = path.join(fakeDir, "empty-gh.mjs");
    fs.writeFileSync(emptyGh, "console.log('[]');\n");

    const err = [];
    const origErr = process.stderr.write.bind(process.stderr);
    process.stderr.write = s => { err.push(String(s)); return true; };
    const failRes = runNotify(497, { gh: process.execPath, ghArgs: [failGh] });
    process.stderr.write = origErr;

    await t.test('搜索失败：ok=false', () => {
      assert.ok(failRes.ok === false, '搜索失败：ok=false  →  ' + JSON.stringify(failRes));
    });
    await t.test('搜索失败：reason=search_failed', () => {
      assert.ok(failRes.reason === "search_failed", '搜索失败：reason=search_failed  →  ' + failRes.reason);
    });
    await t.test('搜索失败：报了 ::error::（不是静默当 0 条）', () => {
      assert.ok(err.join("").includes("::error::"), '搜索失败：报了 ::error::（不是静默当 0 条）  →  ' + err.join("").slice(0, 200));
    });

    const zeroRes = runNotify(497, { gh: process.execPath, ghArgs: [emptyGh] });
    await t.test('搜到 0 条：ok=true（0 条是成功结果）', () => {
      assert.ok(zeroRes.ok === true, '搜到 0 条：ok=true（0 条是成功结果）  →  ' + JSON.stringify(zeroRes));
    });
    await t.test('搜到 0 条：waiters 空数组', () => {
      assert.ok(Array.isArray(zeroRes.waiters) && zeroRes.waiters.length === 0, '搜到 0 条：waiters 空数组');
    });

    // ── ④ #544：等待者搜索同时覆盖 issue 与 PR，任一面的失败都报红 ────────
    // 假 gh：argv 含 'pr' 时回 PR 召回，否则回 issue 召回——证明两个面被合并去重。

    const prDir = fs.mkdtempSync(path.join(os.tmpdir(), "notify-blocked-prs-"));
    const splitGh = path.join(prDir, "split-gh.mjs");
    fs.writeFileSync(splitGh, "const isPr = process.argv.includes('pr');\n" +
      "console.log(JSON.stringify(isPr\n" +
      "  ? [{ number: 501, title: '等它的一张 PR', body: '前置：Blocked-by: #497' }]\n" +
      "  : [{ number: 502, title: '等它的一张 issue', body: 'Blocked-by: #497 的事' }]));\n");
    const mergedRes = runNotify(497, { gh: process.execPath, ghArgs: [splitGh] });
    await t.test('issue 面与 PR 面被合并（#544）', () => {
      assert.ok(mergedRes.ok === true && mergedRes.waiters.map(w => w.number).join(",") === "501,502", 'issue 面与 PR 面被合并（#544）  →  ' + JSON.stringify(mergedRes));
    });

    // PR 面（第二次 gh 调用）失败：必须仍走 search_failed + ::error::，不是静默当 0 条。
    const killPrGh = path.join(prDir, "kill-pr-gh.mjs");
    fs.writeFileSync(killPrGh, "if (process.argv.includes('pr')) { process.stderr.write('gh pr list 限流模拟'); process.exit(1); }\nconsole.log('[]');\n");
    const errPr = [];
    const origErrPr = process.stderr.write.bind(process.stderr);
    process.stderr.write = s => { errPr.push(String(s)); return true; };
    const killPrRes = runNotify(497, { gh: process.execPath, ghArgs: [killPrGh] });
    process.stderr.write = origErrPr;
    await t.test('PR 面失败：ok=false（#544）', () => {
      assert.ok(killPrRes.ok === false, 'PR 面失败：ok=false（#544）  →  ' + JSON.stringify(killPrRes));
    });
    await t.test('PR 面失败：reason=search_failed', () => {
      assert.ok(killPrRes.reason === "search_failed", 'PR 面失败：reason=search_failed  →  ' + killPrRes.reason);
    });
    await t.test('PR 面失败：报 ::error:: 且点名 gh pr list（不当 0 条）', () => {
      assert.ok(errPr.join("").includes("::error::") && errPr.join("").includes("gh pr list"), 'PR 面失败：报 ::error:: 且点名 gh pr list（不当 0 条）  →  ' + errPr.join("").slice(0, 200));
    });

    // 真实 gh 线上冒烟已移出默认回归（#554 审官返工）：固定 fixture 保证回归确定性，
    // 线上验证走显式命令：node scripts/notify-blocked-smoke.mjs（见 scripts/ 下脚本头注释）。

    fs.rmSync(fakeDir, { recursive: true, force: true });
    fs.rmSync(prDir, { recursive: true, force: true });
  });
});