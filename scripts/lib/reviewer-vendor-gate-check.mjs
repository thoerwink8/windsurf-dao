// dao-check ㉔（#679）：起审官同厂硬闸还在。
// 2026-08-23 delete-all-ceremony 拍板：dispatch 预检的同厂闸已删（审官不存在时查空气），
// 闸只钉在审官真正落地的路径：reviewer-create / reviewer-attach / worker-done / 换人。
// 检查器自己持有正则，不 import reviewer-vendor-gate.mjs——自己查自己查不出错。

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const GATE_CALL = /assertCrossVendor\s*\(/;
const REFUSE_CALL = /refuseIfSameVendor\s*\(/;
const NEXT_WORKER = /nextReviewerAfter\s*\([\s\S]{0,240}workerId/;
const CAP_WORKER = /planCapacitySwitch\s*\([\s\S]{0,240}workerId/;
const WD_ACTUAL = /resolveActualWorkerModel\s*\(/;
const WD_CARD = /parseWorkerModelFromCard/;

function chunk(src, re) {
  const m = String(src || '').match(re);
  return m ? m[0] : '';
}

/** #680：审官路径不得写死 forceCommand 起 GPT。检查器自己扫函数块，不 import dao-cmd。 */
export function inspectReviewerNoForceCommand({ daoSrc } = {}) {
  if (daoSrc == null) return { ok: false, unscanned: true, error: '没给 dao.mjs 正文（没查成）' };
  const create = chunk(daoSrc, /function cmdReviewerCreate\b[\s\S]*?\nfunction /);
  const attach = chunk(daoSrc, /function cmdReviewerAttach\b[\s\S]*?\nfunction /);
  const problems = [];
  if (!create) problems.push('找不到 cmdReviewerCreate');
  else if (/forceCommand/.test(create)) problems.push('cmdReviewerCreate 仍写 forceCommand');
  if (!attach) problems.push('找不到 cmdReviewerAttach');
  else if (/forceCommand/.test(attach)) problems.push('cmdReviewerAttach 仍写 forceCommand');
  return { ok: problems.length === 0, unscanned: false, problems };
}

export function inspectVendorGateWiring({ daoSrc, cmdSrc, slotSrc, watchdogSrc } = {}) {
  if (daoSrc == null || cmdSrc == null || slotSrc == null || watchdogSrc == null) {
    return { ok: false, unscanned: true, error: '没给齐 dao/dao-cmd/slot/watchdog 正文（没查成）' };
  }
  const problems = [];
  // dispatch 预检不再钉同厂闸（delete-all-ceremony）：cmdSrc 只要求 resolveDispatchConstraints 还在。
  const constraints = chunk(cmdSrc, /export function resolveDispatchConstraints\b[\s\S]*?\nexport function /);
  if (!constraints) problems.push('找不到 resolveDispatchConstraints');

  const create = chunk(daoSrc, /function cmdReviewerCreate\b[\s\S]*?\nfunction /);
  if (!create) problems.push('找不到 cmdReviewerCreate');
  else if (!REFUSE_CALL.test(create) && !GATE_CALL.test(create)) {
    problems.push('cmdReviewerCreate 没走同厂闸');
  }

  const attach = chunk(daoSrc, /function cmdReviewerAttach\b[\s\S]*?\nfunction /);
  if (!attach) problems.push('找不到 cmdReviewerAttach');
  else if (!REFUSE_CALL.test(attach) && !GATE_CALL.test(attach)) {
    problems.push('cmdReviewerAttach 没走同厂闸');
  }

  const done = chunk(daoSrc, /function cmdWorkerDone\b[\s\S]*?\nfunction /);
  if (!done) problems.push('找不到 cmdWorkerDone');
  else {
    if (!REFUSE_CALL.test(done) && !GATE_CALL.test(done)) problems.push('cmdWorkerDone 没走同厂闸');
    if (NEXT_WORKER.test(done)) problems.push('cmdWorkerDone 失败仍换厂（不许自动换厂）');
  }

  const nextFn = chunk(slotSrc, /export function nextReviewerAfter\b[\s\S]*?\nexport function /);
  if (!nextFn) problems.push('找不到 nextReviewerAfter');
  else if (!/workerId/.test(nextFn)) problems.push('nextReviewerAfter 不跳过工人那一厂');

  const capFn = chunk(slotSrc, /export function planCapacitySwitch\b[\s\S]*/);
  if (!capFn) problems.push('找不到 planCapacitySwitch');
  else if (!CAP_WORKER.test(capFn) && !/workerId/.test(capFn)) {
    problems.push('planCapacitySwitch 换人没带 workerId');
  }

  const exec = chunk(watchdogSrc, /function executeCapacitySwitch\b[\s\S]*?\nfunction /);
  if (!exec) problems.push('找不到 executeCapacitySwitch');
  else if (!WD_ACTUAL.test(exec)) problems.push('executeCapacitySwitch 没从 Dispatch/标签读实际工人模型');
  if (WD_CARD.test(watchdogSrc)) problems.push('watchdog 仍从卡名 parseWorkerModelFromCard 读工人模型');

  return { ok: problems.length === 0, unscanned: false, problems };
}

export function inspectVendorGateFixtures(root) {
  if (!root) return { ok: false, unscanned: true, error: '没给样本根目录' };
  if (!existsSync(root)) return { ok: false, unscanned: true, error: `样本目录不在：${root}` };
  const kinds = { red: 0, ok: 0, empty: 0 };
  const problems = [];

  function bundle(dir) {
    const files = {
      daoSrc: join(dir, 'dao.mjs'),
      cmdSrc: join(dir, 'dao-cmd.mjs'),
      slotSrc: join(dir, 'slot.mjs'),
      watchdogSrc: join(dir, 'watchdog.mjs'),
    };
    const out = {};
    let present = 0;
    for (const [k, p] of Object.entries(files)) {
      if (existsSync(p)) {
        out[k] = readFileSync(p, 'utf8');
        present += 1;
      } else out[k] = null;
    }
    return { present, ...out };
  }

  for (const kind of ['red', 'ok', 'empty']) {
    const dir = join(root, kind);
    if (!existsSync(dir)) {
      problems.push(`缺 ${kind}/`);
      continue;
    }
    const files = readdirSync(dir).filter(f => /\.(mjs|js|md|txt)$/i.test(f));
    if (kind === 'empty') {
      if (files.length !== 0) {
        problems.push('empty/ 应该 0 个样本（0 条 = 没查成）');
        continue;
      }
      const r = inspectVendorGateWiring({});
      if (!r.unscanned) problems.push('empty 没标没查成');
      else kinds.empty += 1;
      continue;
    }
    if (files.length === 0) {
      problems.push(`${kind}: 0 个样本——没查成`);
      continue;
    }
    const b = bundle(dir);
    const r = inspectVendorGateWiring(b);
    if (kind === 'red') {
      if (r.unscanned || r.ok) problems.push('red/ 自称该红但扫不到缺闸');
      else kinds.red += 1;
    }
    if (kind === 'ok') {
      if (r.unscanned) problems.push('ok/ 没查成');
      else if (!r.ok) problems.push(`ok/ 自称该绿但扫到：${(r.problems || []).join('；')}`);
      else kinds.ok += 1;
    }
  }

  if (kinds.red === 0 || kinds.ok === 0 || kinds.empty === 0) {
    return {
      ok: false,
      unscanned: true,
      error: `样本种类不够 red=${kinds.red} ok=${kinds.ok} empty=${kinds.empty}`,
      kinds,
      problems,
    };
  }
  if (problems.length) return { ok: false, unscanned: false, error: problems[0], kinds, problems };
  return { ok: true, unscanned: false, kinds };
}
