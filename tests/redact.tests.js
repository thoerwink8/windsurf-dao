// 凭据脱敏两层防线 · 回归网
//
// 跑法：node tests/redact.tests.js   （全绿 exit 0，任一红 exit 1）
//
// ── 验的是哪几层 ────────────────────────────────────────────────────────────
//   ① 模式表的**正负控**：每类凭据都真的被脱掉（正控）+ 长得像但不是的东西不被误伤（负控）
//   ② **fail-closed**：脱敏抛错 / 目标写不了 / 二进制工件 ⇒ **拒绝落盘并抛错**，
//      且 in-place 失败时那个文件被隔离 —— 这是本次上移修掉的最危险的一格
//      （原实现是空 catch，裸文件原样留在工件目录，退出码 0、日志上什么都没有）
//   ③ **渲染层断言**的三态：泄漏 ⇒ 红 · 干净 ⇒ 绿 · **样本为空 ⇒ 红**（零违例≠零样本）
//   ④ **扫描器的自检面**：分母打印、二进制/不可读分开计数、**报告里绝不回显密钥原文**
//   ⑤ 清单新条目 `qa-artifact-redaction` 的**三态**：命中 / 不命中 / 求值退化
//   ⑥ CLI 的**退出码四态**（0/1/2/3）——只读退出码的消费方拿到的必须是可区分的四个值
//
// ── 断言策略 ────────────────────────────────────────────────────────────────
// 每条判据给**正负两例**：单向断言夹不住「判据被放宽」那个方向。
// 判别力自检问句：**任何把脱敏放宽或收紧的改动，是否都至少有一条断言会变红？**
// 本文件的 mutation 记录（真改代码、真跑、真复原）写在 PR 正文，不写在这里
// ——那是执行记录不是契约，写进代码会随下一次改动变成谎话。
//
// ⚠ 本文件里出现的所有「密钥」都是**合成串**，不是任何真实凭据；且刻意用
//   `CANARY_*` 命名，便于扫描器的自扫把它们排除（守卫自己的语料不该被当成事故）。

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
function threw(fn, code) {
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

// 合成语料。每条：[标签, 输入, 里面那段必须消失的东西]
const CANARY_SK = "sk-CANARYaaaabbbbccccddddeeeeffff1234";
const CANARY_JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJDQU5BUlkifQ.CANARYsignature-xyz";
const POSITIVE = [
  ["sk 系", `key=${CANARY_SK}`, CANARY_SK],
  ["Bearer", "Authorization: Bearer CANARYtoken.abc-123_xyz", "CANARYtoken.abc-123_xyz"],
  ["JWT", `token ${CANARY_JWT}`, CANARY_JWT],
  ["Google", "AIzaCANARY0123456789abcdefghijklmnop", "AIzaCANARY0123456789abcdefghijklmnop"],
  ["GitHub PAT", "ghp_CANARY0123456789abcdefghij0123456", "ghp_CANARY0123456789abcdefghij0123456"],
  ["GitHub fine-grained", "github_pat_CANARY0123456789abcdefghij_more", "github_pat_CANARY0123456789abcdefghij_more"],
  ["Slack", "xoxb-CANARY-0123456789-abcdef", "xoxb-CANARY-0123456789-abcdef"],
  // AWS access key id = AKIA + **恰好 16** 位 —— 首版夹具只给了 14 位而红，
  // 是**夹具错、判据对**（真 AKID 总长 20）。留着这条注释免得下次有人反过来放宽正则。
  ["AWS AKID", "AKIACANARY0123456789", "AKIACANARY0123456789"],
  ["cookie 行", "Cookie: sess=CANARYcookievalue; Path=/", "CANARYcookievalue"],
  ["set-cookie 行", "set-cookie: sid=CANARYsetcookie", "CANARYsetcookie"],
  ["auth 头行", "x-api-key: CANARYheaderkey", "CANARYheaderkey"],
  ["env 赋值", "ANTHROPIC_AUTH_TOKEN=CANARYenvvalue", "CANARYenvvalue"],
  ["env 赋值 · export", "export MY_SECRET=CANARYexportvalue", "CANARYexportvalue"],
  ["json kv · snake_case", '{"api_key":"CANARYjsonsnake"}', "CANARYjsonsnake"],
  ["json kv · 紧凑", '{"apikey":"CANARYjsoncompact"}', "CANARYjsoncompact"],
  ["json kv · x- 前缀大写", '{"X-API-KEY":"CANARYjsonupper"}', "CANARYjsonupper"],
  ["json kv · authorization", '{"Authorization":"CANARYjsonauth"}', "CANARYjsonauth"],
  ["yaml kv", "api_key: CANARYyamlvalue", "CANARYyamlvalue"],
  ["私钥块", "-----BEGIN RSA PRIVATE KEY-----\nCANARYprivatekeybody\n-----END RSA PRIVATE KEY-----", "CANARYprivatekeybody"],
];

// 负控：长得沾边但**不该**被改动的东西。判据放宽时这一组会变红。
const NEGATIVE = [
  ["普通英文句子", "The quick brown fox jumps over the lazy dog."],
  ["中文散文", "这一段讲的是脱敏防线的射程边界，不含任何凭据。"],
  ["Content-Type 头", "Content-Type: application/json"],
  ["git sha", "commit 0d316be4ee7335874350f0e3fee56a2c2e20fb2d"],
  ["普通 json 数值", '{"max_history_messages": 17}'],
  ["普通 json 字符串", '{"model":"claude-opus-5"}'],
  ["skip 这个词不是 sk-", "skipping 3 files"],
  ["短横线开头的 markdown", "- 这是一条列表项：token 的用法说明"],
];

// ══════════════════════════════════════════════════════════════════════════
console.log("\n=== ① 模式表 · 正控（每类凭据都真的消失）===");
for (const [label, input, secret] of POSITIVE) {
  const out = R.redactText(input);
  check(`正控 ${label}`, !out.includes(secret), `out=${JSON.stringify(out).slice(0, 160)}`);
}
check("正控 · 命中类型报得出来（patternsHit 非空）", R.patternsHit(`k=${CANARY_SK}`).length > 0);

console.log("\n=== ① 模式表 · 负控（长得沾边的东西不被误伤）===");
for (const [label, input] of NEGATIVE) {
  check(`负控 ${label} 原样不动`, R.redactText(input) === input,
    `in=${JSON.stringify(input)} out=${JSON.stringify(R.redactText(input))}`);
}

console.log("\n=== ① 幂等（重复跑输出逐字节相同；标记不会被自己再吃一遍）===");
{
  const once = R.redactText(POSITIVE.map((p) => p[1]).join("\n"));
  const twice = R.redactText(once);
  check("redactText 幂等", once === twice, `once≠twice, 差异首现于第 ${
    (() => { for (let i = 0; i < Math.max(once.length, twice.length); i++) if (once[i] !== twice[i]) return i; return -1; })()
  } 字符`);
  check("脱敏标记本身不含任何模式认得的形状", R.patternsHit("[REDACTED:sk-key] [REDACTED:json-kv]").length === 0);
}

console.log("\n=== ① 全局正则不带状态（第二次调用不会从 lastIndex 开始漏报）===");
{
  const s = `a=${CANARY_SK} b=${CANARY_SK}`;
  const first = R.redactText(s);
  const second = R.redactText(s);
  check("同一输入两次调用结果相同（freshRe 生效）", first === second);
  check("同一行内多处命中全部脱掉", !first.includes(CANARY_SK), first.slice(0, 120));
  check("scanText 两次调用命中数相同", R.scanText(s).length === R.scanText(s).length && R.scanText(s).length >= 2,
    `hits=${R.scanText(s).length}`);
}

// ══════════════════════════════════════════════════════════════════════════
console.log("\n=== ② fail-closed · redactFileTo（目标位置从无裸内容）===");
{
  const src = w("copy/src.log", `line1\nANTHROPIC_AUTH_TOKEN=${CANARY_SK}\nline3\n`);
  const dest = sb("copy/out/dest.log");
  const r = R.redactFileTo(src, dest);
  const destText = fs.readFileSync(dest, "utf8");
  check("正控 · 目标写出来了", fs.existsSync(dest));
  check("正控 · 目标里没有密钥", !destText.includes(CANARY_SK), destText);
  check("正控 · 源文件不动", fs.readFileSync(src, "utf8").includes(CANARY_SK));
  check("正控 · 报出命中类型", r.hits.length > 0, JSON.stringify(r.hits));
}
{
  // 脱敏函数抛错 ⇒ 必须拒绝落盘。**这一条就是原空 catch 那个洞的回归网。**
  const src = w("failclosed/src.log", `TOKEN=${CANARY_SK}\n`);
  const dest = sb("failclosed/dest.log");
  const t = threw(() => R.redactFileTo(src, dest, { redactFn: () => { throw new Error("boom"); } }));
  check("fail-closed · 脱敏抛错 ⇒ 抛 EREDACT", t.threw && t.code === "EREDACT", JSON.stringify(t).slice(0, 200));
  check("fail-closed · 脱敏抛错 ⇒ 目标文件根本不存在", !fs.existsSync(dest));
  // 反面教材：如果调用方像原实现那样吞掉异常，会发生什么 —— 这条断言证明**本测试真的分得开两者**
  const swallowed = (() => { try { R.redactFileTo(src, dest, { redactFn: () => { throw new Error("boom"); } }); } catch (_) { /* 吞掉 */ } return fs.existsSync(dest); })();
  check("对照 · 即便调用方吞掉异常，目标位置仍然没有裸文件（不靠调用方守规矩）", swallowed === false);
}
{
  // 脱敏函数返回非字符串（比抛错更隐蔽的一种坏法）
  const src = w("failclosed/src2.log", `TOKEN=${CANARY_SK}\n`);
  const dest = sb("failclosed/dest2.log");
  const t = threw(() => R.redactFileTo(src, dest, { redactFn: () => undefined }));
  check("fail-closed · 脱敏返回非字符串 ⇒ 抛 EREDACT 且不落盘", t.threw && t.code === "EREDACT" && !fs.existsSync(dest));
}
{
  // 目标写不进去（dest 位置是个目录）⇒ 抛 EIO，且不留半截文件
  const src = w("failclosed/src3.log", `TOKEN=${CANARY_SK}\n`);
  const destDir = sb("failclosed/dest3.log");
  fs.mkdirSync(destDir, { recursive: true });
  const t = threw(() => R.redactFileTo(src, destDir));
  check("fail-closed · 目标写不了 ⇒ 抛 EIO", t.threw && t.code === "EIO", JSON.stringify(t).slice(0, 200));
  const strays = fs.readdirSync(path.dirname(destDir)).filter((f) => f.startsWith(".redact-"));
  check("fail-closed · 不留 .redact-*.tmp 半截文件", strays.length === 0, strays.join(","));
}
{
  const t = threw(() => R.redactFileTo(sb("failclosed/nope.log"), sb("failclosed/dest4.log")));
  check("fail-closed · 源读不到 ⇒ 抛 EIO（不是静默跳过）", t.threw && t.code === "EIO");
}

console.log("\n=== ② 🚧 射程：二进制工件当场拒绝（不是跳过、不是原样复制）===");
{
  const bin = sb("binary/shot.png");
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.writeFileSync(bin, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x03]));
  const dest = sb("binary/out.png");
  const t = threw(() => R.redactFileTo(bin, dest));
  check("二进制 ⇒ 抛 EBINARY", t.threw && t.code === "EBINARY", JSON.stringify(t).slice(0, 200));
  check("二进制 ⇒ 目标不产生（不给「已脱敏」的错觉）", !fs.existsSync(dest));
  check("二进制判据 · 正控（含 NUL）", R.isProbablyBinary(Buffer.from([0x41, 0x00, 0x42])) === true);
  check("二进制判据 · 负控（纯文本）", R.isProbablyBinary(Buffer.from("hello 世界", "utf8")) === false);
  // in-place 遇二进制**刻意不隔离**：那多半是有人把截图喂进来了，毁掉它是误伤
  const keep = w("binary/keep.txt", "x");
  fs.writeFileSync(sb("binary/keep.bin"), Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04]));
  const t2 = threw(() => R.redactFileInPlace(sb("binary/keep.bin")));
  check("in-place 遇二进制 ⇒ 抛错但**不隔离**（射程外，毁掉它是误伤）",
    t2.threw && t2.code === "EBINARY" && fs.statSync(sb("binary/keep.bin")).size === 5);
  check("（夹具自检）文本文件仍在", fs.existsSync(keep));
}

