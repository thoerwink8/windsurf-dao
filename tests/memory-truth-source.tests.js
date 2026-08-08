// memory-truth-source 两态自证 · 单元级
//
// @dao-test-tier: env
//
// 跑法：node tests/memory-truth-source.tests.js        （默认层：末节 defer 掉）
//       node tests/memory-truth-source.tests.js --env  （含环境敏感层；要求串行环境）
// 由 `scripts/run-tests.mjs` 扫 `tests/*.tests.js` 自动纳入，不进任何手维护清单
// （手维护的清单会过期——run-tests 头注记着本仓被咬过两次）。
//
// ── 上面那行 `@dao-test-tier: env` 是给 run-tests.mjs 读的（2026-08-08 · issue #160）──
// 被 defer 的只有**末节「并轨 · 投递可达性」**（真喂一次 SessionStart payload），其余 80+ 条
// 全部照跑 —— 它们喂的是临时 fixture，与机器状态无关。
//
// **为什么末节是环境敏感的 —— 根因是 hook 的墙钟预算，不是「git 状态」本身**：
//   `dao-scaffold-check.js` 自己看表，总预算读自**用户真实** `~/.claude/settings.json` 里本
//   hook 的注册 `timeout`；预算见底就不起下一个子进程，只打一行 `⏱ … **没跑**`。
//   memory 指针扫描排在**第 11 位**（全表最后一项检查）⇒ 它是最先被挤掉的那一个。
//   把预算压到 3000 ms 实测：这一节红 ~~3 条，与 issue #160 报的「merge 后 memory-truth-source
//   红 3 条」逐条吻合~~ **4 条**（`PASS=84 FAIL=4`，`--env` 层实测）。
//   **订正 2026-08-08 · PR #200 对抗官 F3**：划掉那半是**改动前**的数 ——「3」是 issue #160
//   报的原始条数，却被写进了**同一个把它改成 4 的 commit** 的头注里（本节新增了一条「前置」
//   断言 ⇒ 红集本来就该 +1）。两个数都留着才看得出这一格是怎么动的：3 = 改前 / 4 = 改后。
//   挤它的三个来源：①用户改注册 timeout ②机器负载 ③git 状态
//   （未提交 / 领先落后 origin ⇒ 同步漂移多算几项、多起几次 git 子进程）。
//
// ⚠ 照直写 `--env` 也兜不住的那一格：这一节在 `--env` 下**仍可能因预算而红**，只是那时
//   多一条前置断言明说「红来自预算，不来自被测对象」并给自查命令。要让它结构上不可能红，
//   得给 hook 开一个「测试模式放宽预算」的口子，而那个口子会让被测的降级路径不再是真的。
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

// 环境敏感层开关：命令行 `--env`，或环境变量 DAO_TEST_ENV_TIER=1。形态同 dead-gates。
const ENV_TIER = process.argv.includes("--env") || process.env.DAO_TEST_ENV_TIER === "1";

