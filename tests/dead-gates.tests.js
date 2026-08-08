// dead-gates 回归网 — ccswitch/scripts/check-dead-gates.mjs 的双向断言
//
// @dao-test-tier: env
//
// 跑法：node tests/dead-gates.tests.js        （默认层：环境敏感那几节 defer 掉）
//       node tests/dead-gates.tests.js --env  （含环境敏感层；要求串行环境，见下）
//       node scripts/run-tests.mjs            （自动发现本文件，无需登记；默认层 → exit 2）
//       node scripts/run-tests.mjs --env      （透传 --env，全绿 exit 0）
//
// ── 上面那行 `@dao-test-tier: env` 是给 run-tests.mjs 读的（issue #116）──────
// 本文件里有一小撮断言**对别人拥有的机器级可变状态做不变量断言**：真实
// `~/.claude/settings.json`、cc-switch GUI 的库（GUI 一存就写它）、指向共享主仓的命令。
// ⇒ **它不制造污染，它被别人的正常活动污染**。前两种互染机制的修法（夹具名加唯一后缀 /
// 假家目录，PR #115）对它结构上不适用 —— 它要断言的就是「真实那一份现在长什么样」。
// 实证：2026-08-03 三路官并行跑测试时首跑 PASS=115 FAIL=1，串行连跑三次均 116/0，
// 那条红复现不出（⚠ 红的条目名已丢失，故这只是「并行期偶发红」，不是对某一条的确证）。
//
// 被 defer 的是 ⑪ / ⑪.5 / ⑫① 里那句「真仓当下是绿态」，共 3 组。**其余 100+ 条全部照跑** ——
// 它们是纯合成夹具，与机器状态无关，是这个回归网真正的判别力所在。
// ⚠ **2026-08-08（issue #160）多出第 4 组，但它是条件性的**：默认层里 hook 若因墙钟预算跳过
//   了死闸检测那一项，⑫① 的**可达性**那一条也走 defer（详见 ⑫① 内注）。⇒ 默认层的 DEFER
//   **是 3 或 4，不是恒 3**；别把它当常量写进任何断言（run-tests 那侧只要求 `DEFER>0`）。
//
// 🔴 **摘出去之后谁保证它还会被跑**（issue #116 关闭条件要的就是这一段，照直写）：
//   ①**真实语料那一半，另有一条每次会话都响的机器通道**：SessionStart hook
//     `ccswitch/hooks/dao-scaffold-check.js` 每次开会话都拿真实 live settings + config-sync
//     快照 + cc-switch providers 三层跑一遍 `check-dead-gates.mjs`（本机实测 0.18s），
//     绿/红/「没查成」直接注进上下文。⑪ 的核心断言（dead=0 / selfcheck=ok / hooks>0 /
//     providers 层活着）**逐条**都是它每次会话在真实语料上求值的东西 ——
//     ⇒ 「指向已删脚本的钩子无人发现」不会因为本文件分层而发生：发现它的从来不是这个
//     测试文件，是那个 hook。本文件保障的是「**检测器本身没坏**」，那一半留在默认层。
//   ②**默认跑法拿不到退出码 0**：`run-tests.mjs` 默认层恒返回 2（「本次没跑完」）。
//     任何以「run-tests 全绿」为验收的消费方必须显式跑 `--env` 才拿得到 0。
//     这把「记得跑」变成「想拿 0 就得跑」。⚠ 弱处：谁要是把谓词写成 `@(0,2)` 就绕过去了，
//     没有任何程序在核这一点。
//   ③ hook 覆盖不到的两格照直标：⑪.5（真库只读性）与「⑪ 的分支结构两种结局都有断言」
//     **只有跑 `--env` 才验得到**，②是它们唯一的保障。
//
// ⚠ **跑 --env 要什么环境**：串行 —— 没有别的官在跑测试 · cc-switch GUI 没在写库 ·
//   没人在改 `~/.claude/settings.json`。合并前的终审、窗口收官、以及任何要拿 exit 0 的
//   场合都该跑一次。
//
// ── 这个回归网要钉住什么 ─────────────────────────────────────────────────────
// 被测对象自己治的病是「死闸与全过的闸在机器可读通道上不可区分」。**一个检测这种病的
// 检测器，最容易得的正是这种病**：它报绿的时候，你分不出「查过了没事」和「压根没看到
// 样本」。故本文件的断言分两类，缺一不可：
//   正控 —— 已知的死闸必须被检出，且**必须指名**（只报个数字，人无从下手）
//   负控 —— 活的闸、无法核验的闸、孤儿 hook 一律不许判红（护栏两侧的代价都是真代价；
//           生下来就吵的检查一定会被静音，静音之后它与不存在等价）
// 另有一组断言专钉**自检半边**：构造「普查看得见、结构化遍历看不见」的样本，
// 断言 `selfcheck=fail` —— 那一半若失灵，上面所有「零死闸」都不可信。
//
// ── 夹具形态 ────────────────────────────────────────────────────────────────
// 全部落 `<repo>/_tmp/dead-gates-tests/<case>/`（已 gitignore），每例一套：
//   live.json        —— 裸 settings 形态（绝对路径，与真实 live 同构）
//   snap/settings.json —— cc-switch DB 导出形态（rows[].value 里嵌 JSON 字符串 + 占位符）
//   hooks/           —— 被指向的脚本本体
//   providers-db/*.db —— ⑬ 专用的**临时 sqlite 库**（issue #57 的 providers 层），
//                        从不碰真库；真库那一侧由 ⑪/⑪.5 的只读实跑 + mtime 断言覆盖
// 两层刻意用不同的路径写法（绝对 vs `${PROJECT_ROOT}` 占位符），顺带钉住占位符还原。
//
// ── 最后一例是真实语料自跑，刻意留着 ─────────────────────────────────────────
// 本仓有过实证：一个检测器在 47 条合成断言下全绿，拿主仓 16 份真实正文一跑**一份都没扫成**，
// 而它照报「均零命中」。合成夹具证明不了「它在真实数据上跑得动」。

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const REPO = path.resolve(__dirname, "..");
const SCRIPT = path.join(REPO, "ccswitch", "scripts", "check-dead-gates.mjs");
const TMP = path.join(REPO, "_tmp", "dead-gates-tests");
const LIVE_REAL = path.join(process.env.USERPROFILE || process.env.HOME || "", ".claude", "settings.json");

// 环境敏感层开关：命令行 `--env`，或环境变量 DAO_TEST_ENV_TIER=1（跨 shell 时后者更省事）。
// run-tests.mjs 在 `--env` 下把这个 flag 透传给每个测试文件。
const ENV_TIER = process.argv.includes("--env") || process.env.DAO_TEST_ENV_TIER === "1";

let pass = 0, fail = 0, defer = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail ? "  ->  " + detail : "")); }
}
// defer 不是 skip：它进汇总行的 `DEFER=n` 字段，run-tests.mjs 据此把整场退出码顶成 2。
// **「没跑」与「跑了全过」必须在机器通道上分得开** —— 这正是被测对象自己治的病。
function deferSection(name, why) {
  defer++;
  console.log("  DEFER " + name + "  ->  " + why);
}
const DEFER_WHY = "环境敏感层：断言的是别人拥有的机器级可变状态。跑它：node tests/dead-gates.tests.js --env（要求串行环境）";

// ── 夹具 ────────────────────────────────────────────────────────────────────
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }
function w(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, "utf8");
}
const VALID_CJS = "// 合法 CommonJS\nconst x = 1;\nmodule.exports = { x };\n";
const VALID_ESM = "// 合法 ESM\nexport const x = 1;\n";
// 坏语法：两侧各一个（script goal 走 vm 判、module goal 走 node --check 判）
const BROKEN_CJS = "// 故意坏掉\nfunction (\n";
const BROKEN_ESM = "// 故意坏掉\nexport const x = ;\n";