console.log("\n=== ② fail-closed · redactFileInPlace 的隔离降级 ===");
{
  const p = w("inplace/ok.log", `Cookie: sess=${CANARY_SK}\n`);
  const r = R.redactFileInPlace(p);
  check("正控 · 就地脱敏后文件里没有密钥", !fs.readFileSync(p, "utf8").includes(CANARY_SK));
  check("正控 · 报出命中类型", r.hits.length > 0);
}
{
  const p = w("inplace/fails.log", `TOKEN=${CANARY_SK}\n`);
  const t = threw(() => R.redactFileInPlace(p, { redactFn: () => { throw new Error("boom"); } }));
  const after = fs.readFileSync(p, "utf8");
  check("fail-closed · 脱敏抛错 ⇒ 抛错", t.threw && t.code === "EREDACT");
  check("fail-closed · 脱敏抛错 ⇒ 该文件被隔离，裸密钥不再在盘上", !after.includes(CANARY_SK), after.slice(0, 120));
  check("fail-closed · 隔离结果报得出来（err.quarantine）", t.err && t.err.quarantine === "overwritten", String(t.err && t.err.quarantine));
}
{
  // onFailure:"throw" ⇒ 只抛错、不动文件（显式选择，调用方自己负责）
  const p = w("inplace/keeps.log", `TOKEN=${CANARY_SK}\n`);
  const t = threw(() => R.redactFileInPlace(p, { onFailure: "throw", redactFn: () => { throw new Error("boom"); } }));
  check("负控 · onFailure:throw ⇒ 抛错但文件原样（缺省不是这个）",
    t.threw && fs.readFileSync(p, "utf8").includes(CANARY_SK));
  const t2 = threw(() => R.redactFileInPlace(p, { onFailure: "怎么都行" }));
  check("参数校验 · onFailure 非法值 ⇒ 抛 EARG（不静默当成缺省）", t2.threw && t2.code === "EARG");
}