let pass = 0, fail = 0, defer = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? "  →  " + detail : ""}`); }
}
// defer 不是 skip：它进汇总行的 `DEFER=n`，run-tests.mjs 据此把整场退出码顶成 2。
// **报 DEFER=n 就必须打 n 行 `DEFER ` 明细**（run-tests 的笨计数器与它对拍）。
function deferSection(name, why) {
  defer++;
  console.log(`  DEFER ${name}  ->  ${why}`);
}
const DEFER_WHY = "环境敏感层：hook 墙钟总预算读自用户真实 ~/.claude/settings.json 的注册 timeout，"
  + "而 memory 指针扫描排在全表最后一项 ⇒ 最先被挤掉；机器负载与 git 状态都会挤它（issue #160）。"
  + "跑它：node tests/memory-truth-source.tests.js --env（要求串行环境）";

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

// 并轨 scope=all 专用夹具：**声明段外**的引用。三种形态同时在场，
// 因为段外走的是严档（见被测模块并轨㈡），三者的归属各不相同：
//   · `nested/ghost-outside.md` —— 含分隔符 + 有扩展名 ⇒ 严档收，且解析不到 ⇒ 该报
//   · `deadsubdir/`             —— 目录引用 ⇒ 严档收，且解析不到 ⇒ 该报
//   · `docs/spec.md`            —— 真实存在 ⇒ 负控，扫描面放大也不许报
//   · `bare-ghost-name.md`      —— **裸文件名（无分隔符）⇒ 严档结构上看不见**。
//     这是并轨后**已知的射程缺口**，不是 bug：段外是整份 memory，允许裸文件名会把
//     散文里随口提的 `README.md` 一并当路径去查。写成断言是为了让它可见、可归因。
w(path.join(MEM_A, "wide-only.md"), [
  "# wide only",
  "",
  "本段没有那个关键词，但提到 `nested/ghost-outside.md`、`deadsubdir/`、",
  "`docs/spec.md` 和 `bare-ghost-name.md`。",
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

// ══════════════════════════════════════════════════════════════════════════════
// 并轨（2026-08-02 · 自上而下审计第 12 件）：`scope: "all"` 与末行契约
// ══════════════════════════════════════════════════════════════════════════════
// 上面全部用例跑的是 `scope: "declared"`（缺省），它们**一条都没改**——这本身就是
// 「并轨没有偷偷改掉原判据」的断言：只要 declared 那一档的行为动了，上面就会红。
console.log("\n=== 并轨 · scope=all：全文扫，且与 declared 是包含关系 ===");
const resAll = M.scan({ memoryRoot: MEM_ROOT, rootResolver: resolver, scope: "all" });
const allByFile = (name) => resAll.findings.filter((f) => path.basename(f.file) === name);
{
  check("declared 档的 scope 字段如实回填", res.scope === "declared", String(res.scope));
  check("all 档的 scope 字段如实回填", resAll.scope === "all", String(resAll.scope));
  // 正控：只有 all 档看得见的那些 —— 声明段外的死路径
  const wide = allByFile("wide-only.md");
  check("正控 · 段外的相对死路径在 all 档被查出",
    wide.some((f) => f.token === "nested/ghost-outside.md"), JSON.stringify(wide.map((f) => f.token)));
  check("正控 · 段外的目录引用在 all 档被查出",
    wide.some((f) => f.token === "deadsubdir/"), JSON.stringify(wide.map((f) => f.token)));
  check("负控 · 同一段里真实存在的 `docs/spec.md` 不报（放大扫描面 ≠ 放宽判据）",
    !wide.some((f) => f.token === "docs/spec.md"), JSON.stringify(wide.map((f) => f.token)));
  check("负控 · declared 档看不见这个文件（它没有声明关键词）",
    res.findings.filter((f) => path.basename(f.file) === "wide-only.md").length === 0);
  // 已知射程缺口：段外的**裸文件名**严档结构上看不见。如实钉住，不假称覆盖。
  check("已知缺口 · 段外裸文件名（无分隔符）在 all 档**仍看不见**（严档的代价，写明不假装）",
    !wide.some((f) => f.token === "bare-ghost-name.md"), JSON.stringify(wide.map((f) => f.token)));
  check("已知缺口 · 同理，`ghost-outside-paragraph.md` 这种段外裸名也不报",
    !allByFile("paragraph.md").some((f) => f.token === "ghost-outside-paragraph.md"),
    JSON.stringify(allByFile("paragraph.md").map((f) => f.token)));
  // 负控：真实存在的路径在 all 档照样不报（放宽扫描面 ≠ 放宽判据）
  check("负控 · 真实存在的真相源在 all 档仍零发现",
    allByFile("live-source.md").length === 0,
    JSON.stringify(allByFile("live-source.md").map((f) => f.token)));
  // 声明段内**仍走宽档**：这是首版订正的那一格，裸文件名在段内必须照样查得到
  check("声明段内的裸文件名在 all 档仍被查（严档只用在段外，见并轨㈡ 订正）",
    allByFile("paragraph.md").some((f) => f.token === "ghost-in-paragraph.md"),
    JSON.stringify(allByFile("paragraph.md").map((f) => f.token)));
  check("all 档的发现数严格多于 declared 档（否则这一档等于没加）",
    resAll.findings.length > res.findings.length,
    `all=${resAll.findings.length} declared=${res.findings.length}`);
  // 🔴 **真超集**：首版把严档用在整份文件上，`all` 反而比 `declared` 少 2 条
  //    （声明段里的裸文件名被严档收掉了）—— 「扫描面放大」与「判据收窄」在总数上
  //    互相抵消，看起来只是数字变了一点。这一条就是为那次订正立的回归网。
  const keyOf = (f) => `${path.basename(f.file)}|${f.lineNo}|${f.token}`;
  const allKeys = new Set(resAll.findings.map(keyOf));
  const missing = res.findings.filter((f) => !allKeys.has(keyOf(f)));
  check("all 档的发现集是 declared 档的**真超集**（一条都不许丢）",
    missing.length === 0, JSON.stringify(missing.map(keyOf)));
  // `declared` 标记：并轨㈢ 的净收益，两个方向各钉一条
  check("段内发现带 declared=true",
    allByFile("stale-source.md").every((f) => f.declared === true),
    JSON.stringify(allByFile("stale-source.md").map((f) => f.declared)));
  check("段外发现带 declared=false 且 declLine 为 null（不许硬取 declLines[0]）",
    wide.length > 0 && wide.every((f) => f.declared === false && f.declLine === null),
    JSON.stringify(wide.map((f) => [f.declared, f.declLine])));
  check("declared 档里每条发现都是 declared=true（那一档本来就只看声明段）",
    res.findings.every((f) => f.declared === true));
}

console.log("\n=== 并轨 · strict token 形态：收紧不是放宽（真子集） ===");
{
  // strict 的命中集必须是非 strict 的真子集 —— 若哪天有人把 strict 写成"另一套判据"，
  // 这一条会红。样本两侧都取（该收的收掉、该留的留住）。
  const samples = [
    "docs/spec.md", "ccswitch/hooks/dao-*.js", "legacy/", "D:/frank/x/y.md",
    "CLAUDE.md", "README.md", "team-donk/mousse-cli", "PromptTemplate",
    "common_config_claude.hooks", "$env:FOO", "--flag", "a|b", "docs/a.md:12",
  ];
  const loose = samples.filter((s) => M.looksLikePath(s, false));
  const strict = samples.filter((s) => M.looksLikePath(s, true));
  check("strict 命中集 ⊆ loose 命中集", strict.every((s) => loose.includes(s)),
    `strict=${JSON.stringify(strict)} loose=${JSON.stringify(loose)}`);
  check("strict 严格更小（否则 strict 分支等于没写）", strict.length < loose.length,
    `strict=${strict.length} loose=${loose.length}`);
  check("strict 收掉裸文件名 `CLAUDE.md`（全文扫时它多半只是散文里提了一句）",
    M.looksLikePath("CLAUDE.md", true) === false && M.looksLikePath("CLAUDE.md", false) === true);
  check("strict 收掉仓库 slug `team-donk/mousse-cli`（像路径但不是文件系统对象）",
    M.looksLikePath("team-donk/mousse-cli", true) === false);
  check("strict 保留带扩展名的相对路径 `docs/spec.md`", M.looksLikePath("docs/spec.md", true) === true);
  check("strict 保留目录引用 `legacy/`", M.looksLikePath("legacy/", true) === true);
  check("strict 保留 glob `ccswitch/hooks/dao-*.js`",
    M.looksLikePath("ccswitch/hooks/dao-*.js", true) === true);
  check("默认不传 strict 时与 loose 同（缺省即并轨前行为）",
    M.looksLikePath("CLAUDE.md") === M.looksLikePath("CLAUDE.md", false));
}

console.log("\n=== 并轨 · stripLocator：`:行号` 与 `#锚点` 剥掉再解析（消真假阳性） ===");
{
  check("剥 `:12`", M.stripLocator("docs/a.md:12") === "docs/a.md");
  check("剥 `:12-20`", M.stripLocator("docs/a.md:12-20") === "docs/a.md");
  check("剥 `#锚点`", M.stripLocator("docs/a.md#节名") === "docs/a.md");
  check("盘符冒号不被误剥（`D:/x/y.md` 原样）", M.stripLocator("D:/x/y.md") === "D:/x/y.md");
  check("没有定位符时原样返回", M.stripLocator("docs/a.md") === "docs/a.md");
  // 端到端：带行号的真实路径不该被报成 dead
  w(path.join(MEM_A, "locator.md"), [
    "# locator", "",
    "**真相源**：`CONTRACT.md`；细节在 `docs/spec.md:42` 与 `docs/spec.md#总则`。", "",
  ].join("\n"));
  const rLoc = M.scan({ memoryRoot: MEM_ROOT, rootResolver: resolver });
  const loc = rLoc.findings.filter((f) => path.basename(f.file) === "locator.md");
  check("端到端 · `docs/spec.md:42` / `#锚点` 解析得到 ⇒ 零发现（剥之前会被报成 dead）",
    loc.length === 0, JSON.stringify(loc.map((f) => f.token)));
}

