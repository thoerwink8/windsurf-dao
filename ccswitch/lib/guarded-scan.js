// guarded-scan.js — 「被 mutation 守护的源文件」扫描（运行时现算，无派生物）
//
// 前身是 ccswitch/scripts/gen-guarded-files.mjs 生成的 ccswitch/guarded-files.json
// （派生清单 + 同步闸）。重设计后派生物消灭：清单由消费方（dao-glob-gate.js）
// 每次运行时从 tests/ 现算（带指纹缓存），不再有「清单过期」这一物种，
// 也不再需要 --check 闸守同步。
//
// 口径（与历史基线数据可比的刻意选择，两个方向都构造得出反例）：
//   ① 含 mutation 的测试：JS 出现 `.replace(` / PS 出现 `-replace` 或 `.Replace(`——
//      粗判（偏松：`"a".replace(` 这类与 mutation 无关的用法也命中；偏紧：整段重写文件的
//      mutation 判不出）。沿用旧口径不收紧。
//   ② 该测试以仓根为基点声明了被测对象路径（path.join|resolve(REPO, "ccswitch", …) /
//      require("../ccswitch/…") / PS Join-Path $repoRoot 'ccswitch/…'），
//      落在 ccswitch/{hooks,scripts,lib,templates}/ 之下、盘上真实存在、是文件。
//
// 已知漏报面：helper 传参/变量拼接的路径追不到；ccswitch/ 之外的守卫不在面内；
// 有守卫但不做 mutation 的测试不算。这是口径推论，不是 bug。
"use strict";
const fs = require("node:fs");
const path = require("node:path");

const OWNED_DIRS = ["ccswitch/hooks/", "ccswitch/scripts/", "ccswitch/lib/", "ccswitch/templates/"];
// 仓根变量白名单：夹具变量（root/TmpRoot/REPO_A…）刻意不在表内
const ROOT_VAR = /^(REPO|ROOT|REPO_ROOT|repoRoot|RepoRoot|__dirname|PSScriptRoot)$/;

function hasMutation(text, ext) {
  if (ext === "ps1") return /-replace/i.test(text) || /\.Replace\s*\(/.test(text);
  return /\.replace\s*\(/.test(text);
}

// 三种「以仓根为基点的路径声明」各写一个抽取器，不合并成一个大正则：
// 合并后任一形态写坏时症状是「清单少几个文件」，与「本来就没有」不可区分。
function fromPathCall(text) {
  const out = [];
  for (const m of text.matchAll(/path\.(?:join|resolve)\(\s*([A-Za-z_$][\w$]*)\s*((?:,\s*["'][^"']*["']\s*)+)\)/g)) {
    if (!ROOT_VAR.test(m[1])) continue;
    const segs = [...m[2].matchAll(/["']([^"']*)["']/g)].map((x) => x[1]).filter((s) => s !== "..");
    if (segs[0] !== "ccswitch") continue;
    out.push(segs.join("/"));
  }
  return out;
}
function fromRequire(text) {
  const out = [];
  for (const m of text.matchAll(/(?:require|from)\s*\(?\s*["']([^"']*ccswitch\/[^"']*)["']/g)) {
    out.push(m[1].slice(m[1].indexOf("ccswitch/")));
  }
  return out;
}
function fromJoinPath(text) {
  const out = [];
  for (const m of text.matchAll(/Join-Path\s+\$(\w+)\s+["']([^"']*ccswitch[/\\][^"']*)["']/g)) {
    if (!ROOT_VAR.test(m[1])) continue;
    const s = m[2].split("\\").join("/");
    out.push(s.slice(s.indexOf("ccswitch/")));
  }
  return out;
}

function resolveOwnedFile(repoRoot, rel) {
  if (!OWNED_DIRS.some((d) => rel.startsWith(d))) return null;
  for (const cand of [rel, rel + ".js", rel + ".mjs", rel + ".cjs"]) {
    try {
      if (fs.statSync(path.join(repoRoot, cand)).isFile()) return cand;
    } catch (_) { /* 不存在就试下一个 */ }
  }
  return null;
}

// 扫一个 tests 目录，算出「被守护源文件 → 守它的测试」映射。
function scanGuarded({ repoRoot, testsDir }) {
  const entries = fs.readdirSync(testsDir).sort();
  const map = new Map();
  let tests = 0;
  let mutationTests = 0;
  for (const f of entries) {
    const m = /\.tests\.(js|mjs|ps1)$/.exec(f);
    if (!m) continue;
    tests++;
    const text = fs.readFileSync(path.join(testsDir, f), "utf8");
    if (!hasMutation(text, m[1])) continue;
    mutationTests++;
    const cands = m[1] === "ps1"
      ? fromJoinPath(text)
      : [...fromPathCall(text), ...fromRequire(text)];
    for (const c of new Set(cands)) {
      const rel = resolveOwnedFile(repoRoot, c);
      if (!rel) continue;
      if (!map.has(rel)) map.set(rel, new Set());
      map.get(rel).add(f);
    }
  }
  const files = [...map.keys()].sort().map((file) => ({ file, guards: [...map.get(file)].sort() }));
  return { files, tests, mutationTests };
}

// 指纹：tests/ 目录的「文件名+大小+mtime」拼串——变了才值得真扫（hook 每次编辑都调）。
function testsFingerprint(testsDir) {
  const out = [];
  for (const f of fs.readdirSync(testsDir).sort()) {
    if (!/\.tests\.(js|mjs|ps1)$/.test(f)) continue;
    try {
      const st = fs.statSync(path.join(testsDir, f));
      out.push(`${f}:${st.size}:${Math.floor(st.mtimeMs)}`);
    } catch (_) { /* 读到一半被删就当它变了 */ out.push(f + ":gone"); }
  }
  return out.join("|");
}

module.exports = { scanGuarded, hasMutation, testsFingerprint, OWNED_DIRS };