// ══════════════════════════════════════════════════════════════════════════
console.log("\n=== ③ 渲染层断言 · 三态 ===");
{
  const cfg = {
    upstreams: [{ name: "a", api_key: "CANARYuiconfigkey", base_url: "https://example.invalid" }],
    nested: { deeper: { authorization: "CANARYuiauth" } },
    plain: { note: "不是密钥", shape: CANARY_SK },
  };
  const secrets = R.collectSecretValues(cfg);
  check("collectSecretValues · 按键名收（api_key）", secrets.includes("CANARYuiconfigkey"), JSON.stringify(secrets));
  check("collectSecretValues · 深层嵌套也收", secrets.includes("CANARYuiauth"));
  check("collectSecretValues · 按值形状收（键名平平无奇的 sk-）", secrets.includes(CANARY_SK));
  check("collectSecretValues · 不收普通字符串", !secrets.includes("不是密钥"));
  check("collectSecretValues · 不收 URL 这类非凭据", !secrets.includes("https://example.invalid"));

  const leakText = `欢迎回来，你的 key 是 CANARYuiconfigkey，请勿外传`;
  const t = threw(() => R.assertNoSecretLeak(leakText, secrets, { label: "首页" }));
  check("态一 · 渲染面出现真密钥 ⇒ 抛 ELEAK", t.threw && t.code === "ELEAK", JSON.stringify(t).slice(0, 200));
  check("态一 · 报错信息里**不回显密钥原文**（只打码）",
    t.threw && !t.message.includes("CANARYuiconfigkey"), t.message);

  const cleanText = "设置已保存。上游：a（密钥已隐藏）";
  const ok = R.assertNoSecretLeak(cleanText, secrets, { label: "首页" });
  check("态二 · 渲染面干净 ⇒ 通过并报出检查了几条", ok.checked === secrets.length && ok.textLength > 0);

  const t3 = threw(() => R.assertNoSecretLeak(cleanText, [], { label: "首页" }));
  check("态三 · **样本为空 ⇒ 红**（零违例与零样本不可区分，devin 原版此处无护栏）",
    t3.threw && t3.code === "ENOSAMPLE", JSON.stringify(t3).slice(0, 200));
  const t4 = threw(() => R.assertNoSecretLeak("", secrets, { label: "首页" }));
  check("态三' · **被检文本为空 ⇒ 红**（渲染失败会伪装成安全）", t4.threw && t4.code === "ENOSAMPLE");
  check("显式 allowEmpty ⇒ 放行（逃生阀存在且必须显式）",
    !threw(() => R.assertNoSecretLeak("", [], { allowEmpty: true })).threw);
  check("findLeaks 只返回打码值", R.findLeaks(leakText, secrets).every((l) => !l.masked.includes("CANARYuiconfigkey")));
  check("maskValue 不泄漏中段", R.maskValue("abcdefghijklmn").indexOf("cdefghijkl") === -1);
}

