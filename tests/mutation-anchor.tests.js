// mutation 锚点闸的回归网 — 正负控 + 历史语料正控 + 扫描面塌陷 + 双向 mutation
//
// 跑法：node tests/mutation-anchor.tests.js   （全绿 exit 0，任一红 exit 1）
//       node scripts/run-tests.mjs            （扫目录自动发现，无需登记）
//
// ── 🔴 本文件有一个别处没有的约束：它住在被测闸自己的扫描面里 ────────────────
// 被测闸扫的是 `<dir>/*.tests.{js,mjs}`，而本文件正是其中之一。
// ⇒ **正控夹具绝不能写成本文件里的字面量**——那会让本文件自己变成一处违例，
//   `check-mutation-anchor.mjs` 一跑就把它的回归网染红。
//   （dao-guard-writing.md 第 3 条「检查器的输出不能落在它自己的扫描面内」的近亲：
//     这里落进扫描面的不是输出，是**夹具**，但自指的形状一模一样。）
// ⇒ 故所有夹具**运行时生成到 `_tmp/`**，闸用 `--dir` 指过去。
//   本文件里出现的 `\\n` 是**转义过的**（字面反斜杠 + n），闸刻意不报这一形态——
//   下面 §④ 有一条断言专门钉住这件事，否则本文件哪天被误报了都没人知道。
//
// ── 每组断言防的是什么 ───────────────────────────────────────────────────────
//   ① 负控      —— 干净夹具必绿。少了它，下面的红说明不了任何事。
//   ② 历史正控  —— **PR #99 修复前的逐字原文**（d47c6e9 的 `-` 行）必须被报出来。
//                  这是本闸唯一的真实语料，删了它本闸就退回"零语料"。
//   ③ 变量锚点  —— 例2 是 `const needle = "...";` 而非内联 ⇒ 只查内联的实现会**漏掉真事故**。
//   ④ 放行面    —— `\r?\n` 已修版 / 纯换行操作 `/\n/g` / 转义的 `\\n`，三种都不许报。
//   ⑤ 扫描面塌陷 —— 主解析瞎掉时必须 exit 5，不许静默 exit 0。
//   ⑥ mutation  —— 上面那些断言真的在测判据吗：三向改坏，红集必须动。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const GATE = path.join(REPO, "ccswitch", "scripts", "check-mutation-anchor.mjs");
const TMP = path.join(REPO, "_tmp", "mutation-anchor-tests");

fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? "\n      " + detail : ""}`); }
}

// 夹具目录：每组一个独立目录，闸用 --dir 指过去
let seq = 0;
function fixture(lines) {
  const d = path.join(TMP, "fx-" + (++seq));
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "sample.tests.js"), lines.join("\n") + "\n", "utf8");
  return d;
}
function run(dir, script = GATE) {
  const r = spawnSync(process.execPath, [script, "--dir", dir, "--json"], { encoding: "utf8" });
  let json = null;
  try { json = JSON.parse(String(r.stdout || "")); } catch (_) { /* exit 5 等走 stderr */ }
  return { code: r.status, json, out: String(r.stdout || ""), err: String(r.stderr || "") };
}

// ── ① 负控：干净夹具必绿 ─────────────────────────────────────────────────────
console.log("\n① 负控 — 干净夹具绿（否则下面的红不算数）");
{
  const d = fixture([
    'const src = fs.readFileSync(GUARD, "utf8");',
    'const needle = "  const fingerprint = rulesFingerprint(roots);";',
    'fs.writeFileSync(mutated, src.replace(needle, "  throw new Error(1);"), "utf8");',
  ]);
  const r = run(d);
  check("单行锚点不报（单行锚点里没有换行，结构上免疫 CRLF）", r.code === 0, r.out);
  check("负控夹具确实被扫到了（不是目录空转）", r.json && r.json.replaces > 0, JSON.stringify(r.json));
}

// ── ② 历史正控：PR #99 修复前的逐字原文 ──────────────────────────────────────
// 下面这一行是 d47c6e9 里被删掉的那一行，**逐字**。它是本闸唯一的真实语料。
console.log("\n② 历史正控 — PR #99（issue #103 例2）修复前的原文必须被报出来");
{
  const d = fixture([
    'const src = fs.readFileSync(GUARD, "utf8");',
    'const needle = "  walk(root, 0);\\n  return out;";',
    'check("mutation 锚点仍在（锚失效则本组空转）", src.includes(needle), needle);',
    'fs.writeFileSync(mutated, src.replace(needle, "  return [];"), "utf8");',
  ]);
  const r = run(d);
  check("例2 原文被报（exit 1）", r.code === 1, `code=${r.code} ${r.out.slice(0, 200)}`);
  check("报的就是那一行（第 2 行的变量锚点）",
    r.json && r.json.findings.length === 1 && r.json.findings[0].line === 2,
    JSON.stringify(r.json && r.json.findings));
  check("报的形态标为「变量锚点」", r.json && r.json.findings[0] && r.json.findings[0].form === "变量锚点",
    JSON.stringify(r.json && r.json.findings));
}

// ── ③ 变量锚点 vs 内联锚点：两条路径都要能报 ────────────────────────────────
console.log("\n③ 两种锚点形态都报 — 只查内联会漏掉真实事故（例2 就是变量形态）");
{
  const inline = fixture([
    'const src = fs.readFileSync(HOOK, "utf8");',
    'fs.writeFileSync(m, src.replace("if (a) {\\n  return 1;", "if (false) {"), "utf8");',
  ]);
  const r1 = run(inline);
  check("内联跨行锚点被报", r1.code === 1 && r1.json.findings[0].form === "内联锚点",
    `code=${r1.code} ${JSON.stringify(r1.json && r1.json.findings)}`);

  const viaVar = fixture([
    'const from = "const A = 1;\\nconst B = 2;";',
    'fs.writeFileSync(m, src.replace(from, "const A = 9;"), "utf8");',
  ]);
  const r2 = run(viaVar);
  check("变量跨行锚点被报", r2.code === 1 && r2.json.findings[0].form === "变量锚点",
    `code=${r2.code} ${JSON.stringify(r2.json && r2.json.findings)}`);
}

// ── ④ 放行面：三种「长得像但不该报」的形态 ──────────────────────────────────
// 护栏两侧代价不对称但都是真代价（官实节「新增覆盖面须同时给出该形态的误伤反例」）。
console.log("\n④ 负控组 — 三种形似而不该报的形态");
{
  const fixed = fixture([
    'const needleRe = /  walk\\(root, 0\\);\\r?\\n  return out;/;',
    'fs.writeFileSync(mutated, src.replace(needleRe, "  return [];"), "utf8");',
  ]);
  check("已修版（\\r?\\n）不报 —— 否则修完还红，等于逼人改回去", run(fixed).code === 0, run(fixed).out);

  const pureOp = fixture([
    'const crlf = lf.replace(/\\n/g, "\\r\\n");',
    'const body = t.replace(/^\\n+/, "").replace(/\\n+$/, "");',
  ]);
  check("纯换行操作（/\\n/g、/^\\n+/）不报 —— 它们的全部目的就是换行，不是锚点",
    run(pureOp).code === 0, run(pureOp).out);

  const escaped = fixture([
    // 夹具里写的是**转义过的**反斜杠 + n（源码里两个字符），不是换行转义
    'const from = "...).join(\\"\\\\n\\")),";',
    'fs.writeFileSync(m, src.replace(from, "[]"), "utf8");',
  ]);
  check("字面反斜杠+n（\\\\n）不报 —— 它匹配的是源码里的两个字符，与行尾无关",
    run(escaped).code === 0, run(escaped).out);
}

// ── ⑤ 扫描面塌陷：主解析瞎掉必须 exit 5，不许静默绿 ─────────────────────────
// dao-guard-writing.md 第 2 条：自检那一半要能在主逻辑瞎掉时仍然看得见。
console.log("\n⑤ 我瞎了吗 — 主解析瞎掉时不许静默绿");
{
  const src = fs.readFileSync(GATE, "utf8");
  // 锚点：单行，且用正则 + \r?\n 无关（本行不跨行）——本文件自己也守本闸的规矩。
  const needle = "    const replaceCount = (line.match(/\\.replace\\s*\\(/g) || []).length;";
  check("mutation 锚点仍在源码里（锚失效则本组空转）", src.split(needle).length === 2,
    `出现 ${src.split(needle).length - 1} 次`);

  const blind = path.join(TMP, "gate-blind.mjs");
  fs.writeFileSync(blind, src.replace(needle, "    const replaceCount = 0;"), "utf8");

  const d = fixture([
    'const needle = "a();\\nb();";',
    'fs.writeFileSync(m, src.replace(needle, "c();"), "utf8");',
  ]);
  const r = run(d, blind);
  check("主解析数到 0 而笨计数器 > 0 ⇒ exit 5（不是 0）", r.code === 5, `code=${r.code} err=${r.err.slice(0, 200)}`);
  check("塌陷时明说「不是本仓很干净，是本闸瞎了」", /瞎了/.test(r.err), r.err.slice(0, 200));

  // canary：未变异副本在同一夹具上仍然正常工作（否则上面的 5 可能只是副本根本没跑起来）
  const control = path.join(TMP, "gate-control.mjs");
  fs.writeFileSync(control, src, "utf8");
  const c = run(d, control);
  check("canary：未变异副本在同一夹具上照常报 exit 1（证明副本跑得起来）", c.code === 1,
    `code=${c.code} ${c.out.slice(0, 160)}`);
}

// ── ⑥ mutation：上面那些断言真的在测判据吗（三向）───────────────────────────
// 官抗节「改坏要试不止一种形态」：①移除 ②留字面但不执行 ③结果不被消费。
// ⚠ 本组自己的锚点**全部是单行字符串**——本闸正在立的规矩，写它的测试时先守一遍。
console.log("\n⑥ mutation 三向 — 判别力自证");
{
  const src = fs.readFileSync(GATE, "utf8");
  const dBad = fixture([
    'const needle = "x();\\ny();";',
    'fs.writeFileSync(m, src.replace(needle, "z();"), "utf8");',
  ]);
  const dGood = fixture([
    'const needleRe = /x\\(\\);\\r?\\ny\\(\\);/;',
    'fs.writeFileSync(m, src.replace(needleRe, "z();"), "utf8");',
  ]);

  function mutate(tag, from, to, wantBad, wantGood) {
    check(`mutation 靶点唯一存在（${tag}）`, src.split(from).length === 2,
      `出现 ${src.split(from).length - 1} 次`);
    if (src.split(from).length !== 2) return;
    const p = path.join(TMP, "gate-mut-" + tag + ".mjs");
    fs.writeFileSync(p, src.replace(from, to), "utf8");
    // canary：变异体还活着（干净夹具上仍能正常跑完、给得出 JSON）
    const alive = run(fixture(['const a = 1;']), p);
    check(`变异体存活（${tag}）：干净夹具仍 exit 0 且出得了 JSON`,
      alive.code === 0 && alive.json !== null, `code=${alive.code}`);
    const rb = run(dBad, p), rg = run(dGood, p);
    check(`${tag}：改坏后红集翻面（坏夹具 ${rb.code} / 好夹具 ${rg.code}）`,
      rb.code === wantBad && rg.code === wantGood,
      `bad=${rb.code}(want ${wantBad}) good=${rg.code}(want ${wantGood})`);
  }

  // ① 移除：跨行判定整个摘掉 ⇒ 坏夹具不再被报
  mutate("①移除跨行判定", "  return left.length > 0 && right.length > 0;", "  return false;", 0, 0);
  // ② 留字面但不执行：\r?\n 豁免分支永不进 ⇒ 好夹具被误报（负控翻面）
  mutate("②豁免分支不执行", "    if (/\\\\r\\?$|\\\\r$/.test(before)) continue;", "    if (false) continue;", 1, 1);
  // ③ 结果不被消费：仍然算 findings，但退出码不看它 ⇒ 坏夹具变绿而报文照旧
  mutate("③结果不被消费", "process.exit(findings.length ? 1 : 0);", "process.exit(0);", 0, 0);
}

// ── ⑦ 真扫一遍本仓 ───────────────────────────────────────────────────────────
// 🔴 少了这一组，本闸就只在**夹具**上跑过，仓里真出现一处跨行裸 \n 锚点也没人会红：
//    上面六组证明的是「它分得清」，这一组才让它**真的在守本仓**。
//    （`run-tests.mjs` 扫 `tests/*.tests.js`，故本组即是本闸挂进全套验证的方式。）
console.log("\n⑦ 真扫本仓 — 上面都是夹具，这一组才是真的在守");
{
  const r = spawnSync(process.execPath, [GATE, "--json"], { encoding: "utf8" });
  let j = null;
  try { j = JSON.parse(String(r.stdout || "")); } catch (_) { /* 落空即下面报出来 */ }
  check("本仓零跨行裸 \\n 锚点（exit 0）", r.status === 0,
    `code=${r.status} ${String(r.stdout || "").slice(0, 400)}`);
  check("确实扫到了东西（不是空目录假绿）", j && j.files > 0 && j.replaces > 0, JSON.stringify(j && { files: j.files, replaces: j.replaces }));
  // 主解析与笨计数器两条独立通路必须一致：分岔即说明其中一条瞎了
  check("主解析数与独立笨计数器一致（两条通路互证没瞎）", j && j.replaces === j.dumb,
    j ? `main=${j.replaces} dumb=${j.dumb}` : "无 JSON");
}

console.log(`\n=== 汇总: PASS=${pass} FAIL=${fail} ===`);
process.exit(fail ? 1 : 0);
