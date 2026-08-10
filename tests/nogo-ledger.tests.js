// nogo-ledger 回归网 —— 「用户拍板：刻意不做」的台账与代码里那行标记，两边必须对得上
//
// 跑法：node tests/nogo-ledger.tests.js     （全绿 exit 0，任一红 exit 1）
//       node scripts/run-tests.mjs          （扫目录自动发现本文件，无需登记）
//
// ── 治的是什么病 ─────────────────────────────────────────────────────────────
// 用户拍板「这件事刻意不做」之后，那条裁决此前只写在一行代码注释里，**靠「没人删它」生效**。
// 删掉那行，下一个 AI 读到代码里自陈的缺口，最自然的第一反应就是去补上——而那正是被否掉的
// 动作，且全仓没有任何东西会红。本批实测过这一点：把三块该类注释整块删掉重跑默认层，
// 红集一条不变（真退出码与计数见 PR 正文，不在此复述）。
//
// ── 判据（一句话）─────────────────────────────────────────────────────────────
// 台账里有条目 ⇒ 它点名的每一份落点文件里都必须找得到 `[NOGO:<编号>]`；
// 代码里出现标记 ⇒ 台账里必须有这个编号，且这份文件必须登记在它的 sites 里。
// 两个方向缺一边即红（同 `ccswitch/clause-ledger.json` 与条款正文那一对的双向孤儿检测）。
//
// ── 射程边界（照直写，别把「绿」读成「这些决定都还对」）──────────────────────
//   ① **只判标记在不在，不判台账里那段文字对不对**。解冻条件写得好不好、理由成不成立，
//      机器判不了，本闸不假装判得了。
//   ② **扫描面只有代码文件**（`.js` / `.mjs` / `.cjs` / `.ps1` / `.psm1` / `.bat`）。
//      Markdown 刻意在外：规则档里写 `[NOGO:<编号>]` 是在**讲格式**不是一个落点，
//      把 .md 收进来就得再造一套「反引号遮罩」的近似判据，而那一层每一个近似都要另配负控。
//      **代价**：有人把标记写进 .md 当落点 ⇒ 本闸看不见。已知，不补。
//   ③ **本文件自己不在扫描面内**——下面 §D 的夹具里有故意写坏的标记，收进来会被自己扫成违例
//      （守卫铁律「检查器的输出不能落在它自己的扫描面内」，见 ccswitch/rules/dao-guard-writing.md）。
//   ④ 排除目录里有 `.claude`：主仓那底下挂着别的分支的 worktree，扫进去会读到别人的半成品。
//
// ── 自检那一半为什么另起一套读法 ────────────────────────────────────────────
// 最危险的失效形态是**静默变绿**：抽取正则一旦坏掉、或扫描面塌了，「一个标记都没找到」与
// 「所有标记都对」在输出上一模一样、退出码都是 0。故普查半边**不用正则**，只做字符串切分数
// 标记前缀的出现次数；普查 > 0 而抽取 == 0 ⇒ 抽取瞎了。另有两道基数闸（台账条目数下界、
// 扫到的文件数下界）挡住「整个塌成零还报绿」。

const fs = require("fs");
const path = require("path");

const REPO = path.resolve(__dirname, "..");
const LEDGER_REL = "docs/ops/nogo-ledger.json";
const SELF_REL = "tests/nogo-ledger.tests.js";

// 台账条目数的下界。入库时盘上是 3 条（本批扫描全仓所得），**写 1 是刻意的**：
// 这道闸要挡的是「整份台账塌成空还报绿」，不是「不许减少」——减少是解冻的正常结果。
const MIN_ENTRIES = 1;
const MIN_SCANNED_FILES = 20;

const EXCLUDED_DIRS = new Set([
  ".git", "node_modules", "_tmp", ".claude", "coverage", "dist", "build",
  ".playwright-mcp", ".vscode", ".idea",
]);
const CODE_EXTS = new Set([".js", ".mjs", ".cjs", ".ps1", ".psm1", ".bat"]);

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail ? "  ->  " + detail : "")); }
}

// ── 抽取半边 ────────────────────────────────────────────────────────────────
// 编号形态刻意**收窄成 ASCII 小写串**：`tests/link-codex.tests.ps1` 是无 BOM 的纯 ASCII 文件
// （PS 5.1 会按 ANSI 解码非 ASCII 注释并弄坏解析），标记必须在那种文件里也写得下。
// 收窄的代价是「写错形态的标记」抽不出来 —— 故下面 §B 有一道「形似而不合法」的普查兜底。
const MARKER_RE = /\[NOGO:([A-Za-z0-9][A-Za-z0-9._-]*)\]/g;
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

function extractMarkers(text) {
  const out = [];
  const re = new RegExp(MARKER_RE.source, "g");
  let m;
  while ((m = re.exec(text)) !== null) out.push(m[1]);
  return out;
}

// 普查半边：**不用正则**。抽取瞎掉时它仍然看得见样本。
const CENSUS_TOKEN = "[NOGO" + ":";
function censusMarkers(text) {
  return text.split(CENSUS_TOKEN).length - 1;
}

