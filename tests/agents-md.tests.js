// agents-md 回归网 — ccswitch/scripts/gen-agents-md.mjs 的双向断言
//
// 跑法：node tests/agents-md.tests.js     （全绿 exit 0，任一红 exit 1）
//       node scripts/run-tests.mjs        （自动发现本文件，无需登记）
//
// ── 这个回归网要钉住什么 ─────────────────────────────────────────────────────
// 被测对象的**全部价值**在于「AGENTS.md 是投影不是第二份真相源」这句话为真。
// 它有三种失效方式，每一种都是静默的：
//   ① 生成不幂等 ⇒ 每次跑都产生只差时间戳的假 diff ⇒ 人开始对这个文件的改动视而不见
//   ② `--check` 只查源 hash ⇒ **有人直接手改投影正文**时它照样报绿（源没动、hash 当然对）
//   ③ 覆盖了一份手写的 AGENTS.md ⇒ 不可逆的数据损失，而它看起来只是「生成成功」
// 故正控（能生成、能查出过期）与负控（不误覆盖、不误判、幂等）同等重要。
//
// ── 另有一节专钉「两个文件之间的契约」（§⑧）────────────────────────────────
// scaffold-manifest.json 的 `agents-md-generated` 条目用 `fileContains` 查一个**字面子串**，
// 而那个子串由本脚本写出。两处各写一遍 ⇒ 改一处忘一处，清单会**静默地永远报缺项**
// （或永远放行），这正是本仓反复在治的「被引用方一改、引用方静默失效」。
// §⑧ 把两处对起来，让漂移在测试里现形而不是在某个项目的 SessionStart 里现形。

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const REPO = path.resolve(__dirname, "..");
const SCRIPT = path.join(REPO, "ccswitch", "scripts", "gen-agents-md.mjs");
const MANIFEST = path.join(REPO, "ccswitch", "scaffold-manifest.json");
const TMP = path.join(REPO, "_tmp", "agents-md-tests");

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail ? "  ->  " + detail : "")); }
}

function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }
function w(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, "utf8");
}
function readOr(file, dflt) { try { return fs.readFileSync(file, "utf8"); } catch (_) { return dflt; } }

const CLAUDE_SAMPLE = [
  "# 某项目 · 铁律",
  "",
  "## 一、这是什么",
  "",
  "一个用来测生成器的假项目。产品型项目。",
  "",
  "## 二、PR-first",
  "",
  "1. 开分支 → 提交 → `gh pr create`",
  "2. commit subject 前缀 `[cc]`",
  "",
].join("\n");

function mkProject(name, claudeMd, agentsMd) {
  const dir = path.join(TMP, name);
  rm(dir);
  fs.mkdirSync(dir, { recursive: true });
  if (claudeMd != null) w(path.join(dir, "CLAUDE.md"), claudeMd);
  if (agentsMd != null) w(path.join(dir, "AGENTS.md"), agentsMd);
  return dir;
}

function run(dir, extra) {
  const r = spawnSync(process.execPath, [SCRIPT, dir].concat(extra || []), { encoding: "utf8", timeout: 60000 });
  const out = String(r.stdout || "");
  const m = /AGENTS_MD_SUMMARY exit=(\d+) action=(\w+) source=(\S+) sha=(\S+)/.exec(out);
  return {
    code: r.status, out, stderr: String(r.stderr || ""),
    sum: m ? { exit: +m[1], action: m[2], source: m[3], sha: m[4] } : null,
    agents: readOr(path.join(dir, "AGENTS.md"), null),
  };
}

rm(TMP);

