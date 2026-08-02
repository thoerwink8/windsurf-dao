// check-token-drift.mjs — 设计值硬编码的**棘轮守卫**（canonical，零依赖 node）
//
// 真相源：windsurf-dao/ccswitch/templates/check-token-drift.mjs
// 项目侧是**派生副本**（scaffold 清单条目 token-drift-guard 的 template.dest =
// scripts/check-token-drift.mjs）。副本会漂移，故本文件带 CANONICAL_VERSION，
// `--selfcheck` 会把它打出来，对副本时肉眼一比即知落后几版。
//
// ── 它替掉的是什么 ──────────────────────────────────────────────────────────
// dao 侧「禁裸 px/hex、出货前 lint 拦截裸值」这句话至少写在五处（dao-design
// standards.md §token 收口铁律 / fidelity.md L1 / open.md §关卡表 / od-prompt.md /
// protocol-od.md），**五处全是散文，零实现** —— 谁来跑、跑什么、什么算过，一个字没有。
// 「零检出」与「根本没人跑」在这种形态下逐字节相同。本文件把那句话变成一个有退出码的东西。
//
// ── 🔴 它首先要**不重犯**的那个病（这条排在功能前面）─────────────────────────
// 事故账 L12（2026-07-07）：某仓的 `check:tokens` 棘轮**基线与扫描规则脱节后恒红多日** ——
// 红到没人看时，新增违规与存量混在一起无从分辨，**检查比不存在更糟**。
// 病根是形态而非疏忽：基线是「规则版本 A 下的一张计数快照」，规则一变（正则放宽、
// 扫描根变动、排除项增删），**每个文件的计数同时跳变 ⇒ 全库看起来在回归**，
// 而输出与「真的到处在加裸值」**长得一模一样**。
// ⇒ 结构性治法：基线里存一份 **rulesFingerprint**（规则指纹 = 正则源码 + 扩展名 +
//    扫描根 + 各排除函数的源码 + RULES_VERSION 的 sha256）。指纹不一致时**不报回归**，
//    走**专用退出码 4** 并只说一件事：「规则变了，基线过期，跑 --update-baseline」。
//    这样「规则脱节」与「真回归」在**机器可读通道上分得开** —— 那正是 L12 缺的东西。
//
// ── 棘轮的关键：**只降不升**（自动收紧）────────────────────────────────────
// 上游那版只有手动 `--update-baseline`，且清理后仅打印一句「🎉 清掉了 N 个」。
// 那不是棘轮，是**带庆祝语的静止闸**：清掉 5 个再加回 5 个，比对照样绿。
// 本版在**比对通过**的那一刻自动把基线**往低了写**（`--no-tighten` 可关，CI 只读环境用），
// 并顺带**剪掉已消失文件的条目**（否则基线只增不减，重构删文件后条目永久滞留）。
// 绝不自动升高：升高只能靠人显式 `--update-baseline`，那是一次可见的、进 git 的动作。
//
// ── 摸过全域分布再定默认扫描根（不只护住刚出事的那一层）────────────────────
// 上游那版把扫描根写死成 `apps/desktop/src` —— 换个仓布局就是**零覆盖而全绿**。
// 本文件落地前跑了一次全域分布摸底（`--distribution`，实测数字见本批 PR body 与
// scaffold 清单条目 token-drift-guard 的 why 字段，**不抄进这里**：那是某一天的快照，
// 抄进来立刻变成一份没人更新的旧数字）。结论落成两条：
//   ① 扫描根**自动发现**（下方 ROOT_CANDIDATES + apps/*/src、packages/*/src 展开），
//      不写死；项目可用 `.token-drift.json` 显式覆盖。
//   ② `--distribution` 是常驻子命令，不是一次性脚本 —— 下次有人想调阈值/加规则时，
//      「现在体量最大的前 N 个目录是谁、在不在覆盖内」是一条命令的事。
//
// ── 自检那一半：刻意不复用扫描逻辑（DRY 在这里是错的）──────────────────────
// 「找违例」与「确认我真的看到了样本」若共用一个遍历实现，遍历漏掉一整片时**两半一起错**：
// 违例数与样本数同时归零，差恒为 0，自检退化成一句永远为真的废话。
// 故 collectFiles()（手写递归 + 显式 skip 表）与 censusFiles()（readdirSync recursive
// + 独立扩展名过滤）是**两套实现**，结果做集合差。差异不为零即打印；扫描面为空而普查
// 非空 ⇒ **exit 5（瞎了）**，不是 exit 0。
//
// ── 检查器的输出不落在自己的扫描面内 ──────────────────────────────────────
// 基线文件若落在某个扫描根之下，它自己就会被扫（里面全是路径与数字，正则未必命中，
// 但那是运气不是设计）⇒ 启动时硬断言，落在扫描面内直接 exit 5。
//
// ── 退出码（只有 0 叫通过；别写 `-le 2` 那种谓词）───────────────────────────
//   0  通过（可能顺带收紧了基线，收紧一定会打印）
//   1  有回归：某文件的裸值数**高于**基线
//   2  没有基线文件 ⇒ 先跑 `--update-baseline`（这不是「通过」）
//   3  用法错误 / 一个扫描根都找不到 / **守卫自己抛异常**（三者对消费方是同一件事：
//      **这次没有结论**）。特别是最后一种：node 未捕获异常默认 exit 1，而 1 在这里是
//      「有回归」⇒ 不接管的话，一次崩溃会被读成「有人加了裸值」，人去追一个不存在的违规。
//   4  🔴 基线与规则脱节（指纹不一致，或旧格式基线且比对不过）⇒ 重建基线，别去追违规
//   5  自检失败：扫描面塌陷（普查有文件、扫描器零文件）或基线落在自己扫描面内
//
// ── 用法 ───────────────────────────────────────────────────────────────────
//   node scripts/check-token-drift.mjs                  棘轮比对（默认）
//   node scripts/check-token-drift.mjs --update-baseline 重建基线（写指纹）
//   node scripts/check-token-drift.mjs --strict          零容忍（不看基线）
//   node scripts/check-token-drift.mjs --distribution    全域分布摸底（不判定，恒 exit 0）
//   node scripts/check-token-drift.mjs --selfcheck       我瞎了吗 / 有没有人调用我
//   附加：--no-tighten（禁自动收紧）  --roots a,b（覆盖扫描根）  --json
//
// ── 三条判据都是近似，照直写（禁笃定措辞）─────────────────────────────────
// ① 正则认的是**文本形态**，不是语义：`gap-[3px]` 与注释外的 `3px` 一样命中；
//    模板字符串里拼出来的 `${n}px` 不命中。两个方向都构造得出反例。
// ② 排除项（注释行 / CSS 变量定义行 / svg data-uri / @keyframes / 滚动条伪元素 /
//    `hsl(var(--x))`）是**按行**判的，跨行写法逃得掉。
// ③ 扫描根自动发现按目录名猜，非常规布局（如 `client/`、`www/`）探不到 ⇒ **漏报**。
//    失败方向刻意选漏报：误报会训练人把整道闸关掉，漏报至少不会。
//    对策不是加更多猜测，是 `.token-drift.json` 显式写死。

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, relative, resolve, sep } from "node:path";

