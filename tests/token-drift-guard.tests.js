// token-drift 棘轮守卫回归网 — 正负控 + L12「基线与规则脱节」专项 + 棘轮只降不升 + 双向 mutation
//
// 跑法：node tests/token-drift-guard.tests.js   （全绿 exit 0，任一红 exit 1）
//       node scripts/run-tests.mjs              （扫目录自动发现，无需登记）
//
// ── 被测对象 ────────────────────────────────────────────────────────────────
// ccswitch/templates/check-token-drift.mjs（canonical，项目侧是派生副本）。
// 一律**当子进程跑、按退出码断言** —— 退出码是这道闸对外的唯一契约，
// 只测导出函数会漏掉「判断顺序错了」这一整类缺陷（L12 专项恰恰是顺序问题：
// 指纹判定必须排在回归判定**之前**，否则规则脱节会被报成一片假回归）。
//
// ── 每组断言防的是什么（写在这里，免得日后有人删掉某条却不知道删了什么）──────
//   ① 负控/正控     —— 闸本身有判别力：干净必绿、加一个裸值必红。
//   ③ L12 专项      —— 事故账 L12（棘轮基线与扫描规则脱节后恒红多日）。**含反向 mutation**：
//                      把指纹判定摘掉之后，同一份夹具必须从 exit 4 变成 exit 1 ——
//                      否则那条断言可能只是碰巧成立（恒真的断言 = 废话）。
//   ⑥ 棘轮只降不升 —— 上游那版**会在这一组里绿**：它清理后不写基线，于是「清掉 1 个再加回
//                      1 个」比对照样过。本组是本次上移相对上游的核心增量，删了它这次改造就白做。
//   ⑫ 扫描面塌陷   —— 「检查器数到 0 个违例」与「检查器根本没看到样本」输出不许长得一样。
//                      用 mutation 把 collectFiles 打瞎，断言 exit 5 而不是 exit 0。
//   ⑯ 清单闸位     —— 钉住 scaffold 条目 severity=info。核验官对本件的第三条修正是
//                      「硬性要求属判断档、须用户再拍一次」；把它钉成断言，
//                      免得日后有人顺手升成硬闸而无人知晓。

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const REPO = path.resolve(__dirname, "..");
const GUARD = path.join(REPO, "ccswitch", "templates", "check-token-drift.mjs");
const TMP = path.join(REPO, "_tmp", "token-drift-tests");

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail ? "  ->  " + detail : "")); }
}

function rmrf(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }
function mkdirp(p) { fs.mkdirSync(p, { recursive: true }); }

// 每个夹具是一个独立项目根。**刻意不共用** —— 共用会让「上一组把基线写脏了」
// 变成下一组的隐藏前提，而那正是本文件在测的那类病。
let fixtureSeq = 0;
function makeFixture(files, opts) {
  const root = path.join(TMP, "fx" + (++fixtureSeq));
  rmrf(root);
  mkdirp(path.join(root, "src"));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    mkdirp(path.dirname(full));
    fs.writeFileSync(full, content, "utf8");
  }
  if (opts && opts.pkg) fs.writeFileSync(path.join(root, "package.json"), JSON.stringify(opts.pkg, null, 2), "utf8");
  return root;
}

// mutation 副本的文件名**必须含 "check-token-drift"** —— 被测脚本用
// `process.argv[1].includes("check-token-drift")` 判「是不是被直接执行」，名字不带这一串的
// 副本会**静默什么都不做、exit 0**，于是每一条 mutation 断言都变成在测「空文件不报错」。
// 第一版正是这么写的（mutant-blind.mjs），三条断言集体假绿 —— 故下面 §⑫ 专门加了一条
// 「未变异副本放在同一路径上仍然工作」的负控，把这条踩过的坑钉死在测试里。
const mutantPath = (tag) => path.join(TMP, `check-token-drift.mutant-${tag}.mjs`);

function run(root, args, guardPath) {
  const r = spawnSync(process.execPath, [guardPath || GUARD, `--project=${root}`].concat(args || []), {
    encoding: "utf8", windowsHide: true,
  });
  const out = String(r.stdout || "") + String(r.stderr || "");
  const sum = (out.match(/TOKEN_DRIFT_SUMMARY .*/) || [""])[0];
  return { code: r.status, out, sum };
}

const baselineOf = (root) => path.join(root, ".token-drift-baseline.json");
const readBase = (root) => JSON.parse(fs.readFileSync(baselineOf(root), "utf8"));