// ══════════════════════════════════════════════════════════════
console.log("\n──── ① 生成：头注 + 标记 + 正文逐字 ────");
{
  const d = mkProject("basic", CLAUDE_SAMPLE);
  const r = run(d);
  check("exit 0 且 action=written", r.code === 0 && r.sum && r.sum.action === "written",
    JSON.stringify(r.sum) + r.out.slice(-300));
  check("AGENTS.md 真的落盘了", r.agents !== null, r.out.slice(-300));
  check("开头有生成标记（清单条目查的就是它）",
    /^<!-- dao:generated-from CLAUDE\.md -->/.test(String(r.agents)), String(r.agents).slice(0, 200));
  check("带源 sha256 标记（--check 的依据）",
    /<!-- dao:source-sha256 [0-9a-f]{64} -->/.test(String(r.agents)), String(r.agents).slice(0, 300));
  check("带生成器版本标记（只查 hash 会漏掉模板自身变更）",
    /<!-- dao:generator gen-agents-md\.mjs v\d+ -->/.test(String(r.agents)), String(r.agents).slice(0, 300));
  // 头注三要素：勿手改 / 真相源 / 再生成命令
  check("头注明说「生成物 · 请勿手改」", /生成物 · 请勿手改/.test(String(r.agents)), String(r.agents).slice(0, 600));
  check("头注点名真相源是 CLAUDE.md", /真相源是同目录下的 `CLAUDE\.md`/.test(String(r.agents)), String(r.agents).slice(0, 800));
  check("头注含**再生成命令**（派单令点名要的那一条）",
    /node <windsurf-dao 根>\/ccswitch\/scripts\/gen-agents-md\.mjs <项目根>/.test(String(r.agents)),
    String(r.agents).slice(0, 900));
  check("头注含查过期的说法（--check）", /--check/.test(String(r.agents)), String(r.agents).slice(0, 900));
  check("头注说清手改的后果（会被逮到 + 会被覆盖）",
    /制造第二份真相源/.test(String(r.agents)) && /覆盖/.test(String(r.agents)), String(r.agents).slice(0, 900));
  // 正文
  const i = String(r.agents).indexOf("<!-- dao:body-begin -->");
  const body = String(r.agents).slice(i + "<!-- dao:body-begin -->".length).replace(/^\n+/, "").replace(/\n+$/, "");
  check("正文与 CLAUDE.md 逐字相等（v1 是全文转写，不做段落筛选）",
    body === CLAUDE_SAMPLE.replace(/\n+$/, ""), "bodyLen=" + body.length + " srcLen=" + CLAUDE_SAMPLE.length);
  // 再生成命令刻意不写本机绝对路径（否则两台机器生成出不同字节 = 又一个漂移源），
  // 但解析好的绝对命令要打在 stdout 上，粘贴即可跑
  check("文件里**不**烘焙本机绝对路径（跨机器漂移源）",
    !/[A-Za-z]:[\\/]frank/.test(String(r.agents)), String(r.agents).slice(0, 1200));
  check("stdout 给出解析好的绝对命令（要粘贴的人当场拿得到）",
    /node .*ccswitch\/scripts\/gen-agents-md\.mjs .* --check/.test(r.out), r.out.slice(-500));
}

// ══════════════════════════════════════════════════════════════
console.log("\n──── ② 幂等：跑两次逐字节同，且第二次不写盘 ────");
{
  const d = mkProject("idempotent", CLAUDE_SAMPLE);
  const r1 = run(d);
  const first = String(r1.agents);
  const mtime1 = fs.statSync(path.join(d, "AGENTS.md")).mtimeMs;
  const r2 = run(d);
  check("第二次 action=unchanged（三样都对就一个字节都不写）",
    r2.sum && r2.sum.action === "unchanged", JSON.stringify(r2.sum) + r2.out.slice(-300));
  check("两次内容逐字节相同（时间戳没有把幂等打破）", String(r2.agents) === first,
    "len1=" + first.length + " len2=" + String(r2.agents).length);
  check("第二次确实没写盘（mtime 未变）",
    fs.statSync(path.join(d, "AGENTS.md")).mtimeMs === mtime1);
  check("exit 仍为 0", r2.code === 0, String(r2.code));
  // --force 是明写的例外：它必须真的重写
  const r3 = run(d, ["--force"]);
  check("--force 强制重写（action=written）", r3.sum && r3.sum.action === "written", JSON.stringify(r3.sum));
}

