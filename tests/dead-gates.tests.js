// dead-gates 回归网 — ccswitch/scripts/check-dead-gates.mjs 的双向断言
//
// 跑法：node tests/dead-gates.tests.js        （全绿 exit 0，任一红 exit 1）
//       node scripts/run-tests.mjs            （自动发现本文件，无需登记）
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

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail ? "  ->  " + detail : "")); }
}

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

function run(dir, extraArgs) {
  const args = [SCRIPT,
    "--live", path.join(dir, "live.json"),
    "--snapshot-dir", path.join(dir, "snap"),
    "--hooks-dir", path.join(dir, "hooks"),
    "--project-root", dir].concat(extraArgs || []);
  const r = spawnSync(process.execPath, args, { encoding: "utf8", timeout: 60000 });
  const out = String(r.stdout || "");
  const m = /DEAD_GATES_SUMMARY exit=(\d+) hooks=(\d+) dead=(\d+) orphan=(\d+) selfcheck=(ok|fail) unverifiable=(\d+)/.exec(out);
  return {
    code: r.status, out, stderr: String(r.stderr || ""),
    sum: m ? { exit: Number(m[1]), hooks: Number(m[2]), dead: Number(m[3]), orphan: Number(m[4]), self: m[5], unver: Number(m[6]) } : null,
  };
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
{
  const r = spawnSync(process.execPath, [SCRIPT], { encoding: "utf8", timeout: 120000, cwd: REPO });
  const out = String(r.stdout || "");
  const m = /DEAD_GATES_SUMMARY exit=(\d+) hooks=(\d+) dead=(\d+) orphan=(\d+) selfcheck=(ok|fail) unverifiable=(\d+)/.exec(out);
  check("真仓自跑打得出末行", m !== null, out.slice(-400) + " [stderr] " + String(r.stderr || "").slice(0, 300));
  if (m) {
    const sum = { exit: +m[1], hooks: +m[2], dead: +m[3], orphan: +m[4], self: m[5] };
    console.log("        实况：" + JSON.stringify(sum));
    if (fs.existsSync(LIVE_REAL)) {
      check("真实 live settings 在 → 必须扫到闸（零样本就是塌陷）", sum.hooks > 0, JSON.stringify(sum));
      check("真实语料上自检 ok", sum.self === "ok", JSON.stringify(sum) + "\n" + out.slice(-900));
      check("真实语料上零死闸（红了就是真发现，去读上面的清单）", sum.dead === 0, out.slice(-900));
    } else {
      // 不写「跳过」——那是静默失效。没有 live 文件时，正确行为是报「没查成」
      check("无 live settings 的机器上 → 报 live-unreadable 且红", sum.self === "fail" && sum.exit === 1 && /live-unreadable/.test(out), JSON.stringify(sum));
    }
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
  {
    const r = runHook(REPO);
    check("真仓 SessionStart 注入里出现死闸检测那一行（调用点可达）", /死闸检测/.test(r.ctx),
      "ctx=" + r.ctx.slice(0, 400) + " [stderr]" + r.err.slice(0, 200));
    check("真仓当下是绿态，且报出闸数（不是零输出）", /死闸检测绿/.test(r.ctx) && /条闸/.test(r.ctx), r.ctx.slice(0, 400));
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
      'process.stdout.write("DEAD_GATES_SUMMARY exit=1 hooks=5 dead=2 orphan=0 selfcheck=ok unverifiable=0\\n");',
      "process.exit(1);",
    ].join("\n");
    const r = runHook(mkFakeMeta("red", stub));
    check("死闸红态传导到 SessionStart 提醒", /死闸检测 FAIL/.test(r.ctx), r.ctx.slice(0, 500));
    check("红态带明细（指名到具体脚本）", /dao-stub-ghost\.js/.test(r.ctx), r.ctx.slice(0, 500));
    check("孤儿那一节不被当成红报明细混进来", !/孤儿 hook：0/.test(r.ctx), r.ctx.slice(0, 500));
  }

  // ⑤ 自检半边失败（dead=0 但 exit=1）→ 措辞必须说「零死闸不可信」，不能说「有 0 条死闸」
  {
    const stub = [
      'process.stdout.write("✗ 自检半边失败 1 条：\\n");',
      'process.stdout.write("    · zero-sample：普查数到 7 条而结构化遍历一条都没拿到\\n");',
      'process.stdout.write("DEAD_GATES_SUMMARY exit=1 hooks=0 dead=0 orphan=0 selfcheck=fail unverifiable=0\\n");',
      "process.exit(1);",
    ].join("\n");
    const r = runHook(mkFakeMeta("selffail", stub));
    check("自检失败态：报「零死闸不可信」而不是报 0 条死闸", /不可信/.test(r.ctx) && /selfcheck=fail/.test(r.ctx), r.ctx.slice(0, 500));
  }

  // ⑥ 绿 + 待办：孤儿/无法核验必须浮到 SessionStart，别只藏在 CLI 正文里
  {
    const stub = [
      'process.stdout.write("DEAD_GATES_SUMMARY exit=0 hooks=9 dead=0 orphan=2 selfcheck=ok unverifiable=3\\n");',
    ].join("\n");
    const r = runHook(mkFakeMeta("todo", stub));
    check("绿 + 孤儿 2 + 无法核验 3 → 一行提示带出两个数",
      /死闸检测绿/.test(r.ctx) && /2 个 hook 文件/.test(r.ctx) && /3 条命令串无法核验/.test(r.ctx), r.ctx.slice(0, 500));
    check("提示里明说「无法核验 != 核验通过」", /不等于核验通过/.test(r.ctx), r.ctx.slice(0, 500));
  }
}

console.log("\n=== 汇总: PASS=" + pass + " FAIL=" + fail + " ===");
process.exit(fail ? 1 : 0);
