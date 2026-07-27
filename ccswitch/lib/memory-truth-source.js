// memory-truth-source.js —— memory 一致性检查的**最窄那一档**
//
// ── 它治什么，以及刻意不治什么 ───────────────────────────────────────────────
// 病灶（2026-07-27 mousse-cli WORKBOARD「memory 系统零检查覆盖」，抽查 3 处全中）：
// `~/.claude/projects/<slug>/memory/*.md` 每次会话自动注入，却**跨仓、且不在任何
// git 仓内** —— `run-tests.mjs` / `verify-all.ps1` / `scaffold-check` 三套检查
// 没有一套跑到它。被引用方改名/改行为，引用方无任何机制被通知。
//
// **本模块只做 issue #256 的候选 C：只比对「memory 里显式声明了真相源」的段落。**
// 理由（这一句是本模块存在的全部依据，改判据前先读它）：
//   **memory 是时间点观察，「过期」是常态不是缺陷。** 一条 memory 记「当时我们决定 X」，
//   半年后 X 变了，那条 memory 依旧是对那一刻的忠实记录。做全量陈旧检测等于把
//   「记录」当成「规范」来审，会产出海量噪音并把真信号淹掉。
//   要检的只有一类：**它引用了一个外部真相源，却与那个源当前的状态矛盾。**
//   那不是「过期」，是**指向空气的指针**——读者以为有兜底，而那一面永远静默。
//
// ── 判据（三段，逐段都近似，两个方向的反例都写明）────────────────────────────
//   ① **声明识别**：行内出现真相源关键词（见 DECL_KEYWORDS）即判为「声明行」。
//      · 会漏：用别的措辞表达同一件事（"以 X 为唯一依据" / "canonical"）不认。
//      · 会误认：正文在**讨论**真相源这个概念（而非声明某个源）也会被认成声明行。
//      两侧都构造得出反例 ⇒ 这是启发式不是判定。误认的代价被②③压得很低。
//   ② **段落取范围**：声明行所在的「连续非空行块」。取段落而非取行，是因为实测形态
//      多是「一行声明 + 紧跟几行 bullet 列举该源下的东西」（`dao-claude-migration.md:12-15`
//      即如此），只看声明行会漏掉 bullet 里那些真正会腐烂的路径。
//      · 会漏：源与其列举被空行隔开时，列举那半不查。
//      · 会多取：同一块里恰好还有一条与真相源无关的路径，也会被查——它若真不存在，
//        报出来通常仍有价值，但归因文案会指向"真相源"这个不准确的由头。
//   ③ **路径解析**：只认反引号里的 token，且须"看起来像路径"（含分隔符或带已知后缀）。
//      解析基址依次尝试：绝对路径原样 → `~/` 展开 → 项目根 → 声明行自己声明的那个目录源
//      → **HOME** → **所有已知项目根的父目录**。全都解析不到才算一条 finding。
//      后两级基址是首次实跑（2026-07-27）按真实误报补的，两条都写明它换来了什么、赔了什么：
//        · **HOME**：memory 里写 `.claude\backups\…` 这种省掉 `~/` 的相对路径很常见。
//          补它消掉 1 处误报。赔的是：真有一个同名文件躺在 HOME 下时会假装解析成功。
//          **刻意不把 `~/.claude` 也做成基址**——那会让 `skills/dao-*/` 从
//          `~/.claude/skills/` 解析成功，正好盖掉本轮要抓的那类真陈旧（部署产物存在
//          不等于源还在原处）。这一条是有意为之的取舍，不是漏了。
//        · **项目根的父目录**：memory 里用裸仓名指邻仓（`windsurf-dao/ccswitch/hooks/…`）
//          同样常见。补它消掉 3 处误报。赔的是：邻仓恰好有同路径时会掩盖本仓的缺失。
//   ④ **发现分两类，不混为一谈**（2026-07-27 首次实跑后加，因为混着报会让人误判严重度）：
//        · `dead` —— 判定基址里解析不到，**并且**在本机任何一个已知项目根下也解析不到。
//          这才是"指针指向空气"。
//        · `ambiguous` —— 判定基址里解析不到，但换到**另一个**已知项目根下就能解析到。
//          它多半不是陈旧，是**没写清相对于谁**（例：mousse-cli 的 memory 里写
//          `config-sync/common/mcp_servers.json`，实际在 windsurf-dao 下）。
//          处方也不同：dead 要改内容，ambiguous 要把路径写全。
//      **刻意不把「其他项目根」并进判定基址**去让 ambiguous 直接消失——那等于承认
//      "只要盘上任何地方有个同名路径就算数"，会把真陈旧一并盖掉（`stacks/` 这类通用
//      目录名在多仓里同名的概率不低）。宁可报出来并标明它属哪一类。
//      实测（2026-07-27 本机）：补 HOME/父目录两级基址前 12 处，补后 10 处
//      （8 dead + 2 ambiguous）。**这些数字是一次性样本，不宜外推。**
//      · 会漏：路径写在反引号外（裸文本）不查——刻意的，裸文本误判率高到不可用。
//      · 会漏：含 `...` 的省略写法一律跳过（那多半是"旧的那个 D:/…/claude/… 已 MISSING"
//        这类**刻意提及死路径**的行文，报它是纯误伤；实测 `claude-settings-self-heal.md`
//        就是这个形态）。代价是真的写了省略号的活路径也不查。
//      · 会误报：路径存在于另一台机器/另一个 checkout 时，本机报缺。**这正是本检查
//        必须是观察线而不是硬闸的原因之一**（见下）。
//
// ── 闸位：观察线，不是硬闸（照 dispatch-clauses 通用节「新增机检项先判闸位」）──
//   findings 恒不参与退出码。三条理由，缺一条我都会选硬闸：
//   ① **修复目标不在仓里**。memory 在 `~/.claude/` 下、不受任何 git 管。仓里的人把仓
//      改成什么样都消不掉这个红 ⇒ 永久红 ⇒ 被跳过 ⇒ 连带废掉本检查的自检那一半。
//      （同一条推理已在 mousse-cli `check-only-user.ps1` 的「为什么积压数不设阈值」用过一次。）
//   ② **它依赖机器本地状态**，换台机器同一份仓库结论就不同。把不可复现的东西做成硬闸，
//      得到的是"谁跑谁红"而不是质量。
//   ③ 结论的形态是「**你该去看一眼这条 memory 还对不对**」——那是人的判断。
//      做成硬闸只会逼出为过闸而敷衍的修改（把声明句删掉最省事，而那是最坏的修法）。
//   **硬的那一半**：本模块自身的契约（解析/解析基址/glob）由 `tests/memory-truth-source.tests.js`
//   用固定 fixture 断言，那部分是真硬闸——"检查器自己坏了"有客观对错。
//
// ── 已知不覆盖面（显式写出来，别当它是全集）──────────────────────────────────
//   · **行为类声明查不了**。例：`MEMORY.md` 里「codex/claude 双链共用 skills」被 `29e08cb`
//     证伪——那是一句**关于行为的断言**，不是一个路径。本模块只验"指针指到了东西"，
//     不验"指到的东西说的是不是这回事"。后者需要语义比对，不在最窄那一档里。
//   · **计数类声明查不了**（"skills 39 / commands 11 / agents 8"）。它们可机检，但需要
//     把"这个 glob 的计数应等于 N"变成一条判据，属另一档，本模块不做。
//   · 只扫 `.md`。memory 目录里若出现别的载体一律不看。

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const HOME = process.env.USERPROFILE || process.env.HOME || os.homedir();
const DEFAULT_MEMORY_ROOT = path.join(HOME, ".claude", "projects");