console.log("\n=== 并轨 · 末行契约 MEMORY_REFS_SUMMARY（消费方只解析这一行） ===");
{
  function runCli(extraArgs) {
    return spawnSync(process.execPath, [MOD].concat(extraArgs || []), {
      encoding: "utf8",
      env: Object.assign({}, process.env, {
        MEMORY_TRUTH_SOURCE_ROOT: MEM_ROOT,
        MEMORY_TRUTH_SOURCE_FAKE_DRIVE: FAKE_DRIVE,
      }),
    });
  }
  const rAll = runCli(["--scope=all"]);
  const outAll = String(rAll.stdout || "");
  const lines = outAll.trim().split(/\r?\n/);
  const last = lines[lines.length - 1];
  check("末行就是契约行（消费方取最后一行即可）", /^MEMORY_REFS_SUMMARY /.test(last), last);
  const m = /^MEMORY_REFS_SUMMARY exit=(\d+) scope=(\w+) root=(\d) projects=(\d+) files=(\d+) checked=(\d+) dead=(\d+) declared_dead=(\d+) ambiguous=(\d+) skipped=(\d+) errors=(\d+)$/.exec(last);
  check("契约全字段齐（缺字段即判契约被改坏，不判那一格没事）", m !== null, last);
  check("契约里的 exit= 与真退出码恒等", m !== null && Number(m[1]) === rAll.status,
    m ? `${m[1]} vs ${rAll.status}` : "n/a");
  check("契约回填了 scope=all", m !== null && m[2] === "all", m ? m[2] : "n/a");
  check("有发现仍 exit 0（观察线契约在 all 档同样成立）", rAll.status === 0, "code=" + rAll.status);
  check("all 档的 dead 数 >= declared_dead 数（后者是前者的子集）",
    m !== null && Number(m[7]) >= Number(m[8]), m ? `${m[7]}/${m[8]}` : "n/a");
  // 报告分栏：段内/段外处方不同，混在一起报会让人误判严重度
  check("all 档报告把「声明段内」与「声明段外」分开列",
    /真相源声明段内/.test(outAll) && /声明段外/.test(outAll), outAll.slice(0, 400));
  // 缺省仍是 declared（并轨没有偷偷换掉默认行为）
  const rDef = runCli([]);
  check("不传 --scope 时缺省仍是 declared", /MEMORY_REFS_SUMMARY exit=\d+ scope=declared /.test(String(rDef.stdout || "")),
    String(rDef.stdout || "").slice(-200));
  // 未知取值不静默回落 —— 回落等于「你以为扫了全文、其实只扫了声明段」
  const rBad = runCli(["--scope=bogus"]);
  check("未知 --scope 值 → exit 2 且不静默回落", rBad.status === 2, "code=" + rBad.status);
  check("未知 --scope 值 → 不打印任何 SUMMARY（免得被消费方当成跑过了）",
    !/MEMORY_REFS_SUMMARY/.test(String(rBad.stdout || "")), String(rBad.stdout || "").slice(0, 200));
}