function settingsOf(o) {
  const s = {};
  const cmds = o.commands || [];
  s.hooks = { SessionStart: [{ matcher: "startup", hooks: cmds.map((c) => ({ type: "command", command: c, timeout: 5 })) }] };
  if (o.extraEvent) s.hooks[o.extraEvent.name] = o.extraEvent.groups;
  if (o.statusLine) s.statusLine = { type: "command", command: o.statusLine, padding: 0 };
  if (o.deny || o.allow) s.permissions = { deny: o.deny || [], allow: o.allow || [] };
  if (o.parked) s.hooksDisabled = { SessionStart: [{ hooks: o.parked.map((c) => ({ type: "command", command: c, timeout: 5 })) }] };
  return s;
}
function snapDoc(settings) {
  return JSON.stringify({
    source: "cc-switch.settings",
    note: "测试夹具",
    rows: [{ key: "common_config_claude", value: JSON.stringify(settings) }],
  }, null, 2);
}

// 建一个用例目录，返回它的绝对路径。
// files: { "<hooks 下的文件名>": "<内容>" }
// live / snap 可传对象或 `(dir) => settings` 回调（要拼绝对路径时用后者）
function mkCase(name, opts) {
  const dir = path.join(TMP, name);
  rm(dir);
  fs.mkdirSync(path.join(dir, "hooks"), { recursive: true });
  for (const [f, body] of Object.entries(opts.files || {})) w(path.join(dir, "hooks", f), body);
  const live = typeof opts.live === "function" ? opts.live(dir) : (opts.live || settingsOf({}));
  const snap = typeof opts.snap === "function" ? opts.snap(dir) : (opts.snap || settingsOf({}));
  w(path.join(dir, "live.json"), JSON.stringify(live, null, 2));
  w(path.join(dir, "snap", "settings.json"), snapDoc(snap));
  return dir;
}

function abs(dir, name) { return path.join(dir, "hooks", name).replace(/\\/g, "/"); }
const PH = "$" + "{PROJECT_ROOT}";   // 普通字符串里不会被插值，写成拼接免去读者的怀疑

const SUMMARY_RE = /DEAD_GATES_SUMMARY exit=(\d+) hooks=(\d+) dead=(\d+) orphan=(\d+) selfcheck=(ok|fail) unverifiable=(\d+) providers=(\d+) providerscan=(ok|off|uncheckable)/;
function parseSummary(out) {
  const m = SUMMARY_RE.exec(String(out));
  return m ? {
    exit: Number(m[1]), hooks: Number(m[2]), dead: Number(m[3]), orphan: Number(m[4]),
    self: m[5], unver: Number(m[6]), providers: Number(m[7]), pscan: m[8],
  } : null;
}

// ① ~ ⑩ 各例测的是 live + 快照两层的判据，故一律带 `--no-providers`：把真实 cc-switch DB
// 拉进合成夹具，会让 hooks= 与普查数随本机 provider 数漂移，那些断言当场失去意义。
// providers 层自己的正控/负控在 ⑬（用一个**临时 fixture DB**，从不碰真库）。
function run(dir, extraArgs) {
  const args = [SCRIPT,
    "--live", path.join(dir, "live.json"),
    "--snapshot-dir", path.join(dir, "snap"),
    "--hooks-dir", path.join(dir, "hooks"),
    "--project-root", dir,
    "--no-providers"].concat(extraArgs || []);
  const r = spawnSync(process.execPath, args, { encoding: "utf8", timeout: 60000 });
  const out = String(r.stdout || "");
  return { code: r.status, out, stderr: String(r.stderr || ""), sum: parseSummary(out) };
}

// providers 层专用跑法：live/快照两层指向一个**空壳**夹具（零闸零普查），
// 让断言里的每一个数字都只可能来自 providers 层。
function runProviders(dir, dbFile, extraArgs) {
  const args = [SCRIPT,
    "--live", path.join(dir, "live.json"),
    "--snapshot-dir", path.join(dir, "snap"),
    "--hooks-dir", path.join(dir, "hooks"),
    "--project-root", dir,
    "--db-file", dbFile].concat(extraArgs || []);
  const r = spawnSync(process.execPath, args, { encoding: "utf8", timeout: 60000 });
  const out = String(r.stdout || "");
  return { code: r.status, out, stderr: String(r.stderr || ""), sum: parseSummary(out) };
}

rm(TMP);

// ══════════════════════════════════════════════════════════════
console.log("\n──── ① 全活（负控：不许把活闸判死）────");
{
  const d = mkCase("all-alive", {
    files: { "dao-alpha.js": VALID_CJS, "dao-beta.js": VALID_CJS, "dao-gamma.mjs": VALID_ESM },
    live: (dir) => settingsOf({
      commands: ['node "' + abs(dir, "dao-alpha.js") + '"', 'node "' + abs(dir, "dao-beta.js") + '" claude'],
      statusLine: "node " + abs(dir, "dao-gamma.mjs"),
    }),
    snap: () => settingsOf({
      commands: ['node "' + PH + '/hooks/dao-alpha.js"', 'node "' + PH + '/hooks/dao-beta.js" claude'],
      statusLine: "node " + PH + "/hooks/dao-gamma.mjs",
    }),
  });
  const r = run(d);
  check("exit 0", r.code === 0 && r.sum && r.sum.exit === 0, JSON.stringify(r.sum) + " " + r.out.slice(-400));
  check("dead=0", r.sum && r.sum.dead === 0, JSON.stringify(r.sum));
  check("两层都被扫到（hooks=6：live 3 + 快照 3）", r.sum && r.sum.hooks === 6, JSON.stringify(r.sum));
  check("自检 ok", r.sum && r.sum.self === "ok", JSON.stringify(r.sum));
  check("孤儿 0（三个文件全被注册）", r.sum && r.sum.orphan === 0, JSON.stringify(r.sum));
  // 占位符还原若失效，快照那 3 条会落进「无法核验」桶而非被真的核验过 —— 数它的计数，
  // 别去 `!/无法核验/` 匹配全文：合计行自己就带着「无法核验 0」这几个字（初版在此自伤一次）。
  check("占位符还原生效（快照 3 条真被核验，不是落进无法核验桶）",
    /· 无法核验 0 ·/.test(r.out), r.out.slice(-300));

  const j = run(d, ["--json"]);
  let doc = null;
  try { doc = JSON.parse(j.out.slice(0, j.out.lastIndexOf("DEAD_GATES_SUMMARY"))); } catch (_) { doc = null; }
  const gamma = doc ? (doc.alive || []).filter((a) => /dao-gamma\.mjs$/.test(a.token)) : [];
  check("合法 .mjs 判活，且走的是权威路径（module goal → node --check）",
    gamma.length === 2 && gamma.every((g) => g.syntax === "node --check"), JSON.stringify(gamma));
  const alphas = doc ? (doc.alive || []).filter((a) => /dao-alpha\.js$/.test(a.token)) : [];
  check("script goal 的 .js 走进程内 vm（零 spawn 的快路真的被走到）",
    alphas.length === 2 && alphas.every((a) => a.syntax === "vm"), JSON.stringify(alphas));
}

