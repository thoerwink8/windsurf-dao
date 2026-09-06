// scripts/lib/admission.mjs —— 派单准入控制（#1007）
//
// 用户 2026-09-06 拍板：上限不许是个填的数字，不许 AI 驱动。
// 每轮派工前算一次「还能不能再收一个」，输入只允许可测量的机器信号：
//   主：归一化负载（loadavg1 / nproc）
//   副：MemAvailable − 在途数 × 单工人实测占用 > 安全余量
//   两条都过才收；任一读不出来 ⇒ fail-close 收紧（读不到 ≠ 可以随便派）。
//
// 本文件纯函数：不读盘、不 spawn、不碰 GitHub。测试喂假 /proc 快照 + 样本数组。
// 读 /proc 的薄壳在 commander.mjs（scanMachine），样本落 ~/.dao/admission/samples.ndjson。
//
// 垫片 maxDispatchPerRound 本单退役：策略里不再有「派几个」可填常量。
// 安全余量、负载阈值是「留多少余量」，不是「派几个」。

/** 审官卡：卡名带「审官」。与 board-gc 同一条，不另造一份判据。 */
function isReviewerCard(name) {
  return /审官/.test(String(name || ''));
}

/** 安全余量 / 负载阈值——「留多少余量」，不是「派几个」。 */
export const ADMISSION_DEFAULTS = {
  // 实测 2026-09-06：12 个工人把 6 核打到 loadavg 6.29（归一化 ≈ 1.05）、空闲 10%。
  // 阈值 0.85 = 还没到超订就停收，避免再加人让所有人变慢。
  loadThreshold: 0.85,
  // 内存是副条件。12 个工人只吃 ~2.2G、还剩 7.9G；留 1.5G 防 OOM / 页面缓存抖动。
  memReserveMb: 1536,
  // 样本不足时的保守单工人占用（实测 RSS ~180MB，取偏大值收紧，不是放开）。
  conservativeWorkerMb: 400,
  // 推增量至少要这么多样本对；少了 fail-close。
  minSamplePairs: 4,
  // 取近 N 对增量的中位数。
  sampleWindow: 12,
};

/** 旧键提示文案。读到 maxDispatchPerRound 时打这条，且不按它限流。 */
export const RENAMED_KEY_HINT = 'maxDispatchPerRound 已改名：上限不再是「每轮派几个」，改成机器余量准入（#1007）';

export function resolveAdmissionPolicy(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const hints = [];
  if (Object.prototype.hasOwnProperty.call(src, 'maxDispatchPerRound')) hints.push(RENAMED_KEY_HINT);
  if (Object.prototype.hasOwnProperty.call(src, 'maxInFlightWorkers')) {
    hints.push('maxInFlightWorkers 也不再是可填上限：在制品由机器余量动态算，这个键被忽略（#1007）');
  }
  const n = (key, lo, hi, fallback) => {
    const v = Number(src[key]);
    if (!Number.isFinite(v) || v < lo || v > hi) return fallback;
    return v;
  };
  return {
    loadThreshold: n('loadThreshold', 0.1, 2, ADMISSION_DEFAULTS.loadThreshold),
    memReserveMb: n('memReserveMb', 256, 16384, ADMISSION_DEFAULTS.memReserveMb),
    conservativeWorkerMb: n('conservativeWorkerMb', 64, 4096, ADMISSION_DEFAULTS.conservativeWorkerMb),
    minSamplePairs: Math.round(n('minSamplePairs', 1, 32, ADMISSION_DEFAULTS.minSamplePairs)),
    sampleWindow: Math.round(n('sampleWindow', 2, 64, ADMISSION_DEFAULTS.sampleWindow)),
    requireModelInRouting: typeof src.requireModelInRouting === 'boolean'
      ? src.requireModelInRouting
      : true,
    renamedKeyHints: hints,
  };
}

/**
 * 解析 /proc/meminfo 文本。只认 MemAvailable（page cache 可回收，用 MemFree 会低估）。
 * 读不到 → { ok:false, unscanned:true }，不许当成余量无限。
 */
export function parseMeminfo(text) {
  if (typeof text !== 'string' || !text.trim()) {
    return { ok: false, unscanned: true, error: 'MemAvailable 读不出来（meminfo 空）' };
  }
  const m = text.match(/^MemAvailable:\s+(\d+)\s+kB/m);
  if (!m) return { ok: false, unscanned: true, error: 'MemAvailable 读不出来（没有这一行）' };
  const kb = Number(m[1]);
  if (!Number.isFinite(kb) || kb < 0) {
    return { ok: false, unscanned: true, error: 'MemAvailable 读不出来（不是数字）' };
  }
  return { ok: true, memAvailableMb: kb / 1024 };
}