console.log("\n=== 并轨 · 投递可达性（「源码里有调用点」是弱判据，只有真跑过才算数） ===");
{
  // 判据同 dead-gates.tests.js ⑫：静态核对证不了调用点可达——它可能被提前 return 跳过、
  // 也可能落在一个从不进入的分支里（`isMetaRepo` 那次就是这么静默了整块模式 A）。
  // 本次并轨的整个价值就在「投递挂上了没有」，故这一条是本文件里最承重的断言。
  const HOOK = path.join(__dirname, "..", "ccswitch", "hooks", "dao-scaffold-check.js");
  const DAO_ROOT = path.resolve(__dirname, "..");
  function runHook(cwd) {
    const payload = JSON.stringify({
      session_id: "memory-truth-source-tests", cwd, hook_event_name: "SessionStart", source: "startup",
    });
    const r = spawnSync(process.execPath, [HOOK], { input: payload, encoding: "utf8", timeout: 120000 });
    let json = null;
    if (r.stdout && r.stdout.trim()) { try { json = JSON.parse(r.stdout); } catch (_) {} }
    const ctx = (json && json.hookSpecificOutput && json.hookSpecificOutput.additionalContext) || "";
    return { code: r.status, ctx, err: String(r.stderr || "") };
  }
  if (!ENV_TIER) {
    deferSection("并轨 · 投递可达性（真喂 SessionStart payload；受 hook 墙钟预算摆布）", DEFER_WHY);
  } else {
    const r = runHook(DAO_ROOT);

    // 🔴 **前置：这一项这次到底跑没跑。** 预算见底时 hook 打的是
    //   `⏱ memory 指针扫描 **没跑**：宿主预算只剩 X ms…`。这一条红的时候直说成因是预算，
    //   而不是让下面三条各自红一次、报文全指向被测对象（issue #160 报的正是那三条）。
    const budgetSkipped = /⏱ memory 指针扫描 \*\*没跑\*\*/.test(r.ctx);
    check("前置：hook 没有因墙钟预算跳过 memory 指针扫描这一项（红了先看这一条）",
      !budgetSkipped,
      "**这条红说明下面三条不可信，且成因与被测对象无关**：hook 的墙钟预算被吃光了，"
      + "而 memory 指针扫描排在全表最后一项、最先被挤掉。"
      + "自查：① 看注入里那行 `ⓘ hook 墙钟预算：本次已花 … / 宿主给 …`"
      + " ② 收干净 git 状态 ③ 别和别的官同时跑测试"
      + " ④ 手跑一次：node ccswitch/lib/memory-truth-source.js --scope=all"
      + "\nctx=" + r.ctx.slice(0, 700));

    // 可达性判据用**行首标记**（ⓘ / ⚠ / ✗ 三者之一）：memoryRefLines 的每条返回路径
    // （模块不在 / 探测失败 / 跑不起来 / 契约被改坏 / 自身出错 / 零可扫 / 取词失效 / 绿）
    // 都以它们之一开头，故这条对真实语料是绿是红不敏感；而 `⏱ …没跑` 不在其中
    // ⇒ 「压根没跑到」再也不能冒充「调用点可达」。
    check("真仓 SessionStart 注入里出现 memory 那一行（调用点可达 —— 这就是「并轨不是搬个家」的证据；「⏱ 没跑」不算）",
      /(?:ⓘ|⚠|✗) memory 指针/.test(r.ctx), "ctx=" + r.ctx.slice(0, 500) + " [stderr]" + r.err.slice(0, 200));
    check("注入的是 scope=all（否则 mousse 侧原有的覆盖面在并轨时被悄悄缩小了）",
      /memory 指针一致性（scope=all/.test(r.ctx) || /scope=all/.test(r.ctx), r.ctx.slice(0, 500));
    check("注入行报出普查数而不是零输出（扫描面缩小必须看得见）",
      /份 memory/.test(r.ctx) && /个路径 token/.test(r.ctx), r.ctx.slice(0, 500));
    check("hook 自身仍 exit 0（SessionStart 只增不阻）", r.code === 0, "code=" + r.code);
  }
}

// 清理
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}

console.log(`\n=== 汇总: PASS=${pass} FAIL=${fail} DEFER=${defer} ===`);
if (defer) {
  console.log("  ⚠ 本次未跑上面 DEFER 那一节 —— **「没跑」不等于「跑了全过」**");
  console.log("  跑完整层：node tests/memory-truth-source.tests.js --env   （要求串行环境，见文件头）");
}
process.exit(fail ? 1 : 0);