// ══════════════════════════════════════════════════════════════
console.log("\n──── ② 指向不存在的脚本 → 红且指名 ────");
{
  const d = mkCase("missing-script", {
    files: { "dao-alpha.js": VALID_CJS },
    live: (dir) => settingsOf({ commands: ['node "' + abs(dir, "dao-alpha.js") + '"', 'node "' + abs(dir, "dao-ghost.js") + '"'] }),
    snap: () => settingsOf({ commands: ['node "' + PH + '/hooks/dao-alpha.js"'] }),
  });
  const r = run(d);
  check("exit 1", r.code === 1 && r.sum && r.sum.exit === 1, JSON.stringify(r.sum));
  check("dead=1", r.sum && r.sum.dead === 1, JSON.stringify(r.sum));
  check("指名到具体脚本（只报个数字等于没报）", /dao-ghost\.js/.test(r.out), r.out.slice(-600));
  check("说清死法是「脚本不存在」", /脚本不存在/.test(r.out), r.out.slice(-600));
  check("活的那条不被牵连（dead 不是 2）", r.sum && r.sum.dead === 1);
  check("自检仍 ok（这是真发现，不是扫描面塌）", r.sum && r.sum.self === "ok", JSON.stringify(r.sum));
}

// ══════════════════════════════════════════════════════════════
console.log("\n──── ③ 存在但语法坏掉 → 红（存在性过不代表可载）────");
{
  const d = mkCase("broken-syntax", {
    files: { "dao-alpha.js": VALID_CJS, "dao-bad.mjs": BROKEN_ESM, "dao-badcjs.js": BROKEN_CJS },
    live: (dir) => settingsOf({
      commands: ['node "' + abs(dir, "dao-alpha.js") + '"', 'node "' + abs(dir, "dao-bad.mjs") + '"', 'node "' + abs(dir, "dao-badcjs.js") + '"'],
    }),
  });
  const r = run(d);
  check("exit 1", r.code === 1 && r.sum && r.sum.exit === 1, JSON.stringify(r.sum));
  check("坏 .mjs 被检出（module goal 走 node --check）", /dao-bad\.mjs/.test(r.out), r.out.slice(-800));
  check("坏 .js 被检出（script goal 走 vm.Script）", /dao-badcjs\.js/.test(r.out), r.out.slice(-800));
  check("两条都算 dead", r.sum && r.sum.dead === 2, JSON.stringify(r.sum));
  check("报文说清是「语法不可载」而非「不存在」", /语法不可载/.test(r.out), r.out.slice(-800));
  check("文件明明在，不许说成不存在", !/dao-bad\.mjs（归属/.test(r.out) || !/脚本不存在：.*dao-bad\.mjs/.test(r.out));
}

// ══════════════════════════════════════════════════════════════
console.log("\n──── ④ 孤儿 hook → 提示，不红 ────");
{
  const d = mkCase("orphan", {
    files: { "dao-alpha.js": VALID_CJS, "dao-orphan.js": VALID_CJS, "README.md": "# 文档不该被当 hook" },
    live: (dir) => settingsOf({ commands: ['node "' + abs(dir, "dao-alpha.js") + '"'] }),
  });
  const r = run(d);
  check("exit 0（孤儿不参与退出码）", r.code === 0 && r.sum && r.sum.exit === 0, JSON.stringify(r.sum));
  check("orphan=1", r.sum && r.sum.orphan === 1, JSON.stringify(r.sum));
  check("指名孤儿文件", /dao-orphan\.js/.test(r.out), r.out.slice(-600));
  check("明说是提示不是错误", /提示不是错误/.test(r.out), r.out.slice(-600));
  check("README.md 不被当 hook 计数", !/README\.md/.test(r.out), r.out.slice(-600));
  check("dead 仍为 0", r.sum && r.sum.dead === 0, JSON.stringify(r.sum));
}

// ══════════════════════════════════════════════════════════════
console.log("\n──── ⑤ 快照层独有的死闸（只扫 live 会漏掉的那一半）────");
{
  const d = mkCase("snapshot-only-dead", {
    files: { "dao-alpha.js": VALID_CJS },
    live: (dir) => settingsOf({ commands: ['node "' + abs(dir, "dao-alpha.js") + '"'] }),
    snap: () => settingsOf({ commands: ['node "' + PH + '/hooks/dao-alpha.js"', 'node "' + PH + '/hooks/dao-snapghost.js"'] }),
  });
  const r = run(d);
  check("exit 1（live 全活也要红）", r.code === 1 && r.sum && r.sum.exit === 1, JSON.stringify(r.sum));
  check("指名快照层那条", /dao-snapghost\.js/.test(r.out), r.out.slice(-600));
  check("报文标出来源是快照", /快照/.test(r.out), r.out.slice(-600));
}

// ══════════════════════════════════════════════════════════════
console.log("\n──── ⑥ permissions 里的路径形态条目 ────");
{
  const d = mkCase("permissions", {
    files: { "dao-guard.js": VALID_CJS },
    live: (dir) => settingsOf({
      commands: [],
      deny: ["Bash(grep:*)", "Bash(node " + abs(dir, "dao-permghost.js") + ":*)"],
      allow: ["Read", "Bash(node " + abs(dir, "dao-guard.js") + ":*)"],
    }),
  });
  const r = run(d);
  check("deny 里指向不存在脚本 → 红", r.code === 1 && r.sum && r.sum.exit === 1, JSON.stringify(r.sum));
  check("指名 permissions 那条", /dao-permghost\.js/.test(r.out), r.out.slice(-700));
  check("报文标出面是 permissions.deny", /permissions\.deny/.test(r.out), r.out.slice(-700));
  check("allow 里指向存在脚本 → 不判死", r.sum && r.sum.dead === 1, JSON.stringify(r.sum));
  check("`Bash(grep:*)` 这类无路径条目不误伤", !/grep/.test(r.out.split("孤儿")[0] || ""), r.out.slice(0, 900));
  check("permissions 条目不掺进 hooks 计数（那个数与普查配对）", r.sum && r.sum.hooks === 0, JSON.stringify(r.sum));
}

// ══════════════════════════════════════════════════════════════
console.log("\n──── ⑦ 无法核验桶：不判红，但必须出声 ────");
{
  const d = mkCase("unverifiable", {
    // dao-bare.js **只**被那条「光文件名」的命令提及 —— 它是上面那条判据的真靶子：
    // 若只登记可核验的引用，它会被误报成孤儿
    files: { "dao-alpha.js": VALID_CJS, "dao-bare.js": VALID_CJS },
    live: (dir) => settingsOf({
      commands: [
        'node "' + abs(dir, "dao-alpha.js") + '"',
        "node dao-bare.js",                    // 光文件名，靠 PATH
        "node ./rel/dao-rel.js",               // 相对路径，cwd 随宿主变
        'node -e "console.log(1)"',            // 命令串里没有脚本 token
      ],
    }),
  });
  const r = run(d);
  check("exit 0（判不了 != 判死）", r.code === 0 && r.sum && r.sum.exit === 0, JSON.stringify(r.sum));
  check("dead=0", r.sum && r.sum.dead === 0, JSON.stringify(r.sum));
  check("三条都被打印出来（判不了必须可见）", /无法核验 3 条/.test(r.out), r.out.slice(-800));
  check("明说「不等于通过」", /不等于通过/.test(r.out), r.out.slice(-800));
  check("三类各自点名", /光文件名/.test(r.out) && /相对路径/.test(r.out) && /没有脚本形态的 token/.test(r.out), r.out.slice(-800));
  // 「核不了」与「没注册」是两种病、两种处方。相对路径注册的脚本若被算成孤儿，
  // 读者会去挂一个其实已经挂着的 hook。
  check("相对/裸名注册也算「被提及」→ 不许误报成孤儿", r.sum && r.sum.orphan === 0, JSON.stringify(r.sum));
  // 这个计数必须进机器通道：只读末行的消费方（SessionStart hook）若只看到 dead=0，
  // 就会说出「零死闸」，而其中 3 条根本没被核验过 —— 「没查成」与「查了没事」必须分得开。
  check("unverifiable 计数进末行契约（不是只写在中文正文里）", r.sum && r.sum.unver === 3, JSON.stringify(r.sum));
}