export const CANONICAL_VERSION = "1.0.0";
// 规则版本：**改了下面任何一条检测/排除规则就手动 +1**。它进指纹，故也可以不改
// （源码一变指纹自然变），留着是为了让「这次是有意改规则」在 git diff 上说得出口。
const RULES_VERSION = 1;

const BASELINE_NAME = ".token-drift-baseline.json";
const CONFIG_NAME = ".token-drift.json";
const EXTENSIONS = [".tsx", ".jsx", ".ts", ".css", ".vue", ".svelte"];

// 扫描根候选（相对项目根）。apps/* 与 packages/* 另行展开，见 discoverRoots()。
const ROOT_CANDIDATES = [
  "src", "app/src", "ui/src", "web/src", "www/src",
  "src-ui/src", "src-ui", "frontend/src", "renderer/src", "client/src",
];
const SKIP_DIRS = new Set([
  ".git", "node_modules", "dist", "build", "out", "target", "coverage",
  "_tmp", ".turbo", ".next", ".nuxt", ".svelte-kit", "storybook-static", "__snapshots__",
]);
const WALK_MAX_DEPTH = 12;

// ── 检测规则（改这一段即改指纹）────────────────────────────────────────────
const PX_RE = /(?<!\w)(\d+\.?\d*)px\b/g;
const HEX_RE = /#([0-9a-fA-F]{3,8})\b/g;
const COLOR_FN_RE = /\b(hsla?|rgba?)\s*\(/g;

export function isCommentLine(line) {
  const t = line.trim();
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*") || t.startsWith("<!--");
}
export function isCssVarDef(line) {
  return /--[\w-]+\s*:/.test(line);
}
export function hasSvgDataUri(line) {
  return line.includes("data:image/svg+xml");
}
export function isDynamicColorFn(line, matchIndex) {
  return /^(?:hsla?|rgba?)\s*\(\s*var\s*\(/.test(line.slice(matchIndex));
}

// 指纹：规则一变就变。**不含项目内容**，只含「我是按什么规则看的」。
export function rulesFingerprint(roots) {
  const material = JSON.stringify({
    v: RULES_VERSION,
    px: PX_RE.source, hex: HEX_RE.source, fn: COLOR_FN_RE.source,
    ext: EXTENSIONS.slice().sort(),
    roots: roots.slice().sort(),
    skip: [...SKIP_DIRS].sort(),
    ex: [isCommentLine, isCssVarDef, hasSvgDataUri, isDynamicColorFn].map((f) => f.toString()),
  });
  return "sha256:" + createHash("sha256").update(material).digest("hex").slice(0, 32);
}

// ── 违例检测 ────────────────────────────────────────────────────────────────
export function detectViolations(content, filePath) {
  const violations = [];
  const lines = content.split("\n");
  const isStyleSheet = /\.(css|vue|svelte)$/i.test(filePath);

  let inKeyframes = false;
  let inScrollbar = false;
  let braceDepth = 0;
  let blockStart = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (isStyleSheet) {
      // `opened` 记「这一行开了一个豁免块」。没有它的话，**单行写法会逃出豁免**：
      // `@keyframes spin { from { top: 4px } }` 的花括号在同一行收支平衡 ⇒ 走到行末
      // inKeyframes 已被复位 ⇒ 该行照样被扫。豁免与否取决于作者敲不敲回车，是不能接受的。
      let opened = false;
      if (/^@keyframes\s/.test(trimmed)) { inKeyframes = true; blockStart = braceDepth; opened = true; }
      if (!inKeyframes && !inScrollbar && /::-webkit-scrollbar/.test(trimmed)) {
        inScrollbar = true; blockStart = braceDepth; opened = true;
      }
      for (const ch of line) {
        if (ch === "{") braceDepth++;
        else if (ch === "}") {
          braceDepth--;
          if ((inKeyframes || inScrollbar) && braceDepth <= blockStart) {
            inKeyframes = false; inScrollbar = false;
          }
        }
      }
      if (inKeyframes || inScrollbar || opened) continue;
      if (/^\s*scrollbar-(width|color)\s*:/.test(line)) continue;
    }

    if (isCommentLine(line)) continue;
    if (isCssVarDef(line)) continue;
    if (hasSvgDataUri(line)) continue;

    let m;
    PX_RE.lastIndex = 0;
    while ((m = PX_RE.exec(line)) !== null) {
      if (m[1] === "0") continue; // 0px 与 0 等价，不是设计值
      violations.push({ file: filePath, line: i + 1, value: m[0], context: trimmed, type: "px" });
    }
    HEX_RE.lastIndex = 0;
    while ((m = HEX_RE.exec(line)) !== null) {
      violations.push({ file: filePath, line: i + 1, value: m[0], context: trimmed, type: "hex" });
    }
    COLOR_FN_RE.lastIndex = 0;
    while ((m = COLOR_FN_RE.exec(line)) !== null) {
      if (!isDynamicColorFn(line, m.index)) {
        violations.push({ file: filePath, line: i + 1, value: m[0], context: trimmed, type: "hsl-rgb" });
      }
    }
  }
  return violations;
}

const isTestFile = (p) => /\.(test|spec)\./.test(p) || /(^|\/)__(tests|mocks)__\//.test(p);

// ── 遍历 A：扫描器本体（手写递归 + 显式 skip）─────────────────────────────
export function collectFiles(root, projectRoot) {
  const out = [];
  const walk = (dir, depth) => {
    if (depth > WALK_MAX_DEPTH) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        walk(full, depth + 1);
      } else if (e.isFile() && EXTENSIONS.some((x) => e.name.toLowerCase().endsWith(x))) {
        const rel = relative(projectRoot, full).split(sep).join("/");
        if (!isTestFile(rel)) out.push(rel);
      }
    }
  };
  walk(root, 0);
  return out;
}

