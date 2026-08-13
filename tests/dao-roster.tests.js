import assert from "node:assert/strict";
import { probe, probePi, summarize, RETRY_TIMEOUT_FACTOR } from "../scripts/dao-roster.mjs";

// 路由假 runner：按命令形态分流「主探测」与「定位器(where/which)」两路结果。
// win32 下 runCommand 把 where/which 拼成 "where <cmd>" 单串；posix 下是 args[0]。
function routed(probeResult, locatorResult) {
  return (command, args) => {
    const isLocator = /^(where|which)\b/.test(String(command)) ||
      (Array.isArray(args) && (args[0] === "where" || args[0] === "which"));
    return { ...(isLocator ? locatorResult : probeResult) };
  };
}
const ok = { status: 0, stdout: "0.84.1\n" };
const failNotFound = { status: 1, stdout: "", stderr: "not found" };

// 退出 0：真可用，取首行版本。
assert.deepEqual(probe("pi", ["--version"], 4000, routed(ok, { status: 1 })), {
  available: true, version: "0.84.1",
});

// 非零退出 + 定位器找不到（where/which 非零）⇒ 真缺席 false。
// 中文 Windows 的 GBK 乱码文案也走这条——判定只认退出码，不认文案。
assert.deepEqual(probe("missing", ["--version"], 4000, routed(failNotFound, { status: 1, stdout: "", stderr: "" })), {
  available: false, reason: "exit:1, locator:miss",
});

// 非零退出 + 定位器找到（where/which 0）⇒ 命令在只是跑坏 ⇒ unknown（原「Access is denied」态）。
assert.deepEqual(probe("denied", ["--version"], 4000, routed(failNotFound, { status: 0, stdout: "C:\\x\\denied.exe\n" })), {
  available: "unknown", reason: "exit:1, locator:found",
});

// 探测超时（status==null）+ 定位器找到 ⇒ unknown（存在，只是探测失败）。
assert.deepEqual(probe("slow", ["--version"], 4000, routed(
  { error: Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }), status: null }, { status: 0, stdout: "x\n" },
)), { available: "unknown", reason: "error:ETIMEDOUT, locator:found" });

// 探测超时 + 定位器也找不到 ⇒ false。
assert.deepEqual(probe("gone", ["--version"], 4000, routed(
  { error: Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }), status: null }, { status: 1, stdout: "", stderr: "" },
)), { available: false, reason: "error:ETIMEDOUT, locator:miss" });

// 定位器自身不可用（error）⇒ 兜底走 NOT_FOUND_RE：文案命中 false、不命中 unknown。
const locatorBroken = { error: Object.assign(new Error("nope"), { code: "ENOENT" }), status: null };
assert.deepEqual(probe("noLoc", ["--version"], 4000, routed(failNotFound, locatorBroken)), {
  available: false, reason: "exit:1, locator:unavailable, not-found-text",
});
assert.deepEqual(probe("noLoc2", ["--version"], 4000, routed({ status: 1, stdout: "", stderr: "Access is denied." }, locatorBroken)), {
  available: "unknown", reason: "exit:1, locator:unavailable",
});

// runner 抛异常 ⇒ unknown。
assert.deepEqual(probe("broken", ["--version"], 4000, () => { throw Object.assign(new Error("spawn failed"), { code: "EACCES" }); }), {
  available: "unknown", reason: "threw:EACCES",
});

// ── issue #385：负载突发下健康 CLI 被判 unknown 的回归组 ──
// 机制模型：突发那一刻这条命令需要 needMs 才答得出。预算够就 exit 0，不够就 ETIMEDOUT。
// 修前两次探测同为 4000ms 预算，同一波突发把两次一起咬住 ⇒ 健康的 pi 落 unknown。
function budgeted(needMs, locatorResult) {
  return (command, args, opts) => {
    const isLocator = /^(where|which)\b/.test(String(command)) ||
      (Array.isArray(args) && (args[0] === "where" || args[0] === "which"));
    if (isLocator) return { ...locatorResult };
    return (opts && opts.timeout >= needMs)
      ? { status: 0, stdout: "0.84.1\n" }
      : { error: Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }), status: null };
  };
}
const locatorFound = { status: 0, stdout: "C:\\nvm4w\\nodejs\\pi.cmd\n" };

