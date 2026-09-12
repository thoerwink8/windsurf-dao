// dao-check ㉠：测试结构性够不着真执行体（#1152）
//
// 来历（2026-09-08 实咬）：tests/dispatch-launch.test.js 与 dao-dispatch-gate.test.js
// 对 `dao.mjs dispatch --issue 565` 真 spawn。denylist（看见测试信号才拦）放行
// 瘦 env 子进程 → 14+ 个已关单 #565 真会话、嵌套 dao-565 树、烧 grok 额度。
//
// 2026-09-12 帅位介入：用静态分析判定任意 JS 能否 spawn 是停机问题，16 轮补正则
// 没有收敛。本闸改 allowlist + 接线，退役源码扫描器。
//
// 检查三面（都不解析测试 JS 语法）：
//   1. 判官判别力：红夹具必须拦、绿夹具必须放、空=没查成。
//   2. 生产接线：ensureWorkspace / startSession / cmdDispatchMirasim / cmdStartMirasim
//      / cmdWorktreeCreateMirasim 都要在真 IO 前过隔离判官；判官必须是 allowlist
//      （空 env 拦，DAO_REAL_EXECUTOR 才放，测试信号不能选择加入）。
//   3. 生产入口打旗：指挥官 runCmd 给子进程 DAO_REAL_EXECUTOR=1；systemd 模板同样声明。
//
// 检查器自持字符串切片，不 import 被测测试。夹具判别调用 judge（纯函数）。
// 扫完 0 个测试文件 = 没查成。故意样本必须是 .json（env 快照），不许 *.js。

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { judgeTestExecutorIsolation } from './mirasim-runtime.mjs';

const JSON_FILE = /\.json$/i;
const JS_FILE = /\.[cm]?js$/i;

function sliceFn(src, startMark, endMark) {
  const a = String(src || '').indexOf(startMark);
  if (a < 0) return '';
  const b = String(src || '').indexOf(endMark, a + startMark.length);
  return b < 0 ? src.slice(a) : src.slice(a, b);
}

function listKindFiles(dir) {
  try { return readdirSync(dir).filter((f) => !f.startsWith('.')); }
  catch { return []; }
}

function readEnvFixture(path) {
  const raw = readFileSync(path, 'utf8');
  const doc = JSON.parse(raw);
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new Error('夹具必须是 env 对象 JSON');
  }
  return doc;
}

/**
 * 红/绿/空夹具验判别力。红=必须拦；绿=必须放行；空目录证明「没查成」通道还在。
 */
export function inspectTestExecutorIsolationFixtures(root) {
  if (!root) return { ok: false, unscanned: true, error: '没给样本根目录', kinds: { red: 0, ok: 0, empty: 0 } };
  if (!existsSync(root)) {
    return { ok: false, unscanned: true, error: `样本目录不在：${root}`, kinds: { red: 0, ok: 0, empty: 0 } };
  }
  const kinds = { red: 0, ok: 0, empty: 0 };
  const problems = [];
  const requiredRed = { 'env-lost': false, 'test-cannot-opt-in': false };
  let productionOk = false;

  for (const kind of ['red', 'ok', 'empty']) {
    const dir = join(root, kind);
    if (!existsSync(dir)) {
      problems.push(`缺 ${kind}/`);
      continue;
    }
    const names = listKindFiles(dir);
    const executable = names.filter((f) => JS_FILE.test(f));
    if (executable.length) {
      problems.push(`${kind}/ 有可执行 JS ${executable.join('、')}：故意样本必须是 .json`);
      continue;
    }
    if (kind === 'empty') {
      const r = inspectIsolationWiring({});
      if (!r.unscanned) problems.push('empty 没标没查成');
      else kinds.empty += 1;
      continue;
    }
    const files = names.filter((f) => JSON_FILE.test(f));
    if (files.length === 0) {
      problems.push(`${kind}: 0 个样本——没查成`);
      continue;
    }
    for (const name of files) {
      const path = join(dir, name);
      let env;
      try { env = readEnvFixture(path); }
      catch (e) {
        problems.push(`${kind}/${name} 读不了：${e && e.message ? e.message : e}`);
        continue;
      }
      const verdict = judgeTestExecutorIsolation(env);
      if (kind === 'red') {
        if (verdict.ok) problems.push(`${kind}/${name} 该拦却放行：${verdict.why || ''}`);
        else {
          kinds.red += 1;
          if (name.startsWith('env-lost')) requiredRed['env-lost'] = true;
          if (name.startsWith('test-cannot-opt-in')) requiredRed['test-cannot-opt-in'] = true;
        }
      } else if (kind === 'ok') {
        if (!verdict.ok) problems.push(`${kind}/${name} 该放行却拦：${verdict.error || verdict.why || ''}`);
        else {
          kinds.ok += 1;
          if (name.startsWith('production')) productionOk = true;
        }
      }
    }
  }
  if (!requiredRed['env-lost']) problems.push('红夹具必须有 env-lost（瘦 env / 空 env 当场拦）');
  if (!requiredRed['test-cannot-opt-in']) problems.push('红夹具必须有 test-cannot-opt-in（测试信号下 DAO_REAL_EXECUTOR 也不能加入）');
  if (!productionOk) problems.push('绿夹具必须有 production（仅 DAO_REAL_EXECUTOR=1 放行）');
  if (kinds.red < 1 || kinds.ok < 1 || kinds.empty < 1) {
    problems.push(`红/绿/空要各至少 1，实际 ${kinds.red}/${kinds.ok}/${kinds.empty}`);
  }
  return { ok: problems.length === 0, unscanned: false, kinds, error: problems.join('；'), problems };
}

