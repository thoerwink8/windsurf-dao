// dao-check ㉒（#667）：删掉「靠 coordinator 横幅给帅收信」整层之后，回归必须能扫出来。
// 检查器自己持有正则，不 import dao-cmd / inbox-station 的解析——自己查自己查不出错。

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/** 裸 orca 数组 run-use 且同一调用里没有 --from。 */
export function scanRawRunUseWithoutFrom(txt) {
  const re = /\[[^\]]*'orchestration'\s*,\s*'run-use'[^\]]*\]/g;
  const hits = [];
  let m;
  while ((m = re.exec(String(txt || '')))) {
    if (!/'--from'/.test(m[0])) hits.push(m[0].replace(/\s+/g, ' ').slice(0, 120));
  }
  return hits;
}

/** 文档还在教「横幅是给帅的收信通道」。 */
export function scanBannerDeliveryTeach(txt) {
  const hits = [];
  const s = String(txt || '');
  if (/帅对话横幅/.test(s)) hits.push('帅对话横幅');
  if (/You have N orchestration messages/.test(s)) hits.push('You have N orchestration messages');
  return hits;
}

export function hasHeartbeatBan(txt) {
  return /心跳不准发/.test(String(txt || ''));
}

export function inspectNoBannerInboxLive({ daoSrc, skillSrc, soldierSrc } = {}) {
  if (daoSrc == null) return { ok: false, unscanned: true, error: '没给 dao.mjs 正文（没查成）' };
  if (skillSrc == null) return { ok: false, unscanned: true, error: '没给 dispatch SKILL 正文（没查成）' };
  if (soldierSrc == null) return { ok: false, unscanned: true, error: '没给 soldier-book 正文（没查成）' };
  const problems = [];
  const dispatchChunk = daoSrc.match(/function cmdDispatch\b[\s\S]*?\nfunction /);
  if (dispatchChunk && /argsRunUse\(/.test(dispatchChunk[0])) {
    problems.push('cmdDispatch 仍调用 argsRunUse（#667 帅窗派工不 run-use）');
  }
  const uses = daoSrc.match(/argsRunUse\([^)]*\)/g) || [];
  for (const u of uses) {
    if (!/self:\s*true/.test(u) && !/from:/.test(u)) {
      problems.push(`dao.mjs argsRunUse 未标 self:true：${u}`);
    }
  }
  const raw = scanRawRunUseWithoutFrom(daoSrc);
  if (raw.length) problems.push(`dao.mjs 裸 run-use 无 --from：${raw.join('；')}`);
  const banners = scanBannerDeliveryTeach(skillSrc);
  if (banners.length) problems.push(`dispatch SKILL 仍教横幅收信：${banners.join(' ')}`);
  if (!hasHeartbeatBan(soldierSrc)) problems.push('soldier-book 没有「心跳不准发」');
  return { ok: problems.length === 0, unscanned: false, problems };
}

export function inspectNoBannerInboxFixtures(root) {
  if (!root) return { ok: false, unscanned: true, error: '没给样本根目录' };
  if (!existsSync(root)) {
    return { ok: false, unscanned: true, error: `样本目录不在：${root}` };
  }
  const kinds = { red: 0, ok: 0 };
  const problems = [];
  for (const kind of ['red', 'ok']) {
    const dir = join(root, kind);
    if (!existsSync(dir)) { problems.push(`缺 ${kind}/`); continue; }
    const files = readdirSync(dir).filter((f) => /\.(md|mjs|js|txt)$/i.test(f));
    if (files.length === 0) { problems.push(`${kind}: 0 个样本——没查成`); continue; }
    kinds[kind] += 1;
    const texts = files.map((f) => ({
      f,
      txt: readFileSync(join(dir, f), 'utf8'),
    }));
    const anyRaw = texts.some((t) => scanRawRunUseWithoutFrom(t.txt).length);
    const anyBanner = texts.some((t) => scanBannerDeliveryTeach(t.txt).length);
    const anyBan = texts.some((t) => hasHeartbeatBan(t.txt));
    if (kind === 'red') {
      const redHasSignal = anyRaw || anyBanner || texts.some((t) => /soldier/.test(t.f) && !hasHeartbeatBan(t.txt));
      if (!redHasSignal) problems.push('red/ 自称该红但扫不到违规（样本没判别力）');
    }
    if (kind === 'ok') {
      if (anyRaw || anyBanner) problems.push('ok/ 自称该绿但扫到裸 run-use 或横幅收信');
      if (texts.some((t) => /soldier/.test(t.f)) && !anyBan) {
        problems.push('ok/ soldier 样本没有「心跳不准发」');
      }
    }
  }
  if (kinds.red === 0 || kinds.ok === 0) {
    return { ok: false, unscanned: true, error: `样本种类不够 red=${kinds.red} ok=${kinds.ok}`, kinds, problems };
  }
  if (problems.length) return { ok: false, unscanned: false, error: problems[0], kinds, problems };
  return { ok: true, unscanned: false, kinds };
}
