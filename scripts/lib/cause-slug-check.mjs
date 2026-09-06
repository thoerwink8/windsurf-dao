// scripts/lib/cause-slug-check.mjs —— 「同一起因只许一张 OPEN 单」的判据（#1063 ②）
//
// 规矩在 CLAUDE.md：「机器与帅位开的单，正文首行写 `起因：<slug>`，同一 slug 只许有一张
// OPEN 单」。2026-09-06 拍板立规时只约束了人，机器那侧照旧一个原因刷 N 张单——本文件是
// 给那条规矩配的、会报警的检查（本仓硬规矩：察觉不到违反的规则，立规矩时就配自动检查）。
//
// 判据自己解析 issue 正文，**不复用 commander 生成正文的那套模板函数**——自己查自己查不出错。
//
// 三态必须分得开：扫完 0 张重复（绿）／查出重复（红）／一张单都没扫到（没查成）。
// 分不开就会把「没查成」当成「查过没事」，这条在本仓咬过多次。

/**
 * 「缺起因行」这一条的生效起点：规矩拍板那一刻（commit `c8bc759b`，2026-09-06 19:46
 * 「开单也算动手——一因一单，起因写进正文首行」）。
 *
 * 为什么要有起点：规矩之前开的单本来就没有这一行，追溯判红会让这道检查**永远红**，
 * 而永远红的检查等于没有检查——人会开始跳过它，真红项就淹在里面
 * （判例 memory `downgrading-false-alarm-can-disable-the-guard`）。实测：立规当天盘面上
 * 有 23 张老单缺这行。
 *
 * 起点是确定性的量（issue 的 createdAt），不是人工维护的豁免名单——名单必然过期。
 * **重复 slug 那一条不受起点限制**：两张单撞同一个起因，跟它们多老没关系。
 */
export const CAUSE_RULE_SINCE = '2026-09-06T11:46:00Z';

/** 只认正文**首行**的 `起因：<slug>`。写在中间不算——首行是规矩指定的位置，放宽就没法机器判。 */
export function causeSlugOf(body) {
  const first = String(body || '').split(/\r?\n/, 1)[0] || '';
  const m = /^\s*起因[:：]\s*(\S+)\s*$/.exec(first);
  return m ? m[1] : null;
}

/**
 * 这张单是不是「机器或帅位」开的。
 *
 * 判据是作者身份：机器与帅位一律经 GitHub App 身份开单（gh-as.mjs marshal），
 * 作者形如 `app/dao-marshal`；用户本人开的是普通账号。**用户手开的单不纳入本检查**
 * ——规矩约束的是机器与帅位，拿它去管人手记的备忘只会制造噪音。
 *
 * 作者字段缺失 ⇒ 返回 null（调用方按「没查成」处置，不许当成用户的单放过）。
 */
export function isMachineAuthored(author) {
  const login = typeof author === 'string' ? author : (author && author.login);
  if (typeof login !== 'string' || !login.trim()) return null;
  return login.trim().toLowerCase().startsWith('app/');
}

/**
 * @param {{issues?: unknown}} snap  issues 需带 number / body / author
 * @returns {{kind:'unscanned'|'ok'|'red', dupes:Array, missing:number[], scanned:number, line:string}}
 */
export function inspectCauseSlugs(snap, { since = CAUSE_RULE_SINCE } = {}) {
  const sinceMs = Date.parse(since);
  const issues = snap && snap.issues;
  if (!Array.isArray(issues)) {
    return { kind: 'unscanned', dupes: [], missing: [], scanned: 0, line: '起因 slug：没查成（issues 不是数组，≠ 扫完 0 张）' };
  }
  const bySlug = new Map();
  const missing = [];
  let scanned = 0;
  for (const it of issues) {
    if (!it || typeof it.number !== 'number') {
      return { kind: 'unscanned', dupes: [], missing: [], scanned, line: '起因 slug：没查成（issue 缺 number 字段）' };
    }
    if (!('body' in it) || !('author' in it)) {
      return { kind: 'unscanned', dupes: [], missing: [], scanned, line: `起因 slug：没查成（#${it.number} 缺 body/author 字段，取数面不全）` };
    }
    const machine = isMachineAuthored(it.author);
    if (machine === null) {
      return { kind: 'unscanned', dupes: [], missing: [], scanned, line: `起因 slug：没查成（#${it.number} 作者读不出，不许当成用户的单放过）` };
    }
    if (!machine) continue; // 用户本人开的，不纳入
    scanned += 1;
    const slug = causeSlugOf(it.body);
    if (!slug) {
      // 规矩生效前开的老单不追溯（理由见 CAUSE_RULE_SINCE）。createdAt 读不出 ⇒ 没查成，
      // 不许当成「老单」放过——那样只要取数面少一个字段，这条就静默失效了。
      if (!('createdAt' in it)) {
        return { kind: 'unscanned', dupes: [], missing: [], scanned, line: `起因 slug：没查成（#${it.number} 缺 createdAt，判不了规矩生效起点）` };
      }
      const born = Date.parse(it.createdAt);
      if (!Number.isFinite(born)) {
        return { kind: 'unscanned', dupes: [], missing: [], scanned, line: `起因 slug：没查成（#${it.number} createdAt 解析不了：${it.createdAt}）` };
      }
      if (Number.isFinite(sinceMs) && born < sinceMs) continue; // 立规之前的老单
      missing.push(it.number);
      continue;
    }
    if (!bySlug.has(slug)) bySlug.set(slug, []);
    bySlug.get(slug).push(it.number);
  }
  const dupes = [...bySlug.entries()]
    .filter(([, nums]) => nums.length >= 2)
    .map(([slug, nums]) => ({ slug, issues: nums.sort((a, b) => a - b) }));
  if (dupes.length || missing.length) {
    const parts = [];
    for (const d of dupes) parts.push(`起因「${d.slug}」有 ${d.issues.length} 张 OPEN 单：${d.issues.map((n) => '#' + n).join(' ')}——合成一张`);
    if (missing.length) parts.push(`机器/帅位开的单缺「起因：」首行：${missing.map((n) => '#' + n).join(' ')}`);
    return { kind: 'red', dupes, missing, scanned, line: parts.join('；') };
  }
  return { kind: 'ok', dupes: [], missing: [], scanned, line: `起因 slug：扫完 ${scanned} 张机器/帅位单，无重复、无缺失（扫完是 0 不是没查成）` };
}
