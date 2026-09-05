// tests/helpers/dao-harness.js —— dao CLI 回归套的共享前置
//
// 2026-09-06 从 dao.test.js（4220 行 / 1058 用例）拆出来：一个文件装下全仓 12% 的测试行，
// 既是最慢的一套，也让影响地图的粒度粗到「碰它依赖的任何文件都要跑 1058 条」。
// 前置抽到这里，各主题套 require 它，行为与拆分前逐字一致。

// 统一命令库 CLI 回归（issue #482）
//
// 验的层：①启动模板从表读、零硬编码、fail-loud
// ②验开工（有输出 / 无待确认）
// ③--help 参数存活（真 --help，禁 mock 内生）
// ④活性：文件 mtime + git 状态
// ⑤逃生口留痕
//
// 原三钉（封装层）：
//   1. 漏 -a never → 审官逐条卡确认
//   2. 用了不存在的 --submit
//   3. pi 界面 Working 一行，活证判据改走 mtime + git
// 规格重定义三钉（约束层，缺参数必须报错）：
//   4. merge-policy 默认 auto（#511：帅只感知不再是关口）；选 manual 必须给 --merge-reason
//   5. 缺 --model/--role（峰时误推 ds-flash：不给则只推荐、禁静默）
//   6. 缺 --reviewer（现建现起造成流转断点）
//   7. 手写 --model 偏离该工种（默认写码）顺位 1 也要 --confirm（#754，与 --role 同一条旗标）

const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

// 本文件在 tests/helpers/ 下，回仓根要上跳两级（拆分时这里少跳了一级，全套 ERR_MODULE_NOT_FOUND）
const REPO = path.resolve(__dirname, '..', '..');
const CLI = path.join(REPO, 'scripts', 'dao.mjs');
const LIB = path.join(REPO, 'scripts', 'lib', 'dao-cmd.mjs');
// 本套验 routing 兜底，不读本机真 Orca 文件。Orca 叠层在 tests/orca-agent-cmds.test.js。
process.env.ORCA_DATA_JSON = path.join(__dirname, "..", "fixtures", 'orca-agent-cmds', 'empty-overrides.json');
const S_LOAD = import('file://' + LIB.replace(/\\/g, '/'));

// ── 进程内跑 CLI（TIA 第二刀，2026-09-06）───────────────────────────────
// spawn 一次 `node dao.mjs` 要 ~225ms，进程内是 2ms——快 110 倍，而走的是同一条
// argv→输出，契约覆盖不减。返回形状**故意对齐 spawnSync**（status/stdout），
// 所以调用点的断言一个字都不用改。
//
// **只给「早退型」用**：参数校验、缺参、未知动词这类在做任何 I/O 之前就 emit 的路径。
// 会真建树/真发请求的动词仍旧 spawn——进程内跑它们会共享模块状态（dispatchResultSink 等），
// 测试之间互相污染，而每次 spawn 拿到的是干净进程。省下的那 200ms 不值这个风险。
const DAO_LOAD = import('file://' + CLI.replace(/\\/g, '/'));
async function cliInProc(args, env) {
  const dao = await DAO_LOAD;
  // env 覆盖：进程内没有独立环境，只能临时改再还原。**必须 finally 还原**，
  // 否则一条用例的 DAO_GH_FAKE 会漏给后面所有用例——spawn 时进程一退就干净，这里不会。
  const saved = env ? Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]])) : null;
  if (env) for (const [k, v] of Object.entries(env)) process.env[k] = v;
  try {
    const r = await dao.runCliInProcess(args);
    return { status: r.status, stdout: r.payload == null ? '' : JSON.stringify(r.payload), inProc: true };
  } finally {
    if (saved) for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}
const ROUTING_LOAD = S_LOAD.then(m => m.loadRouting());

// async-launch：dispatch 热路只受理，拒派/失败落 <id>.out.json。等执行体结果落盘。
function waitForOutJson(resultPath, { timeoutMs = 60000, stepMs = 250 } = {}) {
  if (!resultPath) return null;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (fs.existsSync(resultPath)) return JSON.parse(fs.readFileSync(resultPath, 'utf8'));
    } catch { /* 写一半的瞬态，下一轮再读 */ }
    const wait = Math.min(stepMs, Math.max(0, deadline - Date.now()));
    if (wait > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait);
  }
  return null;
}


module.exports = { assert, fs, os, path, spawnSync, REPO, CLI, LIB, S_LOAD, DAO_LOAD, cliInProc, ROUTING_LOAD, waitForOutJson };