// ══════════════════════════════════════════════════════════════
console.log("\n──── ⑧ 自检半边：扫描面塌陷必须变红 ────");
// 构造「独立普查看得见、结构化遍历看不见」的样本：把 command 条目停在一个
// 遍历器不认识的键下。这不是在测一个假想敌 —— 它模拟的正是「主解析被改瞎 / 宿主
// 改了 schema」之后的形态：违例数与样本数**不再一起归零**，差值就是警报。
{
  const d = mkCase("selfcheck-zero-sample", {
    files: { "dao-alpha.js": VALID_CJS },
    live: (dir) => settingsOf({ commands: [], parked: ['node "' + abs(dir, "dao-alpha.js") + '"'] }),
  });
  const r = run(d);
  check("exit 1（零死闸也不许报绿）", r.code === 1 && r.sum && r.sum.exit === 1, JSON.stringify(r.sum));
  check("selfcheck=fail", r.sum && r.sum.self === "fail", JSON.stringify(r.sum));
  check("dead=0 而 exit=1 —— 两种红在机器通道上分得开", r.sum && r.sum.dead === 0 && r.sum.exit === 1, JSON.stringify(r.sum));
  check("报文点出 zero-sample", /zero-sample/.test(r.out), r.out.slice(-700));
  check("明说此时「零死闸」不可信", /不可信/.test(r.out), r.out.slice(-700));
}
{
  const d = mkCase("selfcheck-undercount", {
    files: { "dao-alpha.js": VALID_CJS },
    live: (dir) => settingsOf({
      commands: ['node "' + abs(dir, "dao-alpha.js") + '"'],
      parked: ['node "' + abs(dir, "dao-alpha.js") + '"'],
    }),
  });
  const r = run(d);
  check("部分塌陷（1 条看得见、1 条看不见）→ 红", r.code === 1 && r.sum && r.sum.exit === 1, JSON.stringify(r.sum));
  check("报文点出 undercount 并给出两个数", /undercount/.test(r.out) && /普查/.test(r.out), r.out.slice(-700));
}
{
  // 负控：自检半边不许恒红 —— 正常样本上必须 ok（否则它和永远为真的废话是镜像关系）
  const d = mkCase("selfcheck-negative", {
    files: { "dao-alpha.js": VALID_CJS },
    live: (dir) => settingsOf({ commands: ['node "' + abs(dir, "dao-alpha.js") + '"'] }),
  });
  const r = run(d);
  check("负控：正常样本 selfcheck=ok（自检不恒红）", r.sum && r.sum.self === "ok" && r.code === 0, JSON.stringify(r.sum));
}

// ══════════════════════════════════════════════════════════════
console.log("\n──── ⑨ 末行契约：每条路径都打印，含「没查成」────");
{
  const d = mkCase("live-unreadable", { files: { "dao-alpha.js": VALID_CJS } });
  fs.rmSync(path.join(d, "live.json"));
  const r = run(d);
  check("live 读不到仍打印末行（没查成不许表现为「什么都没说」）", r.sum !== null, r.out.slice(-500));
  check("exit 1 + selfcheck=fail", r.sum && r.sum.exit === 1 && r.sum.self === "fail", JSON.stringify(r.sum));
  check("点名 live-unreadable", /live-unreadable/.test(r.out), r.out.slice(-600));
}
{
  const d = mkCase("json-mode", {
    files: { "dao-alpha.js": VALID_CJS },
    live: (dir) => settingsOf({ commands: ['node "' + abs(dir, "dao-alpha.js") + '"', 'node "' + abs(dir, "dao-ghost.js") + '"'] }),
  });
  const r = run(d, ["--json"]);
  check("--json 也打末行", r.sum !== null, r.out.slice(-300));
  let doc = null;
  try { doc = JSON.parse(r.out.slice(0, r.out.lastIndexOf("DEAD_GATES_SUMMARY"))); } catch (e) { doc = null; }
  check("--json 正文可解析", doc !== null, r.out.slice(0, 200));
  check("--json 带死闸明细（不是只给个数）", doc && Array.isArray(doc.dead) && doc.dead.length === 1 && /dao-ghost/.test(doc.dead[0].token), JSON.stringify(doc && doc.dead));
}

// ══════════════════════════════════════════════════════════════
console.log("\n──── ⑩ 非 JS 脚本：只查存在性，且说清没查语法 ────");
{
  const d = mkCase("ps1", {
    files: { "dao-guard.ps1": "# 这不是合法 JS，但也不该被当 JS 解析\nWrite-Host 'hi'\n" },
    live: (dir) => settingsOf({ commands: ["pwsh -File " + abs(dir, "dao-guard.ps1"), "pwsh -File " + abs(dir, "dao-nope.ps1")] }),
  });
  const r = run(d);
  check("存在的 .ps1 不因「不是合法 JS」被误判", r.sum && r.sum.dead === 1, JSON.stringify(r.sum));
  check("不存在的 .ps1 照样红", /dao-nope\.ps1/.test(r.out) && r.code === 1, r.out.slice(-600));
}

// ══════════════════════════════════════════════════════════════
console.log("\n──── ⑪ 真实语料自跑（合成夹具证明不了它在真数据上跑得动）────");
// 环境敏感：断言的对象是真实 `~/.claude/settings.json` 与真 cc-switch DB 的当下内容，
// 而那两样归别人所有、随时在变（别的官在改 hook 注册、cc-switch GUI 在写库）。
// 它的**监控价值**由 SessionStart hook 每次会话在同一份真语料上兑现（见文件头 ①），
// 这里保留的是「检测器在真数据上跑得动 + 两种结局都有断言」那一格，只在 --env 下跑。
if (!ENV_TIER) {
  deferSection("⑪ 真实语料自跑（真 ~/.claude/settings.json + 真 cc-switch DB）", DEFER_WHY);
} else {
  const r = spawnSync(process.execPath, [SCRIPT], { encoding: "utf8", timeout: 120000, cwd: REPO });
  const out = String(r.stdout || "");
  const sum = parseSummary(out);
  check("真仓自跑打得出末行", sum !== null, out.slice(-400) + " [stderr] " + String(r.stderr || "").slice(0, 300));
  if (sum) {
    console.log("        实况：" + JSON.stringify(sum));
    if (fs.existsSync(LIVE_REAL)) {
      check("真实 live settings 在 → 必须扫到闸（零样本就是塌陷）", sum.hooks > 0, JSON.stringify(sum));
      check("真实语料上自检 ok", sum.self === "ok", JSON.stringify(sum) + "\n" + out.slice(-900));
      check("真实语料上零死闸（红了就是真发现，去读上面的清单）", sum.dead === 0, out.slice(-900));
    } else {
      // 不写「跳过」——那是静默失效。没有 live 文件时，正确行为是报「没查成」
      check("无 live settings 的机器上 → 报 live-unreadable 且红", sum.self === "fail" && sum.exit === 1 && /live-unreadable/.test(out), JSON.stringify(sum));
    }
    // ── providers 层的**负控就在这里**：真库、只读、实跑 ──────────────────────
    // 合成夹具证不了「它读得动真的 cc-switch DB」。这一段两种结局都得有断言，
    // 不许写「跳过」：有库就必须真读到行，没库就必须报 uncheckable 且 exit=2。
    if (sum.pscan === "ok") {
      check("真库负控：providers 层读到行且逐行扫过（零行会被判 uncheckable，不会走到这里）",
        sum.providers > 0, JSON.stringify(sum));
      check("真库负控：providers 层零死闸、退出码 0（活的 provider 钩子不许被判死）",
        sum.dead === 0 && sum.exit === 0 && r.status === 0, JSON.stringify(sum) + "\n" + out.slice(-1200));
      check("真库负控：报文点名 providers 层并打印 -readonly（只读是结构性的，不是纪律性的）",
        /providers 层：cc-switch DB 共 \d+ 行/.test(out) && /-readonly 打开/.test(out), out.slice(0, 1400));
      check("真库负控：不带 hooks 的行也在扫描面里（**不按 app_type 收窄**，收窄就是白付一个会过期的判据）",
        /行零闸零普查/.test(out) || sum.providers > 0, out.slice(0, 1400));
    } else {
      check("本机没有可读的 cc-switch DB → 必须报 uncheckable + exit 2（不许冒充绿）",
        sum.pscan === "uncheckable" && sum.exit === 2 && r.status === 2 && /本次没查成/.test(out),
        JSON.stringify(sum) + "\n" + out.slice(-900));
    }
  }
}