const CLEAN = `export const Box = () => <div className="p-2 rounded-control text-fg">hi</div>\n`;
const DIRTY_1 = `export const Bad = () => <div style={{ marginTop: 13 + "px" }} className="w-[17px]">x</div>\n`;

rmrf(TMP);
mkdirp(TMP);

// ── ① 负控：干净夹具必须绿 ─────────────────────────────────────────────────
console.log("\n① 负控 — 零裸值必须 exit 0");
{
  const root = makeFixture({ "src/clean.tsx": CLEAN });
  const up = run(root, ["--update-baseline"]);
  check("--update-baseline 成功", up.code === 0, up.sum);
  const r = run(root, []);
  check("干净夹具棘轮通过", r.code === 0, r.sum);
  check("汇总行报 violations=0", /violations=0/.test(r.sum), r.sum);
}

// ── ② 正控：新增裸值必须红 ─────────────────────────────────────────────────
console.log("\n② 正控 — 新增裸值 exit 1");
{
  const root = makeFixture({ "src/clean.tsx": CLEAN });
  run(root, ["--update-baseline"]);
  fs.writeFileSync(path.join(root, "src", "bad.tsx"), DIRTY_1, "utf8");
  const r = run(root, []);
  check("新文件的裸值被抓 ⇒ exit 1", r.code === 1, r.sum);
  check("报文点名了新文件", r.out.includes("src/bad.tsx"), r.out.slice(0, 300));
}

// ── ③ L12 专项：基线与规则脱节 ⇒ exit 4，不是 exit 1 ────────────────────────
console.log("\n③ L12 专项 — 规则脱节走专用出口，且反向 mutation 证明该断言有判别力");
{
  const root = makeFixture({ "src/clean.tsx": CLEAN, "src/bad.tsx": DIRTY_1 });
  run(root, ["--update-baseline"]);
  // 篡改指纹 = 模拟「有人改了扫描规则」。计数一并调低，制造出「看起来像回归」的形态。
  const b = readBase(root);
  b.rulesFingerprint = "sha256:0000000000000000000000000000dead";
  b.counts = {};
  fs.writeFileSync(baselineOf(root), JSON.stringify(b, null, 2), "utf8");

  const r = run(root, []);
  check("指纹不一致 ⇒ exit 4（不是 1）", r.code === 4, r.sum);
  check("汇总行标 reason=rules-drift", /reason=rules-drift/.test(r.sum), r.sum);
  check("报文明说「无从分辨」而不是列违规", r.out.includes("说明不了任何事"), r.out.slice(0, 400));

  // 反向 mutation：把指纹判定整段摘掉，同一份夹具必须退化成 exit 1。
  const src = fs.readFileSync(GUARD, "utf8");
  const needle = "if (baseline.fingerprint && baseline.fingerprint !== fingerprint) {";
  check("mutation 锚点仍在源码里（锚失效则下面的 mutation 是空转）", src.includes(needle), needle);
  const mutated = mutantPath("nofp");
  fs.writeFileSync(mutated, src.replace(needle, "if (false) {"), "utf8");
  const m = run(root, [], mutated);
  check("摘掉指纹判定后同一夹具变成 exit 1 ⇒ 原断言不是恒真", m.code === 1, m.sum);
}

// ── ④⑤ 旧格式基线（无指纹）的两条路 ───────────────────────────────────────
console.log("\n④⑤ 旧格式基线 — 不过则 exit 4；过则自动升级为带指纹格式");
{
  const root = makeFixture({ "src/clean.tsx": CLEAN });
  // 上游那版的基线形态：裸 {path: n} 映射
  fs.writeFileSync(baselineOf(root), JSON.stringify({ "src/clean.tsx": 0 }, null, 2), "utf8");
  fs.writeFileSync(path.join(root, "src", "bad.tsx"), DIRTY_1, "utf8");
  const r = run(root, []);
  check("旧格式 + 有回归 ⇒ exit 4（无从分辨，不冤枉人）", r.code === 4, r.sum);
  check("汇总行标 reason=legacy-baseline", /reason=legacy-baseline/.test(r.sum), r.sum);

  const root2 = makeFixture({ "src/clean.tsx": CLEAN });
  fs.writeFileSync(baselineOf(root2), JSON.stringify({ "src/clean.tsx": 0 }, null, 2), "utf8");
  const r2 = run(root2, []);
  check("旧格式 + 比对通过 ⇒ exit 0", r2.code === 0, r2.sum);
  check("并自动升级：基线现在带 rulesFingerprint", typeof readBase(root2).rulesFingerprint === "string",
    JSON.stringify(readBase(root2)).slice(0, 200));
}

