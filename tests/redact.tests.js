// 凭据脱敏两层防线 · 回归网（每层行为分支留正控 + 负控 + 判别力）
//
// 验的层：①模式表正负控 ②fail-closed（抛错/写不了/二进制 ⇒ 拒绝落盘并抛错；in-place 失败
// 隔离）③渲染层断言三态（泄漏红/干净绿/样本空红）④扫描器自检面（分母、二进制分开、报告
// 不回显密钥原文）⑤清单条目三态 ⑥CLI 退出码四态（0/1/2/3）。
// 判别力自检问句：任何把脱敏放宽或收紧的改动，是否都至少有一条断言会变红？
// ⚠ 本文件里所有「密钥」都是合成串（CANARY_* 命名），不是真实凭据；前缀让扫描器自扫
//   能把它们排除——守卫自己的语料不该被当成事故。

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const REPO = path.resolve(__dirname, "..");
const LIB = path.join(REPO, "ccswitch", "lib", "redact.js");
const CLI = path.join(REPO, "ccswitch", "scripts", "dao-redact.mjs");
const MANIFEST_LIB = path.join(REPO, "ccswitch", "lib", "scaffold-manifest.js");
const REAL_MANIFEST = path.join(REPO, "ccswitch", "scaffold-manifest.json");
const TEMPLATES = path.join(REPO, "ccswitch", "templates");
const SANDBOX = path.join(REPO, "_tmp", "redact-sandbox");