// ══════════════════════════════════════════════════════════════
console.log("\n──── ⑪.5 真库只读性：跑完 mtime/size 不许变（结构性只读的实测半边）────");
// 「我们的 SQL 里没有 UPDATE」是纪律性只读，证不了什么。这一条测的是结果：
// 真库在一次完整运行前后**逐字节没动**。它抓不到「写了又改回来」，故只是必要条件——
// 充分条件由 `runSql(..., readonly:true)` 让 sqlite3 自己拒绝写入来提供（判据不是这条断言）。
//
// 🔴 **这一节是本文件里最经不起并发的一格，也是唯一没有第二条通道兜底的一格**：
// cc-switch GUI 在这两次 stat 之间存一次配置，mtime/size 就变了 —— 而那不是被测对象干的。
// 它只有 `--env` 一条路（文件头 ③）。
const DB_REAL_PATH = path.join(process.env.USERPROFILE || process.env.HOME || "", ".cc-switch", "cc-switch.db");
if (!ENV_TIER) {
  deferSection("⑪.5 真库只读性（真 cc-switch DB 的 mtime/size 前后比对）", DEFER_WHY);
} else {
  const DB_REAL = DB_REAL_PATH;
  if (fs.existsSync(DB_REAL)) {
    const before = fs.statSync(DB_REAL);
    const r = spawnSync(process.execPath, [SCRIPT], { encoding: "utf8", timeout: 120000, cwd: REPO });
    const after = fs.statSync(DB_REAL);
    check("真库 mtime 不变", before.mtimeMs === after.mtimeMs, before.mtimeMs + " → " + after.mtimeMs);
    check("真库 size 不变", before.size === after.size, before.size + " → " + after.size);
    check("（顺带）这一跑仍打得出末行", parseSummary(String(r.stdout || "")) !== null, String(r.stdout || "").slice(-300));
  } else {
    check("本机无 cc-switch DB → 上面 ⑪ 已断言 uncheckable 路径，此处如实记零样本", true, "DB 不存在：" + DB_REAL);
  }
}