// ── ⑥ 棘轮只降不升（本次上移的核心增量）───────────────────────────────────
console.log("\n⑥ 棘轮 — 清理后基线自动收紧，再加回去必须红");
{
  const three = `const a = "3px"; const b = "5px"; const c = "7px";\n`;
  const root = makeFixture({ "src/x.ts": three });
  run(root, ["--update-baseline"]);
  check("基线记 3", readBase(root).counts["src/x.ts"] === 3, JSON.stringify(readBase(root).counts));

  fs.writeFileSync(path.join(root, "src", "x.ts"), `const a = "3px";\n`, "utf8");
  const r = run(root, []);
  check("清理到 1 ⇒ 通过", r.code === 0, r.sum);
  check("基线被自动收紧到 1（只降不升）", readBase(root).counts["src/x.ts"] === 1, JSON.stringify(readBase(root).counts));
  check("报文说出「棘轮已收紧」", r.out.includes("棘轮已收紧"), r.out.slice(0, 300));

  // 关键一击：加回一个。上游那版会绿（它的基线还停在 3）。
  fs.writeFileSync(path.join(root, "src", "x.ts"), `const a = "3px"; const b = "5px";\n`, "utf8");
  const back = run(root, []);
  check("加回一个裸值 ⇒ exit 1（棘轮不许回滑）", back.code === 1, back.sum);
}

// ── ⑦ 已消失的条目要被剪掉（基线只增不减也是一种债）────────────────────────
console.log("\n⑦ 退役 — 文件删了，基线条目要剪掉");
{
  const root = makeFixture({ "src/x.ts": `const a = "3px";\n`, "src/y.ts": `const b = "5px";\n` });
  run(root, ["--update-baseline"]);
  check("基线两个条目", Object.keys(readBase(root).counts).length === 2);
  fs.rmSync(path.join(root, "src", "y.ts"));
  const r = run(root, []);
  check("删文件后仍通过", r.code === 0, r.sum);
  check("基线只剩一个条目（stale 被剪）", Object.keys(readBase(root).counts).length === 1,
    JSON.stringify(readBase(root).counts));
  check("汇总行报 stale>=1", /stale=[1-9]/.test(r.sum), r.sum);
}

// ── ⑧ --no-tighten 是一条只读承诺 ─────────────────────────────────────────
console.log("\n⑧ --no-tighten — 说好不写就一个字节都不写");
{
  const root = makeFixture({ "src/x.ts": `const a = "3px"; const b = "5px";\n` });
  run(root, ["--update-baseline"]);
  const before = fs.readFileSync(baselineOf(root), "utf8");
  fs.writeFileSync(path.join(root, "src", "x.ts"), `const a = "3px";\n`, "utf8");
  const r = run(root, ["--no-tighten"]);
  check("仍然通过", r.code === 0, r.sum);
  check("基线逐字节未变", fs.readFileSync(baselineOf(root), "utf8") === before);
  check("但把「可收紧」如实说出来", r.out.includes("--no-tighten 生效中"), r.out.slice(0, 300));

  // 旧格式 + --no-tighten：升级也不许偷偷写
  const root2 = makeFixture({ "src/clean.tsx": CLEAN });
  fs.writeFileSync(baselineOf(root2), JSON.stringify({ "src/clean.tsx": 0 }, null, 2), "utf8");
  const b2 = fs.readFileSync(baselineOf(root2), "utf8");
  const r2 = run(root2, ["--no-tighten"]);
  check("旧格式升级在 --no-tighten 下也不写", r2.code === 0 && fs.readFileSync(baselineOf(root2), "utf8") === b2, r2.sum);
}

// ── ⑨⑩ 「没查」与「查了没事」必须分得开 ───────────────────────────────────
console.log("\n⑨⑩ 没基线 / 没扫描根 — 各走各的码，都不叫通过");
{
  const root = makeFixture({ "src/clean.tsx": CLEAN });
  const r = run(root, []);
  check("无基线 ⇒ exit 2（不是 0）", r.code === 2, r.sum);

  const bare = path.join(TMP, "bare-project");
  rmrf(bare); mkdirp(bare);
  fs.writeFileSync(path.join(bare, "README.md"), "no frontend here\n", "utf8");
  const r2 = run(bare, []);
  check("一个扫描根都没有 ⇒ exit 3（没查）", r2.code === 3, r2.sum);
  check("报文明说这是「没查」不是「没事」", r2.out.includes("没查"), r2.out.slice(0, 300));
}

