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
// **地图不可信**：affected 只用来「跳过肯定无关的」，不用来「证明改动是安全的」。
//
// 2026-09-06 换方向（用户拍板，整段删掉「预建地图」这个机制）：
//   旧法是 `test-impact-map.mjs build` 预先全量建图，配三道健康闸（不在图里即红 / 过期即红 /
//   每日 cron 重建）。**建一次 1 分 50 秒**，而每加一个测试文件就把图判成不健康 ⇒ 下一个人
//   得先付这 110 秒才能继续。实测代价：帅位一轮里为它烧掉 5.5 分钟，于是干脆退回全量档——
//   **「用快档」越贵，人越会退回慢档**，快档等于白造。
//   新法两条：
//     ① **不在图里的测试一律照跑**（见 affectedTests 规则 ④）。安全方向反过来了：
//        旧法「不在图里」= 静默跳过 + 一条要人处置的红；新法 = 直接跑。
//     ② 地图是**跑测试的副产物**，不是要维护的东西——dao-check 跑哪套就顺手采哪套的依赖
//        并回图（实测只贵 8%）。没有 build 动作、没有健康闸、没有 cron、没有 1:50。
//   于是新机/CI 第一次跑就是全量（本来就该），跑完图自然有了；新增测试第一次必跑，跑完自动入图。

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
 * 四条判定，顺序即优先级：
 *  ① 改动落在**兜底面**（下面 ALWAYS_FULL）⇒ 全量，因为影响面算不出来
 *  ② 改的就是某个测试文件本身 ⇒ 跑它
 *  ③ 图里有测试碰过这个文件 ⇒ 跑那些测试
 *  ④ **图里根本没有这套测试 ⇒ 也跑**（没有依赖信息就不许判它无关）
 *
 * ④ 是这一层的安全底座，2026-09-06 加的。在它之前，「不在图里」= 静默跳过，
 * 靠另一条红项提醒人去重建地图来兜——**把安全性押在人会不会照做上**。
 * 现在方向反过来：不知道就跑。代价是新机第一次全量（本来就该），换来的是
 * 地图彻底不需要维护——没有建图动作、没有健康闸、没有那 110 秒的税。
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
  // ④ 图里没有的一律跑。**这条不看 changed**——没有依赖信息就没有「无关」这个判断的依据。
  const unknown = allTests.filter((t) => !Object.prototype.hasOwnProperty.call(map.entries, t));
  for (const t of unknown) tests.add(t);

  const list = [...tests].sort();
  const parts = [];
  if (list.length - unknown.length > 0 || unknown.length === 0) {
    parts.push(`${changedList.length} 个改动文件命中 ${list.length - unknown.length} 套`);
  }
  if (unknown.length) parts.push(`${unknown.length} 套还不在图里（照跑）`);
  return {
    mode: 'affected',
    tests: list,
    unknown,
    why: list.length ? parts.join('，') : `${changedList.length} 个改动文件在图里没有任何测试碰过，且全部测试都已在图里`,
  };
}

/**
 * 把本轮真跑过的那些套的依赖并回地图。地图从此是**跑测试的副产物**，没有独立的建图动作。
 *
 * 两条纪律：
 *  · **只写采到了的**。`sampled` 里 files 为 null / undefined 的套一概不写——采不到就让它
 *    继续「不在图里」，下轮照跑（规则 ④）。写个空数组冒充「无依赖」= 让它从此被永久跳过。
 *  · **只动跑过的条目**，没跑的原样留着。这样裁剪跑也能一点点把图补全，不需要谁去跑全量。
 * 顺手把已经不存在的测试从图里剔掉（allTests 给了才剔；没给就不动，宁可留幽灵也不误删）。
 */
export function mergeMapEntries({ map, sampled, head = null, allTests = null, now = new Date() }) {
  const entries = { ...((map && map.entries) || {}) };
  let written = 0;
  for (const [t, files] of Object.entries(sampled || {})) {
    if (!Array.isArray(files)) continue;
    entries[t] = [...new Set(files)].sort();
    written += 1;
  }
  if (Array.isArray(allTests)) {
    const alive = new Set(allTests);
    for (const k of Object.keys(entries)) if (!alive.has(k)) delete entries[k];
  }
  return { map: buildMap({ entries, head, now }), written };
}

/**
 * 一次带采样的测试运行 → 它碰过的本仓文件。
 *
 * 采两路，缺一不可：
 *  · V8 覆盖率目录：执行过的 JS（且**继承给 spawn 出去的子进程**，本仓 87% 的测试靠这个）
 *  · 读取日志：`readFileSync` 读过的 json/md/toml——覆盖率看不见数据文件
 *
 * **一份覆盖率都没落 ⇒ 回 null，不回空数组。** 空数组会被 mergeMapEntries 写进图，
 * 从此这套测试被判成「不依赖任何文件」而永久跳过——那是最难发现的一种漏跑。
 * io 注入是为了让这条纪律测得到（不必真去跑一套测试）。
 */
export function depsFromRun({ covDir, readLog, root, testFile, io }) {
  const { exists, readDir, readFile } = io;
  const docs = [];
  for (const f of (exists(covDir) ? readDir(covDir) : [])) {
    if (f === 'reads.txt') continue;
    try { docs.push(JSON.parse(readFile(`${covDir}/${f}`))); } catch { /* 半截文件跳过 */ }
  }
  if (docs.length === 0) return null;          // 没采成 ≠ 没依赖
  const files = filesFromCoverage(docs, root);
  if (readLog && exists(readLog)) {
    for (const l of String(readFile(readLog)).split('\n')) {
      const rel = l.trim();
      if (rel && !IGNORED_IN_MAP.some((re) => re.test(rel))) files.add(rel);
    }
  }
  files.delete(testFile);                       // 自己不算依赖
  return [...files];
}