// ── 遍历 B：普查（**刻意另一套实现**，见头注「自检那一半」）────────────────
// 这里用 readdirSync 的 recursive 选项，与遍历 A 的手写递归无共享代码路径。
// 两者同时瞎掉的概率不是零，但它们不会**因为同一处改动**一起瞎 —— 那才是重点。
export function censusFiles(root, projectRoot) {
  let entries;
  try { entries = readdirSync(root, { recursive: true, encoding: "utf-8" }); } catch { return []; }
  const out = [];
  for (const entry of entries) {
    const norm = String(entry).split(/[\\/]/);
    if (norm.some((seg) => SKIP_DIRS.has(seg))) continue;
    const name = norm[norm.length - 1].toLowerCase();
    if (!EXTENSIONS.some((x) => name.endsWith(x))) continue;
    const rel = relative(projectRoot, join(root, String(entry))).split(sep).join("/");
    if (isTestFile(rel)) continue;
    let st;
    try { st = statSync(join(root, String(entry))); } catch { continue; }
    if (st.isFile()) out.push(rel);
  }
  return out;
}

// ── 扫描根发现 ──────────────────────────────────────────────────────────────
export function discoverRoots(projectRoot) {
  const cfgPath = join(projectRoot, CONFIG_NAME);
  if (existsSync(cfgPath)) {
    try {
      const cfg = JSON.parse(readFileSync(cfgPath, "utf-8"));
      if (Array.isArray(cfg.roots) && cfg.roots.length) {
        return { roots: cfg.roots.filter((r) => existsSync(join(projectRoot, r))), via: CONFIG_NAME };
      }
    } catch { /* 配置坏了不当致命：落回自动发现，并在报告里说出来 */ }
  }
  const found = [];
  const push = (rel) => {
    if (!found.includes(rel) && existsSync(join(projectRoot, rel))) found.push(rel);
  };
  for (const c of ROOT_CANDIDATES) push(c);
  for (const mono of ["apps", "packages"]) {
    let subs;
    try { subs = readdirSync(join(projectRoot, mono), { withFileTypes: true }); } catch { continue; }
    for (const s of subs) {
      if (!s.isDirectory() || SKIP_DIRS.has(s.name)) continue;
      push(`${mono}/${s.name}/src`);
    }
  }
  // 去掉被其它根包含的子根，避免同一文件被计两遍
  const roots = found.filter((r) => !found.some((o) => o !== r && r.startsWith(o + "/")));
  return { roots, via: "自动发现" };
}