// ── ⑪ 检查器的输出不能落在自己的扫描面内 ──────────────────────────────────
console.log("\n⑪ 自指 — 基线落进扫描根即 exit 5");
{
  const root = makeFixture({ "src/clean.tsx": CLEAN });
  const r = run(root, ["--roots=."]);
  check("扫描根含项目根（基线在其中）⇒ exit 5", r.code === 5, r.sum);
  check("汇总行标 reason=output-in-scan-surface", /reason=output-in-scan-surface/.test(r.sum), r.sum);
}

// ── ⑫ 扫描面塌陷：mutation 打瞎主遍历 ─────────────────────────────────────
console.log("\n⑫ 我瞎了吗 — 主遍历被打瞎时不许静默绿");
{
  const root = makeFixture({ "src/clean.tsx": CLEAN, "src/x.ts": `const a = "3px";\n` });
  run(root, ["--update-baseline"]);
  const clean = run(root, []);
  check("负控：未变异副本在同一夹具上绿（否则下面的红不算数）", clean.code === 0, clean.sum);

  // ⚠️ 行尾归一化后再找锚点：盘上是 CRLF（本仓 Windows 检出），而锚点若写死 `\n` 会**恒不命中** ⇒
  // 本组三条断言全部空转，且失败形态是「mutation 没生效所以守卫照常绿」——与「守卫真的没塌陷」
  // 逐字节相同。2026-08-02 主干实测撞到（分支 worktree 与主仓检出的行尾不同，分支绿、合并后红），
  // 同型坑当天另有一例（`node -e` 锚点带 `\n` 而文件 CRLF ⇒ ANCHOR MISS）。
  // 归一化后写回变异体也用归一化文本：守卫本身不关心行尾，但锚点匹配关心。
  const src = fs.readFileSync(GUARD, "utf8");
  const needleRe = /  walk\(root, 0\);\r?\n  return out;/;
  check("mutation 锚点仍在（锚失效则本组空转）", needleRe.test(src), String(needleRe));

  // 负控·针对 mutation 机制本身：**未变异的副本放在同一条路径上必须照常工作**。
  // 少了这一条，「副本根本没跑」与「变异生效了」在退出码上分不开（第一版就栽在这里）。
  const untouched = mutantPath("control");
  fs.writeFileSync(untouched, src, "utf8");
  const ctrl = run(root, [], untouched);
  check("负控：未变异副本在 mutant 路径上仍 exit 0（证明副本真的被执行了）", ctrl.code === 0, ctrl.sum);

  const mutated = mutantPath("blind");
  fs.writeFileSync(mutated, src.replace(needleRe, "  return [];"), "utf8");
  const m = run(root, [], mutated);
  check("主遍历返回空 ⇒ exit 5（不是 0）", m.code === 5, m.sum);
  check("汇总行标 reason=zero-sample", /reason=zero-sample/.test(m.sum), m.sum);
  check("报文说出「我瞎了」而不是「零违例」", m.out.includes("扫描面塌陷"), m.out.slice(0, 300));
}

// ── ⑬ --distribution ──────────────────────────────────────────────────────
console.log("\n⑬ 全域分布摸底 — 恒 exit 0 且报得出 Top 目录");
{
  const root = makeFixture({ "src/a/x.ts": `const a = "3px";\n`, "src/b/y.ts": `const b = "5px"; const c = "7px";\n` });
  const r = run(root, ["--distribution"]);
  check("exit 0", r.code === 0, r.sum);
  check("mode=distribution", /mode=distribution/.test(r.sum), r.sum);
  check("打印了规则指纹（便于人肉对基线）", /规则指纹：sha256:/.test(r.out), r.out.slice(0, 400));
}

