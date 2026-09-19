// scripts/lib/conformance.mjs —— T37 ③：跨仓符合性检查的纯判据（本仓读子仓）。
//
// 起因：用户 2026-09-19「本仓和子仓不应该完全相同，但很多其实应该遵守吧」→ 三原则
// （共性做默认、个性留空间、豁免要留痕）。本仓是约定的唯一真相源（host/conventions/），
// 子仓只拿副本；**本仓无法单方面强制**，所以这里只出「三态报告」，硬手段是 fleet 拒派（T37 ④）。
//
// 三态必须分得开：
//   · 取不到（网络/权限失败）→ unscanned；
//   · 文件**确定不存在**（404）→ 红（未接，不是没查成）；
//   · 块在但戳对不上 → 红（判据复用 kit/conventions-core.mjs，不在这边重写一遍）。
//
// 本模块只做判断，不碰网络。取数在 scripts/conformance.mjs，便于单测。

import { judgeConventions, parseConventionBlock, parseExemptions } from '../../host/conventions/kit/conventions-core.mjs';

export const MUST_ITEMS = Object.freeze(['convention-block']);

/**
 * 判一个子仓。
 * @param {object} input
 * @param {object} input.repo   child-repos.json 里的一条（fullName / must / exempt）
 * @param {object|null} input.sample 已取到的样本：{ docText, docPath, docAbsent, docError, pin, pinAbsent, pinError }
 * @param {number} [input.expectedVersion] 真相源版本（落后即红）
 * @returns {{fullName:string, state:'green'|'red'|'unscanned', code:string, why:string}}
 */
export function judgeRepo({ repo, sample, expectedVersion } = {}) {
  const fullName = (repo && repo.fullName) || '(未命名)';
  const exempt = Array.isArray(repo && repo.exempt) ? repo.exempt : [];
  const skip = exempt.find((e) => e && e.item === 'convention-block');
  if (skip) {
    // 豁免必须带理由（C2）——没理由的豁免不算豁免，继续往下判。
    if (typeof skip.reason === 'string' && skip.reason.trim()) {
      return { fullName, state: 'green', code: 'exempt', why: `已豁免 convention-block：${skip.reason.trim()}` };
    }
  }
  if (!sample) return { fullName, state: 'unscanned', code: 'no-sample', why: '样本没取到（取不到 ≠ 没接）' };
  if (sample.docError) return { fullName, state: 'unscanned', code: 'fetch-failed', why: `取 AGENTS.md/CLAUDE.md 失败：${sample.docError}` };
  if (sample.docAbsent || !sample.docText) {
    return { fullName, state: 'red', code: 'no-doc', why: '没有 AGENTS.md / CLAUDE.md——未接约定脊柱（确定不存在，不是没查成）' };
  }
  // 先判块在不在（子仓有 doc 但没贴块，是最常见的一档——报「没 pin」会指错地方）。
  if (!parseConventionBlock(sample.docText).found) {
    return { fullName, state: 'red', code: 'no-block', why: '有 AGENTS.md/CLAUDE.md 但没有约定块（`<!-- dao-conventions: vN sha256:… -->`）——未接约定脊柱' };
  }
  if (sample.pinError) return { fullName, state: 'unscanned', code: 'pin-fetch-failed', why: `取 .dao/conventions.json 失败：${sample.pinError}` };
  if (sample.pinAbsent || !sample.pin) {
    return { fullName, state: 'red', code: 'no-pin', why: '没有 .dao/conventions.json——块与 pin 缺一不可（子仓没抄真相源的版本戳）' };
  }
  const v = judgeConventions({
    block: parseConventionBlock(sample.docText),
    pin: sample.pin,
    exemptions: parseExemptions(sample.docText),
    expectedVersion,
  });
  return { fullName, state: v.state, code: v.code || 'ok', why: v.why };
}

/**
 * 判整份报告。
 * @param {{repos:unknown, samples:object, expectedVersion?:number}} input
 *   samples: { [fullName]: sample }；缺失的仓按 unscanned 处置。
 * @returns {{state:'green'|'red'|'unscanned', perRepo:object[], counts:object, why:string}}
 */
export function judgeConformance({ repos, samples, expectedVersion } = {}) {
  if (!Array.isArray(repos)) {
    return { state: 'unscanned', perRepo: [], counts: {}, why: '子仓清单没读到（取不到 ≠ 没有子仓）' };
  }
  if (!repos.length) {
    return { state: 'unscanned', perRepo: [], counts: {}, why: '子仓清单是空的——取不到 ≠ 没有子仓，先看 child-repos.json' };
  }
  const bag = samples && typeof samples === 'object' ? samples : {};
  const perRepo = repos.map((r) => judgeRepo({ repo: r, sample: bag[r && r.fullName] || null, expectedVersion }));
  const counts = { green: 0, red: 0, unscanned: 0 };
  for (const p of perRepo) counts[p.state] += 1;
  const state = counts.red ? 'red' : counts.unscanned ? 'unscanned' : 'green';
  const bad = perRepo.filter((p) => p.state !== 'green').map((p) => `${p.fullName}(${p.code})`);
  const why = state === 'green'
    ? `${perRepo.length} 个子仓全部符合`
    : `${counts.green}/${perRepo.length} 符合：${bad.slice(0, 5).join('、')}`;
  return { state, perRepo, counts, why };
}