// 真相源声明的关键词。加词前先想清楚它在别的语境里是不是也常出现——
// 本表刻意短：多一个模糊词，段落取范围就多一片噪音（判据①的误认那一侧）。
const DECL_KEYWORDS = ["真相源", "唯一真相", "唯一源", "唯一依据", "source of truth"];

// "看起来像路径"的后缀白名单。不在表内且不含分隔符的 token 一律不当路径
// （否则 `common_config_claude.hooks`、`PromptTemplate` 这类会被当成文件名去查）。
const PATH_EXTS = [
  ".md", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".json", ".jsonc",
  ".ps1", ".psm1", ".bat", ".cmd", ".sh", ".py", ".rs", ".toml", ".yml",
  ".yaml", ".html", ".css", ".scss", ".sql", ".txt",
];

function isBlank(s) {
  return String(s).trim() === "";
}

/** 反引号 token 抽取（只认单反引号包裹的一段，不含换行） */
function backtickTokens(line) {
  const out = [];
  const re = /`([^`\n]+)`/g;
  let m;
  while ((m = re.exec(line)) !== null) out.push(m[1]);
  return out;
}

/**
 * token 是否"看起来像路径"。
 * 近似，两向都可构造反例：含空格的真实路径会被漏掉（刻意——含空格的 token 里
 * 混着散文的概率远高于是路径的概率）；而形如 `a/b` 的非路径记号会被误当路径。
 */
function looksLikePath(tok) {
  const t = String(tok).trim();
  if (!t) return false;
  if (/\s/.test(t)) return false;                 // 含空白：多半是句子片段
  if (/[()<>"'|?]/.test(t)) return false;          // 含这些字符：多半是命令/表达式
  if (t.startsWith("$") || t.startsWith("-")) return false; // 变量 / 命令行开关
  if (t.includes("...") || t.includes("…")) return false;   // 省略写法，见头注判据③
  if (t.includes("/") || t.includes("\\")) return true;
  const lower = t.toLowerCase();
  return PATH_EXTS.some((e) => lower.endsWith(e));
}

function isAbsolute(tok) {
  return /^[A-Za-z]:[\\/]/.test(tok) || tok.startsWith("\\\\") || tok.startsWith("/");
}

/** 极简 glob：只支持单段内的 `*`，不支持 `**`。够用且行为可预测。 */
function globExists(absPattern) {
  const norm = absPattern.replace(/\\/g, "/").replace(/\/+$/, "");
  const segs = norm.split("/");
  if (!segs.length) return false;
  let bases = [segs[0].length ? segs[0] : "/"];
  for (let i = 1; i < segs.length; i++) {
    const seg = segs[i];
    if (!seg) continue;
    const next = [];
    for (const b of bases) {
      if (!seg.includes("*")) {
        const p = path.join(b, seg);
        if (fs.existsSync(p)) next.push(p);
        continue;
      }
      const re = new RegExp("^" + seg.split("*").map(escapeRe).join("[^/\\\\]*") + "$", "i");
      let entries = [];
      try { entries = fs.readdirSync(b); } catch (_) { entries = []; }
      for (const e of entries) if (re.test(e)) next.push(path.join(b, e));
    }
    bases = next;
    if (!bases.length) return false;
  }
  return bases.length > 0;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function pathOrGlobExists(p) {
  if (p.includes("*")) return globExists(p);
  try { return fs.existsSync(p); } catch (_) { return false; }
}

/**
 * slug（`D--frank-mousse-cli`）→ 项目根。
 *
 * **不做字符串反解**：slug 把 `:` 与 `\` 都压成 `-`，而目录名本身也可以含 `-`
 * （`mousse-cli` 就是），字符串层面**结构上是歧义的**（`D--frank-mousse-cli` 既可读作
 * `D:\frank\mousse-cli` 也可读作 `D:\frank\mousse\cli`）。故改为**照着盘上真实目录走**：
 * 每一层取"能匹配上剩余串的最长目录名"。盘上不存在该项目时返回 null（不猜）。
 *
 * **已知边界（有测试钉住，见 tests 的「最长匹配走错」用例）**：同一层若同时存在 `mousse`
 * 与 `mousse-cli` 两个目录，而 slug 的真值是 `mousse\cli`，最长匹配会解成 `mousse-cli`。
 * 这个方向的错误无法只靠 slug 本身消除（信息在编码时就丢了），故不修，只钉住行为。
 *
 * startOverride：测试注入用，替换掉「从盘符根开始」这一步，使 fixture 不必真占一个盘符。
 */
function decodeSlug(slug, startOverride) {
  const m = /^([A-Za-z])--(.*)$/.exec(slug);
  if (!m) return null;
  let cur = startOverride || (m[1] + ":\\");
  let rest = m[2];
  if (!fs.existsSync(cur)) return null;
  while (rest.length) {
    let entries = [];
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch (_) { return null; }
    const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    let best = null;
    for (const d of dirs) {
      if (rest === d || rest.startsWith(d + "-")) {
        if (!best || d.length > best.length) best = d;
      }
    }
    if (!best) return null;
    cur = path.join(cur, best);
    rest = rest === best ? "" : rest.slice(best.length + 1);
  }
  return cur;
}

/** 把 memory 文件切成段落（连续非空行块），并标出哪些段落含真相源声明 */
function declarationParagraphs(lines) {
  const paras = [];
  let cur = null;
  for (let i = 0; i < lines.length; i++) {
    if (isBlank(lines[i])) { cur = null; continue; }
    if (!cur) { cur = { start: i + 1, lines: [] }; paras.push(cur); }
    cur.lines.push({ lineNo: i + 1, text: lines[i] });
  }
  const out = [];
  for (const p of paras) {
    const decl = p.lines.filter((l) => DECL_KEYWORDS.some((k) => l.text.includes(k)));
    if (decl.length) out.push({ start: p.start, lines: p.lines, declLines: decl });
  }
  return out;
}

/**
 * 解析一个 token。bases 按顺序尝试；任一命中即算解析成功。
 * 返回 { ok, resolved, tried }
 */
function resolveToken(tok, bases) {
  const tried = [];
  const t = tok.replace(/^\.\//, "");
  if (t.startsWith("~/") || t.startsWith("~\\")) {
    const p = path.join(HOME, t.slice(2));
    tried.push(p);
    return { ok: pathOrGlobExists(p), resolved: p, tried };
  }
  if (isAbsolute(t)) {
    tried.push(t);
    return { ok: pathOrGlobExists(t), resolved: t, tried };
  }
  for (const b of bases) {
    if (!b) continue;
    const p = path.join(b, t);
    tried.push(p);
    if (pathOrGlobExists(p)) return { ok: true, resolved: p, tried };
  }
  return { ok: false, resolved: null, tried };
}

/**
 * 检查单个 memory 文件。
 * projectRoot 为 null 时：绝对路径照查，相对路径记为 skipped（**不当作 finding** ——
 * "根解析不出来"是本检查自己的能力边界，不是被检对象的问题；把它算成 finding
 * 就是拿未知当已知）。
 */
function checkFile(file, projectRoot, globalBases, otherRoots) {
  const findings = [];
  const skipped = [];
  const fallbacks = Array.isArray(globalBases) ? globalBases.filter(Boolean) : [];
  // 只用于给 finding 分类（dead vs ambiguous），**不参与判定**。见头注判据④。
  const peers = (Array.isArray(otherRoots) ? otherRoots : []).filter((r) => r && r !== projectRoot);
  let checked = 0;
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (e) {
    return { findings, skipped, checked, error: `读取失败：${e && e.message}` };
  }
  const lines = raw.replace(/\r\n/g, "\n").split("\n");

  for (const para of declarationParagraphs(lines)) {
    // 声明行里如果自己声明了一个「目录型」真相源，它就是本段落内相对路径的第二个基址。
    const extraBases = [];
    for (const d of para.declLines) {
      for (const tok of backtickTokens(d.text)) {
        if (!looksLikePath(tok)) continue;
        const r = resolveToken(tok, projectRoot ? [projectRoot] : []);
        if (r.ok && r.resolved && !r.resolved.includes("*")) {
          try { if (fs.statSync(r.resolved).isDirectory()) extraBases.push(r.resolved); } catch (_) {}
        }
      }
    }
    const bases = [];
    if (projectRoot) bases.push(projectRoot);
    for (const b of extraBases) bases.push(b);
    for (const b of fallbacks) bases.push(b);   // HOME + 各项目根的父目录，见头注判据③

    const seen = new Set();
    for (const l of para.lines) {
      for (const tok of backtickTokens(l.text)) {
        if (!looksLikePath(tok)) continue;
        const key = l.lineNo + "|" + tok;
        if (seen.has(key)) continue;
        seen.add(key);
        const relative = !isAbsolute(tok) && !tok.startsWith("~/") && !tok.startsWith("~\\");
        // 项目根解析不出时，相对路径**一律不判**——哪怕 fallback 基址够用。
        // 只靠 fallback 得出的"解析不到"是弱证据（主基址本来就缺席），报它等于拿未知当已知。
        if (relative && !projectRoot) {
          skipped.push({ file, lineNo: l.lineNo, token: tok, why: "项目根无法从 slug 解析，相对路径不判" });
          continue;
        }
        checked++;
        const r = resolveToken(tok, bases);
        if (!r.ok) {
          let kind = "dead";
          let peerHit = null;
          if (relative) {
            for (const p of peers) {
              if (pathOrGlobExists(path.join(p, tok.replace(/^\.\//, "")))) { kind = "ambiguous"; peerHit = p; break; }
            }
          }
          findings.push({
            file,
            lineNo: l.lineNo,
            token: tok,
            declLine: para.declLines[0].lineNo,
            tried: r.tried,
            kind,
            peerHit,
          });
        }
      }
    }
  }
  return { findings, skipped, checked, error: null };
}

/**
 * 扫一个 memory root（缺省 `~/.claude/projects`）。
 * rootResolver 可注入（测试用固定 fixture 映射，不依赖真实盘上目录）。
 */
function scan(opts) {
  const o = opts || {};
  const memoryRoot = o.memoryRoot || DEFAULT_MEMORY_ROOT;
  const rootResolver = o.rootResolver || decodeSlug;
  const result = {
    memoryRoot,
    rootExists: fs.existsSync(memoryRoot),
    projects: [],
    files: 0,
    checked: 0,
    findings: [],
    skipped: [],
    errors: [],
  };
  if (!result.rootExists) return result;

  let slugs = [];
  try {
    slugs = fs.readdirSync(memoryRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch (e) {
    result.errors.push(`列 memoryRoot 失败：${e && e.message}`);
    return result;
  }

  // ── fallback 基址（判据③后两级）：HOME + 每个已解析项目根的父目录 ──
  // 先跑一遍 resolver 把全部项目根解出来，再取父目录去重。顺序固定（字典序）
  // 以保证同一台机器上两次运行结论一致——基址顺序会影响"命中哪一个"，
  // 不定序会让 tried 列表在两次运行间抖动，排障时极难归因。
  const resolvedRoots = new Map();
  for (const slug of slugs) {
    if (!fs.existsSync(path.join(memoryRoot, slug, "memory"))) continue;
    let r = null;
    try { r = rootResolver(slug); } catch (_) { r = null; }
    resolvedRoots.set(slug, r);
  }
  const parentSet = new Set();
  for (const r of resolvedRoots.values()) {
    if (!r) continue;
    const p = path.dirname(r);
    if (p && p !== r) parentSet.add(p);
  }
  const globalBases = [HOME].concat(Array.from(parentSet).sort());
  result.globalBases = globalBases;
  const allRoots = Array.from(new Set(Array.from(resolvedRoots.values()).filter(Boolean))).sort();

  for (const slug of slugs) {
    const memDir = path.join(memoryRoot, slug, "memory");
    if (!fs.existsSync(memDir)) continue;
    const projectRoot = resolvedRoots.has(slug) ? resolvedRoots.get(slug) : null;
    let mdFiles = [];
    try {
      mdFiles = fs.readdirSync(memDir).filter((f) => f.toLowerCase().endsWith(".md")).sort();
    } catch (e) {
      result.errors.push(`列 ${memDir} 失败：${e && e.message}`);
      continue;
    }
    result.projects.push({ slug, projectRoot, files: mdFiles.length });
    for (const f of mdFiles) {
      const full = path.join(memDir, f);
      result.files++;
      const r = checkFile(full, projectRoot, globalBases, allRoots);
      if (r.error) { result.errors.push(`${full}: ${r.error}`); continue; }
      result.checked += r.checked;
      for (const x of r.findings) result.findings.push(Object.assign({ slug }, x));
      for (const x of r.skipped) result.skipped.push(Object.assign({ slug }, x));
    }
  }
  return result;
}

/** 观察线输出：只打印，调用方决定退出码（本模块从不代人判红绿） */
function formatReport(res) {
  const L = [];
  L.push("== memory 真相源指针一致性（观察线：只打印，恒不参与退出码）==");
  L.push(`  扫描面：${res.memoryRoot}`);
  if (!res.rootExists) {
    L.push("  本机无该目录 —— 零可扫。这不是通过，是**没测**（换台机器结论会不同）。");
    return L.join("\n");
  }
  L.push(`  项目 ${res.projects.length} 个 · memory 文件 ${res.files} 份 · 实判路径 token ${res.checked} 个`);
  const noRoot = res.projects.filter((p) => !p.projectRoot);
  if (noRoot.length) {
    L.push(`  ⓘ 其中 ${noRoot.length} 个项目的根从 slug 解析不出（盘上已不存在？），其相对路径一律不判：`);
    for (const p of noRoot) L.push(`      · ${p.slug}`);
  }
  const dead = res.findings.filter((f) => f.kind !== "ambiguous");
  const amb = res.findings.filter((f) => f.kind === "ambiguous");
  if (!res.findings.length) {
    L.push("  [无发现] 所有「显式声明真相源」段落里的路径指针都还指得到东西。");
  }
  if (dead.length) {
    L.push(`  [${dead.length} 处指针指向空气 · dead] —— 声明了真相源，但该路径在本机哪儿都找不到：`);
    for (const f of dead) {
      L.push(`    · ${path.basename(f.file)}:${f.lineNo}  \`${f.token}\`   （声明行 :${f.declLine}，项目 ${f.slug}）`);
      L.push(`        试过：${f.tried.join(" | ") || "（无可用基址）"}`);
    }
  }
  if (amb.length) {
    L.push(`  [${amb.length} 处相对路径没写清相对于谁 · ambiguous] —— 本项目下解析不到，但另一个仓下能：`);
    for (const f of amb) {
      L.push(`    · ${path.basename(f.file)}:${f.lineNo}  \`${f.token}\`   （声明行 :${f.declLine}，项目 ${f.slug}）`);
      L.push(`        在 ${f.peerHit} 下能解析到 ⇒ 处方是把路径写全，不是改内容`);
    }
  }
  if (res.skipped.length) {
    L.push(`  ⓘ 另有 ${res.skipped.length} 个相对路径因项目根不可解析而未判（不计入发现，也不算通过）`);
  }
  for (const e of res.errors) L.push(`  ⚠ ${e}`);
  L.push("  射程边界：只查「显式声明真相源」段落里反引号包裹的路径是否解析得到；");
  L.push("  **不查**行为类断言是否仍成立、不查计数是否仍相符、不查内容语义。判据与两向反例见本模块头注。");
  return L.join("\n");
}

