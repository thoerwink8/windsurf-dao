import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { probe, probePi, summarize, RETRY_TIMEOUT_FACTOR, rosterCachePath, writeRosterCache } from "../scripts/dao-roster.mjs";
import refreshHook from "../ccswitch/hooks/dao-roster-refresh.js";

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
// 环境感知正控（issue: CI 无 pi 时硬编码 true 必红）：本机真有 pi 就必须验真正控，
// 不许删；CI/无 pi 环境如实按探测结果断言 false/unknown，不许无条件跳过整条断言。
// 非 true 分支额外断言「落在合法三态之内 + 带 reason」，防止真回归伪装成「环境缺失」溜过去
// ——纯粹接受任意值等于没断言，那不是「环境感知」，是「关掉了这条正控」。
{
  const piResult = probePi();
  if (piResult.available === true) {
    assert.equal(piResult.available, true, "本机探测到 pi 时 probePi() 必须判 available=true（真机正控）");
  } else {
    assert.ok(piResult.available === false || piResult.available === "unknown",
      `CI/无 pi 环境下 probePi().available 必须落在 false/unknown 二态之一，实际=${JSON.stringify(piResult.available)}`);
    assert.ok(typeof piResult.reason === "string" && piResult.reason.length > 0,
      `非 true 判定必须带 reason 留痕（不许静默无理由通过），实际=${JSON.stringify(piResult)}`);
  }
}

assert.equal(summarize({ orca: { available: "unknown" } }, { pi: { available: true }, claude: { available: false }, codex: { available: "unknown" } }), "fabric=orca? agents=pi✓,claude✗,codex?");

// ── issue #409 第 1 项：缓存落盘 + SessionStart 刷新钩子（跨工兵冻结常量见 issue 正文 §二）──
// 全程 env 覆盖把落点指到 os.tmpdir() 下的临时目录，**不许往真 HOME 写**。
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "dao-roster-tests-"));

// rosterCachePath()：env 覆盖生效。
{
  const custom = path.join(TMP_ROOT, "custom-cache.json");
  const prev = process.env.DAO_ROSTER_CACHE;
  process.env.DAO_ROSTER_CACHE = custom;
  assert.equal(rosterCachePath(), custom, "DAO_ROSTER_CACHE 设了就必须原样生效");
  if (prev === undefined) delete process.env.DAO_ROSTER_CACHE; else process.env.DAO_ROSTER_CACHE = prev;
}

// rosterCachePath()：默认公式 = HOME/.claude/dao-roster-cache.json（不写盘，只比对字符串，
// 所以哪怕算出来的是真 HOME 也安全——这条只断言公式，不落地）。
{
  assert.equal(process.env.DAO_ROSTER_CACHE, undefined, "本条断言默认公式前必须确认 env 覆盖已清空");
  const home = process.env.USERPROFILE || process.env.HOME || os.homedir();
  assert.equal(rosterCachePath(), path.join(home, ".claude", "dao-roster-cache.json"));
}

// writeRosterCache()：mkdir -p 语义（目标目录不存在也能落盘）+ 内容原样 JSON、不加包装层。
{
  const nested = path.join(TMP_ROOT, "nested", "dir", "cache.json");
  const fakeRoster = { at: new Date().toISOString(), fabric: { orca: { available: true } }, agents: {}, summary: "x" };
  writeRosterCache(fakeRoster, nested);
  const onDisk = JSON.parse(fs.readFileSync(nested, "utf8"));
  assert.deepEqual(onDisk, fakeRoster, "缓存内容必须是 buildRoster() 返回对象原样 JSON，不加包装层");
}

// writeRosterCache()：temp+rename 落盘后目录里不残留临时文件（W3 换家对抗审 O1）。
// 只断言「写完之后目录是干净的」，不 mock fs.renameSync——mock 掉正是要验证的那个原子操作，
// 断言会变成守着近似物的假安心。
{
  const dir = path.join(TMP_ROOT, "no-leftover-dir");
  const target = path.join(dir, "cache.json");
  const fakeRoster = { at: new Date().toISOString(), fabric: {}, agents: {}, summary: "y" };
  writeRosterCache(fakeRoster, target);
  const entries = fs.readdirSync(dir);
  assert.deepEqual(entries, ["cache.json"], `落盘后目录不许残留临时文件，实际：${JSON.stringify(entries)}`);
}

// ── SessionStart 刷新钩子（ccswitch/hooks/dao-roster-refresh.js）──

// 指针必须配一道会红的闸：rosterScriptPath() 指向的文件必须真实存在。
// 这条不许 mock ——它守的正是「钩子解析 scripts/dao-roster.mjs 的路径」这根指针本身。
assert.ok(fs.existsSync(refreshHook.rosterScriptPath()),
  `rosterScriptPath() 指向的文件不存在：${refreshHook.rosterScriptPath()}（指针断了，钩子会静默刷不了缓存）`);
// 且它确实指到 scripts/dao-roster.mjs，不是随便一个存在的文件。
assert.equal(path.basename(refreshHook.rosterScriptPath()), "dao-roster.mjs");

