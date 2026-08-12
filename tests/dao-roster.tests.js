import assert from "node:assert/strict";
import { probe, probePi, summarize } from "../scripts/dao-roster.mjs";

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
  available: false,
});

// 非零退出 + 定位器找到（where/which 0）⇒ 命令在只是跑坏 ⇒ unknown（原「Access is denied」态）。
assert.deepEqual(probe("denied", ["--version"], 4000, routed(failNotFound, { status: 0, stdout: "C:\\x\\denied.exe\n" })), {
  available: "unknown",
});

// 探测超时（status==null）+ 定位器找到 ⇒ unknown（存在，只是探测失败）。
assert.deepEqual(probe("slow", ["--version"], 4000, routed(
  { error: Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }), status: null }, { status: 0, stdout: "x\n" },
)), { available: "unknown" });

// 探测超时 + 定位器也找不到 ⇒ false。
assert.deepEqual(probe("gone", ["--version"], 4000, routed(
  { error: Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }), status: null }, { status: 1, stdout: "", stderr: "" },
)), { available: false });

// 定位器自身不可用（error）⇒ 兜底走 NOT_FOUND_RE：文案命中 false、不命中 unknown。
const locatorBroken = { error: Object.assign(new Error("nope"), { code: "ENOENT" }), status: null };
assert.deepEqual(probe("noLoc", ["--version"], 4000, routed(failNotFound, locatorBroken)), { available: false });
assert.deepEqual(probe("noLoc2", ["--version"], 4000, routed({ status: 1, stdout: "", stderr: "Access is denied." }, locatorBroken)), { available: "unknown" });

// runner 抛异常 ⇒ unknown。
assert.deepEqual(probe("broken", ["--version"], 4000, () => { throw Object.assign(new Error("spawn failed"), { code: "EACCES" }); }), {
  available: "unknown",
});

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
console.log("dao-roster tests: 14 passed");
