// dao-roster-refresh.js — SessionStart hook：开窗时把 dao-roster 缓存续新鲜（issue #409 第 1 项）。
//
// 改这个文件前必须知道的两条：
//
// 1. **这条挂在 SessionStart 上，预算是每次开窗都要还的债**（见
//    `.claude/rules/hooks-deployment.md` 的 SessionStart 超时预算表：串行叠加，当前总预算 20s）。
//    而 `scripts/dao-roster.mjs` 探测多个 CLI，最坏要几十秒。两条对不上，所以本钩子自己绝不
//    同步跑探测：缓存新鲜 ⇒ 什么都不做直接退出；缓存过期/缺失 ⇒ 用 detached+unref 的后台子
//    进程去跑 dao-roster.mjs，本钩子自己立刻退出，不等子进程结束、不读它的输出。
// 2. **缓存路径与新鲜度公式是 issue #409 §二冻结的跨工兵常量**，与 `scripts/dao-roster.mjs`
//    的 `rosterCachePath()`、`ccswitch/hooks/dao-dispatch-gate.js` 各自独立实现同一条公式——
//    三处不互相 import（mjs/cjs 模块系统不同，硬约束不是偷懒）。改这条公式必须三处同改。
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const childProcess = require("child_process");

function homeDir() {
  return process.env.USERPROFILE || process.env.HOME || os.homedir();
}

function cachePath() {
  return process.env.DAO_ROSTER_CACHE || path.join(homeDir(), ".claude", "dao-roster-cache.json");
}

function ttlMs() {
  return Number(process.env.DAO_ROSTER_TTL_MS) || 2 * 60 * 60 * 1000; // 2 小时
}

// dao-roster.mjs 的绝对路径，从本文件的 __dirname 推导（不是写死的相对字符串），
// 这样 ccswitch/hooks/ 或 scripts/ 但凡有一层被挪动，这条推导会跟着断——
// 断了的表现是 existsSync 为 false，测试里有一条断言专门守这一格（指针配一道会红的闸）。
function rosterScriptPath() {
  return path.join(__dirname, "..", "..", "scripts", "dao-roster.mjs");
}

// 新鲜 = 缓存存在、可解析、带 at 字段，且 now - at <= TTL。
// 缺失 / 解析失败 / 无 at / 时间戳解析不出来，一律判「不新鲜」——宁可多刷新一次，
// 不因为缓存本身就是坏的而永远跳过刷新。
function isFresh(cachePathValue, ttl, fsImpl) {
  const impl = fsImpl || fs;
  let raw;
  try {
    raw = impl.readFileSync(cachePathValue, "utf8");
  } catch (_e) {
    return false;
  }
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (_e) {
    return false;
  }
  const at = doc && doc.at;
  if (!at) return false;
  const ts = Date.parse(at);
  if (Number.isNaN(ts)) return false;
  return Date.now() - ts <= ttl;
}

// 主逻辑，全部依赖可注入（测试用假 spawn/假 fs，不真起进程、不碰真 HOME）。
// 返回值只供测试断言用，钩子真跑时不消费返回值。
function run(opts) {
  const o = opts || {};
  const fsImpl = o.fs || fs;
  const spawnFn = o.spawn || childProcess.spawn;
  const cache = o.cachePath || cachePath();
  const ttl = o.ttlMs != null ? o.ttlMs : ttlMs();
  const scriptPath = o.scriptPath || rosterScriptPath();

  if (isFresh(cache, ttl, fsImpl)) {
    return { action: "skip-fresh" };
  }
  if (!fsImpl.existsSync(scriptPath)) {
    // 指针指到了不存在的文件：没法刷新，也没法假装刷新了。安静跳过——
    // 这一格本身已经被测试里的真实 existsSync 断言守住，钩子运行时不重复报警吵关。
    return { action: "skip-missing-script" };
  }
  try {
    const child = spawnFn(process.execPath, [scriptPath], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    return { action: "spawned" };
  } catch (e) {
    return { action: "spawn-failed", error: e };
  }
}

module.exports = run;
module.exports.cachePath = cachePath;
module.exports.ttlMs = ttlMs;
module.exports.rosterScriptPath = rosterScriptPath;
module.exports.isFresh = isFresh;

if (require.main === module) {
  run();
  process.exit(0);
}