const R = require(LIB);
const M = require(MANIFEST_LIB);

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? "  →  " + detail : ""}`); }
}
function threw(fn) {
  try { fn(); return { threw: false }; }
  catch (e) { return { threw: true, code: e.code, message: String(e.message || e), err: e }; }
}

fs.rmSync(SANDBOX, { recursive: true, force: true });
fs.mkdirSync(SANDBOX, { recursive: true });
function sb(rel) { return path.join(SANDBOX, rel); }
function w(rel, content) {
  const p = sb(rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, "utf8");
  return p;
}

const CANARY_SK = "sk-CANARYaaaabbbbccccddddeeeeffff1234";
const CANARY_JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJDQU5BUlkifQ.CANARYsignature-xyz";

console.log("\n=== ① 模式表 · 正控（代表性凭据类型）===");
{
  const positives = [
    ["sk 系", `key=${CANARY_SK}`, CANARY_SK],
    ["Bearer", "Authorization: Bearer CANARYtoken.abc-123_xyz", "CANARYtoken.abc-123_xyz"],
    ["JWT", `token ${CANARY_JWT}`, CANARY_JWT],
    ["GitHub PAT", "ghp_CANARY0123456789abcdefghij0123456", "ghp_CANARY0123456789abcdefghij0123456"],
    // AWS access key id = AKIA + 恰好 16 位（真 AKID 总长 20）；首版夹具只给 14 位而红，
    // 是夹具错、判据对。留着免得下次有人反过来放宽正则。
    ["AWS AKID", "AKIACANARY0123456789", "AKIACANARY0123456789"],
    ["私钥块", "-----BEGIN RSA PRIVATE KEY-----\nCANARYprivatekeybody\n-----END RSA PRIVATE KEY-----", "CANARYprivatekeybody"],
    ["env 赋值", "ANTHROPIC_AUTH_TOKEN=CANARYenvvalue", "CANARYenvvalue"],
    ["json kv", '{"api_key":"CANARYjsonsnake"}', "CANARYjsonsnake"],
  ];
  for (const [label, input, secret] of positives) {
    check(`正控 ${label} 消失`, !R.redactText(input).includes(secret), JSON.stringify(R.redactText(input)).slice(0, 120));
  }
  check("正控 · 命中类型报得出来", R.patternsHit(`k=${CANARY_SK}`).length > 0);
  check("幂等 · 重复跑输出逐字节相同，脱敏标记不再被自己吃一遍",
    (() => { const once = R.redactText(`a=${CANARY_SK} b=${CANARY_SK}`); return once === R.redactText(once) && !once.includes(CANARY_SK); })());
}

console.log("\n=== ① 模式表 · 负控 + 全局正则无状态 ===");
{
  const negatives = [
    ["普通英文句子", "The quick brown fox jumps over the lazy dog."],
    ["中文散文", "这一段讲的是脱敏防线的射程边界，不含任何凭据。"],
    ["Content-Type 头", "Content-Type: application/json"],
    ["git sha", "commit 0d316be4ee7335874350f0e3fee56a2c2e20fb2d"],
    ["普通 json 数值", '{"max_history_messages": 17}'],
  ];
  for (const [label, input] of negatives) {
    check(`负控 ${label} 原样不动`, R.redactText(input) === input, JSON.stringify(R.redactText(input)));
  }
  check("正控 · 同一行内多处命中全部脱掉（freshRe，不带 lastIndex 状态）",
    !R.redactText(`a=${CANARY_SK} b=${CANARY_SK}`).includes(CANARY_SK));
}

console.log("\n=== ② fail-closed（拒绝落盘 + in-place 隔离）===");
{
  const src = w("copy/src.log", `line1\nANTHROPIC_AUTH_TOKEN=${CANARY_SK}\nline3\n`);
  const dest = sb("copy/out/dest.log");
  const r = R.redactFileTo(src, dest);
  const destText = fs.readFileSync(dest, "utf8");
  check("正控 · 目标写出来且没有密钥，源文件不动，报出命中类型",
    fs.existsSync(dest) && !destText.includes(CANARY_SK) &&
    fs.readFileSync(src, "utf8").includes(CANARY_SK) && r.hits.length > 0);

  const fsrc = w("failclosed/src.log", `TOKEN=${CANARY_SK}\n`);
  const fdest = sb("failclosed/dest.log");
  const t = threw(() => R.redactFileTo(fsrc, fdest, { redactFn: () => { throw new Error("boom"); } }));
  check("fail-closed · 脱敏抛错 ⇒ 抛 EREDACT 且目标根本不存在（原空 catch 那个洞的回归网）",
    t.threw && t.code === "EREDACT" && !fs.existsSync(fdest));

  const bin = sb("binary/shot.png");
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.writeFileSync(bin, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x03]));
  const bt = threw(() => R.redactFileTo(bin, sb("binary/out.png")));
  check("fail-closed · 二进制 ⇒ 抛 EBINARY 且目标不产生", bt.threw && bt.code === "EBINARY" && !fs.existsSync(sb("binary/out.png")));
  check("二进制判据 · 含 NUL 判真 / 纯文本判假",
    R.isProbablyBinary(Buffer.from([0x41, 0x00, 0x42])) === true &&
    R.isProbablyBinary(Buffer.from("hello 世界", "utf8")) === false);
  // in-place 遇二进制刻意不隔离：那多半是有人把截图喂进来了，毁掉它是误伤
  const keepBin = sb("inplace/keep.bin");
  fs.mkdirSync(path.dirname(keepBin), { recursive: true });
  fs.writeFileSync(keepBin, Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04]));
  const t2 = threw(() => R.redactFileInPlace(keepBin));
  check("in-place 遇二进制 ⇒ 抛 EBINARY 但文件原样（射程外，毁掉它是误伤）",
    t2.threw && t2.code === "EBINARY" && fs.statSync(keepBin).size === 5);

  const p = w("inplace/ok.log", `Cookie: sess=${CANARY_SK}\n`);
  const ir = R.redactFileInPlace(p);
  check("正控 · in-place 就地脱敏 + 报出命中类型",
    !fs.readFileSync(p, "utf8").includes(CANARY_SK) && ir.hits.length > 0);
  const fp = w("inplace/fails.log", `TOKEN=${CANARY_SK}\n`);
  const ft = threw(() => R.redactFileInPlace(fp, { redactFn: () => { throw new Error("boom"); } }));
  check("fail-closed · in-place 脱敏抛错 ⇒ 抛错且文件被隔离（裸密钥不再在盘上）",
    ft.threw && ft.code === "EREDACT" && !fs.readFileSync(fp, "utf8").includes(CANARY_SK) &&
    ft.err.quarantine === "overwritten");
  check("参数校验 · onFailure 非法值 ⇒ 抛 EARG（不静默当成缺省）",
    threw(() => R.redactFileInPlace(fp, { onFailure: "怎么都行" })).code === "EARG");
  check("隔离 · 正控 ⇒ overwritten 且覆写内容自陈原因；目录 ⇒ failed 不谎报",
    R.quarantine(w("quarantine/t.log", `TOKEN=${CANARY_SK}\n`), "测试") === "overwritten" &&
    fs.readFileSync(sb("quarantine/t.log"), "utf8").includes("已被隔离") &&
    (() => { const d = sb("quarantine/is-dir.log"); fs.mkdirSync(d, { recursive: true }); return R.quarantine(d, "测试") === "failed"; })());
}

console.log("\n=== ③ 渲染层断言 · 三态 ===");
{
  const cfg = {
    upstreams: [{ name: "a", api_key: "CANARYuiconfigkey", base_url: "https://example.invalid" }],
    nested: { deeper: { authorization: "CANARYuiauth" } },
    plain: { note: "不是密钥", shape: CANARY_SK },
  };
  const secrets = R.collectSecretValues(cfg);
  check("collectSecretValues · 按键名收 + 按值形状收（sk-），不收普通字符串/URL",
    secrets.includes("CANARYuiconfigkey") && secrets.includes(CANARY_SK) &&
    !secrets.includes("不是密钥") && !secrets.includes("https://example.invalid"));

  const leakText = `欢迎回来，你的 key 是 CANARYuiconfigkey，请勿外传`;
  const t = threw(() => R.assertNoSecretLeak(leakText, secrets, { label: "首页" }));
  check("态一 · 渲染面出现真密钥 ⇒ 抛 ELEAK 且报错里不回显密钥原文（只打码）",
    t.threw && t.code === "ELEAK" && !t.message.includes("CANARYuiconfigkey"));
  const ok = R.assertNoSecretLeak("设置已保存。上游：a（密钥已隐藏）", secrets, { label: "首页" });
  check("态二 · 渲染面干净 ⇒ 通过并报出检查了几条", ok.checked === secrets.length && ok.textLength > 0);
  check("态三 · 样本为空或被检文本为空 ⇒ 红（ENOSAMPLE，零违例与零样本不可区分）",
    threw(() => R.assertNoSecretLeak("设置已保存", [], { label: "首页" })).code === "ENOSAMPLE" &&
    threw(() => R.assertNoSecretLeak("", secrets, { label: "首页" })).code === "ENOSAMPLE");
  check("显式 allowEmpty ⇒ 放行（逃生阀存在且必须显式）",
    !threw(() => R.assertNoSecretLeak("", [], { allowEmpty: true })).threw);
}

console.log("\n=== ④ 扫描器 · 自检面 ===");
{
  w("scan/tree/a.log", `x\nAUTH_TOKEN=${CANARY_SK}\ny\n`);
  w("scan/tree/sub/b.md", "这里没有凭据，只有散文。\n");
  fs.writeFileSync(sb("scan/tree/c.png"), Buffer.from([0x89, 0x50, 0x00, 0x01]));
  const r = R.scanTree(sb("scan/tree"));
  check("扫描 · 命中 a.log，分母不含二进制，二进制单独计数",
    r.findings.some((f) => f.file.endsWith("a.log")) && r.scanned === 2 && r.binarySkipped === 1,
    JSON.stringify(r).slice(0, 200));
  check("扫描 · 命中项不带密钥原文、带路径/行号/模式名（报告不落进自己的扫描面）",
    !JSON.stringify(r.findings).includes(CANARY_SK) &&
    r.findings.every((f) => f.file && f.line > 0 && f.pattern));
  const empty = R.scanTree(sb("scan/nonexistent-dir"));
  check("扫描 · 路径不存在 ⇒ unreadable≥1 且 scanned=0（与「零命中」分得开）",
    empty.unreadable >= 1 && empty.scanned === 0);
  check("跳过目录清单含 .git / node_modules",
    R.DEFAULT_SKIP_DIRS.has(".git") && R.DEFAULT_SKIP_DIRS.has("node_modules"));
}

console.log("\n=== ⑥ CLI · 退出码四态 + 末行契约 ===");
function cli(args) {
  const r = spawnSync(process.execPath, [CLI].concat(args), { encoding: "utf8" });
  const out = String(r.stdout || "");
  const m = out.match(/DAO_REDACT_SUMMARY exit=(\d+) mode=(\S+) files=(\d+) ok=(\d+) hits=(\d+) binary=(\d+) unreadable=(\d+) failed=(\d+)/);
  return { code: r.status, out, sum: m ? { exit: +m[1], mode: m[2], files: +m[3], ok: +m[4], hits: +m[5], binary: +m[6], unreadable: +m[7], failed: +m[8] } : null };
}
{
  const src = w("cli/src.log", `A=1\nAPI_KEY=${CANARY_SK}\n`);
  const dest = sb("cli/out/dest.log");
  const a = cli(["--copy", src, dest]);
  check("CLI · --copy 成功 ⇒ exit 0 + 末行契约 + 目标无密钥",
    a.code === 0 && a.sum && a.sum.exit === 0 && a.sum.mode === "copy" &&
    fs.existsSync(dest) && !fs.readFileSync(dest, "utf8").includes(CANARY_SK));

  const c = cli(["--scan", sb("scan/tree")]);
  check("CLI · --scan 有命中 ⇒ exit 1，且输出里没有密钥原文",
    c.code === 1 && c.sum && c.sum.hits >= 1 && !c.out.includes(CANARY_SK));

  fs.mkdirSync(sb("cli/emptydir2"), { recursive: true });
  const g = cli(["--scan", sb("cli/emptydir2")]);
  check("CLI · 空目录（零样本）⇒ exit 2 而不是 0", g.code === 2 && g.sum && g.sum.files === 0);

  const h = cli(["--json"]);
  check("CLI · 没给模式 ⇒ exit 3（用法错，与失败分得开）", h.code === 3 && h.sum && h.sum.exit === 3);

  const j = cli(["--scan", sb("scan/tree"), "--exclude", "a.log"]);
  check("CLI · --exclude 能把守卫自己排除出扫描面", j.code === 0 && j.sum && j.sum.hits === 0);

  const p = w("cli/inplace.log", `Cookie: s=${CANARY_SK}\n`);
  const k = cli(["--in-place", p]);
  check("CLI · --in-place ⇒ exit 0 且文件已脱敏", k.code === 0 && !fs.readFileSync(p, "utf8").includes(CANARY_SK));

  // 最坏一格端到端：目标读不了且隔离也动不了 ⇒ exit 2 且明说需要人手处置，
  // 不许表现成普通失败（那会被当成「重跑一下就好」而放过可能裸的文件）。
  const dirAsFile = sb("cli/is-a-dir.log");
  fs.mkdirSync(dirAsFile, { recursive: true });
  const l = cli(["--in-place", dirAsFile]);
  check("CLI · 读不了且隔离也失败 ⇒ exit 2 且明说需要人手处置",
    l.code === 2 && /隔离也失败/.test(l.out) && /人手处置/.test(l.out), l.out.slice(0, 300));
}

console.log("\n=== ⑤ 清单条目 qa-artifact-redaction · 三态 ===");
{
  const ENTRY_ID = "qa-artifact-redaction";
  const { manifest, errors } = M.load(REAL_MANIFEST, { templatesRoot: TEMPLATES });
  const entry = ((manifest && manifest.entries) || []).find((e) => e.id === ENTRY_ID);
  check("真实清单仍过 schema，条目在且 class=conditional，canonical 模板真实存在",
    errors.length === 0 && !!entry && entry.class === "conditional" &&
    fs.existsSync(path.join(TEMPLATES, entry.template.src)));

  const only = { entries: [entry] };
  const hit = path.join(SANDBOX, "proj-hit");
  fs.mkdirSync(path.join(hit, "scripts", "qa"), { recursive: true });
  const fHit = M.evaluate(only, hit, { templatesRoot: TEMPLATES });
  check("态一 · 命中（有 QA 脚本指纹且缺 rule）⇒ 报一条，带零编辑复制指令与 label",
    fHit.length === 1 && /零编辑复制 canonical/.test(fHit[0].message) && /QA 脚本目录/.test(fHit[0].message));

  const miss = path.join(SANDBOX, "proj-miss");
  fs.mkdirSync(path.join(miss, "src"), { recursive: true });
  fs.writeFileSync(path.join(miss, "package.json"), '{"name":"x"}', "utf8");
  check("态二 · 不命中（无 QA 脚本指纹）⇒ 零报",
    M.evaluate(only, miss, { templatesRoot: TEMPLATES }).length === 0);

  const full = path.join(SANDBOX, "proj-full");
  fs.mkdirSync(path.join(full, "scripts", "qa"), { recursive: true });
  fs.mkdirSync(path.join(full, ".claude", "rules"), { recursive: true });
  fs.writeFileSync(path.join(full, ".claude", "rules", "qa-artifact-redaction.md"), "# 派生自 canonical", "utf8");
  check("态二' · 齐备（指纹命中但 rule 在）⇒ 零报",
    M.evaluate(only, full, { templatesRoot: TEMPLATES }).length === 0);

  const degraded = path.join(SANDBOX, "proj-degraded");
  fs.mkdirSync(path.join(degraded, "scripts", "qa"), { recursive: true });
  fs.mkdirSync(path.join(degraded, ".claude", "rules", "qa-artifact-redaction.md"), { recursive: true });
  check("态三 · 求值退化（rule 位置是目录不是文件）⇒ 仍然报，失败方向朝「多报」",
    M.evaluate(only, degraded, { templatesRoot: TEMPLATES }).length === 1);
  const noTpl = M.evaluate(only, hit, { templatesRoot: path.join(SANDBOX, "no-such-templates") });
  check("态三' · canonical 模板缺失 ⇒ 报文明说「模板缺失」不静默退回 AI 自己写",
    noTpl.length === 1 && /canonical 模板缺失/.test(noTpl[0].message));
}

try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch (_) {}

console.log(`\n=== 汇总: PASS=${pass} FAIL=${fail} ===`);
process.exit(fail ? 1 : 0);