/**
 * 解析 /proc/loadavg 文本 + nproc。归一化负载 = load1 / nproc。
 * 任一侧读不到 → unscanned。
 */
export function parseLoadavg(text, nproc) {
  if (typeof text !== 'string' || !text.trim()) {
    return { ok: false, unscanned: true, error: 'loadavg 读不出来（空）' };
  }
  const n = Number(nproc);
  if (!Number.isInteger(n) || n < 1) {
    return { ok: false, unscanned: true, error: 'nproc 读不出来（不是正整数）' };
  }
  const first = text.trim().split(/\s+/)[0];
  const load1 = Number(first);
  if (!Number.isFinite(load1) || load1 < 0) {
    return { ok: false, unscanned: true, error: 'loadavg 1 分钟值读不出来' };
  }
  return { ok: true, load1, nproc: n, loadNorm: load1 / n };
}

/**
 * 从相邻样本推单工人内存增量，取近 N 对的中位数。
 * 样本形如 { at, inFlight, memAvailableMb }。
 * 只认「在途数刚好差 1」的相邻对——差更多分不清是谁吃的。
 * 样本不足 / 对不够 → unscanned，调用方用 conservativeWorkerMb 收紧。
 */
export function estimateWorkerMb(samples, { minPairs = ADMISSION_DEFAULTS.minSamplePairs, window = ADMISSION_DEFAULTS.sampleWindow } = {}) {
  if (!Array.isArray(samples)) {
    return { ok: false, unscanned: true, error: '占用样本不是数组（没查成）', pairs: 0 };
  }
  const deltas = [];
  for (let i = 1; i < samples.length; i += 1) {
    const a = samples[i - 1];
    const b = samples[i];
    if (!a || !b) continue;
    const da = Number(a.inFlight);
    const db = Number(b.inFlight);
    const ma = Number(a.memAvailableMb);
    const mb = Number(b.memAvailableMb);
    if (![da, db, ma, mb].every(Number.isFinite)) continue;
    if (Math.abs(db - da) !== 1) continue;
    const per = Math.abs(ma - mb); // 在途 +1 时 MemAvailable 通常下降
    if (!Number.isFinite(per) || per <= 0) continue;
    deltas.push(per);
  }
  const used = deltas.slice(-window);
  if (used.length < minPairs) {
    return {
      ok: false,
      unscanned: true,
      error: `占用样本不足（有效对 ${used.length}，要 ≥ ${minPairs}）——按保守值收紧`,
      pairs: used.length,
    };
  }
  const sorted = [...used].sort((x, y) => x - y);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return { ok: true, workerMb: median, pairs: used.length };
}

/**
 * 在途真工人。跟 board-gc 同一把尺：
 *   - 主树 / 归档不算
 *   - 审官卡不算（审官不是烧机器的工人）
 *   - 僵尸卡（zombieIds）不算成真工人
 *   - 活着看 aliveIds：至少有一个会话判 active 的卡
 * worktrees / aliveIds / zombieIds 任一不是预期类型 → unscanned（fail-close，不当成 0 在途）。
 */
export function countLiveWorkers({ worktrees, aliveIds, zombieIds } = {}) {
  if (!Array.isArray(worktrees)) {
    return { ok: false, unscanned: true, error: '盘面没查成（worktrees 不是数组），在途数不当成 0', count: null };
  }
  if (!(aliveIds instanceof Set)) {
    return { ok: false, unscanned: true, error: '活性没查成（没给 alive 集合），在途数不当成 0', count: null };
  }
  if (!(zombieIds instanceof Set)) {
    return { ok: false, unscanned: true, error: '僵尸名单没查成（没给 zombie 集合），在途数不当成 0', count: null };
  }
  let count = 0;
  for (const w of worktrees) {
    if (!w || w.isMainWorktree === true || w.isArchived) continue;
    const id = w.worktreeId || w.id;
    if (!id) continue;
    const name = w.displayName || w.name || '';
    if (isReviewerCard(name)) continue;
    if (zombieIds.has(id)) continue;
    if (!aliveIds.has(id)) continue;
    count += 1;
  }
  return { ok: true, count };
}

function normPath(p) {
  return String(p || '').replace(/\\/g, '/').replace(/\/+$/, '');
}

/**
 * mirasim 工作树路径 → 工人 / 审官。布局是 `~/mirasim-worktrees/<仓>/<分支>`。
 * 认不出不猜（临时目录、baseline 树不是在途工人）。
 */
export function classifyMirasimTreePath(p) {
  const s = normPath(p);
  const r = /(?:^|\/)dao-review-pr-(\d+)$/.exec(s);
  if (r) return { kind: '审官', n: Number(r[1]), id: s };
  const w = /(?:^|\/)dao-(\d+)(?:-\d+)?$/.exec(s);
  if (w) return { kind: '工人', n: Number(w[1]), id: s };
  return null;
}