// ══════════════════════════════════════════════════════════════════════════
console.log("\n=== ④ 扫描器 · 自检面（零命中 vs 零样本必须分得开）===");
{
  w("scan/tree/a.log", `x\nAUTH_TOKEN=${CANARY_SK}\ny\n`);
  w("scan/tree/sub/b.md", "这里没有凭据，只有散文。\n");
  fs.writeFileSync(sb("scan/tree/c.png"), Buffer.from([0x89, 0x50, 0x00, 0x01]));
  const r = R.scanTree(sb("scan/tree"));
  check("扫描 · 命中了 a.log", r.findings.some((f) => f.file.endsWith("a.log")), JSON.stringify(r.findings).slice(0, 200));
  check("扫描 · 分母（scanned）由遍历产出且不含二进制", r.scanned === 2, `scanned=${r.scanned}`);
  check("扫描 · 二进制单独计数（不混进「零命中」）", r.binarySkipped === 1, `binary=${r.binarySkipped}`);
  check("扫描 · 命中项里**没有密钥原文**（报告不落进自己的扫描面）",
    !JSON.stringify(r.findings).includes(CANARY_SK), JSON.stringify(r.findings).slice(0, 200));
  check("扫描 · 命中项带路径/行号/模式名", r.findings.every((f) => f.file && f.line > 0 && f.pattern));
  const empty = R.scanTree(sb("scan/empty-dir-that-does-not-exist"));
  check("扫描 · 路径不存在 ⇒ unreadable 计数 ≥1 且 scanned=0（与「零命中」分得开）",
    empty.unreadable >= 1 && empty.scanned === 0, JSON.stringify(empty).slice(0, 160));
  check("扫描 · 跳过目录清单里有 .git / node_modules", R.DEFAULT_SKIP_DIRS.has(".git") && R.DEFAULT_SKIP_DIRS.has("node_modules"));
}