function walkCodeFiles(root) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!EXCLUDED_DIRS.has(e.name)) stack.push(p);
      } else if (e.isFile() && CODE_EXTS.has(path.extname(e.name).toLowerCase())) {
        const rel = path.relative(root, p).replace(/\\/g, "/");
        if (rel !== SELF_REL) out.push(rel);
      }
    }
  }
  return out.sort();
}

// ── 判据本体：一个纯函数，夹具与真树喂的是同一个它 ──────────────────────────
// `sightings` 形态：[{ file: <仓内相对路径>, slug }]
function judge(ledger, sightings) {
  const v = [];
  const entries = (ledger && ledger.entries) || {};
  const slugs = Object.keys(entries);

  for (const slug of slugs) {
    const e = entries[slug] || {};
    const str = (x) => typeof x === "string" && x.trim().length > 0;
    if (!SLUG_RE.test(slug)) v.push({ kind: "bad-slug", slug });
    for (const f of ["decision", "decided_by", "decided_on", "owner", "unfreeze", "unfreeze_source", "status"]) {
      if (!str(e[f])) v.push({ kind: "missing-field", slug, field: f });
    }
    if (str(e.decided_by) && e.decided_by !== "用户") v.push({ kind: "not-user-decision", slug });
    if (str(e.decided_on) && !/^\d{4}-\d{2}-\d{2}$/.test(e.decided_on)) v.push({ kind: "bad-date", slug });
    if (str(e.unfreeze_source) && !["用户原话", "AI 拟定待确认"].includes(e.unfreeze_source)) {
      v.push({ kind: "bad-unfreeze-source", slug });
    }
    if (str(e.status) && !["frozen", "thawed"].includes(e.status)) v.push({ kind: "bad-status", slug });

    const sites = Array.isArray(e.sites) ? e.sites : [];
    if (sites.length === 0) v.push({ kind: "no-sites", slug });
    if (new Set(sites).size !== sites.length) v.push({ kind: "dup-site", slug });
    for (const f of sites) {
      const seen = sightings.some((s) => s.file === f && s.slug === slug);
      if (!seen) v.push({ kind: "site-missing-marker", slug, file: f });
    }
  }

  for (const s of sightings) {
    const e = entries[s.slug];
    if (!e) { v.push({ kind: "orphan-marker", slug: s.slug, file: s.file }); continue; }
    const sites = Array.isArray(e.sites) ? e.sites : [];
    if (!sites.includes(s.file)) v.push({ kind: "marker-file-not-registered", slug: s.slug, file: s.file });
  }
  return v;
}

const kinds = (vs) => vs.map((x) => x.kind).sort().join(",");

// ══ §A 台账读得进来，且是台账该有的样子 ══════════════════════════════════════
console.log("\n=== A 台账本体 ===");
const ledgerAbs = path.join(REPO, LEDGER_REL);
check("A1 台账文件在", fs.existsSync(ledgerAbs), ledgerAbs);
let ledger = null, ledgerErr = "";
try { ledger = JSON.parse(fs.readFileSync(ledgerAbs, "utf8")); } catch (err) { ledgerErr = String(err && err.message); }
check("A2 台账是合法 JSON", ledger !== null, ledgerErr);
const entryCount = ledger && ledger.entries ? Object.keys(ledger.entries).length : 0;
check(`A3 基数闸：条目数 ${entryCount} >= ${MIN_ENTRIES}（挡「整份塌空还报绿」）`, entryCount >= MIN_ENTRIES);
check("A4 台账带 _doc（说清它是什么、谁在检）", !!(ledger && ledger._doc && typeof ledger._doc === "object"));

// ══ §B 扫描面真的扫到了东西（自检半边，另起一套读法）══════════════════════════
console.log("\n=== B 扫描面自检 ===");
const files = walkCodeFiles(REPO);
check(`B1 扫到代码文件 ${files.length} 份 >= ${MIN_SCANNED_FILES}（挡扫描面塌陷）`, files.length >= MIN_SCANNED_FILES);

const sightings = [];
let census = 0;
for (const rel of files) {
  let text;
  try { text = fs.readFileSync(path.join(REPO, rel), "utf8"); } catch { continue; }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  census += censusMarkers(text);
  for (const slug of extractMarkers(text)) sightings.push({ file: rel, slug });
}
check(`B2 普查数 ${census} > 0（零样本 = 这道闸这次什么都没查）`, census > 0);
check(`B3 抽取没瞎：普查 ${census} > 0 时抽取数 ${sightings.length} > 0`, !(census > 0 && sightings.length === 0));
check(`B4 普查数与抽取数相等（不等 ⇒ 有写坏形态的标记被静默丢掉）`, census === sightings.length,
  `census=${census} extracted=${sightings.length}`);