/**
 * 生产接线：隔离判官必须在真 IO 之前，且是 allowlist。
 * 不 import 被测测试——自己切函数块、自己数调用。
 */
export function inspectIsolationWiring({ runtimeSrc, daoSrc, executionSrc, commanderSrc, unitSrc } = {}) {
  if (runtimeSrc == null && daoSrc == null && executionSrc == null && commanderSrc == null && unitSrc == null) {
    return { ok: false, unscanned: true, error: '没给接线正文（没查成）', problems: [] };
  }
  const problems = [];
  if (runtimeSrc == null) problems.push('没给 mirasim-runtime.mjs 正文（没查成函数块）');
  else {
    if (!/export function judgeTestExecutorIsolation\(/.test(runtimeSrc)) {
      problems.push('mirasim-runtime 缺导出 judgeTestExecutorIsolation');
    }
    if (!/DAO_REAL_EXECUTOR/.test(runtimeSrc)) {
      problems.push('隔离判官没读 DAO_REAL_EXECUTOR（allowlist 旗标）');
    }
    if (!/missing-DAO_REAL_EXECUTOR/.test(runtimeSrc)) {
      problems.push('隔离判官空 env 没有 missing-DAO_REAL_EXECUTOR 这条默认拦');
    }
    if (/why: 'no-test-signal'/.test(runtimeSrc)) {
      problems.push('隔离判官还在 denylist：空 env 走 no-test-signal 放行');
    }
    if (!/NODE_TEST_CONTEXT/.test(runtimeSrc)) {
      problems.push('隔离判官没读 NODE_TEST_CONTEXT');
    }
    if (!/DAO_DISPATCH_NO_SPAWN/.test(runtimeSrc)) {
      problems.push('隔离判官没读 DAO_DISPATCH_NO_SPAWN');
    }
    const ensure = sliceFn(runtimeSrc, 'async function ensureWorkspace(', 'async function startSession(');
    const start = sliceFn(runtimeSrc, 'async function startSession(', 'async function readSession(');
    if (!ensure) problems.push('找不到 ensureWorkspace（没查成函数块）');
    else {
      const iso = ensure.indexOf('judgeTestExecutorIsolation(');
      const open = ensure.indexOf('await open()');
      if (iso < 0) problems.push('ensureWorkspace 没过隔离闸');
      else if (open >= 0 && iso > open) problems.push('ensureWorkspace 隔离闸必须在 open() 前');
    }
    if (!start) problems.push('找不到 startSession（没查成函数块）');
    else {
      const iso = start.indexOf('judgeTestExecutorIsolation(');
      const open = start.indexOf('await open()');
      if (iso < 0) problems.push('startSession 没过隔离闸');
      else if (open >= 0 && iso > open) problems.push('startSession 隔离闸必须在 open() 前');
    }
  }
  if (daoSrc == null) problems.push('没给 dao.mjs 正文（没查成函数块）');
  else {
    const mira = sliceFn(daoSrc, 'async function cmdDispatchMirasim(', 'async function cmdDispatch(');
    if (!mira) problems.push('找不到 cmdDispatchMirasim（没查成函数块）');
    else {
      const iso = mira.indexOf('judgeTestExecutorIsolation(');
      const ens = mira.indexOf('ensureWorkspace(');
      if (iso < 0) problems.push('cmdDispatchMirasim 没过隔离闸');
      else if (ens < 0) problems.push('cmdDispatchMirasim 找不到 ensureWorkspace');
      else if (iso > ens) problems.push('cmdDispatchMirasim 隔离闸必须在 ensureWorkspace 前');
    }
    const start = sliceFn(daoSrc, 'async function cmdStartMirasim(', 'async function cmdSessionRead(');
    if (!start) problems.push('找不到 cmdStartMirasim（没查成函数块）');
    else {
      const iso = start.indexOf('judgeTestExecutorIsolation(');
      const ens = start.indexOf('ensureWorkspace(');
      if (iso < 0) problems.push('cmdStartMirasim 没过隔离闸');
      else if (ens < 0) problems.push('cmdStartMirasim 找不到 ensureWorkspace');
      else if (iso > ens) problems.push('cmdStartMirasim 隔离闸必须在 ensureWorkspace 前');
    }
    const wt = sliceFn(daoSrc, 'async function cmdWorktreeCreateMirasim(', 'function cmdLedgerQuery(');
    if (!wt) problems.push('找不到 cmdWorktreeCreateMirasim（没查成函数块）');
    else {
      const iso = wt.indexOf('judgeTestExecutorIsolation(');
      const create = wt.indexOf('worktreeCreate(');
      if (iso < 0) problems.push('cmdWorktreeCreateMirasim 没过隔离闸');
      else if (create < 0) problems.push('cmdWorktreeCreateMirasim 找不到 worktreeCreate');
      else if (iso > create) problems.push('cmdWorktreeCreateMirasim 隔离闸必须在 worktreeCreate 前');
    }
  }
  if (executionSrc == null) problems.push('没给 execution-runtime.mjs 正文（没查成函数块）');
  else {
    if (!/judgeTestExecutorIsolation\(/.test(executionSrc)) {
      problems.push('execution-runtime 没过隔离闸（git 建树路径会绕开 mirasim-runtime）');
    }
    const ens = sliceFn(executionSrc, 'ensureWorkspace:async(repo,branch)=>{', 'interact:async(');
    if (!ens) problems.push('找不到 execution-runtime ensureWorkspace');
    else if (!/assertExecutorIsolation\(/.test(ens)) {
      problems.push('execution-runtime ensureWorkspace 没过隔离闸');
    }
    const start = sliceFn(executionSrc, 'async function startSession(spec) {', 'async function readSession(');
    if (!start) problems.push('找不到 execution-runtime startSession');
    else if (!/assertExecutorIsolation\(/.test(start)) {
      problems.push('execution-runtime startSession 没过隔离闸');
    }
  }
  if (commanderSrc == null) problems.push('没给 commander.mjs 正文（没查成函数块）');
  else {
    const runCmd = sliceFn(commanderSrc, 'export function runCmd(', 'export function parseDaoResult(');
    if (!runCmd) problems.push('找不到 runCmd（没查成函数块）');
    else if (!/DAO_REAL_EXECUTOR/.test(runCmd)) {
      problems.push('指挥官 runCmd 没给子进程打 DAO_REAL_EXECUTOR');
    }
  }
  if (unitSrc == null) problems.push('没给指挥官 systemd 模板正文（没查成）');
  else if (!/Environment=DAO_REAL_EXECUTOR=1/.test(unitSrc)) {
    problems.push('指挥官 systemd 模板没声明 Environment=DAO_REAL_EXECUTOR=1');
  }
  return { ok: problems.length === 0, unscanned: false, problems };
}

/**
 * live：tests/ 下要有测试文件（0 套 = 没查成）。真 spawn 靠运行时 allowlist 拦，
 * 不再静态解析 JS。
 */
export function inspectTestExecutorIsolationLive({ dir, readdir } = {}) {
  if (!dir || typeof readdir !== 'function') {
    return { ok: false, unscanned: true, error: '没给 tests 目录或 readdir（没查成）', scanned: 0, violations: [] };
  }
  let names;
  try { names = readdir(dir); }
  catch (e) {
    return { ok: false, unscanned: true, error: `读 tests/ 失败：${e && e.message ? e.message : e}`, scanned: 0, violations: [] };
  }
  const tests = (names || []).filter((f) => /\.test\.(js|mjs|cjs)$/i.test(f));
  if (tests.length === 0) {
    return { ok: false, unscanned: true, error: '扫到 0 个测试文件（没查成，不是没有真派工）', scanned: 0, violations: [] };
  }
  return { ok: true, unscanned: false, scanned: tests.length, violations: [] };
}
