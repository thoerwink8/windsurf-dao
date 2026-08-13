// dao.md 裸路径指针存在性回归网（issue #292）。
//
// 背景：ccswitch/dao.md 里十几条「XXX 前 = Read `rules/xxx.md`」这类指路句，原靶
// tests/stub-targets.tests.js 已随「条款元数据链整体退役」（2026-08-12）一并被重设计删除，
// 此后这道缺口零守护——2026-08-13 侦察官只读复核确认：把被指文件挪走，全仓的闸一个都不红。
// 本文件是重建的那道闸。
//
// 解析语义（不是想当然，是实测核对过部署实况）：dao.md 不走 symlink 部署——
// ~/.claude/CLAUDE.md 用绝对路径 `@D:/frank/windsurf-dao/ccswitch/dao.md` 直接 @import 仓内
// 本体（~/.claude 下没有 dao.md 这份文件；~/.claude/rules/ 下也只有 scoped/ 几份作用域小纸条，
// 没有 dao-dispatch.md 这类顶层规则文件）。因此 dao.md 里裸写的 `rules/xxx.md`，它的落点是
// <dao.md 所在目录>/rules/xxx.md ——即本仓的 ccswitch/rules/xxx.md：相对的是 dao.md 自己所在
// 的目录，不是仓根、不是当前 CWD、也不是任何部署后的 ~/.claude 路径。
//
// 全域摸底（issue #292「范围改写」评论要求的前置动作——先摸有没有同型缺口，再决定钉几份）：
// 整仓搜反引号包裹的裸写形态 `` `rules/xxx.md` ``，命中恰好 2 个文件：
//   ① ccswitch/dao.md —— 15 处指针 / 7 个不同目标（2026-08-13 实测，见下方基线常量）；
//   ② ccswitch/skills/dao-design/standards.md 第 477 行 —— 落在 `~~划线~~` 历史订正块里，
//      是在**引用**当时 dao.md 的原文（"dao.md 现在只剩「截图前 Read `rules/dao-gui-verify.md`」"），
//      不是一条独立的指路句；它引用的目标文件与 dao.md 自己那条 dao-gui-verify.md 指针完全
//      同一个，已经被下面对 dao.md 的检查覆盖，另钉一遍只会多一份要维护的解析代码、不增加
//      实际覆盖面，故本守卫刻意只钉 dao.md 本体。
// 仓内其余引用 rules/ 的地方（ccswitch/rules/*.md 内部互指、docs/rules/dispatch-clauses.md、
// 各 scoped/ 触发器）一律带 `ccswitch/` 前缀或写死机器绝对路径（C:/frank/... 、D:/frank/...），
// 解析语义与本处不同（前缀形态天然可从仓根解析，不受本单描述的裸路径缺口影响），本轮不收。
//
// 自检独立性（按 ccswitch/rules/dao-writing-rules.md 第二节「自检不能复用被守对象的解析」）：
// extractPointers()（结构化正则抽取，回答「哪条指针 → 哪个目标」）与
// independentPointerCount()（逐行 indexOf 计数，不用正则、不调用 extractPointers、
// 也不关心指针的具体目标）是两套完全独立的实现。若 extractPointers 的正则被改坏导致抽出
// 0 条，independentPointerCount 仍能看见非零的 "rules/" 子串出现次数，从而分清
// 「dao.md 真的没有指针了」与「解析器瞎了」——这两种情况对只有一套解析的守卫看起来一模一样。

const fs = require("fs");
const path = require("path");

const REPO = path.resolve(__dirname, "..");
const DAO_MD = path.join(REPO, "ccswitch", "dao.md");
const RULES_DIR = path.join(REPO, "ccswitch", "rules");

// 2026-08-13 实测基线：15 处指针 / 7 个不同目标。留量到 8 条：既远高于「解析器瞎了导致
// 抽出 0 条」的判别线，又不会因为 dao.md 后续正常增删一两条指路句就把这套回归网跑脆。
const MIN_EXPECTED_POINTERS = 8;

let pass = 0,
  fail = 0;