// ══ §C 真树：双向对账零违例 ═══════════════════════════════════════════════════
console.log("\n=== C 真树双向对账 ===");
const real = ledger ? judge(ledger, sightings) : [{ kind: "ledger-unreadable" }];
check("C1 真树零违例", real.length === 0, JSON.stringify(real).slice(0, 600));
if (real.length === 0) {
  console.log(`  ⓘ 普查：台账 ${entryCount} 条 · 落点标记 ${sightings.length} 处 · 扫了 ${files.length} 份代码文件`);
}

// ══ §D 判别力自证：每一格单独构造，断言**违例种类与条数都精确** ══════════════
// 只断言 length > 0 会让「打死一整片」看起来和「精确命中那一格」一模一样，故逐条对种类。
console.log("\n=== D 判别力自证（夹具，不碰真树）===");
const FX = {
  entries: {
    "alpha-one": {
      decision: "示例：不做 X", decided_by: "用户", decided_on: "2026-01-02", owner: "u",
      unfreeze: "出现 Y 时重议", unfreeze_source: "用户原话", sites: ["a/x.js"],
      existing_guard: null, notes: "", status: "frozen",
    },
  },
};
const OK = [{ file: "a/x.js", slug: "alpha-one" }];

check("D0 负控：台账与落点完全对齐 ⇒ 零违例", judge(FX, OK).length === 0, JSON.stringify(judge(FX, OK)));

const d1 = judge(FX, []);
check("D1 落点里的标记被删掉 ⇒ 恰好一条 site-missing-marker", kinds(d1) === "site-missing-marker", JSON.stringify(d1));

const d2 = judge(FX, OK.concat([{ file: "b/y.ps1", slug: "beta-two" }]));
check("D2 代码里有台账没登记的编号 ⇒ 恰好一条 orphan-marker", kinds(d2) === "orphan-marker", JSON.stringify(d2));

const d3 = judge(FX, OK.concat([{ file: "b/y.ps1", slug: "alpha-one" }]));
check("D3 标记出现在没登记的文件里 ⇒ 恰好一条 marker-file-not-registered",
  kinds(d3) === "marker-file-not-registered", JSON.stringify(d3));

const FX_NOSRC = JSON.parse(JSON.stringify(FX));
delete FX_NOSRC.entries["alpha-one"].unfreeze;
check("D4 缺解冻条件 ⇒ 恰好一条 missing-field", kinds(judge(FX_NOSRC, OK)) === "missing-field",
  JSON.stringify(judge(FX_NOSRC, OK)));

const FX_AISRC = JSON.parse(JSON.stringify(FX));
FX_AISRC.entries["alpha-one"].unfreeze_source = "我觉得可以";
check("D5 解冻条件出处不是那两个取值之一 ⇒ 恰好一条 bad-unfreeze-source",
  kinds(judge(FX_AISRC, OK)) === "bad-unfreeze-source", JSON.stringify(judge(FX_AISRC, OK)));

const FX_AI_OK = JSON.parse(JSON.stringify(FX));
FX_AI_OK.entries["alpha-one"].unfreeze_source = "AI 拟定待确认";
check("D5b 负控：`AI 拟定待确认` 是合法取值（别把「待确认」判成违例）",
  judge(FX_AI_OK, OK).length === 0, JSON.stringify(judge(FX_AI_OK, OK)));

const FX_NOTUSER = JSON.parse(JSON.stringify(FX));
FX_NOTUSER.entries["alpha-one"].decided_by = "AI";
check("D6 AI 自己的取舍混进台账 ⇒ 恰好一条 not-user-decision",
  kinds(judge(FX_NOTUSER, OK)) === "not-user-decision", JSON.stringify(judge(FX_NOTUSER, OK)));

// 抽取器的两侧代价：能抽出该抽的，且不抽形似而不是标记的。
console.log("\n=== D′ 抽取器正负控 ===");
const OPEN = "[NOGO" + ":";
check("D7 正控：标准形态抽得出来", extractMarkers(OPEN + "probe-deadman]").join(",") === "probe-deadman");
check("D8 正控：一行里两个标记都抽得出来",
  extractMarkers(OPEN + "a-one] 与 " + OPEN + "b-two]").join(",") === "a-one,b-two");
check("D9 负控：没有冒号的 `[NOGO]` 不算标记", extractMarkers("[NOGO]").length === 0);
check("D10 负控：没有方括号的 `NOGO:x` 不算标记", extractMarkers("NOGO:x").length === 0);
check("D11 负控：`[NOGOX:y]` 这种形似前缀不算标记", extractMarkers("[NOGOX:y]").length === 0);
check("D12 普查与抽取对同一段文本给出同一个数（两套读法的交叉核对）",
  censusMarkers(OPEN + "a-one] " + OPEN + "b-two]") === extractMarkers(OPEN + "a-one] " + OPEN + "b-two]").length);
check("D13 普查抓得到抽取抓不到的坏形态（这正是 B4 的判别力来源）",
  censusMarkers(OPEN + "有中文的编号]") === 1 && extractMarkers(OPEN + "有中文的编号]").length === 0);

console.log(`\nnogo-ledger: PASS=${pass} FAIL=${fail}`);
process.exit(fail === 0 ? 0 : 1);