module.exports = {
  scan, checkFile, decodeSlug, declarationParagraphs, backtickTokens,
  looksLikePath, resolveToken, globExists, formatReport,
  DECL_KEYWORDS, PATH_EXTS, DEFAULT_MEMORY_ROOT, HOME,
};

if (require.main === module) {
  // MEMORY_TRUTH_SOURCE_ROOT：测试注入用（把扫描面指到 fixture）。生产不设该变量。
  const rootOverride = process.env.MEMORY_TRUTH_SOURCE_ROOT || null;
  const opts = {};
  if (rootOverride) {
    opts.memoryRoot = rootOverride;
    // fixture 的 slug 用假盘符，真实 decodeSlug 解不出；让它相对 fixture 根解。
    if (process.env.MEMORY_TRUTH_SOURCE_FAKE_DRIVE) {
      const start = process.env.MEMORY_TRUTH_SOURCE_FAKE_DRIVE;
      opts.rootResolver = (slug) => decodeSlug(slug, start);
    }
  }
  const res = scan(opts);
  process.stdout.write(formatReport(res) + "\n");
  // 观察线：**findings 恒不改退出码**（这一行就是闸位决定本身，改它前先读头注「闸位」段）。
  // 只有本模块自己出错（读不动目录）才非零。
  process.exit(res.errors.length ? 1 : 0);
}