function check(name, cond, detail) {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${detail ? "  →  " + detail : ""}`);
  }
}

/** 主解析：结构化抽取「反引号包裹的裸 rules/xxx.md」指针，用于「哪条 → 哪个目标」定位。
 *  不是自检半边——自检半边是下面的 independentPointerCount。 */
function extractPointers(text) {
  const RE = /`rules\/((?:scoped\/)?[A-Za-z0-9._-]+\.md)`/g;
  const out = [];
  let m;
  while ((m = RE.exec(text))) out.push(m[1]);
  return out;
}

/** 自检半边：与 extractPointers 完全独立的第二套实现——不用正则、不调用 extractPointers，
 *  逐行用 indexOf 数 "rules/" 子串出现次数。粒度比主解析粗（会把 `rules/scoped/` 这种没有
 *  .md 文件名的裸目录提及也数进去）——这是有意为之：它只需要证明「主解析没有整体瞎掉」，
 *  不需要与主解析逐条对应。 */
function independentPointerCount(text) {
  let count = 0;
  for (const line of text.split("\n")) {
    let idx = 0;
    for (;;) {
      const found = line.indexOf("rules/", idx);
      if (found === -1) break;
      count++;
      idx = found + "rules/".length;
    }
  }
  return count;
}

/** 指针目标解析：相对 rules/ 目录（= dao.md 所在目录的 rules/ 子目录），见头注「解析语义」。 */
function resolveTarget(rel) {
  return path.join(RULES_DIR, ...rel.split("/"));
}

console.log("\n=== ① 自检半边：两套独立实现都必须看见样本（零命中与瞎了不可区分，用这一节分开）===");
{
  check("dao.md 存在（本次没查成 vs 没问题的前提）", fs.existsSync(DAO_MD), DAO_MD);
  const text = fs.existsSync(DAO_MD) ? fs.readFileSync(DAO_MD, "utf8") : "";
  const pointers = extractPointers(text);
  const indCount = independentPointerCount(text);
  check(
    `主解析（正则）抽到 ${pointers.length} 条 ≥ 基线 ${MIN_EXPECTED_POINTERS}`,
    pointers.length >= MIN_EXPECTED_POINTERS,
    `实际 ${pointers.length}`
  );
  check(
    `独立计数（不复用主解析）算出 ${indCount} ≥ 主解析 ${pointers.length} 且 ≥ 基线（互相印证，任一坍缩到 0 都会被另一半看见）`,
    indCount >= pointers.length && indCount >= MIN_EXPECTED_POINTERS,
    `独立=${indCount} 主=${pointers.length}`
  );
}

console.log("\n=== ② 主检查：dao.md 每条 rules/ 指针的目标必须在盘上存在 ===");
{
  const text = fs.readFileSync(DAO_MD, "utf8");
  const pointers = extractPointers(text);
  const uniqTargets = [...new Set(pointers)];
  const broken = uniqTargets.filter((rel) => !fs.existsSync(resolveTarget(rel)));
  check(
    `${uniqTargets.length} 个不同目标全部存在（解析：相对 dao.md 所在目录的 rules/ 子目录）`,
    broken.length === 0,
    broken.length ? broken.map((r) => `${r} → ${resolveTarget(r)}`).join("; ") : undefined
  );
  for (const rel of uniqTargets) {
    check(`  · rules/${rel} 存在`, fs.existsSync(resolveTarget(rel)), resolveTarget(rel));
  }
}

console.log("\n=== ③ 判别力负控（合成夹具，不依赖真实 dao.md 此刻的内容，长期常驻回归网）===");
{
  const FIXTURE = [
    "这是一条健康指针：动作前 = Read `rules/dao-gui-verify.md`。",
    "这是一条指向空气的指针（canary，本仓不存在这个文件）：改前 = Read `rules/dao-292-canary-does-not-exist.md`。",
    "这行只是提到目录，不该被误抓成指针：常驻规则 / 作用域档（`rules/scoped/`）。",
  ].join("\n");
  const pointers = extractPointers(FIXTURE);
  check("负控夹具 · 抽到恰好 2 条指针（裸目录提及不误抓成指针）", pointers.length === 2, JSON.stringify(pointers));
  const healthy = pointers.filter((rel) => fs.existsSync(resolveTarget(rel)));
  const brokenFixture = pointers.filter((rel) => !fs.existsSync(resolveTarget(rel)));
  check("负控 · 健康指针（dao-gui-verify.md，真实存在）判为存在", healthy.includes("dao-gui-verify.md"), JSON.stringify(healthy));
  check(
    "负控 · 投毒指针（canary，真实不存在）被抓成不存在——这是本守卫的判别力证明",
    brokenFixture.includes("dao-292-canary-does-not-exist.md"),
    JSON.stringify(brokenFixture)
  );
}

console.log("\n=== ④ 自检半边自身的正负控（防它退化成永远返回定值的摆设）===");
{
  check("独立计数 · 含 3 处 rules/ 子串的合成文本数出 3", independentPointerCount("a rules/x.md b rules/y rules/z.md") === 3);
  check("独立计数 · 不含 rules/ 的文本数出 0（负控）", independentPointerCount("这段散文完全不提那个词。") === 0);
}

console.log(`\n=== 汇总: PASS=${pass} FAIL=${fail} ===`);
process.exit(fail ? 1 : 0);
