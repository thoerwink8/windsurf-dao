// scripts/lib/test-impact.mjs —— 只跑受影响的测试（Test Impact Analysis）的纯函数层
//
// 为什么是覆盖率而不是 import 图（2026-09-06 实测定的路）：
//   本仓 102 个测试文件里，**只有 13 个**能从静态 `import` 推出它测的是谁；
//   其余 89 个走动态 `import()` 或直接 spawn CLI。静态依赖图对 87% 的测试是瞎的。
//   而 `NODE_V8_COVERAGE` 会**继承给 spawn 出去的子进程**——实测 dao.test.js 落 105 份
//   覆盖率文件、解析出 58 个本仓文件且含 `scripts/dao.mjs`，正好把 spawn 那部分补上了。
//   ⇒ 地图从「真实跑过什么」采样，不从名字猜，也不手写映射表
//     （手写的那张表就是 memory `hand-typed-constant-will-be-wrong` 的下一个受害者）。
//
// 采样必然有漏（某条分支从没被测到过，它碰的文件就不在图里）。所以这一层的设计前提是
// **地图不可信**，配套三道在 test-impact-check.mjs：新增测试不在图里即红、地图过期即红、
// 每日全量跑时顺手重建。affected 只用来「跳过肯定无关的」，不用来「证明改动是安全的」。