// ── ⑭ --selfcheck：「文件在盘上」≠「有人跑它」 ────────────────────────────
console.log("\n⑭ selfcheck — 没有调用入口要说出来");
{
  const root = makeFixture({ "src/clean.tsx": CLEAN }, { pkg: { name: "fx", scripts: { build: "tsc" } } });
  const r = run(root, ["--selfcheck"]);
  check("无人调用 ⇒ exit 1", r.code === 1, r.sum);
  check("报文点破「守卫在盘上 ≠ 守卫在跑」", r.out.includes("守卫在盘上 ≠ 守卫在跑"), r.out.slice(0, 500));

  const root2 = makeFixture({ "src/clean.tsx": CLEAN },
    { pkg: { name: "fx", scripts: { "check:tokens": "node scripts/check-token-drift.mjs" } } });
  const r2 = run(root2, ["--selfcheck"]);
  check("有调用入口 ⇒ exit 0（负控：不是恒红）", r2.code === 0, r2.sum);
}

// ── ⑮ 排除项负控：合法写法零误伤 ──────────────────────────────────────────
console.log("\n⑮ 排除项 — 合法写法不许被当成裸值");
{
  const css = [
    ":root { --space-2: 8px; }",              // CSS 变量定义行：允许
    ".a { color: hsl(var(--fg)); }",          // 动态色函数：允许
    ".b { margin: 0px; }",                    // 0px 等价 0：允许
    "/* 注释里的 12px 与 #abc 不算 */",
    "@keyframes spin { from { top: 4px; } }", // keyframes 内：允许
    "::-webkit-scrollbar { width: 6px; }",    // 滚动条伪元素：允许
  ].join("\n") + "\n";
  const root = makeFixture({ "src/ok.css": css });
  const r = run(root, ["--strict"]);
  check("六种合法写法全部零违例（strict 也过）", r.code === 0, r.out.slice(0, 600));

  const bad = makeFixture({ "src/no.css": ".c { padding: 14px; color: #a1b2c3; }\n" });
  const rb = run(bad, ["--strict"]);
  check("正控：真裸值在 strict 下必红", rb.code === 1, rb.sum);
  check("px 与 hex 都报出来", /px/.test(rb.out) && /#a1b2c3/.test(rb.out), rb.out.slice(0, 400));
}

// ── ⑰ 崩溃不许伪装成「有回归」────────────────────────────────────────────
// node 未捕获异常默认 exit 1，而 1 在本闸的契约里是「有回归」⇒ 一次崩溃会让人去追一个
// 不存在的违规。本组用 mutation 造一次真崩溃，断言它落到 exit 3（没查成）。
// （这不是假想：自指断言第一版真的这么崩过，就是这条回归网抓出来的。）
console.log("\n⑰ 崩溃 — 落 exit 3（没查成），不落 exit 1（有回归）");
{
  const root = makeFixture({ "src/clean.tsx": CLEAN });
  run(root, ["--update-baseline"]);
  const src = fs.readFileSync(GUARD, "utf8");
  const needle = "  const fingerprint = rulesFingerprint(roots);";
  check("mutation 锚点仍在（锚失效则本组空转）", src.includes(needle), needle);
  const mutated = mutantPath("crash");
  fs.writeFileSync(mutated, src.replace(needle, '  throw new Error("人为注入崩溃");'), "utf8");
  const m = run(root, [], mutated);
  check("守卫抛异常 ⇒ exit 3（不是 1）", m.code === 3, m.sum);
  check("汇总行标 reason=crash", /reason=crash/.test(m.sum), m.sum);
  check("报文明说「这不是代码里有裸值」", m.out.includes("不是**代码里有裸值"), m.out.slice(0, 300));
}

// ── ⑯ 清单闸位钉死在 info（核验官第三条修正）──────────────────────────────
console.log("\n⑯ 清单条目 — 闸位必须停在 info（升硬闸属判断档，须用户拍板）");
{
  const manifest = JSON.parse(fs.readFileSync(path.join(REPO, "ccswitch", "scaffold-manifest.json"), "utf8"));
  const e = manifest.entries.find((x) => x.id === "token-drift-guard");
  check("清单里有 token-drift-guard 条目", !!e);
  if (e) {
    check("severity === info（红了说明有人把建议升成了硬性要求）", e.severity === "info", e.severity);
    check("template.src 指向本 canonical", e.template && e.template.src === "check-token-drift.mjs",
      JSON.stringify(e.template));
    check("require 与 template.dest 指同一路径", e.require && e.require.file === e.template.dest,
      JSON.stringify({ require: e.require, dest: e.template && e.template.dest }));
  }
}

rmrf(TMP);
console.log("\n=== 汇总: PASS=" + pass + " FAIL=" + fail + " ===");
process.exit(fail ? 1 : 0);