// ══════════════════════════════════════════════════════════════
console.log("\n──── ③ drift 两态：一致 → 0，源改了 → 1 ────");
{
  const d = mkProject("drift", CLAUDE_SAMPLE);
  run(d);
  const ok = run(d, ["--check"]);
  check("负控：一致时 --check exit 0", ok.code === 0 && ok.sum && ok.sum.action === "unchanged",
    JSON.stringify(ok.sum) + ok.out.slice(-300));
  check("负控报文说清查了三样", /源 hash \/ 生成器版本 \/ 正文三样都对/.test(ok.out), ok.out.slice(-400));

  w(path.join(d, "CLAUDE.md"), CLAUDE_SAMPLE + "\n## 三、新加的一节\n\n改了源但没重新生成。\n");
  const bad = run(d, ["--check"]);
  check("正控：源改了 → exit 1", bad.code === 1 && bad.sum && bad.sum.action === "drift",
    JSON.stringify(bad.sum) + bad.out.slice(-400));
  check("点出是「源 hash 不匹配」而非别的", /源 hash 不匹配/.test(bad.out), bad.out.slice(-600));
  check("报文给出重新生成的命令（只说过期等于没说）",
    /重新生成：node .*gen-agents-md\.mjs/.test(bad.out), bad.out.slice(-600));
  check("--check 不写盘（它只报，不代做）",
    /source-sha256/.test(String(bad.agents)) && String(bad.agents) === String(run(d, ["--check"]).agents));

  // 重新生成后应恢复一致
  const fixed = run(d);
  check("重新生成后 action=written", fixed.sum && fixed.sum.action === "written", JSON.stringify(fixed.sum));
  check("重新生成后 --check 回到 0", run(d, ["--check"]).code === 0);
}

// ══════════════════════════════════════════════════════════════
console.log("\n──── ④ drift 的另外两种形态（只查 hash 会全部漏掉）────");
{
  // 形态 A：**有人直接手改了投影正文**。源没动 ⇒ hash 照样对得上 ⇒ 只查 hash 的实现报绿。
  const d = mkProject("hand-edited-body", CLAUDE_SAMPLE);
  run(d);
  const p = path.join(d, "AGENTS.md");
  w(p, String(fs.readFileSync(p, "utf8")).replace("commit subject 前缀 `[cc]`", "commit subject 随便写"));
  const r = run(d, ["--check"]);
  check("手改正文 → exit 1（源没动、hash 对得上，只查 hash 结构上失明）",
    r.code === 1 && r.sum && r.sum.action === "drift", JSON.stringify(r.sum) + r.out.slice(-500));
  check("点出是「正文不再逐字相等」", /正文与 CLAUDE\.md 不再逐字相等/.test(r.out), r.out.slice(-600));
  check("并说明为什么只查 hash 逮不到", /只查 hash 对这一类结构上失明/.test(r.out), r.out.slice(-600));
}
{
  // 形态 B：生成器模板本身变了（版本号不匹配）
  const d = mkProject("stale-generator", CLAUDE_SAMPLE);
  run(d);
  const p = path.join(d, "AGENTS.md");
  w(p, String(fs.readFileSync(p, "utf8")).replace(/gen-agents-md\.mjs v\d+/, "gen-agents-md.mjs v0"));
  const r = run(d, ["--check"]);
  check("生成器版本不匹配 → exit 1", r.code === 1, JSON.stringify(r.sum) + r.out.slice(-400));
  check("点出是「生成器版本不匹配」", /生成器版本不匹配/.test(r.out), r.out.slice(-600));
}
{
  // 形态 C：正文起点标记被删掉（文件结构被改坏）
  const d = mkProject("broken-structure", CLAUDE_SAMPLE);
  run(d);
  const p = path.join(d, "AGENTS.md");
  w(p, String(fs.readFileSync(p, "utf8")).replace("<!-- dao:body-begin -->", ""));
  const r = run(d, ["--check"]);
  check("正文起点标记没了 → exit 1 且点名", r.code === 1 && /找不到正文起点标记/.test(r.out), r.out.slice(-600));
}