// ── 基线 ────────────────────────────────────────────────────────────────────
export function buildCounts(violations) {
  const counts = {};
  for (const v of violations) counts[v.file] = (counts[v.file] ?? 0) + 1;
  return counts;
}

// 兼容旧格式（裸 {path: n} 映射，无指纹）：能读，但指纹标记为 null。
export function readBaseline(p) {
  if (!existsSync(p)) return null;
  let j;
  try { j = JSON.parse(readFileSync(p, "utf-8")); } catch (e) { return { broken: e.message }; }
  if (j && typeof j === "object" && !Array.isArray(j) && j.counts && typeof j.counts === "object") {
    return { counts: j.counts, fingerprint: j.rulesFingerprint || null, legacy: false, generatedAt: j.generatedAt };
  }
  if (j && typeof j === "object" && !Array.isArray(j)) {
    return { counts: j, fingerprint: null, legacy: true };
  }
  return { broken: "基线不是对象" };
}

export function writeBaseline(p, counts, fingerprint, roots) {
  const body = {
    _note: "棘轮基线。counts 只降不升（自动收紧）；rulesFingerprint 变了说明扫描规则变了，" +
           "此时不要去追「回归」，跑 --update-baseline 重建。真相源 windsurf-dao ccswitch/templates/check-token-drift.mjs",
    canonicalVersion: CANONICAL_VERSION,
    rulesFingerprint: fingerprint,
    generatedAt: new Date().toISOString(),
    roots,
    counts,
  };
  writeFileSync(p, JSON.stringify(body, null, 2) + "\n");
}