// ══════════════════════════════════════════════════════════════════════════
console.log("\n=== ⑥ CLI · 退出码四态 + 末行契约 ===");
function cli(args) {
  const r = spawnSync(process.execPath, [CLI].concat(args), { encoding: "utf8" });
  const out = String(r.stdout || "");
  const m = out.match(/DAO_REDACT_SUMMARY exit=(\d+) mode=(\S+) files=(\d+) ok=(\d+) hits=(\d+) binary=(\d+) unreadable=(\d+) failed=(\d+)/);
  return { code: r.status, out, err: String(r.stderr || ""), sum: m ? { exit: +m[1], mode: m[2], files: +m[3], ok: +m[4], hits: +m[5], binary: +m[6], unreadable: +m[7], failed: +m[8] } : null };
}
{
  const src = w("cli/src.log", `A=1\nAPI_KEY=${CANARY_SK}\n`);
  const dest = sb("cli/out/dest.log");
  const a = cli(["--copy", src, dest]);
  check("CLI · --copy 成功 ⇒ exit 0", a.code === 0, `code=${a.code} out=${a.out.slice(-200)}`);
  check("CLI · 末行契约每条路径都打印", !!a.sum && a.sum.exit === 0 && a.sum.mode === "copy", JSON.stringify(a.sum));
  check("CLI · --copy 后目标无密钥", fs.existsSync(dest) && !fs.readFileSync(dest, "utf8").includes(CANARY_SK));

  const bin = sb("cli/shot.png");
  fs.writeFileSync(bin, Buffer.from([0x89, 0x50, 0x00, 0x01]));
  const b = cli(["--copy", bin, sb("cli/out/shot.png")]);
  check("CLI · 二进制 ⇒ exit 2（fail-closed，不是 0 也不是 1）", b.code === 2 && b.sum && b.sum.exit === 2 && b.sum.binary === 1, `code=${b.code}`);
  check("CLI · 二进制路径也打印末行", !!b.sum);

  const c = cli(["--scan", sb("scan/tree")]);
  check("CLI · --scan 有命中 ⇒ exit 1（「有活要干」不是「错误」）", c.code === 1 && c.sum.hits >= 1, `code=${c.code} sum=${JSON.stringify(c.sum)}`);
  check("CLI · --scan 输出里没有密钥原文", !c.out.includes(CANARY_SK), c.out.slice(0, 300));

  const cleanDir = sb("scan/clean");
  fs.mkdirSync(cleanDir, { recursive: true });
  w("scan/clean/ok.md", "干净的散文\n");
  const d = cli(["--scan", cleanDir]);
  check("CLI · --scan 零命中 ⇒ exit 0", d.code === 0 && d.sum.hits === 0, `code=${d.code}`);

  const e = cli(["--scan", sb("scan/nonexistent")]);
  check("CLI · --scan 路径不存在 ⇒ exit 2（与「零命中」分得开）", e.code === 2 && e.sum.failed >= 1, `code=${e.code}`);

  const f = cli(["--scan", sb("cli/emptydir")]);
  fs.mkdirSync(sb("cli/emptydir2"), { recursive: true });
  const g = cli(["--scan", sb("cli/emptydir2")]);
  check("CLI · 空目录（零样本）⇒ exit 2 而不是 exit 0", g.code === 2 && g.sum.files === 0, `code=${g.code} sum=${JSON.stringify(g.sum)}`);
  check("（夹具）不存在与空目录都不给 0", f.code === 2);

  const h = cli(["--json"]);
  check("CLI · 没给模式 ⇒ exit 3（用法错，与失败分得开）", h.code === 3 && h.sum && h.sum.exit === 3, `code=${h.code}`);
  const i = cli(["--copy", "--scan", "x"]);
  check("CLI · 模式互斥 ⇒ exit 3", i.code === 3);

  const j = cli(["--scan", sb("scan/tree"), "--exclude", "a.log"]);
  check("CLI · --exclude 能把守卫自己排除出扫描面", j.code === 0 && j.sum.hits === 0, `sum=${JSON.stringify(j.sum)}`);

  const p = w("cli/inplace.log", `Cookie: s=${CANARY_SK}\n`);
  const k = cli(["--in-place", p]);
  check("CLI · --in-place ⇒ exit 0 且文件已脱敏",
    k.code === 0 && !fs.readFileSync(p, "utf8").includes(CANARY_SK), `code=${k.code}`);
}