// 下面的预算全写死字面量，**不许用 RETRY_TIMEOUT_FACTOR 算期望值**：
// 那样是自指断言——把因子改回 1 时期望值跟着变小，退化测不出来（实测漏网，故改此写法）。
// 因子是判据契约，改它必须同改这一行和下面两个字面预算。
assert.equal(RETRY_TIMEOUT_FACTOR, 3, "重试放大倍数变了：下面的字面预算必须同改");

// 正控：健康但首探 4000ms 不够、需 10000ms（落在首探预算与放大后 12000ms 之间）
// ⇒ 重试放大预算后判 available。因子退回 1 时重试仍是 4000ms，这条转红。
assert.deepEqual(probe("pi", ["--version"], 4000, budgeted(10000, locatorFound)), {
  available: true, version: "0.84.1",
});

// 负控①：放大后预算仍不够（突发尾巴无上界）⇒ 仍是 unknown，**不许一律改判 available**。
assert.deepEqual(probe("pi", ["--version"], 4000, budgeted(Number.MAX_SAFE_INTEGER, locatorFound)), {
  available: "unknown", reason: "error:ETIMEDOUT, locator:found",
});

// 负控②：怎么放大预算都答不出、且定位器找不到 ⇒ 真缺席仍判 false（放大预算没绕开缺席判定）。
assert.deepEqual(probe("absent", ["--version"], 4000, budgeted(Number.MAX_SAFE_INTEGER, { status: 1, stdout: "", stderr: "" })), {
  available: false, reason: "error:ETIMEDOUT, locator:miss",
});

// 重试确实拿到了放大后的预算——只断言结果的话，预算没放大也能靠假 runner 蒙混过关。
const budgets = [];
probe("pi", ["--version"], 4000, (command, args, opts) => {
  const isLocator = /^(where|which)\b/.test(String(command));
  if (isLocator) return { ...locatorFound };
  budgets.push(opts.timeout);
  return { error: Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }), status: null };
});
assert.deepEqual(budgets, [4000, 12000]);

// unknown 重试一次：首探坏（非零 + 定位器找到）→ 重试探出 0。定位器占一次 runner 调用，共 3 次。
let attempts = 0;
const retrySpawn = () => {
  attempts += 1;
  if (attempts === 1) return { status: 1, stdout: "", stderr: "Access is denied." }; // 主探测：跑坏
  if (attempts === 2) return { status: 0, stdout: "C:\\x\\pi.exe\n" };              // 定位器：找到
  return { status: 0, stdout: "0.84.1\n" };                                          // 重试：成功
};
assert.equal(probe("pi", ["--version"], 4000, retrySpawn).available, true);
assert.equal(attempts, 3);

// ── 不 mock 的真实负控（本机实测，用真 spawnSync）──
// 随机乱名：任何机器上都不应存在 ⇒ 必须 false。
const garbage = "qzkx_" + Math.random().toString(36).slice(2);
assert.equal(probe(garbage).available, false, `随机乱名 ${garbage} 必须为 false`);
// 本机 omp 真不存在（协调者亲测坐实，本机复验）⇒ 必须 false。
assert.equal(probe("omp").available, false, "本机 omp 必须为 false");
// 本机 pi 真实存在 ⇒ 必须 true。
assert.equal(probePi().available, true, "pi 在本机必须为 true");

assert.equal(summarize({ orca: { available: "unknown" } }, { pi: { available: true }, claude: { available: false }, codex: { available: "unknown" } }), "fabric=orca? agents=pi✓,claude✗,codex?");
console.log("dao-roster tests: 18 passed");