/** 本仓内、值得进图的文件。覆盖率里还会有 node 内部模块与 node_modules，全滤掉。 */
export function repoRelPath(url, repoRoot) {
  if (typeof url !== 'string' || !url.startsWith('file:')) return null;
  let p;
  try { p = decodeURIComponent(new URL(url).pathname); } catch { return null; }
  if (process.platform === 'win32') p = p.replace(/^\//, '');
  const root = String(repoRoot).replace(/\\/g, '/').replace(/\/$/, '');
  const norm = p.replace(/\\/g, '/');
  if (!norm.startsWith(root + '/')) return null;
  const rel = norm.slice(root.length + 1);
  return IGNORED_IN_MAP.some((re) => re.test(rel)) ? null : rel;
}

// 不入图的：依赖它们没有意义，而且会让图永远对不上。
//  · node_modules：外部依赖，改不动也不该触发
//  · _tmp/ 与 tests/fixtures 下的沙盒产物：**测试自己造出来的文件**——
//    实测 dao-mode.test.js 把它临时写出的 8 个沙盒脚本当成了依赖（2026-09-06），
//    这些路径每跑一次就变一次，留在图里等于图天天脏。
export const IGNORED_IN_MAP = [
  /(^|\/)node_modules\//,
  /^_tmp\//,
  /^tests\/fixtures\/.*\/(homes|sandbox)\//,
  // 采样器自己不许出现在被采样的结果里——它每套都会被读到，进图等于每套都依赖它，
  // 改一下它就触发全量（而它落在 tests/helpers/ 本来就是兜底面，已经会触发全量）。
  /^tests\/helpers\/record-reads\.mjs$/,
];

/** 一次覆盖率采集（一个目录下的 N 份 json）→ 它碰过的本仓文件集合。 */
export function filesFromCoverage(coverageDocs, repoRoot) {
  const out = new Set();
  for (const doc of coverageDocs || []) {
    for (const s of (doc && doc.result) || []) {
      const rel = repoRelPath(s && s.url, repoRoot);
      if (rel) out.add(rel);
    }
  }
  return out;
}

/**
 * 地图形状：`{ version, builtAt, head, entries: { "tests/x.test.js": ["scripts/..", ..] } }`
 * 存 HEAD 是为了让「地图比代码旧多少」可判——没有它就只能看文件 mtime，而 mtime 在 clone 后全是新的。
 */
export const MAP_VERSION = 1;

export function buildMap({ entries, head, now = new Date() }) {
  const sorted = {};
  for (const k of Object.keys(entries || {}).sort()) sorted[k] = [...new Set(entries[k])].sort();
  return { version: MAP_VERSION, builtAt: now.toISOString(), head: head || null, entries: sorted };
}

/**
 * 改动文件 → 要跑的测试。
 *
 * 三条判定，顺序即优先级：
 *  ① 改的就是某个测试文件本身 ⇒ 跑它（不管它在不在图里——新测试第一次跑就是这条兜住的）
 *  ② 图里有测试碰过这个文件 ⇒ 跑那些测试
 *  ③ 改动落在**兜底面**（下面 ALWAYS_FULL）⇒ 全量，因为影响面算不出来
 *
 * 返回 `{ mode:'full'|'affected', tests:[...], why }`——**永远不返回空集加 mode:'affected'**
 * 而不说明理由：静默跑 0 个测试与「查过没事」在输出上必须分得开。
 */
export const ALWAYS_FULL = [
  /^package(-lock)?\.json$/,
  /^scripts\/dao-check\.mjs$/,          // 检查器自己变了，全量
  /^scripts\/lib\/test-impact/,          // 本层自己变了，全量
  /^tests\/helpers\//,                   // 测试公用件
  /^\.github\/workflows\//,
];

export function affectedTests({ map, changed, allTests = [] }) {
  const tests = new Set();
  const changedList = (changed || []).filter(Boolean);
  if (changedList.length === 0) {
    return { mode: 'affected', tests: [], why: '本次没有改动文件' };
  }
  for (const f of changedList) {
    if (ALWAYS_FULL.some((re) => re.test(f))) {
      return { mode: 'full', tests: [...allTests], why: `${f} 落在兜底面（影响面算不出来）` };
    }
  }
  if (!map || map.version !== MAP_VERSION || !map.entries) {
    return { mode: 'full', tests: [...allTests], why: '没有可用的影响地图（没查成，按全量走）' };
  }
  const known = new Set(allTests);
  for (const f of changedList) {
    if (/\.test\.(js|mjs|cjs)$/.test(f)) { if (known.has(f)) tests.add(f); continue; }
    for (const [t, srcs] of Object.entries(map.entries)) {
      if (known.has(t) && srcs.includes(f)) tests.add(t);
    }
  }
  const list = [...tests].sort();
  return {
    mode: 'affected',
    tests: list,
    why: list.length ? `${changedList.length} 个改动文件命中 ${list.length} 套测试` : `${changedList.length} 个改动文件在图里没有任何测试碰过`,
  };
}

/**
 * 地图健康度。**这是本层唯一防「静默漏跑」的东西**，比 affected 本身更重要。
 * 返回 `{ ok, problems:[...] }`；problems 非空即应判红，不许降级成警告。
 */
export function mapHealth({ map, allTests = [], headDistance = null, maxHeadDistance = 200 }) {
  const problems = [];
  if (!map) return { ok: false, problems: ['影响地图不存在——本次等于没查（跑 test-impact-map.mjs 建图）'] };
  if (map.version !== MAP_VERSION) problems.push(`地图版本 ${map.version} ≠ 当前 ${MAP_VERSION}，判据变了要重建`);
  const inMap = new Set(Object.keys(map.entries || {}));
  const missing = allTests.filter((t) => !inMap.has(t));
  if (missing.length) {
    problems.push(`${missing.length} 套测试不在地图里（新增后没重建）：${missing.slice(0, 5).join('、')}${missing.length > 5 ? ' …' : ''}`);
  }
  const stale = [...inMap].filter((t) => !allTests.includes(t));
  if (stale.length) problems.push(`地图里有 ${stale.length} 套已不存在的测试：${stale.slice(0, 5).join('、')}`);
  if (Number.isFinite(headDistance) && headDistance > maxHeadDistance) {
    problems.push(`地图落后 HEAD ${headDistance} 个提交（上限 ${maxHeadDistance}），采样已不代表现状`);
  }
  return { ok: problems.length === 0, problems };
}
