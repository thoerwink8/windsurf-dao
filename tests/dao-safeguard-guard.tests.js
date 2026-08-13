// dao-safeguard-guard 回归网（issue #361 自动化三件：自测桥接 + 接线层端到端 + state-file 字段）
//
// 为什么存在（PR #357 对抗验证报告挂账的三洞）：
//   ① 脚本内置的 56 条 selftest 不被 dao-check 扫描（tests/ 零引用）——[STALL] 逻辑将来
//      回归不会红任何门。⇒ 本套按 tests/ 既有 *.tests.js 的形态桥接：require 脚本直跑
//      runSelfTest()，体检自动发现，回归即红。
//   ② 接线层 serviceStall 0/5 覆盖（M4 实证：把 serviceStall 里 isTerminalEnded 调用短路，
//      56 条自测仍全绿）——判定纯函数有测试，把它们接起来的生产调用点全在盲区。
//      ⇒ 本套注入假 runner 模拟 read 返回序列，经生产链路 serviceOnce→serviceStall 驱动
//      完整判定链（read → classify → isTerminalEnded → 差分 → inbox → stallNext → 告警）。
//      场景 B（status=exited）就是 M4 探针载体：短路 isTerminalEnded 本套必红。
//   ③ state-file 的 stall 行缺 stallCount/stallRounds。⇒ 见 ③ 节。
// 不碰真 orca CLI：read/inbox 全部注入假实现；state-file 沙箱到 _tmp/（gitignored）。
// 判别力自检问句：任何放宽/收紧 stall 判定或接线改动的改动，是否都至少有一条断言会变红？

const fs = require("fs");
const path = require("path");

