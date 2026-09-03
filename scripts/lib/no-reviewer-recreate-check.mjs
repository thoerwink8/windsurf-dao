// dao-check ㉕：删掉「审官死了/结算后再造卡、换厂」整层。
// 检查器自己持有正则，不 import dao-cmd 的解析——自己查自己查不出错。
// 扫完 0 条违规 ≠ 没扫成：没给正文 / 找不到函数块 = unscanned。
// #807 起 flow.mjs 已删（本机守卫栈退役），本检查只剩 dao.mjs 半边；#857 返工把 flow 半边一并清掉。

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const NEXT_IN_DONE = /nextReviewerAfter/;

function chunk(src, re) {
  const m = String(src || '').match(re);
  return m ? m[0] : '';
}

/** 扫 worker-done 还在不在造第二张审官/换厂。不读被查对象自己的函数。 */
export function inspectNoReviewerRecreate({ daoSrc } = {}) {
  if (daoSrc == null) return { ok: false, unscanned: true, error: '没给 dao.mjs 正文（没查成）' };
  const problems = [];
  const done = chunk(daoSrc, /function cmdWorkerDone\b[\s\S]*?\nfunction /);
  if (!done) problems.push('找不到 cmdWorkerDone（没查成函数块）');
  else if (NEXT_IN_DONE.test(done)) problems.push('worker-done 仍调 nextReviewerAfter 换厂');
  return { ok: problems.length === 0, unscanned: false, problems };
}

export function inspectNoReviewerRecreateFixtures(root) {
  if (!root) return { ok: false, unscanned: true, error: '没给样本根目录' };
  if (!existsSync(root)) return { ok: false, unscanned: true, error: `样本目录不在：${root}` };
  const kinds = { red: 0, ok: 0, empty: 0 };
  const problems = [];

  function bundle(dir) {
    const dao = join(dir, 'dao.mjs');
    return {
      daoSrc: existsSync(dao) ? readFileSync(dao, 'utf8') : null,
    };
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
      const r = inspectNoReviewerRecreate({});
      if (!r.unscanned) problems.push('empty 没标没查成');
      else kinds.empty += 1;
      continue;
    }
    if (files.length === 0) {
      problems.push(`${kind}: 0 个样本——没查成`);
      continue;
    }
    const r = inspectNoReviewerRecreate(bundle(dir));
    if (kind === 'red') {
      if (r.unscanned || r.ok) problems.push('red/ 自称该红但扫不到再造/换厂');
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