// ══════════════════════════════════════════════════════════════
console.log("\n──── ⑤ 负控：手写的 AGENTS.md 绝不覆盖 ────");
// 静默覆盖一份人写的规则文件是**不可逆**的数据损失，而它看起来只是「生成成功」。
{
  const HAND = "# AGENTS.md\n\n这是人手写的，里面有别处没有的规则。\n";
  const d = mkProject("hand-written", CLAUDE_SAMPLE, HAND);
  const r = run(d);
  check("exit 3 且 action=refused", r.code === 3 && r.sum && r.sum.action === "refused",
    JSON.stringify(r.sum) + r.out.slice(-400));
  check("**文件一个字节都没被动**", String(r.agents) === HAND, JSON.stringify(String(r.agents)));
  check("说清为什么拒绝（覆盖不可逆）", /拒绝覆盖/.test(r.out) && /不可逆/.test(r.out), r.out.slice(-500));
  check("给出改成生成式的走法（只拒绝不指路等于把人挡在门外）",
    /并进 CLAUDE\.md/.test(r.out) && /删掉 AGENTS\.md/.test(r.out), r.out.slice(-500));
  // 一份「正文里恰好抄了标记字样」的手写件不该被误判成投影 —— 标记只在开头 512 字符认
  const d2 = mkProject("marker-in-body", CLAUDE_SAMPLE,
    "# 手写\n\n" + "填充。".repeat(300) + "\n提到 dao:generated-from CLAUDE.md 这几个字而已。\n");
  const r2 = run(d2);
  check("正文深处出现标记字样的手写件仍被判为手写（标记只在开头认）",
    r2.code === 3 && r2.sum && r2.sum.action === "refused", JSON.stringify(r2.sum) + r2.out.slice(-300));
}

// ══════════════════════════════════════════════════════════════
console.log("\n──── ⑥ 源侧边界：缺失 / 空 / 无投影时的 --check ────");
{
  const d = mkProject("no-source", null);
  const r = run(d);
  check("CLAUDE.md 不存在 → exit 2（不凭空造一份投影）", r.code === 2 && r.sum && r.sum.action === "error",
    JSON.stringify(r.sum) + r.out.slice(-400));
  check("说清「没有源就没有投影」", /没有源就没有投影/.test(r.out), r.out.slice(-400));
}
{
  const d = mkProject("empty-source", "   \n\n  \n");
  const r = run(d);
  check("CLAUDE.md 是空的 → exit 2（空源不是「无漂移」，是「无样本」）",
    r.code === 2 && /无样本/.test(r.out), JSON.stringify(r.sum) + r.out.slice(-400));
  check("没有产出一份空的 AGENTS.md 然后宣告成功", r.agents === null, String(r.agents).slice(0, 100));
}
{
  const d = mkProject("check-without-agents", CLAUDE_SAMPLE);
  const r = run(d, ["--check"]);
  check("没有 AGENTS.md 时 --check 是 0 不是 1（本脚本不主张每个项目都该有一份）",
    r.code === 0 && r.sum && r.sum.action === "unchanged", JSON.stringify(r.sum) + r.out.slice(-300));
}

// ══════════════════════════════════════════════════════════════
console.log("\n──── ⑦ 计量口径：CRLF / BOM 不许制造假漂移 ────");
// core.autocrlf 下同一份内容在两台机器上字节不同；拿原始字节做 hash
// 会产生**永远修不好的漂移**，而那种检查最终一定会被静音。
{
  const dLf = mkProject("eol-lf", CLAUDE_SAMPLE);
  const rLf = run(dLf);
  const dCrlf = mkProject("eol-crlf", CLAUDE_SAMPLE.replace(/\n/g, "\r\n"));
  const rCrlf = run(dCrlf);
  check("CRLF 源与 LF 源算出同一个 sha", rLf.sum && rCrlf.sum && rLf.sum.sha === rCrlf.sum.sha,
    "lf=" + (rLf.sum && rLf.sum.sha) + " crlf=" + (rCrlf.sum && rCrlf.sum.sha));
  check("盘上字节确实不同（否则上一条是空断言）",
    fs.statSync(path.join(dCrlf, "CLAUDE.md")).size > fs.statSync(path.join(dLf, "CLAUDE.md")).size);

  const dBom = mkProject("bom", "\ufeff" + CLAUDE_SAMPLE);
  const rBom = run(dBom);
  check("带 BOM 的源算出同一个 sha", rBom.sum && rLf.sum && rBom.sum.sha === rLf.sum.sha,
    "bom=" + (rBom.sum && rBom.sum.sha));

  // 生成完再把源改成 CRLF ⇒ 不该被报成过期（否则每次 checkout 都红）
  const d2 = mkProject("eol-recheck", CLAUDE_SAMPLE);
  run(d2);
  w(path.join(d2, "CLAUDE.md"), CLAUDE_SAMPLE.replace(/\n/g, "\r\n"));
  check("源换成 CRLF 后 --check 仍为 0（不制造「换台机器就红」的假漂移）",
    run(d2, ["--check"]).code === 0);
}

