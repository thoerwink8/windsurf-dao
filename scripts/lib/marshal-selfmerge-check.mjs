// 帅位不得自审自合且 reviews=0（issue #1093）。
//
// 病：红线写成「帅窗不许碰 git」，真正没闸的是「判定权归帅位」。
// 2026-09-06 夜 5 个 PR author=mergedBy=dao-marshal、reviews=0 进了 master。
// 自觉层失效（memory my-fix-is-a-self-discipline-layer）。本闸盯那次的形状。
//
// 判据（验收原文）：扫已合并 PR，author 与 mergedBy 同为 marshal 且 reviews=0 ⇒ 红。
// 检查器自持 marshal 登录名，不 import gh.mjs / land.mjs（自己查自己查不出错）。
//
// 三态必须分得开：
//   unscanned —— 没查成（没给清单 / 0 个 PR / 条目缺字段）
//   red       —— 扫到了，且命中自合并 reviews=0
//   ok        —— 扫了 N 个（N>0），0 个违规
// 「一个都没扫到」不许当绿（「扫完 0 条违规」和「这次没扫到任何样本」分不开
// 就会把没查成记成查过没事）。
//
// live 有基准线：只对照 baselinePr 之后的已合并单，避免 2026-09-06 那 5 个
// 存量把闸钉死在红。禁 Date.now。

export const MARSHAL_LOGINS = Object.freeze(['dao-marshal[bot]', 'dao-marshal']);
/** 本单 PR 号；只对照这号之后。存量自合并是另一单（marshal-selfmerged-audit）。 */
export const MARSHAL_SELFMERGE_BASELINE_PR = 1100;

const MARSHAL_SET = new Set(MARSHAL_LOGINS);

export function loginOf(person) {
  if (person == null) return null;
  if (typeof person === 'string') {
    const s = person.trim();
    return s ? s : null;
  }
  if (typeof person === 'object' && typeof person.login === 'string') {
    const s = person.login.trim();
    return s ? s : null;
  }
  return null;
}

export function isMarshalLogin(login) {
  return typeof login === 'string' && MARSHAL_SET.has(login);
}

export function reviewCountOf(pr) {
  if (!pr || typeof pr !== 'object' || !Object.prototype.hasOwnProperty.call(pr, 'reviews')) {
    return null;
  }
  const r = pr.reviews;
  if (Array.isArray(r)) return r.length;
  if (typeof r === 'number' && Number.isInteger(r) && r >= 0) return r;
  return null;
}

/**
 * 一条已合并 PR 是不是「marshal 自合且 reviews=0」。
 * 缺字段 → unscanned（不是「reviews=0」）。
 */
export function judgeOne({ number, author, mergedBy, reviews } = {}) {
  const pr = { number, author, mergedBy, reviews };
  if (!Number.isInteger(number) || number <= 0) {
    return { kind: 'unscanned', error: 'PR 缺 number', violation: false };
  }
  const a = loginOf(author);
  const m = loginOf(mergedBy);
  if (a == null) return { kind: 'unscanned', error: `#${number} 缺 author.login（不是「它不是 marshal」）`, violation: false };
  if (m == null) return { kind: 'unscanned', error: `#${number} 缺 mergedBy.login（不是「别人合的」）`, violation: false };
  // 验收公式要两边都是 marshal。一边不是 ⇒ 本闸不报，也不索 reviews。
  if (!isMarshalLogin(a) || !isMarshalLogin(m)) {
    return { kind: 'ok', violation: false, number, author: a, mergedBy: m, reviews: reviewCountOf(pr) };
  }
  const n = reviewCountOf(pr);
  if (n == null) {
    return { kind: 'unscanned', error: `#${number} 没拿到 reviews（不是「reviews=0」）`, violation: false };
  }
  return {
    kind: 'ok',
    violation: n === 0,
    number,
    author: a,
    mergedBy: m,
    reviews: n,
  };
}

/**
 * 纯判官。prs 不是数组 / 长度为 0 / 条目缺字段 → unscanned。
 * baselinePr 之后才对照；滤完 0 个 = 没扫到样本，不是绿。
 *
 * @returns {{
 *   kind: 'unscanned'|'ok'|'red',
 *   ok: boolean,
 *   unscanned: boolean,
 *   violations: object[],
 *   scanned: number,
 *   labeled: number[],
 *   error?: string,
 *   line: string
 * }}
 */
