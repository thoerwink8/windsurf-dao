#!/usr/bin/env node
// check-mutation-anchor.mjs — mutation 锚点的行尾健壮性闸
//
// ── 治的是什么病（issue #103）─────────────────────────────────────────────────
// mutation 的锚点写死 `\n`，而盘上检出是 CRLF ⇒ 锚点**恒不命中** ⇒ `String.replace`
// 原样返回 ⇒ 变异体 == 原文 ⇒ 被测守卫**照常绿**。
// 🔴 而「变异体没生效所以守卫绿」与「守卫真的没塌陷」**逐字节相同**——
//    这正是 dao-guard-writing.md「零检出 ≠ 零存在」在 mutation 这一层的形态。
//
// 2026-08-02 同日撞两次：
//   例1 PR #63  `node -e` 锚点带 `\n`，ANCHOR MISS 两次（官原话「落空与"文案已不在"不可区分」）
//   例2 PR #99  `const needle = "  walk(root, 0);\n  return out;";`
//               → **分支绿、合并后主干红**（分支 worktree 与主仓检出行尾不同），修复 d47c6e9
//
// ── 判据（刻意窄，理由见下）───────────────────────────────────────────────────
// 只报一件事：**被当作 mutation 锚点的字面量里，有跨行的裸 `\n`**。
//   跨行 = `\n` 两侧都有实质内容（`/\n/g`、`/^\n+/`、`"\n"` 这类**纯换行操作**是有意为之，放行）
//   裸   = 没写成 `\r?\n`（写了的即已吃掉行尾差异，放行）
//
// **为什么不查「每组 mutation 有没有锚点断言」**（issue 里提议的那个形态）——实测过，做不到：
//   本仓 25 处真 mutation 站点上量了四档窗口，误报率 84.6%(±3行) → 100%(±40行)，
//   且窗口放大到能覆盖 helper 间接（6/25 处的断言在 helper 里或调用点十几行外）时，
//   误报率就到 100%。两头堵死，没有可用窗口。详见 dao-guard-writing.md 该条。
//   ⇒ 那一半留作**判据**（人读），只有这一半做成闸（机器读）。
//
// ── 两个自指陷阱，都是 dao-guard-writing.md 点名过的 ─────────────────────────
// ① **扫描面塌陷**（第 2 条）：主解析读到 0 个锚点时，「本仓真的没有违例」与「我瞎了」
//    输出一样。故本闸另有一个**独立的、笨的**样本计数器（`countReplacesDumb`，纯子串计数，
//    **刻意不复用主解析的任何一行**），主解析看到 0 个 replace 而笨计数器 > 0 ⇒ exit 5。
// ② **输出落在自己扫描面内**（第 3 条）：扫描面是 `<dir>/*.tests.{js,mjs}`。
//    本闸的输出走 stdout，**不落盘**；其回归网的正/负控夹具由测试在 `_tmp/` 下现场生成、
//    不作为字面量写在 `tests/mutation-anchor.tests.js` 里——**否则夹具会把它自己的测试文件染红**。
//    这不是洁癖：第一版就是把夹具写成字面量，当场自伤。
//
// ── 射程，照直写（别把本闸读成「这类坑现在有人管了」）───────────────────────
//   ㈠ **只覆盖 JS/MJS 测试**。PowerShell 测试（`*.tests.ps1`）的 `-replace` / `.Replace()`
//      不在射程内——PS 里没有 `\n` 转义这回事（单引号串里 `\n` 就是两个字符），
//      风险形态不同，需要单独判据，本批未做。
//   ㈡ **只覆盖「直接喂给 `.replace()` 的锚点」**：内联字面量，以及**赋值给变量后**
//      直接用作 `.replace()` 首参的那些。**经 helper 传参的锚点**（如
//      `writeMutant(tag, from, to)` 里的 `from`）**追不到**——那需要跨函数数据流。
//      本仓实测 6/25 处属这一类，是**已知漏报面**，不是"没有"。
//   ㈢ 例1（`node -e` 里的锚点）住在 shell 命令里而不是测试文件里，本闸**看不见**。
//   ㈣ 上线时本仓真实违例 **0 处**（例2 已于 d47c6e9 修复）⇒ 本闸是**纵深防御**，
//      不是在止血。历史语料 1/1（例2 的原文形态被回归网的正控钉着）。
//      **别把「它报 0」读成「它管用」**——那正是 ① 要防的那件事。
//
// 用法：node ccswitch/scripts/check-mutation-anchor.mjs [--dir <测试目录>] [--json]
// 退出码：0 干净 · 1 发现跨行裸 \n 锚点 · 2 目录不存在 · 5 扫描面塌陷（自检失败）

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");