// ══════════════════════════════════════════════════════════════
console.log("\n──── ⑫ 挂载可达性（「源码里有调用点」是弱判据，只有真跑过才算数）────");
// settings-drift 头注把这件事写死了：静态核对**证不了调用点可达**——它可能被提前
// return 跳过、可能落在一个从不进入的分支里（`isMetaRepo` 那次就是这么静默了整块模式 A）。
// 故这一节全部走「真喂一次 SessionStart payload，看注入的正文里有没有那一行」。
{
  const HOOK = path.join(REPO, "ccswitch", "hooks", "dao-scaffold-check.js");
  const DRIFT_STATE = path.join(TMP, "drift-state");   // 心跳重定向，别污染真实 fired.log

  function runHook(cwd) {
    const payload = JSON.stringify({
      session_id: "dead-gates-tests", cwd, hook_event_name: "SessionStart", source: "startup",
    });
    const r = spawnSync(process.execPath, [HOOK], {
      input: payload, encoding: "utf8", timeout: 120000,
      env: Object.assign({}, process.env, {
        DAO_SETTINGS_DRIFT_STATE_DIR: DRIFT_STATE,
        DAO_SETTINGS_DRIFT_SELFTEST: "1",   // 强制 synthetic：自测不许把接线心跳染绿
      }),
    });
    let json = null;
    if (r.stdout && r.stdout.trim()) { try { json = JSON.parse(r.stdout); } catch (_) {} }
    const ctx = (json && json.hookSpecificOutput && json.hookSpecificOutput.additionalContext) || "";
    return { code: r.status, ctx, out: String(r.stdout || ""), err: String(r.stderr || "") };
  }

  // 假元仓库：内容签名（ccswitch/dao.md + scaffold-manifest.json）让模式 A 生效；
  // `.git` 写成一个内容为垃圾的**文件** —— 沙箱里没有 .git 时 git 会一路向上找到真仓库，
  // 把真仓库的状态报成沙箱的（这一手抄自 dao-scaffold-check.tests.js 的隔离说明）。
  function mkFakeMeta(tag, stubBody) {
    const root = path.join(TMP, "hookwire", tag);
    rm(root);
    fs.mkdirSync(path.join(root, "ccswitch", "hooks"), { recursive: true });
    w(path.join(root, ".git"), "not a real gitfile\n");
    w(path.join(root, "ccswitch", "dao.md"), "# fixture dao\n");
    w(path.join(root, "ccswitch", "scaffold-manifest.json"), '{"entries":[]}');
    if (stubBody != null) w(path.join(root, "ccswitch", "scripts", "check-dead-gates.mjs"), stubBody);
    return root;
  }

  // ① 真仓可达性：这是唯一能证明「调用点真的跑到了」的断言
  //    **可达性这一条不是环境敏感的，留在默认层**：`deadGateLines` 的每一条返回路径
  //    （脚本不在 / 跑不起来 / 契约被改坏 / FAIL / 没查成 / 绿）都带「死闸检测」这四个字，
  //    所以它对真实语料是绿是红一概不敏感 —— 敏感的只有下面那句「当下是绿态」。
  //    ⇒ 「hook 还在调它吗」这个问题，默认层每次都答得出。
  //
  //    🔴 **2026-08-08（issue #160）：上面那句枚举漏了一条返回路径，而漏掉的恰是致命的那条。**
  //    `deadGateLines` 是经 `runWithinBudget()` 调的，预算见底时它**压根不被调用**，
  //    hook 改打 `⏱ 死闸检测 **没跑**：宿主预算只剩 X ms…` —— **那句话里也有「死闸检测」
  //    这四个字** ⇒ 旧断言 `/死闸检测/` 在「调用点这次根本没被跑到」时**照常 PASS**，
  //    而它的名字说的正是相反的事。「不敏感」是真的，但它不敏感的方式是**恒真**。
  //    ⇒ 判据换成**行首标记**（ⓘ / ⚠ / ✗ 三者之一，那六条返回路径全都以它们之一开头，
  //      而 `⏱` 不在其中），并另立一条把「被预算跳过」这一态单独说出来。
  //    **预算跳过在默认层走 defer 不走红**：它与被测对象无关，判红只会训练人无视这道闸；
  //    但 `--env` 里必须是红 —— 那一层的契约是「零 defer 才拿得到 exit 0」，条件性 defer
  //    会让 run-tests 的分层自检报 exit 4（`declared && ENV_TIER && observed > 0`）。
  {
    const r = runHook(REPO);
    const budgetSkipped = /⏱ 死闸检测 \*\*没跑\*\*/.test(r.ctx);
    const SELFCHECK_HINT = "hook 的墙钟预算被吃光了，成因与被测对象无关（issue #160）。"
      + "自查：① 看注入里那行 `ⓘ hook 墙钟预算：本次已花 … / 宿主给 …`"
      + " ② 收干净 git 状态（未提交 / 领先落后 origin 会让同步漂移多起几次 git 子进程）"
      + " ③ 别和别的官同时跑测试 ④ 手跑一次：node ccswitch/scripts/check-dead-gates.mjs";
    if (budgetSkipped && !ENV_TIER) {
      deferSection("⑫① 可达性（本次 hook 因墙钟预算跳过了死闸检测这一项，可达性无从判定）",
        SELFCHECK_HINT);
    } else {
      check("真仓 SessionStart 注入里出现死闸检测那一行（调用点可达；「⏱ 没跑」不算跑到）",
        /(?:ⓘ|⚠|✗) 死闸检测/.test(r.ctx) && !budgetSkipped,
        (budgetSkipped ? "**被预算跳过** —— " + SELFCHECK_HINT + "\n" : "")
        + "ctx=" + r.ctx.slice(0, 400) + " [stderr]" + r.err.slice(0, 200));
    }
    if (!ENV_TIER) {
      deferSection("⑫① 真仓当下是绿态（读的是真实 live settings + 真 cc-switch DB 的当下内容）", DEFER_WHY);
    } else {
      check("真仓当下是绿态，且报出闸数（不是零输出）", /死闸检测绿/.test(r.ctx) && /条闸/.test(r.ctx), r.ctx.slice(0, 400));
    }
  }

  // ② 自指：查死闸的东西自己不在了 —— 必须响，不许静默跳过
  {
    const r = runHook(mkFakeMeta("no-script", null));
    check("检测脚本不在 → hook 报红（不静默）", /死闸检测脚本不在/.test(r.ctx), r.ctx.slice(0, 400));
  }

  // ③ 末行契约被改坏 → 「跑完但没拿到摘要」必须与「跑了没事」区分开
  {
    const r = runHook(mkFakeMeta("bad-contract",
      'process.stdout.write("我把末行改成了别的样子\\n");\n'));
    check("拿不到末行契约 → 报红并点出契约可能被改坏", /没拿到 DEAD_GATES_SUMMARY/.test(r.ctx), r.ctx.slice(0, 400));
  }

  // ④ 红态传导：摘要说有死闸时，hook 要把明细也带出来（只报个数字人无从下手）
  {
    const stub = [
      'process.stdout.write("✗ 死闸 2 条 —— 它们此刻在宿主里静默 no-op：\\n");',
      'process.stdout.write("    · [live hooks.SessionStart[startup]] 脚本不存在：D:/fake/dao-stub-ghost.js（归属：dao）\\n");',
      'process.stdout.write("ⓘ 孤儿 hook：0\\n");',
      'process.stdout.write("DEAD_GATES_SUMMARY exit=1 hooks=5 dead=2 orphan=0 selfcheck=ok unverifiable=0 providers=13 providerscan=ok\\n");',
      "process.exit(1);",
    ].join("\n");
    const r = runHook(mkFakeMeta("red", stub));
    check("死闸红态传导到 SessionStart 提醒", /死闸检测 FAIL/.test(r.ctx), r.ctx.slice(0, 500));
    check("红态带明细（指名到具体脚本）", /dao-stub-ghost\.js/.test(r.ctx), r.ctx.slice(0, 500));
    check("孤儿那一节不被当成红报明细混进来", !/孤儿 hook：0/.test(r.ctx), r.ctx.slice(0, 500));
  }

  // ④.5 红优先于「没查成」：既有死闸、providers 又没查成时，报的必须是红不是 ⚠
  {
    const stub = [
      'process.stdout.write("✗ 死闸 1 条 —— 静默 no-op：\\n");',
      'process.stdout.write("    · [live hooks.SessionStart[startup]] 脚本不存在：D:/fake/dao-both-ghost.js（归属：dao）\\n");',
      'process.stdout.write("DEAD_GATES_SUMMARY exit=1 hooks=5 dead=1 orphan=0 selfcheck=ok unverifiable=0 providers=0 providerscan=uncheckable\\n");',
      "process.exit(1);",
    ].join("\n");
    const r = runHook(mkFakeMeta("red-and-uncheckable", stub));
    check("死闸 + providers 没查成 → 报红（真发现优先于「有一层没查成」）",
      /死闸检测 FAIL/.test(r.ctx) && /dao-both-ghost\.js/.test(r.ctx), r.ctx.slice(0, 500));
  }

  // ⑤ 自检半边失败（dead=0 但 exit=1）→ 措辞必须说「零死闸不可信」，不能说「有 0 条死闸」
  {
    const stub = [
      'process.stdout.write("✗ 自检半边失败 1 条：\\n");',
      'process.stdout.write("    · zero-sample：普查数到 7 条而结构化遍历一条都没拿到\\n");',
      'process.stdout.write("DEAD_GATES_SUMMARY exit=1 hooks=0 dead=0 orphan=0 selfcheck=fail unverifiable=0 providers=0 providerscan=ok\\n");',
      "process.exit(1);",
    ].join("\n");
    const r = runHook(mkFakeMeta("selffail", stub));
    check("自检失败态：报「零死闸不可信」而不是报 0 条死闸", /不可信/.test(r.ctx) && /selfcheck=fail/.test(r.ctx), r.ctx.slice(0, 500));
  }

  // ⑥ 绿 + 待办：孤儿/无法核验必须浮到 SessionStart，别只藏在 CLI 正文里
  {
    const stub = [
      'process.stdout.write("DEAD_GATES_SUMMARY exit=0 hooks=9 dead=0 orphan=2 selfcheck=ok unverifiable=3 providers=13 providerscan=ok\\n");',
    ].join("\n");
    const r = runHook(mkFakeMeta("todo", stub));
    check("绿 + 孤儿 2 + 无法核验 3 → 一行提示带出两个数",
      /死闸检测绿/.test(r.ctx) && /2 个 hook 文件/.test(r.ctx) && /3 条命令串无法核验/.test(r.ctx), r.ctx.slice(0, 500));
    check("提示里明说「无法核验 != 核验通过」", /不等于核验通过/.test(r.ctx), r.ctx.slice(0, 500));
  }

  // ⑦ exit 2（providers 层没查成）→ 必须是 ⚠ 且明说「这不是零死闸」，不许说成绿、也不许说成自检失败
  {
    const stub = [
      'process.stdout.write("DEAD_GATES_SUMMARY exit=0 hooks=9 dead=0 orphan=0 selfcheck=ok unverifiable=0 providers=0 providerscan=uncheckable\\n");',
      "process.exit(2);",
    ].join("\n");
    // 末行 exit=0 而真退出码 2 —— 先钉住「两者恒等」这条契约本身
    const r0 = runHook(mkFakeMeta("exit2-mismatch", stub));
    check("末行 exit= 与真退出码不一致 → 报契约被改坏（不许取一个信一个）",
      /真退出码却是 2/.test(r0.ctx), r0.ctx.slice(0, 500));

    const stub2 = [
      'process.stdout.write("  ⚠ providers 层：**本次没查成**\\n");',
      'process.stdout.write("DEAD_GATES_SUMMARY exit=2 hooks=9 dead=0 orphan=0 selfcheck=ok unverifiable=0 providers=0 providerscan=uncheckable\\n");',
      "process.exit(2);",
    ].join("\n");
    const r = runHook(mkFakeMeta("exit2", stub2));
    check("providers 没查成 → ⚠ 且明说不是「零死闸」", /没查成/.test(r.ctx) && /这不是「零死闸」/.test(r.ctx), r.ctx.slice(0, 500));
    check("没查成不许被措辞成绿", !/死闸检测绿/.test(r.ctx), r.ctx.slice(0, 500));
    check("没查成不许被误报成自检半边失败（两种病、两种处方）", !/自检半边失败/.test(r.ctx), r.ctx.slice(0, 500));
  }

  // ⑧ providerscan=off：本 hook 从不传 --no-providers，所以看到 off 就说明调用点被改过
  {
    const stub = [
      'process.stdout.write("DEAD_GATES_SUMMARY exit=0 hooks=9 dead=0 orphan=0 selfcheck=ok unverifiable=0 providers=0 providerscan=off\\n");',
    ].join("\n");
    const r = runHook(mkFakeMeta("pscan-off", stub));
    check("providerscan=off → ⚠ 并点出「谁改了调用点」（显式缩面与环境没给成是两种病）",
      /显式关掉/.test(r.ctx) && /改了调用点/.test(r.ctx), r.ctx.slice(0, 500));
  }

  // ⑨ 旧版末行（无 providers 两字段）→ 必须报「契约被改坏」，不许当它没有就放过
  //    这防的是「脚本比消费方旧」被静默读成「providers 层跑过了」。
  {
    const stub = [
      'process.stdout.write("DEAD_GATES_SUMMARY exit=0 hooks=9 dead=0 orphan=0 selfcheck=ok unverifiable=0\\n");',
    ].join("\n");
    const r = runHook(mkFakeMeta("old-contract", stub));
    check("缺 providers 字段的旧末行 → 报契约被改坏（不静默降级）",
      /没拿到 DEAD_GATES_SUMMARY/.test(r.ctx), r.ctx.slice(0, 500));
  }
}