export function inspectMarshalSelfMerge({
  prs,
  baselinePr = MARSHAL_SELFMERGE_BASELINE_PR,
} = {}) {
  if (!Array.isArray(prs)) {
    return {
      kind: 'unscanned',
      ok: false,
      unscanned: true,
      violations: [],
      scanned: 0,
      labeled: [],
      error: '没给已合并 PR 清单（没查成）',
      line: '帅位 reviews=0 自合并：没查成（没给 PR 列表）',
    };
  }
  if (prs.length === 0) {
    return {
      kind: 'unscanned',
      ok: false,
      unscanned: true,
      violations: [],
      scanned: 0,
      labeled: [],
      error: '扫到 0 个已合并 PR（没查成，不是 0 个违规）',
      line: '帅位 reviews=0 自合并：这次没扫到任何样本，不是绿',
    };
  }

  const baseline = Number.isInteger(baselinePr) ? baselinePr : 0;
  const after = [];
  for (const pr of prs) {
    if (!pr || typeof pr.number !== 'number') {
      return {
        kind: 'unscanned',
        ok: false,
        unscanned: true,
        violations: [],
        scanned: 0,
        labeled: [],
        error: 'PR 缺 number 字段',
        line: '帅位 reviews=0 自合并：没查成（PR 缺 number）',
      };
    }
    if (pr.number > baseline) after.push(pr);
  }
  const labeled = after.map((p) => p.number).sort((a, b) => a - b);
  if (after.length === 0) {
    return {
      kind: 'unscanned',
      ok: false,
      unscanned: true,
      violations: [],
      scanned: 0,
      labeled,
      error: `基准 PR #${baseline} 之后 0 个已合并 PR——没扫到样本，不是绿`,
      line: `帅位 reviews=0 自合并：基准 PR #${baseline} 之后 0 个已合并 PR——没扫到样本，不是绿`,
    };
  }

  const judged = [];
  for (const pr of after) {
    const one = judgeOne(pr);
    if (one.kind === 'unscanned') {
      return {
        kind: 'unscanned',
        ok: false,
        unscanned: true,
        violations: [],
        scanned: judged.length,
        labeled,
        error: one.error,
        line: `帅位 reviews=0 自合并：没查成（${one.error}）`,
      };
    }
    judged.push(one);
  }
  const violations = judged.filter((j) => j.violation);
  if (violations.length) {
    const bits = violations.map((v) => `#${v.number} author=${v.author} mergedBy=${v.mergedBy} reviews=${v.reviews}`);
    return {
      kind: 'red',
      ok: false,
      unscanned: false,
      violations,
      scanned: judged.length,
      labeled,
      error: null,
      line: `帅位 reviews=0 自合并：${violations.length} 个（${bits.join('；')}）`,
    };
  }
  return {
    kind: 'ok',
    ok: true,
    unscanned: false,
    violations: [],
    scanned: judged.length,
    labeled,
    error: null,
    line: `帅位 reviews=0 自合并：对照 ${judged.length} 个已合并 PR，0 个违规`,
  };
}

function readJson(path, readFile) {
  const raw = readFile(path);
  if (typeof raw !== 'string') throw new Error(`读 ${path} 没给正文`);
  return JSON.parse(raw);
}

/**
 * 夹具判别力：red 必须拦住 marshal 自合 reviews=0、ok 必须绿、empty 必须标没查成。
 * 探头注入，测试与 dao-check 走同一条。
 */
export function inspectMarshalSelfMergeFixtures({
  rootRel = 'tests/fixtures/marshal-selfmerge',
  exists,
  readFile,
} = {}) {
  if (typeof exists !== 'function' || typeof readFile !== 'function') {
    return { ok: false, unscanned: true, error: '没给 exists/readFile 探头（没查成）' };
  }
  if (!exists(rootRel)) {
    return { ok: false, unscanned: true, error: `样本目录不在：${rootRel}` };
  }
  const kinds = { red: 0, ok: 0, empty: 0 };
  const problems = [];
  for (const kind of ['red', 'ok', 'empty']) {
    const file = `${rootRel}/${kind}.json`;
    if (!exists(file)) {
      problems.push(`缺 ${kind}.json`);
      continue;
    }
    let doc;
    try { doc = readJson(file, readFile); }
    catch (e) {
      problems.push(`${kind}.json 不是 JSON（${String(e && e.message ? e.message : e).slice(0, 80)}）`);
      continue;
    }
    if (!doc || !Array.isArray(doc.prs)) {
      problems.push(`${kind}.json 缺 prs 数组`);
      continue;
    }
    const r = inspectMarshalSelfMerge({ prs: doc.prs, baselinePr: doc.baselinePr ?? 0 });
    if (kind === 'empty') {
      if (!r.unscanned) {
        problems.push(`empty.json 应没查成但判成 kind=${r.kind} unscanned=${r.unscanned} scanned=${r.scanned}`);
      } else kinds.empty += 1;
    } else if (kind === 'red') {
      if (r.unscanned || r.ok || r.kind !== 'red') {
        problems.push(`red.json 自称该红但判成 kind=${r.kind} ok=${r.ok} unscanned=${r.unscanned}`);
      } else {
        const hit = (r.violations || []).some((v) => v.reviews === 0 && isMarshalLogin(v.author) && isMarshalLogin(v.mergedBy));
        if (!hit) problems.push('red.json 没点出 marshal 自合 reviews=0');
        else kinds.red += 1;
      }
    } else if (kind === 'ok') {
      if (r.unscanned || !r.ok || r.kind !== 'ok') {
        const names = (r.violations || []).map((v) => `#${v.number}`).join('、');
        problems.push(`ok.json 自称该绿但判成 kind=${r.kind} unscanned=${r.unscanned}${names ? `：${names}` : ''}`);
      } else if (r.scanned === 0) {
        problems.push('ok.json 扫了 0 个——和 empty 分不开');
      } else kinds.ok += 1;
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

