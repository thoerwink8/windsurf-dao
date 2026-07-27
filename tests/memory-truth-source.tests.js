// memory-truth-source 两态自证 · 单元级
//
// 跑法：node tests/memory-truth-source.tests.js   （全绿 exit 0，任一红 exit 1）
// 由 `scripts/run-tests.mjs` 扫 `tests/*.tests.js` 自动纳入，不进任何手维护清单
// （手维护的清单会过期——run-tests 头注记着本仓被咬过两次）。
//
// ── 本文件验的是哪一层，以及**明确不验**哪一层 ────────────────────────────────
// 验：**检查器自身的输入→输出契约**。全部用例喂临时 fixture 目录，不读真实
//     `~/.claude/projects/`——真实 memory 是机器本地、不受 git 管的可变状态，
//     拿它当断言输入等于把"谁跑谁红"写进测试。
// 不验：真实 memory 现在有几处发现。那是**观察线**（`node ccswitch/lib/memory-truth-source.js`
//     手跑或将来挂进某个必经动作），恒不参与红绿。理由写在被测模块头注「闸位」段：
//     修复目标不在仓里 ⇒ 硬闸必然永久红 ⇒ 被跳过 ⇒ 连自检这一半也废掉。
//
// ── 判别力自检（对抗验证官节「判别力缝的自检问句」）──────────────────────────
// 每组断言都问过一遍"把这个逻辑放宽或收紧，是否至少有一条会变红"：
//   · 判据放宽（把不存在的路径也算解析成功）→ 正控组变红
//   · 判据收紧（把存在的路径也算失败）      → 负控组变红
//   · 段落取范围放宽（跨空行取）            → 「跨段落不取」用例变红
//   · 段落取范围收紧（只取声明行）          → 「同段 bullet 要取」用例变红
//   · dead/ambiguous 合并成一类            → 分类用例变红
//   · findings 参与退出码                  → 观察线契约用例变红

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const MOD = path.resolve(__dirname, "..", "ccswitch", "lib", "memory-truth-source.js");
const M = require(MOD);

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? "  →  " + detail : ""}`); }
}

// ── fixture 搭建 ──────────────────────────────────────────────────────────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "mts-"));
function mkdirp(p) { fs.mkdirSync(p, { recursive: true }); }
function w(p, s) { mkdirp(path.dirname(p)); fs.writeFileSync(p, s, "utf8"); }

// 假"盘符根"，让 decodeSlug 可以在 fixture 里走目录
const FAKE_DRIVE = path.join(TMP, "drive");
const REPO_A = path.join(FAKE_DRIVE, "work", "repo-alpha");   // slug: X--work-repo-alpha
const REPO_B = path.join(FAKE_DRIVE, "work", "repo-beta");
mkdirp(path.join(REPO_A, "docs"));
mkdirp(path.join(REPO_A, "ccswitch", "hooks"));
w(path.join(REPO_A, "CONTRACT.md"), "x");
w(path.join(REPO_A, "docs", "spec.md"), "x");
w(path.join(REPO_A, "ccswitch", "hooks", "dao-one.js"), "x");
w(path.join(REPO_A, "ccswitch", "hooks", "dao-two.js"), "x");
mkdirp(path.join(REPO_B, "config-sync", "common"));
w(path.join(REPO_B, "config-sync", "common", "mcp.json"), "{}");

const MEM_ROOT = path.join(TMP, "projects");
const SLUG_A = "X--work-repo-alpha";
const SLUG_B = "X--work-repo-beta";
const MEM_A = path.join(MEM_ROOT, SLUG_A, "memory");
const MEM_B = path.join(MEM_ROOT, SLUG_B, "memory");

// 负控：声明的真相源真实存在 ⇒ 一条都不该报
w(path.join(MEM_A, "live-source.md"), [
  "# live",
  "",
  "本项目的**唯一真相源**是 `CONTRACT.md`，细则见 `docs/spec.md`。",
  "",
].join("\n"));

// 正控：声明的真相源已不存在 ⇒ 应报 dead
w(path.join(MEM_A, "stale-source.md"), [
  "# stale",
  "",
  "**真相源**：`legacy/` ",
  "- 其下 `legacy/notes.md` 是正文",
  "",
].join("\n"));

// 段落取范围：声明行 + 同段 bullet 要取；跨空行的另一段不取
w(path.join(MEM_A, "paragraph.md"), [
  "# para",
  "",
  "**真相源**：`CONTRACT.md`",
  "- 同段里的 `ghost-in-paragraph.md` 应当被查出来",
  "",
  "另起一段提到 `ghost-outside-paragraph.md`，本模块**不该**查它。",
  "",
].join("\n"));

// 路径样貌负控：这些 token 都不该被当成路径去查
w(path.join(MEM_A, "not-paths.md"), [
  "# not paths",
  "",
  "真相源那一段里出现的这些都不是路径：`common_config_claude.hooks`、`$env:FOO`、",
  "`some sentence with spaces`、`D:/old/path/...`、`--flag`、`a|b`。",
  "",
].join("\n"));

// glob：命中 ≥1 即算存在；零命中即 dead
w(path.join(MEM_A, "globs.md"), [
  "# globs",
  "",
  "**真相源**：`CONTRACT.md`；hooks 在 `ccswitch/hooks/dao-*.js`，而 `ccswitch/hooks/zzz-*.js` 已不存在。",
  "",
].join("\n"));

// 非声明段落：没有关键词 ⇒ 整个文件不查（哪怕路径全是死的）
w(path.join(MEM_A, "no-declaration.md"), [
  "# no decl",
  "",
  "这里提到 `totally-dead-path.md`，但本段没有那个关键词。",
  "",
].join("\n"));

// 已知误认形态（判据① 的"会误认"那一侧）：正文只是在**讨论**真相源这个概念，
// 也会被当成声明行。**本用例刻意钉住这个行为而不是修它**——修法只有"加语义判断"，
// 那已经超出最窄那一档。写成测试是为了让它可见、可归因，而不是让下一个人以为是 bug。
// 本用例的存在本身就是实证：写这份 fixture 时第一版正文写的是「但没有声明任何真相源」，
// 该句自己触发了误认、当场把测试判红。
w(path.join(MEM_A, "meta-mention.md"), [
  "# meta",
  "",
  "这一段只是在讨论真相源这个机制本身，并提到 `discussed-only-path.md`。",
  "",
].join("\n"));

// ambiguous：repo-beta 下的路径写在 repo-alpha 的 memory 里
w(path.join(MEM_A, "ambiguous.md"), [
  "# amb",
  "",
  "**真相源**：`CONTRACT.md`；另核实过 `config-sync/common/mcp.json`。",
  "",
].join("\n"));

// repo-beta 需要有 memory 目录，否则它的根不会进 allRoots（分类用得到）
w(path.join(MEM_B, "placeholder.md"), ["# b", "", "无声明。", ""].join("\n"));

const resolver = (slug) => M.decodeSlug(slug, FAKE_DRIVE);
const res = M.scan({ memoryRoot: MEM_ROOT, rootResolver: resolver });
const byFile = (name) => res.findings.filter((f) => path.basename(f.file) === name);

console.log("\n=== decodeSlug：照盘上真实目录走，不做字符串反解 ===");
{
  check("正常 slug → 解出真实项目根", M.decodeSlug(SLUG_A, FAKE_DRIVE) === REPO_A,
    String(M.decodeSlug(SLUG_A, FAKE_DRIVE)));
  check("盘上不存在的 slug → null（不猜）", M.decodeSlug("X--work-nope-nope", FAKE_DRIVE) === null);
  check("非 slug 形态 → null", M.decodeSlug("not-a-slug", FAKE_DRIVE) === null);
  // 钉住已知边界：信息在编码时就丢了，最长匹配这一侧必然走错，测试写明而不是假装没有
  const amb = path.join(TMP, "ambdrive");
  mkdirp(path.join(amb, "mousse", "cli"));
  mkdirp(path.join(amb, "mousse-cli"));
  check("已知边界：`mousse` + `mousse-cli` 同层时最长匹配解成 mousse-cli（不修，只钉住）",
    M.decodeSlug("X--mousse-cli", amb) === path.join(amb, "mousse-cli"),
    String(M.decodeSlug("X--mousse-cli", amb)));
}

console.log("\n=== 正控 / 负控：判据两侧都要能变红 ===");
{
  check("负控 · 真相源存在 ⇒ 零发现", byFile("live-source.md").length === 0,
    JSON.stringify(byFile("live-source.md").map((f) => f.token)));
  const stale = byFile("stale-source.md");
  check("正控 · 真相源不存在 ⇒ 有发现", stale.length >= 1, "count=" + stale.length);
  check("正控 · 报的是那个死路径本身", stale.some((f) => f.token === "legacy/"),
    JSON.stringify(stale.map((f) => f.token)));
  check("正控 · 同段 bullet 里挂在死源下的路径也报", stale.some((f) => f.token === "legacy/notes.md"),
    JSON.stringify(stale.map((f) => f.token)));
  check("正控 · 分类为 dead 而非 ambiguous", stale.every((f) => f.kind === "dead"),
    JSON.stringify(stale.map((f) => f.kind)));
  check("正控 · 记下了声明行行号（便于人回去看那段在说什么）",
    stale.every((f) => f.declLine === 3), JSON.stringify(stale.map((f) => f.declLine)));
}

console.log("\n=== 段落取范围：同段取、跨段不取（两个方向各一条） ===");
{
  const p = byFile("paragraph.md");
  check("同段 bullet 里的死路径 → 报", p.some((f) => f.token === "ghost-in-paragraph.md"),
    JSON.stringify(p.map((f) => f.token)));
  check("跨空行另一段的死路径 → 不报", !p.some((f) => f.token === "ghost-outside-paragraph.md"),
    JSON.stringify(p.map((f) => f.token)));
  check("无真相源声明的文件 → 整个不查", byFile("no-declaration.md").length === 0,
    JSON.stringify(byFile("no-declaration.md").map((f) => f.token)));
  // 钉住已知误认（判据① 的另一侧）：只要行里出现关键词就算声明行，哪怕它只是在
  // 讨论这个机制。**这是当前判据的真实行为，不是缺陷**——本行断言它，好让将来
  // 有人改判据时立刻看见自己动了哪一侧。
  check("已知误认：只是在讨论『真相源』这个词的段落也会被查（如实钉住，不假装没有）",
    byFile("meta-mention.md").some((f) => f.token === "discussed-only-path.md"),
    JSON.stringify(byFile("meta-mention.md").map((f) => f.token)));
}

console.log("\n=== 路径样貌负控：形似而非的 token 一个都不许当路径 ===");
{
  const np = byFile("not-paths.md");
  check("`common_config_claude.hooks`（后缀不在白名单）不当路径", !np.some((f) => f.token.includes("common_config")));
  check("`$env:FOO`（变量）不当路径", !np.some((f) => f.token.startsWith("$")));
  check("含空格的句子片段不当路径", !np.some((f) => /\s/.test(f.token)));
  check("含 `...` 的省略写法不当路径（刻意提及的死路径不误伤）", !np.some((f) => f.token.includes("...")));
  check("`--flag` 不当路径", !np.some((f) => f.token.startsWith("--")));
  check("含 `|` 的表达式不当路径", !np.some((f) => f.token.includes("|")));
  check("这一组整体零发现", np.length === 0, JSON.stringify(np.map((f) => f.token)));
  // 单元级再夹一次（上面是端到端，这里直接夹判据函数，防"恰好因别的原因没报"）
  check("looksLikePath 直判：`docs/spec.md` 是路径", M.looksLikePath("docs/spec.md") === true);
  check("looksLikePath 直判：`common_config_claude.hooks` 不是", M.looksLikePath("common_config_claude.hooks") === false);
  check("looksLikePath 直判：`PromptTemplate` 不是", M.looksLikePath("PromptTemplate") === false);
  check("looksLikePath 直判：`CLAUDE.md` 是（无分隔符但后缀在白名单）", M.looksLikePath("CLAUDE.md") === true);
}

console.log("\n=== glob：≥1 命中算存在，零命中算 dead ===");
{
  const g = byFile("globs.md");
  check("`ccswitch/hooks/dao-*.js` 有命中 ⇒ 不报", !g.some((f) => f.token.includes("dao-*")),
    JSON.stringify(g.map((f) => f.token)));
  check("`ccswitch/hooks/zzz-*.js` 零命中 ⇒ 报", g.some((f) => f.token.includes("zzz-*")),
    JSON.stringify(g.map((f) => f.token)));
  check("globExists 直判：有命中 → true",
    M.globExists(path.join(REPO_A, "ccswitch", "hooks", "dao-*.js")) === true);
  check("globExists 直判：零命中 → false",
    M.globExists(path.join(REPO_A, "ccswitch", "hooks", "nope-*.js")) === false);
  check("globExists 直判：中间层不存在 → false（不抛）",
    M.globExists(path.join(REPO_A, "nosuch", "*", "x.js")) === false);
}

console.log("\n=== dead vs ambiguous：两类必须分开（合并即变红） ===");
{
  const a = byFile("ambiguous.md");
  const hit = a.filter((f) => f.token === "config-sync/common/mcp.json");
  check("邻仓下能解析到的相对路径 → 仍报（不静默放过）", hit.length === 1, "count=" + hit.length);
  check("但分类为 ambiguous 而非 dead", hit.length === 1 && hit[0].kind === "ambiguous",
    hit.length ? hit[0].kind : "n/a");
  check("并指出它在哪个仓下能解析到", hit.length === 1 && hit[0].peerHit === REPO_B,
    hit.length ? String(hit[0].peerHit) : "n/a");
  check("真死路径不会被误分成 ambiguous",
    byFile("stale-source.md").every((f) => f.kind === "dead" && f.peerHit === null));
}

console.log("\n=== 根不可解析时：相对路径记 skipped 而非 finding（拿未知当已知才是错） ===");
{
  const r2 = M.scan({ memoryRoot: MEM_ROOT, rootResolver: () => null });
  const relFindings = r2.findings.filter((f) => !/^[A-Za-z]:[\\/]/.test(f.token));
  check("根解析不出 ⇒ 相对路径零 finding", relFindings.length === 0,
    JSON.stringify(relFindings.map((f) => f.token)));
  check("根解析不出 ⇒ 相对路径进 skipped（不是无声吞掉）", r2.skipped.length > 0,
    "skipped=" + r2.skipped.length);
  check("skipped 写明了原因", r2.skipped.every((s) => typeof s.why === "string" && s.why.length > 0));
}

console.log("\n=== 观察线契约：有发现也必须 exit 0（这一条是闸位本身） ===");
{
  const r = spawnSync(process.execPath, [MOD], {
    encoding: "utf8",
    env: Object.assign({}, process.env, {
      MEMORY_TRUTH_SOURCE_ROOT: MEM_ROOT,
      MEMORY_TRUTH_SOURCE_FAKE_DRIVE: FAKE_DRIVE,
    }),
  });
  const out = String(r.stdout || "");
  check("fixture 里确有发现（否则下一条断言是空跑）", /指针指向空气/.test(out), out.slice(0, 300));
  check("有发现仍 exit 0（观察线，不参与红绿）", r.status === 0, "code=" + r.status);
  check("报告里印出了射程边界（别被读成全集）", /射程边界/.test(out));
  check("报告里显式声明不查行为类断言与计数", /不查.*行为类断言/.test(out) && /不查计数/.test(out));
}

console.log("\n=== 扫描面缺失：不假装通过 ===");
{
  const r3 = M.scan({ memoryRoot: path.join(TMP, "nope"), rootResolver: resolver });
  check("memoryRoot 不存在 → rootExists=false", r3.rootExists === false);
  check("memoryRoot 不存在 → 零发现零文件", r3.findings.length === 0 && r3.files === 0);
  const txt = M.formatReport(r3);
  check("报告明说这是『没测』不是『通过』", /这不是通过，是\*\*没测\*\*/.test(txt), txt);
}

// 清理
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}

console.log(`\n=== 汇总: PASS=${pass} FAIL=${fail} ===`);
process.exit(fail ? 1 : 0);