// ══════════════════════════════════════════════════════════════
console.log("\n──── ⑧ 两个文件之间的契约：清单条目 ↔ 生成标记 ────");
// 清单用一个**字面子串**查投影，而那个子串由脚本写出。两处各写一遍 ⇒ 改一处忘一处，
// 清单会静默地永远报缺项（或永远放行）。这一节让漂移在测试里现形。
{
  let manifest = null;
  try { manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8")); } catch (_) { manifest = null; }
  const entry = manifest && (manifest.entries || []).find((e) => e.id === "agents-md-generated");
  check("清单里有 agents-md-generated 条目", !!entry, JSON.stringify(Object.keys(manifest || {})));
  check("它是 conditional（不是 universal/product-type——集合不同，见 why）",
    entry && entry.class === "conditional", entry && entry.class);
  check("when 是「已经有 AGENTS.md」这个纯存在性指纹（不判「该不该有」那种语义题）",
    entry && entry.when && entry.when.file === "AGENTS.md", JSON.stringify(entry && entry.when));

  const needle = entry && entry.require && entry.require.fileContains && entry.require.fileContains.text;
  check("require 用 fileContains 查生成标记", typeof needle === "string" && needle.length > 0,
    JSON.stringify(entry && entry.require));

  // 真靶：拿一份**真的生成出来的** AGENTS.md 去过清单那条判据
  const d = mkProject("manifest-contract", CLAUDE_SAMPLE);
  run(d);
  const generated = String(readOr(path.join(d, "AGENTS.md"), ""));
  check("清单的子串在真实生成物里命中（契约没漂）",
    !!needle && generated.indexOf(needle) !== -1,
    "needle=" + JSON.stringify(needle) + " head=" + generated.slice(0, 120));
  // 反向：手写件不许命中（否则这条清单条目是一句永远为真的废话）
  check("负控：手写的 AGENTS.md 不命中该子串（否则清单条目恒真 = 废话）",
    !!needle && "# AGENTS.md\n\n人手写的。\n".indexOf(needle) === -1, "needle=" + JSON.stringify(needle));

  // 清单自身要能通过校验器（新条目写错 class/when 组合会让整份清单加载失败）
  const M = require(path.join(REPO, "ccswitch", "lib", "scaffold-manifest.js"));
  const errs = M.validate(manifest || {});
  check("加了新条目后整份清单仍通过 validate（0 条错）", errs.length === 0, JSON.stringify(errs).slice(0, 500));
}

// ══════════════════════════════════════════════════════════════
console.log("\n──── ⑨ `@import` 出声但不判红 ────");
{
  const d = mkProject("with-imports", CLAUDE_SAMPLE + "\n@D:/frank/windsurf-dao/ccswitch/dao.md\n");
  const r = run(d);
  check("有 @import 仍 exit 0（不判红）", r.code === 0 && r.sum && r.sum.action === "written", JSON.stringify(r.sum));
  check("但必须出声（别的宿主不认这个机制）", /`@路径` 导入/.test(r.out) && /不展开/.test(r.out), r.out.slice(-600));
  check("点名具体是哪一行", /@D:\/frank\/windsurf-dao/.test(r.out), r.out.slice(-600));
  check("说清为什么不代为展开", /烘焙进项目仓库/.test(r.out), r.out.slice(-600));
  // 精确断言，不给 `||` 兜底：兜底会把这一条变成一句几乎恒真的话
  // （初版写了 `|| /不会/.test(...)`，那等于没断言）。
  check("投影头注里也留了这条警告（读投影的人看得到，不只是跑脚本的人）",
    /`@路径` 导入\*\*不会\*\*在本文件里展开/.test(String(r.agents)), String(r.agents).slice(0, 1500));
}

console.log("\n=== 汇总: PASS=" + pass + " FAIL=" + fail + " ===");
process.exit(fail ? 1 : 0);