const argv = process.argv.slice(2);
const dirIdx = argv.indexOf("--dir");
const SCAN_DIR = dirIdx >= 0 ? argv[dirIdx + 1] : join(REPO, "tests");
const AS_JSON = argv.includes("--json");

if (!existsSync(SCAN_DIR)) {
  console.error(`✗ 扫描目录不存在：${SCAN_DIR}`);
  process.exit(2);
}

// ── 词法：把一行里的字符串/正则字面量切出来 ──────────────────────────────────
// 刻意手写而不用 AST：要检的东西是**字面量内部的转义序列**，多数 AST 库会在解析时
// 把 `\n` 解成真实换行，那正好把要检的信息吃掉了（同 dao-rules-deploy 不肯用 YAML 库的理由）。
function literalsOf(line) {
  const out = [];
  let i = 0;
  while (i < line.length) {
    const c = line[i];
    if (c === '"' || c === "'" || c === "`") {
      const start = i;
      i++;
      while (i < line.length) {
        if (line[i] === "\\") { i += 2; continue; }
        if (line[i] === c) { i++; break; }
        i++;
      }
      out.push({ kind: "str", text: line.slice(start, i), start });
    } else if (c === "/" && !/[\w)\]]/.test(line.slice(0, i).trimEnd().slice(-1) || "")) {
      // 正则字面量（粗判：`/` 前不是标识符/右括号 ⇒ 不是除法）
      if (line[i + 1] === "/" || line[i + 1] === "*") break;   // 注释，整行后面不要了
      const start = i;
      i++;
      let closed = false;
      while (i < line.length) {
        if (line[i] === "\\") { i += 2; continue; }
        if (line[i] === "[") { while (i < line.length && line[i] !== "]") { if (line[i] === "\\") i++; i++; } }
        if (line[i] === "/") { i++; closed = true; break; }
        i++;
      }
      while (i < line.length && /[gimsuy]/.test(line[i])) i++;
      if (closed) out.push({ kind: "re", text: line.slice(start, i), start });
    } else {
      i++;
    }
  }
  return out;
}

// 裸 `\n` 判定：`\n` 前面的连续反斜杠个数为**偶数**才算真转义（`\\n` 是字面反斜杠+n，不算）
function hasBareNewlineEscape(lit) {
  for (let i = 0; i < lit.length - 1; i++) {
    if (lit[i] !== "\\" || lit[i + 1] !== "n") continue;
    let back = 0, j = i - 1;
    while (j >= 0 && lit[j] === "\\") { back++; j--; }
    if (back % 2 !== 0) continue;              // `\\n` ⇒ 字面 \ + n，与换行无关
    // 已写成 \r?\n 或 \r\n ⇒ 已吃掉行尾差异
    const before = lit.slice(Math.max(0, i - 4), i);
    if (/\\r\?$|\\r$/.test(before)) continue;
    return i;
  }
  return -1;
}

