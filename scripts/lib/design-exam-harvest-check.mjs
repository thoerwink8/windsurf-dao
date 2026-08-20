// dao-check ㉓（#675）：盲考收卷纪律。起考轮自己盯产物收到完再说话。
// 检查器自己持有标记文本，不 import design-exam skill 的任何解析——自己查自己查不出错。

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export const HARVEST_MARKS = [
  '起灶的这一轮',
  'answer.md',
  '禁止起完等人问',
  '不把帅对话框',
];

export function harvestSlice(txt) {
  const m = /^##\s*收卷[^\n]*$/m.exec(String(txt || ''));
  if (!m) return '';
  const rest = String(txt).slice(m.index + m[0].length);
  const end = /^##\s+/m.exec(rest);
  return end ? rest.slice(0, end.index) : rest;
}

export function missingHarvestMarks(slice) {
  const s = String(slice || '');
  return HARVEST_MARKS.filter((mark) => !s.includes(mark));
}

export function inspectDesignExamHarvestLive({ skillSrc } = {}) {
  if (skillSrc == null) {
    return { ok: false, unscanned: true, error: '没给 design-exam SKILL 正文（没查成）' };
  }
  const slice = harvestSlice(skillSrc);
  if (!slice.trim()) {
    return { ok: false, unscanned: false, problems: ['design-exam 没有「## 收卷」节（指针失效）'] };
  }
  const missing = missingHarvestMarks(slice);
  if (missing.length) {
    return { ok: false, unscanned: false, problems: missing.map((m) => `收卷节缺「${m}」`) };
  }
  return { ok: true, unscanned: false, problems: [] };
}

export function inspectDesignExamHarvestFixtures(root) {
  if (!root) return { ok: false, unscanned: true, error: '没给样本根目录' };
  if (!existsSync(root)) {
    return { ok: false, unscanned: true, error: `样本目录不在：${root}` };
  }
  const kinds = { red: 0, ok: 0, empty: 0 };
  const problems = [];
  for (const kind of ['red', 'ok', 'empty']) {
    const dir = join(root, kind);
    if (!existsSync(dir)) { problems.push(`缺 ${kind}/`); continue; }
    const files = readdirSync(dir).filter((f) => /\.md$/i.test(f));
    if (kind === 'empty') {
      if (files.length !== 0) problems.push('empty/ 不该有样本（0 条才是没查成）');
      else kinds.empty += 1;
      continue;
    }
    if (files.length === 0) { problems.push(`${kind}: 0 个样本——没查成`); continue; }
    const texts = files.map((f) => readFileSync(join(dir, f), 'utf8'));
    const results = texts.map((txt) => inspectDesignExamHarvestLive({ skillSrc: txt }));
    if (kind === 'red') {
      const anyRed = results.some((r) => r.ok === false && !r.unscanned);
      if (!anyRed) problems.push('red/ 自称该红但扫不到违规（样本没判别力）');
      else kinds.red += 1;
    }
    if (kind === 'ok') {
      const anyBad = results.some((r) => r.ok !== true);
      if (anyBad) problems.push('ok/ 自称该绿但收卷纪律不齐');
      else kinds.ok += 1;
    }
  }
  if (kinds.red === 0 || kinds.ok === 0 || kinds.empty === 0) {
    problems.push(`样本种类不够 red=${kinds.red} ok=${kinds.ok} empty=${kinds.empty}`);
  }
  return { ok: problems.length === 0, unscanned: false, kinds, error: problems.join('；') };
}