function matchTreePath(cwd, treePaths) {
  const c = normPath(cwd);
  if (!c) return null;
  let best = null;
  for (const p of treePaths) {
    const t = normPath(p);
    if (!t) continue;
    if (c === t || c.startsWith(`${t}/`)) {
      if (!best || t.length > best.length) best = t;
    }
  }
  return best;
}

/**
 * 用会话存活事实数在途真工人。treePaths 是两层枚举出来的绝对路径；
 * sessionFacts 是已经过 liveness 判定的 { cwd, state }。
 * 任一工人树对上 unscanned 会话 → 整闸 fail-close，不按目录数、不按「全部 alive」猜。
 */
export function countLiveWorkersFromSessionFacts({ treePaths, sessionFacts } = {}) {
  if (!Array.isArray(treePaths)) {
    return { ok: false, unscanned: true, error: '工作树清单没查成，在途数不当成 0', count: null };
  }
  if (!Array.isArray(sessionFacts)) {
    return { ok: false, unscanned: true, error: '会话存活事实没查成，在途数不当成 0', count: null };
  }
  const worktrees = [];
  for (const p of treePaths) {
    const c = classifyMirasimTreePath(p);
    if (!c) continue;
    worktrees.push({
      id: c.id,
      path: c.id,
      displayName: c.kind === '审官' ? `PR-${c.n} 审官` : `ISSUE-${c.n} 工人`,
      isMainWorktree: false,
      isArchived: false,
    });
  }
  const byTree = new Map();
  for (const fact of sessionFacts) {
    if (!fact) continue;
    const tree = matchTreePath(fact.cwd, treePaths);
    if (!tree) continue;
    if (!byTree.has(tree)) byTree.set(tree, []);
    byTree.get(tree).push(fact.state);
  }
  const aliveIds = new Set();
  const zombieIds = new Set();
  for (const w of worktrees) {
    if (isReviewerCard(w.displayName)) continue;
    const states = byTree.get(w.id) || [];
    if (states.includes('unscanned')) {
      return {
        ok: false,
        unscanned: true,
        error: `工作树 ${w.id} 活性没查成，在途数不当成猜测`,
        count: null,
      };
    }
    if (states.includes('active')) aliveIds.add(w.id);
    else if (states.length) zombieIds.add(w.id);
  }
  return countLiveWorkers({ worktrees, aliveIds, zombieIds });
}

/**
 * 还能收几个工人。纯函数，喂快照。
 *
 * slots = floor( min(
 *   (loadThreshold − loadNorm) / 不估 CPU 增量 → 负载只当闸：过线 = 0，没过线不按负载限张数
 *   (memAvailable − reserve − inFlight × workerMb) / workerMb
 * ) )
 *
 * CPU 是主闸（过线一张都不收），内存算还能塞几张。
 * 不引入「每轮最多 N 张」常量：余量够就按余量收，余量不够就 0。
 *
 * 返回 { ok, slots, why, unscanned?, renamedKeyHints }。
 * ok:false 时 slots 一律 0（fail-close）。
 */
export function admitCapacity({
  meminfoText,
  loadavgText,
  nproc,
  inFlight,
  samples,
  policy,
} = {}) {
  const pol = resolveAdmissionPolicy(policy);
  const hints = pol.renamedKeyHints;

  const mem = parseMeminfo(meminfoText);
  if (!mem.ok) {
    return { ok: false, unscanned: true, slots: 0, why: mem.error, renamedKeyHints: hints };
  }
  const load = parseLoadavg(loadavgText, nproc);
  if (!load.ok) {
    return { ok: false, unscanned: true, slots: 0, why: load.error, renamedKeyHints: hints };
  }
  if (!Number.isInteger(inFlight) || inFlight < 0) {
    return { ok: false, unscanned: true, slots: 0, why: '在途数没查成，不派', renamedKeyHints: hints };
  }

  const est = estimateWorkerMb(samples, {
    minPairs: pol.minSamplePairs,
    window: pol.sampleWindow,
  });
  const sampleUnscanned = !est.ok;
  const workerMb = est.ok ? est.workerMb : pol.conservativeWorkerMb;

  // 主闸：归一化负载已到阈值 → 一张都不收（再加人只会让所有人变慢）。
  if (load.loadNorm >= pol.loadThreshold) {
    return {
      ok: true,
      slots: 0,
      why: `归一化负载 ${load.loadNorm.toFixed(2)} ≥ 阈值 ${pol.loadThreshold}，机器已满，不收`,
      loadNorm: load.loadNorm,
      memAvailableMb: mem.memAvailableMb,
      workerMb,
      inFlight,
      sampleUnscanned,
      renamedKeyHints: hints,
    };
  }

  const headroomMb = mem.memAvailableMb - pol.memReserveMb - inFlight * workerMb;
  if (!Number.isFinite(headroomMb)) {
    return { ok: false, unscanned: true, slots: 0, why: '内存余量算不出，不派', renamedKeyHints: hints };
  }
  if (headroomMb <= 0) {
    return {
      ok: true,
      slots: 0,
      why: `内存余量 ${headroomMb.toFixed(0)}MB ≤ 0（可用 ${mem.memAvailableMb.toFixed(0)}MB − 预留 ${pol.memReserveMb}MB − 在途 ${inFlight}×${workerMb.toFixed(0)}MB），不收`,
      loadNorm: load.loadNorm,
      memAvailableMb: mem.memAvailableMb,
      workerMb,
      inFlight,
      sampleUnscanned,
      renamedKeyHints: hints,
    };
  }
  const slots = Math.floor(headroomMb / workerMb);
  const why = sampleUnscanned
    ? `${est.error}；按保守占用 ${workerMb}MB/人，还能收 ${slots} 张`
    : `负载 ${load.loadNorm.toFixed(2)} < ${pol.loadThreshold}，内存余量 ${headroomMb.toFixed(0)}MB，还能收 ${slots} 张`;
  return {
    ok: true,
    slots: Math.max(0, slots),
    why,
    loadNorm: load.loadNorm,
    memAvailableMb: mem.memAvailableMb,
    workerMb,
    inFlight,
    sampleUnscanned,
    renamedKeyHints: hints,
  };
}