// cachePath()/ttlMs()：默认公式与 env 覆盖，各自独立于 mjs 那份重新实现（issue #409 §二硬约束）。
{
  assert.equal(process.env.DAO_ROSTER_CACHE, undefined);
  const home = process.env.USERPROFILE || process.env.HOME || os.homedir();
  assert.equal(refreshHook.cachePath(), path.join(home, ".claude", "dao-roster-cache.json"));
  assert.equal(refreshHook.ttlMs(), 2 * 60 * 60 * 1000, "默认 TTL 必须是冻结的 2 小时");

  const prevCache = process.env.DAO_ROSTER_CACHE;
  const prevTtl = process.env.DAO_ROSTER_TTL_MS;
  process.env.DAO_ROSTER_CACHE = path.join(TMP_ROOT, "env-cache.json");
  process.env.DAO_ROSTER_TTL_MS = "1234";
  assert.equal(refreshHook.cachePath(), path.join(TMP_ROOT, "env-cache.json"));
  assert.equal(refreshHook.ttlMs(), 1234);
  if (prevCache === undefined) delete process.env.DAO_ROSTER_CACHE; else process.env.DAO_ROSTER_CACHE = prevCache;
  if (prevTtl === undefined) delete process.env.DAO_ROSTER_TTL_MS; else process.env.DAO_ROSTER_TTL_MS = prevTtl;
}

// isFresh()：三态——新鲜 / 过期 / 缺失或坏掉，且两端（TTL 边界）都验。
{
  const freshFile = path.join(TMP_ROOT, "fresh.json");
  fs.writeFileSync(freshFile, JSON.stringify({ at: new Date().toISOString() }));
  assert.equal(refreshHook.isFresh(freshFile, 2 * 60 * 60 * 1000, fs), true);

  const staleFile = path.join(TMP_ROOT, "stale.json");
  const staleAt = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(); // 3 小时前，TTL 2 小时
  fs.writeFileSync(staleFile, JSON.stringify({ at: staleAt }));
  assert.equal(refreshHook.isFresh(staleFile, 2 * 60 * 60 * 1000, fs), false);

  assert.equal(refreshHook.isFresh(path.join(TMP_ROOT, "does-not-exist.json"), 999999, fs), false, "缺失文件必须判不新鲜");

  const badFile = path.join(TMP_ROOT, "bad.json");
  fs.writeFileSync(badFile, "{not json");
  assert.equal(refreshHook.isFresh(badFile, 999999, fs), false, "解析失败必须判不新鲜，不许当异常往外抛");

  const noAtFile = path.join(TMP_ROOT, "no-at.json");
  fs.writeFileSync(noAtFile, JSON.stringify({ fabric: {} }));
  assert.equal(refreshHook.isFresh(noAtFile, 999999, fs), false, "无 at 字段必须判不新鲜");
}

// run()：两态，用注入的假 spawn，绝不真起进程。
{
  const freshFile = path.join(TMP_ROOT, "run-fresh.json");
  fs.writeFileSync(freshFile, JSON.stringify({ at: new Date().toISOString() }));
  let spawnCalls = 0;
  const fakeSpawn = () => { spawnCalls++; return { unref() {} }; };
  const skipResult = refreshHook(({ cachePath: freshFile, ttlMs: 2 * 60 * 60 * 1000, spawn: fakeSpawn }));
  assert.equal(skipResult.action, "skip-fresh");
  assert.equal(spawnCalls, 0, "缓存新鲜时绝不许起子进程");

  const staleFile = path.join(TMP_ROOT, "run-stale.json");
  fs.writeFileSync(staleFile, JSON.stringify({ at: new Date(Date.now() - 999999999).toISOString() }));
  let spawnArgs = null;
  const fakeSpawn2 = (cmd, args, opts) => { spawnArgs = { cmd, args, opts }; return { unref() {} }; };
  const spawnResult = refreshHook({ cachePath: staleFile, ttlMs: 1, spawn: fakeSpawn2 });
  assert.equal(spawnResult.action, "spawned");
  assert.ok(spawnArgs, "缓存过期时必须起后台子进程");
  assert.equal(spawnArgs.args[0], refreshHook.rosterScriptPath(), "子进程必须跑 dao-roster.mjs");
  assert.equal(spawnArgs.opts.detached, true, "必须 detached，钩子进程退出不许拖着子进程一起死");
  assert.equal(spawnArgs.opts.stdio, "ignore", "不许同步等子进程的输出");

  // 指针指到不存在的脚本时安静跳过，不许硬起一个必然失败的子进程。
  let spawnCalls3 = 0;
  const skipMissingResult = refreshHook({
    cachePath: staleFile, ttlMs: 1, spawn: () => { spawnCalls3++; return { unref() {} }; },
    scriptPath: path.join(TMP_ROOT, "no-such-roster.mjs"),
  });
  assert.equal(skipMissingResult.action, "skip-missing-script");
  assert.equal(spawnCalls3, 0);
}

fs.rmSync(TMP_ROOT, { recursive: true, force: true });

console.log("dao-roster tests: 34 passed");
