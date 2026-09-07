// scripts/lib/competing-prs.mjs —— 竞争 PR 闸：两个开放 PR 新建同一个文件就报警
//
// 起因（2026-09-06 实咬）：#884（卡 B）和 #886（卡 C）各自新建了 scripts/lib/executor-binding.mjs。
// #886 先合，#884 当场变成 CONFLICTING，挂了两天，最后整份 1339 行的工作只剩一段实现可用。
// 两张卡都源自 #880，正文还明写着「只依赖已冻结的接口签名，不等 A 合并即可并行开工」——
// 但那个公共依赖根本没进接口卡，「冻结」只是一句口头约定，没有任何东西会在两边同时新建时叫一声。
//
// 学术上这叫 competing pull requests（编辑了同一行且时间窗重叠）；实测三成 PR 属于这一类，
// 所以这不是本仓特有的坑。业界三层解法里，本文件是兜底那层——它让冲突**早暴露**，
// 不能让冲突**不发生**。真正让它不发生的是缩短分支寿命（分支活小时级而不是天级）。
// 别指望这道闸替代那件事。
//
// 判据只认「新建同一路径」，不认「同时改了同一个已有文件」：后者是日常，git 自己会合；
// 前者是两份独立实现，合并时必然二选一，而且往往要作废一整个 PR。
//
// 「一个 PR 都没扫到」和「扫完没有冲突」必须分开——gh 挂了、token 过期、仓里本来就没有开放 PR，
// 这三件事在输出上长得一模一样，混成一个「绿」就等于闸静默失效。

/** 主干已有的文件不算「新建」。判据在调用方注入（本模块不碰盘）。 */
export function judgeCompetingPrs({ prs } = {}) {
  if (!Array.isArray(prs)) {
    return { kind: 'unscanned', error: '没给 prs 数组', collisions: [], scanned: 0, line: '竞争 PR 闸：没查成（没给 PR 列表）' };
  }
  if (prs.length === 0) {
    // 0 个开放 PR 是真实且合法的状态，但它与「gh 没返回」不可区分——所以调用方必须
    // 先自证 gh 查得成，再把空数组传进来。传到这儿就当真的没有开放 PR。
    return { kind: 'ok', collisions: [], scanned: 0, line: '竞争 PR 闸：没有开放 PR，无从相撞' };
  }
  const byPath = new Map();
  for (const pr of prs) {
    const n = pr && pr.number;
    if (n == null) {
      return { kind: 'unscanned', error: 'PR 缺 number 字段', collisions: [], scanned: prs.length, line: '竞争 PR 闸：没查成（PR 缺 number）' };
    }
    if (!Array.isArray(pr.newPaths)) {
      return {
        kind: 'unscanned',
        error: `#${n} 没拿到新建文件清单（不是「它没新建文件」）`,
        collisions: [], scanned: prs.length,
        line: `竞争 PR 闸：没查成（#${n} 文件清单没取到）`,
      };
    }
    for (const p of pr.newPaths) {
      const key = String(p || '').trim();
      if (!key) continue;
      if (!byPath.has(key)) byPath.set(key, []);
      byPath.get(key).push(n);
    }
  }
  const collisions = [];
  for (const [path, numbers] of byPath) {
    const uniq = [...new Set(numbers)].sort((a, b) => a - b);
    if (uniq.length >= 2) collisions.push({ path, prs: uniq });
  }
  collisions.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  if (collisions.length) {
    const bits = collisions.map(c => `${c.path} ← PR ${c.prs.map(n => '#' + n).join(' / ')}`);
    return {
      kind: 'red', collisions, scanned: prs.length,
      line: `竞争 PR 闸：${collisions.length} 处两个以上开放 PR 新建同一文件（${bits.join('；')}）`,
    };
  }
  return {
    kind: 'ok', collisions: [], scanned: prs.length,
    line: `竞争 PR 闸：对照 ${prs.length} 个开放 PR，没有两个新建同一文件`,
  };
}

/**
 * 采集开放 PR 的「新建文件」清单。IO 全注入，测试不打网。
 *
 * runGh(args) → { ok, json }；mainHas(path) → 主干上是否已有这个文件。
 * 「新建」= 该 PR 有增行 + 主干上还没有这个路径。只看 additions 会把「改已有文件」也算进来。
 */
export function collectOpenPrNewFiles({ runGh, mainHas, limit = 50 } = {}) {
  if (typeof runGh !== 'function' || typeof mainHas !== 'function') {
    return { unscanned: true, error: '要注入 runGh / mainHas', prs: [] };
  }
  const listed = runGh(['pr', 'list', '--state', 'open', '--limit', String(limit), '--json', 'number,title']);
  if (!listed || !listed.ok || !Array.isArray(listed.json)) {
    return { unscanned: true, error: `开放 PR 列表没取到：${listed && listed.error ? listed.error : '无返回'}`, prs: [] };
  }
  const prs = [];
  for (const row of listed.json) {
    const n = row && row.number;
    if (n == null) continue;
    const detail = runGh(['pr', 'view', String(n), '--json', 'files']);
    if (!detail || !detail.ok || !detail.json || !Array.isArray(detail.json.files)) {
      // 单个 PR 取不到就整体判没查成——少扫一个 PR 就可能漏掉正好那一对。
      return { unscanned: true, error: `#${n} 的文件清单没取到`, prs: [] };
    }
    const newPaths = [];
    for (const f of detail.json.files) {
      const path = f && f.path;
      if (!path) continue;
      if (Number(f.additions) > 0 && !mainHas(path)) newPaths.push(path);
    }
    prs.push({ number: n, title: row.title || '', newPaths });
  }
  return { unscanned: false, prs };
}
