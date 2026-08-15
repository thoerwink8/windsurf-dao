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
// 真实仓库的构造样本（真关真评论）在自测里做，看 PR 描述。

const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  findWaiters, buildComment, markerPattern, runNotify,
} = require("../scripts/notify-blocked.mjs");

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? "  →  " + detail : ""}`); }
}

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

check("markerPattern(#497) 不吞 #4970", !markerPattern(497).test("Blocked-by: #4970"), "词边界失效");
check("findWaiters 命中「Blocked-by: #497」正文", findWaiters([ok497], 497).map(i => i.number).join(",") === "501");
check("findWaiters 命中加粗/带理由的写法", findWaiters([ok497Reason], 497).map(i => i.number).join(",") === "502");
check("findWaiters 不命中 #4970", findWaiters([wrong4970], 497).length === 0);
check("findWaiters 不命中「前置：#497」旧写法", findWaiters([oldStyle], 497).length === 0);
check("findWaiters 不命中「等 #497」旧写法", findWaiters([waitStyle], 497).length === 0);
check("findWaiters 不命中小写 blocked-by", findWaiters([lowercase], 497).length === 0);
check("findWaiters 不命中全角冒号", findWaiters([fullwidth], 497).length === 0);
check("findWaiters 不命中无标记正文", findWaiters([noBody, noBodyField], 497).length === 0);
check("findWaiters 按编号排序", findWaiters([ok497, { number: 2, body: "Blocked-by: #497" }, { number: 100, body: "Blocked-by: #497" }], 497).map(i => i.number).join(",") === "2,100,501");

// ── ② 评论措辞 ─────────────────────────────────────────────────────────

const c = buildComment(497, { title: "等它的一单" });
check("评论含「请先确认这单还成不成立」", c.includes("请先确认这单还成不成立"), c);
check("评论不含「可以开工了」", !c.includes("可以开工了"), c);
check("评论引用被依赖的 #号", c.includes("#497"), c);
check("评论含默认动作=重估的措辞", /还做|重估|确认后/.test(c), c);

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

check("搜索失败：ok=false", failRes.ok === false, JSON.stringify(failRes));
check("搜索失败：reason=search_failed", failRes.reason === "search_failed", failRes.reason);
check("搜索失败：报了 ::error::（不是静默当 0 条）", err.join("").includes("::error::"), err.join("").slice(0, 200));

const zeroRes = runNotify(497, { gh: process.execPath, ghArgs: [emptyGh] });
check("搜到 0 条：ok=true（0 条是成功结果）", zeroRes.ok === true, JSON.stringify(zeroRes));
check("搜到 0 条：waiters 空数组", Array.isArray(zeroRes.waiters) && zeroRes.waiters.length === 0);

fs.rmSync(fakeDir, { recursive: true, force: true });

console.log(`\n=== 汇总: PASS=${pass} FAIL=${fail} ===`);
process.exit(fail ? 1 : 0);