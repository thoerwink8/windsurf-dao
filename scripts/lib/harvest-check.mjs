// 回流闸（issue #888）：好东西不许烂在单里。
//
// 病：通用产物只在做它的那张单里躺着。指望「记得抽出来」= 靠自觉，实证四次全哑
// （判机制不靠自觉，2026-09-04 拍板）；靠用户口头提醒 = 用户当闸，最贵的一种闸。
//
// 闸：交卷时士兵在 PR 正文写 `## 回流` 段（士兵书自查第 4 条）；合并时收口官/帅接单，
// 在段内回写受理证据。**孤儿回流段 = 有人发现了好东西但没人接** → 红，点名 PR。
//
// 两套独立逻辑，禁止互相调用：
//   scanHarvestSection —— 只认 PR 正文里的段与受理行，不查 issue 存不存在。
//   judgeHarvest       —— 只吃已扫出的结构，不碰 IO、不发网络请求。
// 自己查自己查不出错：判官不复用「写段的人自己说已受理」以外的推断。
//
// 零样本：给了 PR 列表却一条正文都没扫到 = 没查成（红），不是「都没写回流段」。
// 三行体：段里缺任一行（产物/为什么通用/落点）→ 红。空段比没段更坏——它看着像做了。

export const SECTION_HEADING = '## 回流';
/** 段内三行的必填标记。写法宽松（认中文冒号或英文冒号），缺一行即红。 */
export const REQUIRED_FIELDS = ['产物', '为什么通用', '落点'];
/** 受理证据：开了回流单，或已经就地上收（给 sha / PR 号）。 */
const ACCEPT_PATTERNS = [
  /回流单[：:]\s*#(\d+)/,
  /已回流[：:]\s*([0-9a-f]{7,40}|#\d+)/,
  /不回流[：:]\s*\S+/,   // 明确判定不值得上收，也算接住了（要写原因）
];

/**
 * 扫一份 PR 正文。返回 { has, fields, missing, accepted, acceptedBy }。
 * 不查 issue 是否真存在——那是 live 检查另一条腿的事，这里只认正文自述。
 */
export function scanHarvestSection(body) {
  const text = String(body || '');
  const at = text.indexOf(SECTION_HEADING);
  if (at === -1) return { has: false, fields: {}, missing: [], accepted: false, acceptedBy: null };
  // 段落到下一个同级/更高级标题为止
  const rest = text.slice(at + SECTION_HEADING.length);
  const end = rest.search(/\r?\n#{1,2} /);
  const section = end === -1 ? rest : rest.slice(0, end);
  const fields = {};
  for (const key of REQUIRED_FIELDS) {
    const m = section.match(new RegExp(`${key}[：:]\\s*(.+)`));
    const val = m ? String(m[1]).trim() : '';
    if (val) fields[key] = val;
  }
  const missing = REQUIRED_FIELDS.filter(k => !fields[k]);
  let acceptedBy = null;
  for (const re of ACCEPT_PATTERNS) {
    const m = section.match(re);
    if (m) { acceptedBy = m[0]; break; }
  }
  return { has: true, fields, missing, accepted: Boolean(acceptedBy), acceptedBy, section };
}

/**
 * 判官。吃 [{number, title, body, mergedAt}]，出 { ok, unscanned, orphans[], thin[], accepted[] }。
 * - orphans：有段、没受理证据（合并了却没人接）。
 * - thin：有段、三行不全（空段最坏：看着像做了）。
 */
export function judgeHarvest(prs) {
  if (!Array.isArray(prs)) {
    return { ok: false, unscanned: true, error: '没拿到 PR 列表——没查成', orphans: [], thin: [], accepted: [] };
  }
  if (prs.length === 0) {
    // 近窗口内一个合并 PR 都没有：本项无从判断，交给调用方按 SKIP 处置（不是绿）。
    return { ok: true, unscanned: false, empty: true, orphans: [], thin: [], accepted: [] };
  }
  const orphans = [];
  const thin = [];
  const accepted = [];
  let scanned = 0;
  for (const pr of prs) {
    if (!pr || pr.number == null) continue;
    // 正文读到了才算扫成。全是空正文 = 取数那步没成（gh 字段没取对/权限不够），
    // 不是「大家都没写回流段」——这两者的处置完全不同。
    if (typeof pr.body !== 'string' || pr.body.trim() === '') continue;
    scanned += 1;
    const r = scanHarvestSection(pr.body);
    if (!r.has) continue;
    if (r.missing.length) thin.push(`#${pr.number} 回流段缺「${r.missing.join('/')}」`);
    if (!r.accepted) orphans.push(`#${pr.number} 回流段没人接（缺 回流单:#N / 已回流:<sha> / 不回流:<原因>）`);
    else accepted.push(`#${pr.number} ${r.acceptedBy}`);
  }
  if (scanned === 0) {
    return { ok: false, unscanned: true, error: '给了 PR 却一条都没扫成——没查成', orphans: [], thin: [], accepted: [] };
  }
  return { ok: orphans.length === 0 && thin.length === 0, unscanned: false, scanned, orphans, thin, accepted };
}

/**
 * 夹具判别（样本检查用）。readJson(name) → [{number,body}] 或 null。
 * red 必须判红、ok 必须干净、empty 必须判没查成。
 */
export function inspectHarvestFixtures({ readJson }) {
  const red = readJson('red');
  if (!red) return { ok: false, unscanned: true, error: 'red 夹具读不到' };
  const rv = judgeHarvest(red);
  if (rv.ok) return { ok: false, unscanned: false, error: 'red 夹具没判红——闸失去判别力' };

  const okDoc = readJson('ok');
  if (!okDoc) return { ok: false, unscanned: true, error: 'ok 夹具读不到' };
  const ov = judgeHarvest(okDoc);
  if (!ov.ok) {
    return { ok: false, unscanned: false, error: `ok 夹具被误杀：${[...ov.orphans, ...ov.thin].slice(0, 2).join('；')}` };
  }

  const empty = readJson('empty');
  if (!empty) return { ok: false, unscanned: true, error: 'empty 夹具读不到' };
  const ev = judgeHarvest(empty);
  if (!ev.unscanned) {
    return { ok: false, unscanned: false, error: 'empty 夹具（有 PR 但全无正文）没判成没查成' };
  }
  return {
    ok: true,
    unscanned: false,
    kinds: { red: rv.orphans.length + rv.thin.length, ok: ov.accepted.length, empty: 1 },
  };
}