export function compare(violations, baselineCounts) {
  const current = buildCounts(violations);
  const regressions = [];
  const newViolations = [];
  for (const [file, count] of Object.entries(current)) {
    const allowed = baselineCounts[file] ?? 0;
    if (count > allowed) {
      regressions.push({ file, was: allowed, now: count });
      newViolations.push(...violations.filter((v) => v.file === file).slice(allowed));
    }
  }
  // 棘轮的另一半：能收紧的与已消失的
  const tightened = [];
  const stale = [];
  for (const [file, allowed] of Object.entries(baselineCounts)) {
    const now = current[file] ?? 0;
    if (now === 0) stale.push(file);
    else if (now < allowed) tightened.push({ file, was: allowed, now });
  }
  return { current, regressions, newViolations, tightened, stale };
}

// ── CLI ─────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const isDirectRun = (process.argv[1] || "").replace(/\\/g, "/").includes("check-token-drift");

function flagValue(name) {
  const hit = argv.find((a) => a.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1) : null;
}

function main() {
  const projectRoot = resolve(flagValue("--project") || process.cwd());
  const out = (s) => process.stdout.write(s + "\n");

  const rootsOverride = flagValue("--roots");
  const discovered = rootsOverride
    ? { roots: rootsOverride.split(",").map((s) => s.trim()).filter(Boolean), via: "--roots" }
    : discoverRoots(projectRoot);
  const roots = discovered.roots;

  if (!roots.length) {
    out(`✗ 一个扫描根都没找到（试过：${ROOT_CANDIDATES.join(", ")} + apps/*/src + packages/*/src）`);
    out(`  ⇒ 这是「没查」，不是「查了没事」。在项目根写 ${CONFIG_NAME}：{"roots":["你的前端源码目录"]}`);
    out("TOKEN_DRIFT_SUMMARY exit=3 roots=0 files=0 violations=0");
    process.exit(3);
  }

  // 输出面外硬断言：基线不能落在自己的扫描面内。
  // **按绝对路径判，不按字符串前缀判** —— `--roots=.` 这种写法用前缀比法恰好逃得掉
  // （`".token-drift-baseline.json".startsWith("./")` 是 false），而 `.` 恰恰是最坏的那个根。
  const baselinePath = join(projectRoot, BASELINE_NAME);
  const baselineAbs = resolve(baselinePath);
  const inScan = roots.find((r) => {
    const rootAbs = resolve(projectRoot, r);
    return baselineAbs === rootAbs || baselineAbs.startsWith(rootAbs.endsWith(sep) ? rootAbs : rootAbs + sep);
  });
  if (inScan) {
    out(`✗ 自检失败：基线文件 ${BASELINE_NAME} 落在扫描根 ${inScan} 之内 —— 检查器的输出成了自己的输入。`);
    out("  ⇒ 报告成为下一轮的输入，每跑一次命中更多，而那个增长看起来像「问题在恶化」。");
    out("TOKEN_DRIFT_SUMMARY exit=5 reason=output-in-scan-surface");
    process.exit(5);
  }

  // 两套遍历，做集合差（自检那一半）
  const scanned = new Set();
  const censused = new Set();
  for (const r of roots) {
    for (const f of collectFiles(join(projectRoot, r), projectRoot)) scanned.add(f);
    for (const f of censusFiles(join(projectRoot, r), projectRoot)) censused.add(f);
  }
  const missedByScanner = [...censused].filter((f) => !scanned.has(f));
  const missedByCensus = [...scanned].filter((f) => !censused.has(f));

  if (scanned.size === 0 && censused.size > 0) {
    out(`✗ 自检失败：扫描器看到 0 个文件，而独立普查看到 ${censused.size} 个 ⇒ 扫描面塌陷（我瞎了）。`);
    out("TOKEN_DRIFT_SUMMARY exit=5 reason=zero-sample");
    process.exit(5);
  }

  const violations = [];
  for (const rel of scanned) {
    let content;
    try { content = readFileSync(join(projectRoot, rel), "utf-8"); } catch { continue; }
    violations.push(...detectViolations(content, rel));
  }

  const selfLines = [
    `扫描根（${discovered.via}）：${roots.join(", ")}`,
    `文件数：扫描器 ${scanned.size} / 独立普查 ${censused.size}` +
      (missedByScanner.length || missedByCensus.length
        ? `　⚠ 集合差 ${missedByScanner.length}/${missedByCensus.length}：${[...missedByScanner, ...missedByCensus].slice(0, 5).join(", ")}`
        : "　（集合差 0）"),
    `裸值总数：${violations.length}`,
  ];

  // ── --distribution：全域分布摸底（恒 exit 0，只是看，不判定）──────────────
  if (argv.includes("--distribution")) {
    const byDir = {};
    for (const v of violations) {
      const d = v.file.split("/").slice(0, 3).join("/");
      byDir[d] = (byDir[d] ?? 0) + 1;
    }
    const top = Object.entries(byDir).sort((a, b) => b[1] - a[1]).slice(0, 15);
    out(`\n=== 全域分布摸底 · ${projectRoot} ===`);
    for (const l of selfLines) out("  " + l);
    out("\n  Top 目录（前 3 段路径）：");
    for (const [d, n] of top) out(`    ${String(n).padStart(5)}  ${d}`);
    const byType = {};
    for (const v of violations) byType[v.type] = (byType[v.type] ?? 0) + 1;
    out(`\n  按类型：${Object.entries(byType).map(([k, n]) => `${k}=${n}`).join(" ")}`);
    out(`  规则指纹：${rulesFingerprint(roots)}`);
    out(`TOKEN_DRIFT_SUMMARY exit=0 mode=distribution roots=${roots.length} files=${scanned.size} violations=${violations.length}`);
    process.exit(0);
  }

  // ── --selfcheck：我瞎了吗 / 有没有人调用我 ───────────────────────────────
  if (argv.includes("--selfcheck")) {
    out(`\n[check-token-drift --selfcheck] canonical=${CANONICAL_VERSION} rules=v${RULES_VERSION}`);
    for (const l of selfLines) out("  · " + l);
    const b = readBaseline(baselinePath);
    out("  · 基线：" + (!b ? "不存在（先 --update-baseline）"
      : b.broken ? `读不动（${b.broken}）`
      : b.legacy ? "旧格式（无指纹）—— 下次通过时会自动升级"
      : b.fingerprint === rulesFingerprint(roots) ? "指纹一致" : "🔴 指纹不一致 ⇒ 规则已变，基线过期"));
    // 「文件在盘上」≠「有人跑它」：查 package.json 有没有入口调用它
    let wired = null;
    try {
      const pkg = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf-8"));
      wired = Object.entries(pkg.scripts || {}).filter(([, v]) => String(v).includes("check-token-drift"));
    } catch { /* 无 package.json 的项目跳过这一问 */ }
    out("  · 调用入口：" + (wired === null ? "无 package.json，未判"
      : wired.length ? wired.map(([k]) => `pnpm ${k}`).join(" / ")
      : "🔴 package.json 里没有任何脚本调用它 —— 守卫在盘上 ≠ 守卫在跑"));
    const bad = (wired !== null && wired.length === 0) || missedByScanner.length > 0;
    out(`TOKEN_DRIFT_SUMMARY exit=${bad ? 1 : 0} mode=selfcheck files=${scanned.size} violations=${violations.length}`);
    process.exit(bad ? 1 : 0);
  }

  const fingerprint = rulesFingerprint(roots);

  // ── --update-baseline ──────────────────────────────────────────────────
  if (argv.includes("--update-baseline")) {
    const counts = buildCounts(violations);
    writeBaseline(baselinePath, counts, fingerprint, roots);
    out(`✅ 基线已重建：${violations.length} 处裸值，分布在 ${Object.keys(counts).length} 个文件。`);
    out(`   规则指纹 ${fingerprint} 已写入 —— 下次规则再变会被认出来，而不是变成一片假回归。`);
    out(`TOKEN_DRIFT_SUMMARY exit=0 mode=update-baseline files=${scanned.size} violations=${violations.length}`);
    process.exit(0);
  }

  // ── --strict ───────────────────────────────────────────────────────────
  if (argv.includes("--strict")) {
    if (violations.length === 0) {
      out(`✅ strict 通过 —— ${scanned.size} 个文件零裸值。`);
      out(`TOKEN_DRIFT_SUMMARY exit=0 mode=strict files=${scanned.size} violations=0`);
      process.exit(0);
    }
    out(`\n❌ strict：${violations.length} 处裸值\n`);
    for (const v of violations.slice(0, 200)) out(`  ${v.file}:${v.line} [${v.type}] "${v.value}"`);
    if (violations.length > 200) out(`  …另有 ${violations.length - 200} 处`);
    out(`TOKEN_DRIFT_SUMMARY exit=1 mode=strict files=${scanned.size} violations=${violations.length}`);
    process.exit(1);
  }

  // ── 默认：棘轮比对 ──────────────────────────────────────────────────────
  const baseline = readBaseline(baselinePath);
  if (!baseline) {
    out(`⚠️  没有基线文件 ${BASELINE_NAME}。当前 ${violations.length} 处裸值。`);
    out("   先跑 `--update-baseline`。**这不是「通过」** —— 没基线的棘轮不是棘轮。");
    out(`TOKEN_DRIFT_SUMMARY exit=2 mode=ratchet files=${scanned.size} violations=${violations.length}`);
    process.exit(2);
  }
  if (baseline.broken) {
    out(`✗ 基线读不动：${baseline.broken} ⇒ 跑 --update-baseline 重建。`);
    out("TOKEN_DRIFT_SUMMARY exit=4 mode=ratchet reason=baseline-unreadable");
    process.exit(4);
  }

  const cmp = compare(violations, baseline.counts);

  // 🔴 L12 专用出口：规则脱节。放在「报回归」之前 —— 顺序即判据。
  if (baseline.fingerprint && baseline.fingerprint !== fingerprint) {
    out("\n🔴 基线与扫描规则脱节（规则指纹不一致）");
    out(`   基线指纹 ${baseline.fingerprint}`);
    out(`   当前指纹 ${fingerprint}`);
    out(`   ⇒ 现在这份比对**说明不了任何事**：规则一变，全库计数同时跳变，`);
    out("      「真回归」与「换了把尺子」在输出上长得一模一样（事故账 L12：恒红多日、真回归被掩护）。");
    out("   → 唯一正确动作：`--update-baseline` 重建基线，并在 commit message 里写清改了哪条规则。");
    out(`TOKEN_DRIFT_SUMMARY exit=4 mode=ratchet reason=rules-drift files=${scanned.size} violations=${violations.length}`);
    process.exit(4);
  }
  if (!baseline.fingerprint && cmp.regressions.length > 0) {
    out("\n🔴 旧格式基线（无规则指纹）且比对不过 —— **无从分辨**这是真回归还是规则变过。");
    out(`   ${cmp.regressions.length} 个文件计数上升。先确认扫描规则没动过，再 --update-baseline。`);
    out(`TOKEN_DRIFT_SUMMARY exit=4 mode=ratchet reason=legacy-baseline files=${scanned.size} violations=${violations.length}`);
    process.exit(4);
  }

  if (cmp.regressions.length > 0) {
    out(`\n❌ 裸值回归：${cmp.regressions.length} 个文件计数上升\n`);
    for (const r of cmp.regressions) out(`  ${r.file}: ${r.was} → ${r.now} (+${r.now - r.was})`);
    out("\n新增：\n");
    for (const v of cmp.newViolations.slice(0, 100)) {
      out(`  ${v.file}:${v.line} [${v.type}] "${v.value}"`);
      out(`    ${v.context}\n`);
    }
    out(`TOKEN_DRIFT_SUMMARY exit=1 mode=ratchet files=${scanned.size} violations=${violations.length}`);
    process.exit(1);
  }

  // 通过 ⇒ 棘轮往低了拧（只降不升），顺带剪掉已消失的条目
  const total = violations.length;
  // `--no-tighten` 是**一条只读承诺**：它一旦给出，本次运行绝不写基线 —— 含旧格式升级。
  // （一个说好不写的模式偷偷写一次，比不提供这个模式更糟：CI 只读环境里那次写入会静默失败或产生脏工作区。）
  const readOnly = argv.includes("--no-tighten");
  const hasSlack = cmp.tightened.length > 0 || cmp.stale.length > 0;
  const lines = [];
  if (!readOnly && (hasSlack || baseline.legacy)) {
    writeBaseline(baselinePath, cmp.current, fingerprint, roots);
    if (hasSlack) {
      lines.push(`   🔧 棘轮已收紧（只降不升）：${cmp.tightened.length} 个文件下调` +
        (cmp.stale.length ? `，${cmp.stale.length} 个已清零/已删除的条目被剪掉` : "") + "。");
    }
    if (baseline.legacy) {
      lines.push("   ⬆ 旧格式基线已升级为带指纹格式（本次比对通过 ⇒ 规则未脱节，可安全盖章）。");
    }
  } else if (hasSlack || baseline.legacy) {
    lines.push(`   ⓘ 可收紧 ${cmp.tightened.length} 个、可剪 ${cmp.stale.length} 个` +
      (baseline.legacy ? "、基线仍是旧格式" : "") + "（--no-tighten 生效中，基线未写）。");
  }
  const tightenedLine = lines.join("\n");

  out(`✅ 棘轮通过 —— 无新增裸值（存量 ${total} 处 / ${scanned.size} 个文件）。`);
  if (tightenedLine) out(tightenedLine);
  if (missedByScanner.length) out(`   ⚠ 自检：独立普查多看到 ${missedByScanner.length} 个文件，扫描面可能有洞：${missedByScanner.slice(0, 5).join(", ")}`);
  out(`TOKEN_DRIFT_SUMMARY exit=0 mode=ratchet files=${scanned.size} violations=${total} tightened=${cmp.tightened.length} stale=${cmp.stale.length}`);
  process.exit(0);
}

// 崩了不许伪装成 exit 1。**未捕获异常的默认退出码恰好是 1，而 1 在本文件的契约里
// 是「有回归」** ⇒ 一次 ReferenceError 会被 CI 读成「有人加了裸值」，人去追一个不存在的违规。
// （不是假想：本文件的自指断言第一版就崩过一次，回归网当场把它抓出来。）
// 归 3（「没查成」）与「找不到扫描根」同码 —— 两者对消费方是同一件事：**这次没有结论**。
if (isDirectRun) {
  try {
    main();
  } catch (e) {
    process.stdout.write("✗ 守卫自身抛错（这**不是**代码里有裸值）：" + (e && e.stack ? e.stack : String(e)) + "\n");
    process.stdout.write("TOKEN_DRIFT_SUMMARY exit=3 reason=crash\n");
    process.exit(3);
  }
}