// 「跨行锚点」：\n 两侧都有实质内容。纯换行操作（/\n/g、/^\n+/、"\n"）不是锚点。
function isCrossLineAnchor(lit) {
  const at = hasBareNewlineEscape(lit);
  if (at < 0) return false;
  const body = lit.replace(/^[/'"`]/, "").replace(/[/'"`][gimsuy]*$/, "");
  const idx = body.indexOf("\\n");
  if (idx < 0) return false;
  const left = body.slice(0, idx).replace(/[\^\s]/g, "");
  const right = body.slice(idx + 2).replace(/[$\s+*?]/g, "");
  return left.length > 0 && right.length > 0;
}

// ── 主解析：找出「用作 mutation 锚点」的字面量 ───────────────────────────────
const ANCHOR_HINT = /\b(needle|needleRe|anchor|from\d?|target|ORIG|FROM)\b/i;

const files = readdirSync(SCAN_DIR).filter((f) => /\.tests\.(js|mjs)$/.test(f));
const findings = [];
let replacesSeenByMainParser = 0;

for (const f of files) {
  const raw = readFileSync(join(SCAN_DIR, f), "utf8");
  const lines = raw.split(/\r?\n/);

  // pass 1：收集「被当作 .replace() 首参」的变量名
  const anchorVars = new Set();
  for (const line of lines) {
    for (const m of line.matchAll(/\.replace\s*\(\s*([A-Za-z_$][\w$]*)\s*[,)]/g)) anchorVars.add(m[1]);
  }

  lines.forEach((line, i) => {
    const replaceCount = (line.match(/\.replace\s*\(/g) || []).length;
    replacesSeenByMainParser += replaceCount;

    // (a) 内联锚点：.replace( 后面紧跟的字面量
    if (replaceCount > 0) {
      const after = line.slice(line.indexOf(".replace("));
      for (const lit of literalsOf(after).slice(0, 1)) {
        if (isCrossLineAnchor(lit.text)) {
          findings.push({ file: f, line: i + 1, form: "内联锚点", lit: lit.text.slice(0, 120), ctx: line.trim().slice(0, 140) });
        }
      }
    }

    // (b) 变量锚点：`const <名> = <字面量>`，且该名在本文件里被用作 .replace() 首参
    //     ⚠ 例2（PR #99）正是这一形态 —— 只查内联的检查器会**漏掉真实事故**。
    const def = line.match(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(.+)$/);
    if (def) {
      const [, name, rhs] = def;
      if (anchorVars.has(name) || ANCHOR_HINT.test(name)) {
        for (const lit of literalsOf(rhs)) {
          if (isCrossLineAnchor(lit.text)) {
            findings.push({ file: f, line: i + 1, form: "变量锚点", lit: lit.text.slice(0, 120), ctx: line.trim().slice(0, 140) });
          }
        }
      }
    }
  });
}

// ── 自检：我是不是瞎了（独立于主解析的笨计数器）──────────────────────────────
// 刻意用最笨的方式：整份文本里 `.replace(` 的子串出现次数。它不共享主解析的任何状态，
// 主解析若整段瞎掉（词法器抛错吞掉、正则写坏、readdir 过滤写反），两个数会分岔。
function countReplacesDumb() {
  let n = 0;
  for (const f of readdirSync(SCAN_DIR)) {
    if (!/\.tests\.(js|mjs)$/.test(f)) continue;
    const t = readFileSync(join(SCAN_DIR, f), "utf8");
    let idx = 0;
    for (;;) {
      idx = t.indexOf(".replace(", idx);
      if (idx < 0) break;
      n++; idx += 9;
    }
  }
  return n;
}
const dumbCount = countReplacesDumb();

if (dumbCount > 0 && replacesSeenByMainParser === 0) {
  console.error("✗ 扫描面塌陷：笨计数器看到 " + dumbCount + " 个 .replace(，主解析一个都没看到。");
  console.error("  这不是「本仓很干净」，是本闸瞎了。别把这次的 0 当通过。");
  process.exit(5);
}

// ── 报告 ─────────────────────────────────────────────────────────────────────
if (AS_JSON) {
  console.log(JSON.stringify({ files: files.length, replaces: replacesSeenByMainParser, dumb: dumbCount, findings }, null, 1));
} else {
  console.log(`[mutation-anchor] 扫 ${files.length} 套测试，主解析见到 ${replacesSeenByMainParser} 个 .replace(（笨计数器 ${dumbCount}）`);
  if (findings.length === 0) {
    console.log("  ✓ 零跨行裸 \\n 锚点");
    console.log("  ⓘ 射程：不含 *.tests.ps1、不含经 helper 传参的锚点（本仓约 6 处）——见本脚本头注");
  } else {
    for (const v of findings) {
      console.log(`  ✗ ${v.file}:${v.line}  [${v.form}]  ${v.lit}`);
      console.log(`      ${v.ctx}`);
    }
    console.log(`\n  ${findings.length} 处跨行锚点写死了 \\n。CRLF 检出下它恒不命中 ⇒ mutation 空转 ⇒ 被测守卫假绿。`);
    console.log("  改法：锚点改用正则，换行位写 \\r?\\n（如 /  walk\\(root, 0\\);\\r?\\n  return out;/）。");
    console.log("  ⚠ 别改用「读进来先归一化行尾」——那会改变副本内容，PR #99 第一版即因此触发守卫自身的");
    console.log("     规则指纹检测（exit 4 rules-drift）。正则锚点保持原文件逐字节不变，是更干净的那条。");
  }
}

process.exit(findings.length ? 1 : 0);