const REPO = path.resolve(__dirname, "..");
const G = require(path.join(REPO, "scripts", "dao-safeguard-guard.mjs")); // Node 24 require(esm)

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? "  →  " + detail : ""}`); }
}

/** 捕获一轮异步执行里守卫的 stdout+stderr（log() 全走这两根流）。 */
async function capture(fn) {
  const origOut = process.stdout.write, origErr = process.stderr.write;
  let buf = "";
  process.stdout.write = (s) => { buf += s; return true; };
  process.stderr.write = (s) => { buf += s; return true; };
  try { await fn(); }
  finally { process.stdout.write = origOut; process.stderr.write = origErr; }
  return buf;
}

function makeTermState(over = {}) {
  return {
    handle: "term_e2e", state: "idle", attempts: 0, failures: 0, consecutiveReadFails: 0,
    events: 0, announcedStop: false, prevTail: [], established: false, scannedOnce: false,
    reBaseline: false, forceScan: false, stallCount: 0, done: false, ...over,
  };
}

function makeStallCfg(over = {}) {
  return {
    watchStall: true, stallRounds: 3, readLimit: 200, inboxLimit: 200,
    patterns: G.DOWNGRADE_PATTERNS, stateFile: null, scanOnStart: false, ...over,
  };
}

async function main() {

console.log("\n=== ① 内置 selftest 桥接（回归会红体检）===");
{
  const r = G.runSelfTest();
  check(`runSelfTest 全绿（passed=${r.passed} / failed=${r.failed}）`, r.failed === 0, `failed=${r.failed}`);
}

console.log("\n=== ② serviceStall 端到端（假 runner 注入 · 生产链路 serviceOnce→serviceStall）===");
{
  // 场景 A：running 终端 1 轮基线 + 3 轮零新行 → 第 4 轮 [STALL]（阈值 3）
  const readsA = [
    { ok: true, result: { terminal: { status: "running", tail: ["line1"] } } },
    { ok: true, result: { terminal: { status: "running", tail: ["line1"] } } },
    { ok: true, result: { terminal: { status: "running", tail: ["line1"] } } },
    { ok: true, result: { terminal: { status: "running", tail: ["line1"] } } },
  ];
  let i = 0;
  const tA = makeTermState();
  const outA = await capture(async () => {
    for (let n = 0; n < readsA.length; n++) {
      await G.serviceOnce(tA, makeStallCfg(), {
        read: () => readsA[i++],
        inbox: () => ({ ok: true, result: { messages: [] } }),
      });
    }
  });
  check("场景A · 3 轮零新行 → stallCount=3 且出 [STALL] 告警行",
    tA.stallCount === 3 && /\[STALL\]/.test(outA),
    `stallCount=${tA.stallCount} out=${JSON.stringify(outA.slice(-160))}`);

  // 场景 B：status=exited 的终端（零新行）→ 静默合法，绝不 [STALL]。
  // isTerminalEnded 的生产调用点就在 serviceStall 里——短路/删掉该调用（M4 探针），
  // 这个 ended 终端就会掉进计数链并在第 4 轮出 [STALL]，本断言即红。
  const readsB = [
    { ok: true, result: { terminal: { status: "exited", tail: [] } } },
    { ok: true, result: { terminal: { status: "exited", tail: [] } } },
    { ok: true, result: { terminal: { status: "exited", tail: [] } } },
    { ok: true, result: { terminal: { status: "exited", tail: [] } } },
  ];
  let j = 0;
  const tB = makeTermState();
  const outB = await capture(async () => {
    for (let n = 0; n < readsB.length; n++) {
      await G.serviceOnce(tB, makeStallCfg(), {
        read: () => readsB[j++],
        inbox: () => ({ ok: true, result: { messages: [] } }),
      });
    }
  });
  check("场景B · 已结束终端 → done 且 [STALL] 永不出现（M4 探针载体）",
    tB.done === true && !/\[STALL\]/.test(outB) && outB.includes("终端已结束"),
    `done=${tB.done} out=${JSON.stringify(outB.slice(-160))}`);

  // 场景 C：零新行但 inbox 见到本终端 worker_done → 静默合法（stall_completed），不计数
  const readsC = [
    { ok: true, result: { terminal: { status: "running", tail: ["line1"] } } },
    { ok: true, result: { terminal: { status: "running", tail: ["line1"] } } },
  ];
  let k = 0;
  const tC = makeTermState();
  const outC = await capture(async () => {
    for (let n = 0; n < readsC.length; n++) {
      await G.serviceOnce(tC, makeStallCfg(), {
        read: () => readsC[k++],
        inbox: () => ({ ok: true, result: { messages: [{ type: "worker_done", from_handle: "term_e2e" }] } }),
      });
    }
  });
  check("场景C · 零新行 + 已见 worker_done → done 且不计数（inbox 结构化信号判定链）",
    tC.done === true && tC.stallCount === 0 && outC.includes("检测到 worker_done"),
    `done=${tC.done} stallCount=${tC.stallCount} out=${JSON.stringify(outC.slice(-160))}`);
}

console.log("\n=== ③ state-file 的 stall 行带 stallCount/stallRounds ===");
{
  const sf = path.join(REPO, "_tmp", "guard-e2e-state.ndjson");
  fs.mkdirSync(path.dirname(sf), { recursive: true }); // 干净 CI 树没有 _tmp/，写前必须先保证目录存在
  fs.rmSync(sf, { force: true });
  const reads = [
    { ok: true, result: { terminal: { status: "running", tail: ["line1"] } } },
    { ok: true, result: { terminal: { status: "running", tail: ["line1"] } } },
    { ok: true, result: { terminal: { status: "running", tail: ["line1"] } } },
    { ok: true, result: { terminal: { status: "running", tail: ["line1"] } } },
  ];
  let m = 0;
  const t = makeTermState();
  await capture(async () => {
    for (let n = 0; n < reads.length; n++) {
      await G.serviceOnce(t, makeStallCfg({ stateFile: sf }), {
        read: () => reads[m++],
        inbox: () => ({ ok: true, result: { messages: [] } }),
      });
    }
  });
  const lines = fs.readFileSync(sf, "utf8").trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
  const stall = lines.find((l) => l.outcomeKind === "stall");
  check("state-file · stall 行带 stallCount=3 / stallRounds=3",
    !!stall && stall.stallCount === 3 && stall.stallRounds === 3, JSON.stringify(stall));
  check("state-file · 其余行不带该对字段（只补 stall 行，不污染）",
    lines.filter((l) => l.outcomeKind !== "stall").every((l) => l.stallCount === undefined && l.stallRounds === undefined));
  fs.rmSync(sf, { force: true });
}

console.log(`\n=== 汇总: PASS=${pass} FAIL=${fail} ===`);
process.exit(fail ? 1 : 0);

}

main().catch((err) => { console.error(err); process.exit(1); });