// ══════════════════════════════════════════════════════════════════════════
console.log("\n=== ⑤ 清单条目 qa-artifact-redaction · 三态 ===");
{
  const ENTRY_ID = "qa-artifact-redaction";
  const { manifest, errors } = M.load(REAL_MANIFEST, { templatesRoot: TEMPLATES });
  check("真实清单仍通过 schema 校验（新条目没把它弄坏）", errors.length === 0 && !!manifest,
    JSON.stringify(errors).slice(0, 300));
  const entry = ((manifest && manifest.entries) || []).find((e) => e.id === ENTRY_ID);
  check("新条目在清单里", !!entry);
  check("新条目 class=conditional（核验官点名：条件档，不是产品型档）", entry && entry.class === "conditional");
  check("新条目 canonical 模板真实存在", !!entry && fs.existsSync(path.join(TEMPLATES, entry.template.src)));
  check("新条目 why 里写明了「只查投递面不查接线」这个射程", !!entry && /投递面/.test(entry.why));
  check("canonical 模板里注明了「只管文本不管截图」的射程",
    fs.readFileSync(path.join(TEMPLATES, "qa-redaction-rule.md"), "utf8").includes("不管截图"));

  const only = { entries: [entry] };
  // 态一 · 命中：有 QA 脚本指纹 + 没有那份 rule ⇒ 报
  const hit = path.join(SANDBOX, "proj-hit");
  fs.mkdirSync(path.join(hit, "scripts", "qa"), { recursive: true });
  const fHit = M.evaluate(only, hit, { templatesRoot: TEMPLATES });
  check("态一 · 命中（有 scripts/qa 且缺 rule）⇒ 报一条", fHit.length === 1 && fHit[0].id === ENTRY_ID, JSON.stringify(fHit).slice(0, 200));
  check("态一 · 报文带零编辑复制指令（终点不是「AI 自己写一份」）", fHit.length === 1 && /零编辑复制 canonical：powershell/.test(fHit[0].message), fHit[0] && fHit[0].message);
  check("态一 · 报文带 label（说得出是哪一路指纹命中的）", fHit.length === 1 && /QA 脚本目录/.test(fHit[0].message));

  // 态一' · 另一路指纹（glob 命名）
  const hit2 = path.join(SANDBOX, "proj-hit2");
  fs.mkdirSync(path.join(hit2, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(hit2, "scripts", "qa-full.ps1"), "# qa", "utf8");
  check("态一' · glob 指纹（scripts/qa-*.ps1）同样命中",
    M.evaluate(only, hit2, { templatesRoot: TEMPLATES }).length === 1);
  const hit3 = path.join(SANDBOX, "proj-hit3");
  fs.mkdirSync(path.join(hit3, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(hit3, "scripts", "ui-smoke.js"), "// smoke", "utf8");
  check("态一'' · 冒烟脚本指纹（scripts/*-smoke.js）同样命中",
    M.evaluate(only, hit3, { templatesRoot: TEMPLATES }).length === 1);

  // 态二 · 不命中：没有任何 QA 工件脚本指纹 ⇒ 不报（且此时 rule 也确实不在，证明是 when 挡住的）
  const miss = path.join(SANDBOX, "proj-miss");
  fs.mkdirSync(path.join(miss, "src"), { recursive: true });
  fs.writeFileSync(path.join(miss, "package.json"), '{"name":"x"}', "utf8");
  check("态二 · 不命中（无 QA 脚本指纹）⇒ 零报",
    M.evaluate(only, miss, { templatesRoot: TEMPLATES }).length === 0);
  check("态二 · 且该项目确实没有那份 rule（证明挡住它的是 when，不是碰巧齐备）",
    !fs.existsSync(path.join(miss, ".claude", "rules", "qa-artifact-redaction.md")));

  // 态二' · 齐备：指纹命中但 rule 在 ⇒ 不报
  const full = path.join(SANDBOX, "proj-full");
  fs.mkdirSync(path.join(full, "scripts", "qa"), { recursive: true });
  fs.mkdirSync(path.join(full, ".claude", "rules"), { recursive: true });
  fs.writeFileSync(path.join(full, ".claude", "rules", "qa-artifact-redaction.md"), "# 派生自 canonical", "utf8");
  check("态二' · 齐备 ⇒ 零报", M.evaluate(only, full, { templatesRoot: TEMPLATES }).length === 0);

  // 态三 · 求值退化：rule 那个位置是**目录**而不是文件 ⇒ 判为缺（报），**不静默放行**
  const degraded = path.join(SANDBOX, "proj-degraded");
  fs.mkdirSync(path.join(degraded, "scripts", "qa"), { recursive: true });
  fs.mkdirSync(path.join(degraded, ".claude", "rules", "qa-artifact-redaction.md"), { recursive: true });
  check("态三 · 求值退化（该位置是目录不是文件）⇒ 仍然报，失败方向朝「多报」",
    M.evaluate(only, degraded, { templatesRoot: TEMPLATES }).length === 1);
  // 态三' · 项目根整个不存在 ⇒ 求值不抛、判为不命中（when 探不到）；check() 把加载/求值错误显式报出
  const ghost = path.join(SANDBOX, "proj-ghost-not-created");
  const cr = M.check(ghost, REAL_MANIFEST, { templatesRoot: TEMPLATES });
  check("态三' · 项目根不存在 ⇒ 求值不抛错、错误面为空（这条只是钉住现有语义，不是主张它对）",
    Array.isArray(cr.findings) && cr.errors.length === 0, JSON.stringify(cr).slice(0, 200));
  // 态三'' · 模板文件缺失时报文要说出来（不静默退回「AI 自己写一份」）
  const noTpl = M.evaluate(only, hit, { templatesRoot: path.join(SANDBOX, "no-such-templates") });
  check("态三'' · canonical 模板不在盘上 ⇒ 报文明说「模板缺失」",
    noTpl.length === 1 && /canonical 模板缺失/.test(noTpl[0].message), JSON.stringify(noTpl).slice(0, 200));
}

// ── 清理 ────────────────────────────────────────────────────────────────────
try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch (_) {}

console.log(`\n=== 汇总: PASS=${pass} FAIL=${fail} ===`);
process.exit(fail ? 1 : 0);