/**
 * ready 优先级：从 issue 自身可读的事实推，不新增人工标。
 *
 * 1. 阻塞别人的（有别的开放单在正文里引用它 / 它是某张在途 PR 的前置）
 * 2. 机制自愈类（type/体系 之外，标题或标签指向指挥官/看门狗/派单链路本身）
 * 3. 其余按 issue 号升序
 *
 * 吃 issue 数组（+ 可选 openIssues / openPrs 作引用面），吐排好序的 number[]。
 * 入参不是数组 → 原样返回空（调用方按没查成处理，这里不猜）。
 */
const SELFHEAL_RE = /指挥官|看门狗|派单|commander|watchdog|dispatch|stall|board-gc|准入|熔断/;
const SELFHEAL_LABELS = new Set(['type/指挥官', 'type/看门狗', 'type/派单']);

function labelNamesOf(issue) {
  const labels = Array.isArray(issue?.labels) ? issue.labels : [];
  return labels.map((l) => (l && typeof l.name === 'string' ? l.name : '')).filter(Boolean);
}

function isFramework(issue) {
  return labelNamesOf(issue).includes('type/体系');
}

function isSelfHeal(issue) {
  if (isFramework(issue)) return false;
  const names = labelNamesOf(issue);
  if (names.some((n) => SELFHEAL_LABELS.has(n))) return true;
  const title = String(issue?.title || '');
  const body = String(issue?.body || '');
  return SELFHEAL_RE.test(title) || SELFHEAL_RE.test(body);
}

/** 从一段文本里抽出 #N 引用（不含本单自己的号）。 */
export function citedIssueNumbers(text, self) {
  const found = [];
  const re = /#(\d+)/g;
  let m;
  while ((m = re.exec(String(text || '')))) {
    const n = Number(m[1]);
    if (!Number.isInteger(n) || n < 1 || n === self) continue;
    if (!found.includes(n)) found.push(n);
  }
  return found;
}

function blockingSet(readyIssues, openIssues, openPrs) {
  const cited = new Set();
  const others = Array.isArray(openIssues) ? openIssues : readyIssues;
  for (const i of others) {
    if (!i || typeof i.number !== 'number') continue;
    const text = `${i.title || ''}\n${i.body || ''}`;
    for (const n of citedIssueNumbers(text, i.number)) cited.add(n);
  }
  for (const p of Array.isArray(openPrs) ? openPrs : []) {
    const text = `${p?.title || ''}\n${p?.body || ''}`;
    for (const n of citedIssueNumbers(text, null)) cited.add(n);
  }
  return cited;
}

export function prioritizeReady(issues, { openIssues, openPrs } = {}) {
  if (!Array.isArray(issues)) return [];
  const blocking = blockingSet(issues, openIssues, openPrs);
  const rows = issues
    .filter((i) => i && typeof i.number === 'number')
    .map((i) => {
      const blockedByOthers = blocking.has(i.number);
      const selfHeal = isSelfHeal(i);
      const rank = blockedByOthers ? 0 : selfHeal ? 1 : 2;
      return { n: i.number, rank };
    });
  rows.sort((a, b) => (a.rank - b.rank) || (a.n - b.n));
  return rows.map((r) => r.n);
}