// ══════════════════════════════════════════════════════════════
// ⑬ providers 层（cc-switch DB）—— 正控/负控/没查成三态
//
// 为什么用**真的 sqlite fixture DB** 而不是内存对象：这一层新增的代码里，一半是判据
// （谁是死闸），另一半是**读取路径**（sqlite3 spawn / -readonly / -json 解析）。
// 拿内存对象直测只证得了前一半，而 #57 之前那个洞恰恰不在判据里，在「这一层压根没被读」。
// fixture 库落 `_tmp/`（已 gitignore），**从不碰真库**——真库那一侧由 ⑪/⑪.5 只读实跑覆盖。
async function providersSection() {
  console.log("\n──── ⑬ providers 层：cc-switch DB 里的死闸（issue #57）────");

  let sqlite = null;
  try {
    const mod = await import("../config-sync/lib/sqlite.mjs");
    sqlite = mod.findSqlite3();
  } catch (e) {
    sqlite = null;
    console.log("        ⚠ 本机找不到 sqlite3（" + (e && e.message ? e.message.split("\n")[0] : e) +
      "）⇒ **fixture 正控本轮未跑**，下面只断言「没查成」那条降级路径。");
  }

  function lit(v) { return "'" + String(v == null ? "" : v).split("'").join("''") + "'"; }
  function mkDb(name, rows, opts) {
    const file = path.join(TMP, "providers-db", name + ".db");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try { fs.rmSync(file, { force: true }); } catch (_) {}
    const stmts = [];
    if (!(opts && opts.noTable)) {
      stmts.push('CREATE TABLE providers ("id" TEXT PRIMARY KEY, "name" TEXT, "app_type" TEXT, "settings_config" TEXT);');
    } else {
      stmts.push('CREATE TABLE "somethingelse" ("id" TEXT PRIMARY KEY);');
    }
    for (const r of rows || []) {
      stmts.push("INSERT INTO providers (\"id\",\"name\",\"app_type\",\"settings_config\") VALUES (" +
        [lit(r.id), lit(r.name), lit(r.app_type), lit(r.settings_config)].join(", ") + ");");
    }
    const res = spawnSync(sqlite, [file], { input: stmts.join("\n"), encoding: "utf8", timeout: 60000 });
    if (res.status !== 0) throw new Error("fixture DB 建不起来（exit " + res.status + "）：" + String(res.stderr || "").slice(0, 300));
    return file;
  }
  // provider 的 settings_config 是**裸 settings 形态**（不是快照那种 rows[].value 嵌套）
  function pcfg(commands, extra) {
    const s = { hooks: { SessionStart: [{ matcher: "startup", hooks: commands.map((c) => ({ type: "command", command: c, timeout: 5 })) }] } };
    return JSON.stringify(Object.assign(s, extra || {}));
  }

  // live/快照两层用空壳夹具：下面每个数字都只可能来自 providers 层
  const shell = mkCase("providers-shell", { files: { "dao-alpha.js": VALID_CJS, "dao-provonly.js": VALID_CJS } });
  const ALIVE = abs(shell, "dao-alpha.js");
  const GHOST = abs(shell, "dao-provghost.js");     // 不存在
  const PROVONLY = abs(shell, "dao-provonly.js");   // 只被某个 provider 注册

  if (sqlite) {
    // ── 正控：某个 provider 的钩子指向已删脚本 ⇒ 红且指名（#57 关闭条件点名要的那条）──
    {
      const db = mkDb("dead-hook", [
        { id: "p-ok", name: "Alpha", app_type: "claude", settings_config: pcfg(['node "' + ALIVE + '"']) },
        { id: "p-bad", name: "Beta", app_type: "claude", settings_config: pcfg(['node "' + ALIVE + '"', 'node "' + GHOST + '"']) },
      ]);
      const r = runProviders(shell, db);
      check("正控：provider 钩子指向已删脚本 → exit 1", r.code === 1 && r.sum && r.sum.exit === 1, JSON.stringify(r.sum) + "\n" + r.out.slice(-700));
      check("正控：dead=1（活的那条不被牵连）", r.sum && r.sum.dead === 1, JSON.stringify(r.sum));
      check("正控：指名到具体脚本（只报个数字等于没报）", /dao-provghost\.js/.test(r.out), r.out.slice(-800));
      check("正控：指名到具体是哪个 provider（切到它才会死，人得知道切哪个）",
        /provider\/Beta \[p-bad\]/.test(r.out), r.out.slice(-800));
      check("正控：说清死法是「脚本不存在」", /脚本不存在/.test(r.out), r.out.slice(-800));
      check("正控：自检仍 ok（这是真发现，不是扫描面塌）", r.sum && r.sum.self === "ok", JSON.stringify(r.sum));
      check("正控：末行 providers=2 providerscan=ok", r.sum && r.sum.providers === 2 && r.sum.pscan === "ok", JSON.stringify(r.sum));
    }

    // ── 负控：全活 ⇒ 不许判红（护栏两侧的代价都是真代价）──
    {
      const db = mkDb("all-alive", [
        { id: "p-ok", name: "Alpha", app_type: "claude", settings_config: pcfg(['node "' + ALIVE + '"']) },
        { id: "p-ok2", name: "Gamma", app_type: "claude", settings_config: pcfg(['node "' + ALIVE + '" x'], { statusLine: { type: "command", command: "node " + ALIVE } }) },
      ]);
      const r = runProviders(shell, db);
      check("负控：provider 钩子全活 → exit 0 / dead=0", r.code === 0 && r.sum && r.sum.exit === 0 && r.sum.dead === 0, JSON.stringify(r.sum) + "\n" + r.out.slice(-700));
      check("负控：三条都被扫到（2 个 hook + 1 个 statusLine，口径与前两层一致）", r.sum && r.sum.hooks === 3, JSON.stringify(r.sum));
      check("负控：自检 ok（不恒红）", r.sum && r.sum.self === "ok", JSON.stringify(r.sum));
      check("负控：报文里「零死闸」这句话声明覆盖到三层", /live \+ 快照 \+ providers 三层/.test(r.out), r.out.slice(-900));
    }

    // ── 不按 app_type 收窄：非 claude 行里的死钩子照样报（与 settings-drift 的刻意分工）──
    {
      const db = mkDb("non-claude-dead", [
        { id: "p-ok", name: "Alpha", app_type: "claude", settings_config: pcfg(['node "' + ALIVE + '"']) },
        { id: "p-x", name: "Weird", app_type: "opencode", settings_config: pcfg(['node "' + GHOST + '"']) },
        { id: "p-none", name: "NoHooks", app_type: "codex", settings_config: JSON.stringify({ auth: {}, config: "model = 'x'" }) },
      ]);
      const r = runProviders(shell, db);
      check("非 claude 的 provider 里的死钩子照样红（收窄 app_type 会漏掉它）",
        r.code === 1 && /dao-provghost\.js/.test(r.out) && /provider\/Weird/.test(r.out), JSON.stringify(r.sum) + "\n" + r.out.slice(-800));
      check("不带 hooks 的行贡献 0 噪音，但仍在扫描面里点名（范围没被收窄要看得见）",
        r.sum && r.sum.providers === 3 && /NoHooks/.test(r.out), JSON.stringify(r.sum) + "\n" + r.out.slice(0, 1200));
    }

    // ── provider 的 permissions 面也过同一道判据 ──
    // 今天真实数据里这类条目是 0 条，**正因为是 0 条才必须有夹具**：真数据上零命中
    // 与「这一面根本没接上」输出完全一样（本脚本自己治的就是这个病）。
    {
      const db = mkDb("provider-perms", [
        { id: "p-perm", name: "Perm", app_type: "claude", settings_config: pcfg([], {
          permissions: { deny: ["Bash(grep:*)", "Bash(node " + GHOST + ":*)"], allow: ["Read", "Bash(node " + ALIVE + ":*)"] } }) },
      ]);
      const r = runProviders(shell, db);
      check("provider 的 permissions.deny 指向已删脚本 → 红且点名",
        r.code === 1 && r.sum && r.sum.dead === 1 && /dao-provghost\.js/.test(r.out) && /permissions\.deny/.test(r.out),
        JSON.stringify(r.sum) + "\n" + r.out.slice(-800));
      check("provider 的 permissions.allow 指向存在脚本 → 不误伤；无路径条目也不误伤",
        r.sum && r.sum.dead === 1, JSON.stringify(r.sum));
      check("permissions 条目不掺进 hooks 计数（那个数与普查配对）", r.sum && r.sum.hooks === 0, JSON.stringify(r.sum));
    }

    // ── 孤儿反查：只在 provider 层注册的 hook 不许被误报成孤儿 ──
    // 「核不了/没注册」是两种病两种处方；providers 是真下发源，在那里注册就是注册了。
    {
      const db = mkDb("provider-only-reg", [
        { id: "p-ok", name: "Alpha", app_type: "claude", settings_config: pcfg(['node "' + ALIVE + '"', 'node "' + PROVONLY + '"']) },
      ]);
      const r = runProviders(shell, db);
      check("只被 provider 注册的 hook 不算孤儿（orphan=0）", r.sum && r.sum.orphan === 0, JSON.stringify(r.sum) + "\n" + r.out.slice(-700));
      // 对照组：live/快照两层在这个夹具里**一条都没注册**，故关掉 providers 后两个文件都成孤儿。
      // 这一条要钉的不是「1 个」这个数，而是「orphan 从 0 变成非 0」这个**差**——
      // 那个差就是 providers 层的注册面，它证明上一条 orphan=0 不是白捡的。
      check("（对照）关掉 providers 层 → 这两个文件都成孤儿，差额即 providers 层的注册面",
        (() => { const r2 = run(shell); return r2.sum && r2.sum.orphan === 2 && /dao-provonly\.js/.test(r2.out); })(), "对照组");
    }

    // ── 自检半边：provider 的 settings_config 解析不动 ⇒ 普查看得见、遍历看不见 ⇒ 必须红 ──
    {
      const db = mkDb("selfcheck-provider", [
        { id: "p-ok", name: "Alpha", app_type: "claude", settings_config: pcfg(['node "' + ALIVE + '"']) },
        { id: "p-broken", name: "Broken", app_type: "claude", settings_config: '{"hooks": [{"type": "command", "command": "node x.js"' },
      ]);
      const r = runProviders(shell, db);
      check("provider 配置解析不动但普查数得到条目 → selfcheck=fail + exit 1",
        r.code === 1 && r.sum && r.sum.self === "fail" && r.sum.exit === 1, JSON.stringify(r.sum) + "\n" + r.out.slice(-900));
      check("报文点名是哪个 provider 塌的", /provider\/Broken/.test(r.out), r.out.slice(-900));
      check("此时 dead=0 而 exit=1 —— 两种红在机器通道上分得开", r.sum && r.sum.dead === 0, JSON.stringify(r.sum));
    }

    // ── 零行：**不是**「全都活着」 ──
    {
      const db = mkDb("zero-rows", []);
      const r = runProviders(shell, db);
      check("providers 表零行 → exit 2 / providerscan=uncheckable（零样本不冒充绿）",
        r.code === 2 && r.sum && r.sum.exit === 2 && r.sum.pscan === "uncheckable", JSON.stringify(r.sum) + "\n" + r.out.slice(-700));
      check("零行时明说「不等于零死闸」", /不等于/.test(r.out) && /没查成/.test(r.out), r.out.slice(-900));
      check("零行时那句「零死闸」自己收窄射程到两层", /live \+ 快照两层/.test(r.out) && /这一句不覆盖它/.test(r.out), r.out.slice(-900));
    }

    // ── 没有 providers 表（DB 在，但不是 cc-switch 的库 / schema 变了）──
    {
      const db = mkDb("no-table", [], { noTable: true });
      const r = runProviders(shell, db);
      check("DB 在但没有 providers 表 → exit 2 而不是崩、也不是绿",
        r.code === 2 && r.sum && r.sum.pscan === "uncheckable", JSON.stringify(r.sum) + "\n" + r.out.slice(-700));
      check("原因原文照登（不做措辞转译，转译只会丢信息）", /no such table/i.test(r.out), r.out.slice(-800));
    }
  }

  // ── DB 不在（这条不需要 sqlite3，任何机器上都跑）──
  {
    const r = runProviders(shell, path.join(TMP, "providers-db", "does-not-exist.db"));
    check("DB 文件不在 → exit 2 / uncheckable（**不等于零死闸**）",
      r.code === 2 && r.sum && r.sum.exit === 2 && r.sum.pscan === "uncheckable", JSON.stringify(r.sum) + "\n" + r.out.slice(-700));
    check("报文给出 DB 路径与原因（人要拿这行去查是哪一种）",
      /本次没查成/.test(r.out) && /does-not-exist\.db/.test(r.out), r.out.slice(-800));
  }

  // ── --no-providers：显式缩面，与「没查成」必须分得开 ──
  {
    const r = run(shell);
    check("--no-providers → providerscan=off 且退出码不受影响（显式缩面 != 环境没给成）",
      r.code === 0 && r.sum && r.sum.pscan === "off" && r.sum.exit === 0, JSON.stringify(r.sum));
    check("off 时报文明说「不是查过了没事」", /被 --no-providers 显式关掉/.test(r.out) && /不是「查过了没事」/.test(r.out), r.out.slice(0, 1200));
  }
}

providersSection().then(() => {
  console.log("\n=== 汇总: PASS=" + pass + " FAIL=" + fail + " DEFER=" + defer + " ===");
  if (defer) {
    console.log("⚠ 本次未跑 " + defer + " 组环境敏感断言（默认层）—— 「没跑」不等于「跑了全过」。");
    console.log("  跑完整层：node tests/dead-gates.tests.js --env   （要求串行环境，见文件头）");
  }
  process.exit(fail ? 1 : 0);
}).catch((e) => {
  // 异常不许被读成「这一节没有断言」：显式记一条 FAIL 再退出
  fail++;
  console.log("  FAIL  ⑬ providers 段抛异常  ->  " + (e && e.stack ? e.stack : e));
  console.log("\n=== 汇总: PASS=" + pass + " FAIL=" + fail + " DEFER=" + defer + " ===");
  if (defer) {
    console.log("⚠ 本次未跑 " + defer + " 组环境敏感断言（默认层）—— 「没跑」不等于「跑了全过」。");
    console.log("  跑完整层：node tests/dead-gates.tests.js --env   （要求串行环境，见文件头）");
  }
  process.exit(1);
});
