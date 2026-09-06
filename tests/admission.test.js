// #1007 派单准入 + ready 优先级。纯函数夹具，不碰 /proc / GitHub。
const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const REPO = path.resolve(__dirname, '..');
const toUrl = (p) => 'file://' + p.replace(/\\/g, '/');
const ADMIT = import(toUrl(path.join(REPO, 'scripts', 'lib', 'admission.mjs')));
const CORE = import(toUrl(path.join(REPO, 'scripts', 'lib', 'commander-core.mjs')));
const POLICY_CHECK = import(toUrl(path.join(REPO, 'scripts', 'lib', 'dispatch-policy-check.mjs')));
const COMMANDER = () => import(toUrl(path.join(REPO, 'scripts', 'commander.mjs')));

function meminfo(availKb) {
  return `MemTotal:       12247040 kB\nMemFree:          1000000 kB\nMemAvailable:    ${availKb} kB\n`;
}
function loadavg(load1) {
  return `${load1} 0.50 0.40 1/200 12345\n`;
}
function samplesFromPairs(pairs) {
  // pairs: [{inFlight, memAvailableMb}, ...] 相邻差 1 才算有效对
  return pairs.map((p, i) => ({ at: `2026-09-06T0${i}:00:00Z`, ...p }));
}
const ENOUGH_SAMPLES = samplesFromPairs([
  { inFlight: 1, memAvailableMb: 8000 },
  { inFlight: 2, memAvailableMb: 7800 },
  { inFlight: 3, memAvailableMb: 7600 },
  { inFlight: 4, memAvailableMb: 7400 },
  { inFlight: 5, memAvailableMb: 7200 },
]);

function baseSituation(over = {}) {
  return {
    github: { scanned: true, issues: [], prs: [] },
    orca: { scanned: true, worktrees: [] },
    reviewPending: { scanned: true, items: [] },
    prReviews: { scanned: true, byPr: {} },
    stall: { scanned: true, strikes: {} },
    wakeCounts: {},
    reworkDispatched: {},
    commanderPolicy: { requireModelInRouting: false },
    routingModels: ['grok-4.6', 'deepseek-v4-flash', 'gpt-5.6-sol'],
    healthRedModels: [],
    ...over,
  };
}
function readyIssue(n, extraLabels = [], extra = {}) {
  return {
    number: n,
    title: extra.title || `单 ${n}`,
    body: extra.body || '',
    labels: [
      { name: '已消歧' }, { name: 'model/grok-4.6' }, { name: 'reviewer/gpt-5.6-sol' }, { name: 'type/写码' },
      ...extraLabels.map((name) => ({ name })),
    ],
  };
}
const byKind = (r, k) => r.actions.filter((a) => a.kind === k);

describe('parseMeminfo / parseLoadavg', () => {
  it('MemAvailable 正常 → ok', async () => {
    const { parseMeminfo } = await ADMIT;
    const r = parseMeminfo(meminfo(8101888));
    assert.equal(r.ok, true);
    assert.equal(Math.round(r.memAvailableMb), 7912);
  });
  it('没有 MemAvailable 行 → unscanned', async () => {
    const { parseMeminfo } = await ADMIT;
    const r = parseMeminfo('MemTotal: 100 kB\nMemFree: 10 kB\n');
    assert.equal(r.ok, false);
    assert.equal(r.unscanned, true);
  });
  it('空文本 → unscanned', async () => {
    const { parseMeminfo } = await ADMIT;
    const r = parseMeminfo('');
    assert.equal(r.ok, false);
    assert.equal(r.unscanned, true);
  });
  it('loadavg + nproc → 归一化负载', async () => {
    const { parseLoadavg } = await ADMIT;
    const r = parseLoadavg(loadavg(6.29), 6);
    assert.equal(r.ok, true);
    assert.equal(Number(r.loadNorm.toFixed(2)), 1.05);
  });
  it('nproc 不是正整数 → unscanned', async () => {
    const { parseLoadavg } = await ADMIT;
    const r = parseLoadavg(loadavg(1), 0);
    assert.equal(r.ok, false);
    assert.equal(r.unscanned, true);
  });
});

describe('estimateWorkerMb', () => {
  it('相邻在途差 1 的对够数 → 中位数', async () => {
    const { estimateWorkerMb } = await ADMIT;
    const r = estimateWorkerMb(ENOUGH_SAMPLES, { minPairs: 4, window: 12 });
    assert.equal(r.ok, true);
    assert.equal(r.workerMb, 200);
  });
  it('样本不足 → unscanned，不放开', async () => {
    const { estimateWorkerMb } = await ADMIT;
    const r = estimateWorkerMb(samplesFromPairs([
      { inFlight: 1, memAvailableMb: 8000 },
      { inFlight: 2, memAvailableMb: 7800 },
    ]), { minPairs: 4 });
    assert.equal(r.ok, false);
    assert.equal(r.unscanned, true);
    assert.equal(r.pairs, 1);
  });
  it('不是数组 → unscanned', async () => {
    const { estimateWorkerMb } = await ADMIT;
    const r = estimateWorkerMb(null);
    assert.equal(r.ok, false);
    assert.equal(r.unscanned, true);
  });
});

describe('countLiveWorkers：僵尸卡不算真工人', () => {
  it('活着的工人计数；僵尸 / 审官 / 主树排除', async () => {
    const { countLiveWorkers } = await ADMIT;
    const worktrees = [
      { id: 'main', isMainWorktree: true, displayName: 'master' },
      { id: 'w1', displayName: 'ISSUE-1 工人·grok' },
      { id: 'w2', displayName: 'ISSUE-2 工人·grok' },
      { id: 'z1', displayName: 'ISSUE-9 工人·grok' },
      { id: 'r1', displayName: 'PR-10 审官·luna' },
    ];
    const r = countLiveWorkers({
      worktrees,
      aliveIds: new Set(['w1', 'w2', 'z1', 'r1']),
      zombieIds: new Set(['z1']),
    });
    assert.equal(r.ok, true);
    assert.equal(r.count, 2);
  });
  it('没给 alive 集合 → unscanned，count 不是 0', async () => {
    const { countLiveWorkers } = await ADMIT;
    const r = countLiveWorkers({ worktrees: [], zombieIds: new Set() });
    assert.equal(r.ok, false);
    assert.equal(r.unscanned, true);
    assert.equal(r.count, null);
  });
});

describe('admitCapacity', () => {
  it('内存吃紧 → slots=0，即使队列再长', async () => {
    const { admitCapacity } = await ADMIT;
    const r = admitCapacity({
      meminfoText: meminfo(200 * 1024), // 200MB 可用
      loadavgText: loadavg(0.5),
      nproc: 6,
      inFlight: 4,
      samples: ENOUGH_SAMPLES,
      policy: { loadThreshold: 0.85, memReserveMb: 1536, conservativeWorkerMb: 400 },
    });
    assert.equal(r.ok, true);
    assert.equal(r.slots, 0);
  });
  it('负载已满 → slots=0（主闸是 CPU）', async () => {
    const { admitCapacity } = await ADMIT;
    const r = admitCapacity({
      meminfoText: meminfo(8000 * 1024),
      loadavgText: loadavg(6.29),
      nproc: 6,
      inFlight: 4,
      samples: ENOUGH_SAMPLES,
      policy: { loadThreshold: 0.85, memReserveMb: 1536 },
    });
    assert.equal(r.ok, true);
    assert.equal(r.slots, 0);
    assert.match(r.why, /归一化负载/);
  });
  it('余量充足 → 一轮收多张，且张数随余量变', async () => {
    const { admitCapacity } = await ADMIT;
    const pol = { loadThreshold: 0.85, memReserveMb: 1536 };
    const a = admitCapacity({
      meminfoText: meminfo(8000 * 1024),
      loadavgText: loadavg(1.0),
      nproc: 6,
      inFlight: 2,
      samples: ENOUGH_SAMPLES,
      policy: pol,
    });
    const b = admitCapacity({
      meminfoText: meminfo(4000 * 1024),
      loadavgText: loadavg(1.0),
      nproc: 6,
      inFlight: 2,
      samples: ENOUGH_SAMPLES,
      policy: pol,
    });
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    assert.ok(a.slots > 1, `余量充足应收多张，实际 ${a.slots}`);
    assert.ok(a.slots > b.slots, `余量更大应收更多：${a.slots} vs ${b.slots}`);
  });
  it('MemAvailable 读不出来 → 不派，报没查成', async () => {
    const { admitCapacity } = await ADMIT;
    const r = admitCapacity({
      meminfoText: 'MemTotal: 1 kB\n',
      loadavgText: loadavg(0.2),
      nproc: 6,
      inFlight: 0,
      samples: ENOUGH_SAMPLES,
    });
    assert.equal(r.ok, false);
    assert.equal(r.unscanned, true);
    assert.equal(r.slots, 0);
  });
  it('样本不足 → 按保守占用收紧，标 sampleUnscanned', async () => {
    const { admitCapacity } = await ADMIT;
    const r = admitCapacity({
      meminfoText: meminfo(8000 * 1024),
      loadavgText: loadavg(0.5),
      nproc: 6,
      inFlight: 0,
      samples: [],
      policy: { conservativeWorkerMb: 400, memReserveMb: 1536, loadThreshold: 0.85 },
    });
    assert.equal(r.ok, true);
    assert.equal(r.sampleUnscanned, true);
    assert.equal(r.workerMb, 400);
    assert.match(r.why, /样本不足|保守/);
  });
  it('在途数不是整数 → 不派', async () => {
    const { admitCapacity } = await ADMIT;
    const r = admitCapacity({
      meminfoText: meminfo(8000 * 1024),
      loadavgText: loadavg(0.2),
      nproc: 6,
      inFlight: null,
      samples: ENOUGH_SAMPLES,
    });
    assert.equal(r.ok, false);
    assert.equal(r.slots, 0);
    assert.equal(r.unscanned, true);
  });
  it('读到旧键 maxDispatchPerRound → 提示已改名，且不按它限流', async () => {
    const { admitCapacity, RENAMED_KEY_HINT } = await ADMIT;
    const r = admitCapacity({
      meminfoText: meminfo(8000 * 1024),
      loadavgText: loadavg(0.5),
      nproc: 6,
      inFlight: 0,
      samples: ENOUGH_SAMPLES,
      policy: { maxDispatchPerRound: 1, loadThreshold: 0.85, memReserveMb: 1536 },
    });
    assert.equal(r.ok, true);
    assert.ok(r.slots > 1, `旧键不许限流，实际 slots=${r.slots}`);
    assert.ok(r.renamedKeyHints.includes(RENAMED_KEY_HINT));
  });
});

describe('prioritizeReady', () => {
  it('被别的开放单引用的先于号更小的普通单', async () => {
    const { prioritizeReady } = await ADMIT;
    const a = { number: 10, title: '普通', body: '', labels: [{ name: 'type/写码' }] };
    const b = { number: 99, title: '被引用', body: '', labels: [{ name: 'type/写码' }] };
    const citer = { number: 200, title: '依赖 #99', body: '等 #99 合了才能动', labels: [] };
    const ordered = prioritizeReady([a, b], { openIssues: [a, b, citer] });
    assert.deepEqual(ordered, [99, 10]);
  });
  it('全部无引用 → 退回号升序', async () => {
    const { prioritizeReady } = await ADMIT;
    const issues = [
      { number: 30, title: 'c', labels: [{ name: 'type/写码' }] },
      { number: 10, title: 'a', labels: [{ name: 'type/写码' }] },
      { number: 20, title: 'b', labels: [{ name: 'type/写码' }] },
    ];
    assert.deepEqual(prioritizeReady(issues), [10, 20, 30]);
  });
  it('机制自愈类（标题含指挥官）排在普通单前面、阻塞单后面', async () => {
    const { prioritizeReady } = await ADMIT;
    const block = { number: 50, title: '被引用', labels: [{ name: 'type/写码' }] };
    const heal = { number: 80, title: '指挥官派单准入坏了', labels: [{ name: 'type/写码' }] };
    const plain = { number: 10, title: '普通', labels: [{ name: 'type/写码' }] };
    const citer = { number: 200, title: '等 #50', body: '#50', labels: [] };
    assert.deepEqual(
      prioritizeReady([plain, heal, block], { openIssues: [plain, heal, block, citer] }),
      [50, 80, 10],
    );
  });
  it('type/体系 不算自愈（框架活不进自动队列，排序也不抬）', async () => {
    const { prioritizeReady } = await ADMIT;
    const fw = { number: 5, title: '指挥官重构', labels: [{ name: 'type/体系' }] };
    const plain = { number: 20, title: '普通', labels: [{ name: 'type/写码' }] };
    assert.deepEqual(prioritizeReady([plain, fw]), [5, 20]);
  });
});

describe('decide 接线：准入 + 优先级', () => {
  it('喂内存吃紧的 admission → 10 张 ready 一张都不派', async () => {
    const { decide } = await CORE;
    const issues = Array.from({ length: 10 }, (_, i) => readyIssue(2000 + i));
    const r = decide(baseSituation({
      github: { scanned: true, issues, prs: [] },
      admission: { ok: true, slots: 0, why: '内存吃紧' },
    }));
    assert.equal(byKind(r, 'dispatch').length, 0);
    assert.ok(byKind(r, 'notify-hub').some((a) => /余量不够/.test(a.subject)));
  });
  it('余量充足 slots=5 → 一轮派 5 张，不是固定 2', async () => {
    const { decide } = await CORE;
    const issues = Array.from({ length: 10 }, (_, i) => readyIssue(2100 + i));
    const r = decide(baseSituation({
      github: { scanned: true, issues, prs: [] },
      admission: { ok: true, slots: 5, why: '余量充足' },
    }));
    assert.equal(byKind(r, 'dispatch').length, 5);
    assert.deepEqual(byKind(r, 'dispatch').map((a) => a.issue), [2100, 2101, 2102, 2103, 2104]);
  });
  it('slots 随余量变：3 和 7 派的张数不同', async () => {
    const { decide } = await CORE;
    const issues = Array.from({ length: 10 }, (_, i) => readyIssue(2200 + i));
    const a = decide(baseSituation({
      github: { scanned: true, issues, prs: [] },
      admission: { ok: true, slots: 3 },
    }));
    const b = decide(baseSituation({
      github: { scanned: true, issues, prs: [] },
      admission: { ok: true, slots: 7 },
    }));
    assert.equal(byKind(a, 'dispatch').length, 3);
    assert.equal(byKind(b, 'dispatch').length, 7);
  });
  it('admission.ok=false → 不派，escalate admission-unscanned', async () => {
    const { decide } = await CORE;
    const issues = [readyIssue(2300), readyIssue(2301)];
    const r = decide(baseSituation({
      github: { scanned: true, issues, prs: [] },
      admission: { ok: false, unscanned: true, slots: 0, why: 'MemAvailable 读不出来' },
    }));
    assert.equal(byKind(r, 'dispatch').length, 0);
    assert.ok(byKind(r, 'escalate').some((a) => a.reason === 'admission-unscanned'));
  });
  it('被引用的 ready 单先于号更小的普通单', async () => {
    const { decide } = await CORE;
    const cited = readyIssue(99, [], { title: '被引用的前置' });
    const small = readyIssue(10, [], { title: '号更小的普通单' });
    const citer = { number: 300, title: '依赖 #99', body: '等 #99', labels: [{ name: '已消歧' }] };
    const r = decide(baseSituation({
      github: { scanned: true, issues: [small, cited, citer], prs: [] },
      admission: { ok: true, slots: 1 },
    }));
    const d = byKind(r, 'dispatch');
    assert.equal(d.length, 1);
    assert.equal(d[0].issue, 99);
  });
  it('读到旧键 → 回流「已改名」，且不按 1 张限流', async () => {
    const { decide, RENAMED_KEY_HINT } = await CORE;
    const issues = Array.from({ length: 5 }, (_, i) => readyIssue(2400 + i));
    const r = decide(baseSituation({
      github: { scanned: true, issues, prs: [] },
      commanderPolicy: { maxDispatchPerRound: 1, requireModelInRouting: false },
      admission: { ok: true, slots: 4 },
    }));
    assert.equal(byKind(r, 'dispatch').length, 4, '旧键不许限流');
    assert.ok(byKind(r, 'notify-hub').some((a) => a.subject === RENAMED_KEY_HINT));
  });
});

describe('全流程 grep 不到派几个的可填常量', () => {
  it('策略文件 commander 节没有「派几个」可填常量', () => {
    const doc = JSON.parse(fs.readFileSync(path.join(REPO, 'docs', 'dispatch-policy.json'), 'utf8'));
    const cm = doc.commander || {};
    assert.equal(Object.prototype.hasOwnProperty.call(cm, 'maxDispatchPerRound'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(cm, 'maxInFlightWorkers'), false);
  });
  it('COMMANDER_POLICY_DEFAULTS 没有这两个键', async () => {
    const { COMMANDER_POLICY_DEFAULTS } = await CORE;
    assert.equal(Object.prototype.hasOwnProperty.call(COMMANDER_POLICY_DEFAULTS, 'maxDispatchPerRound'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(COMMANDER_POLICY_DEFAULTS, 'maxInFlightWorkers'), false);
  });
});

describe('classifyMirasimTreePath / countLiveWorkersFromSessionFacts', () => {
  it('两层路径认出工人 / 审官；临时目录不猜', async () => {
    const { classifyMirasimTreePath } = await ADMIT;
    assert.deepEqual(classifyMirasimTreePath('/home/orca/mirasim-worktrees/windsurf-dao/dao-1007'), {
      kind: '工人', n: 1007, id: '/home/orca/mirasim-worktrees/windsurf-dao/dao-1007',
    });
    assert.deepEqual(classifyMirasimTreePath('/home/orca/mirasim-worktrees/windsurf-dao/dao-1007-2'), {
      kind: '工人', n: 1007, id: '/home/orca/mirasim-worktrees/windsurf-dao/dao-1007-2',
    });
    assert.deepEqual(classifyMirasimTreePath('/home/orca/mirasim-worktrees/windsurf-dao/dao-review-pr-1064'), {
      kind: '审官', n: 1064, id: '/home/orca/mirasim-worktrees/windsurf-dao/dao-review-pr-1064',
    });
    assert.equal(classifyMirasimTreePath('/home/orca/mirasim-worktrees/windsurf-dao'), null);
    assert.equal(classifyMirasimTreePath('/tmp/dao-1064-check'), null);
  });

  it('只数对上 active 会话的工人树；僵尸 / 审官 / 一层仓目录不算', async () => {
    const { countLiveWorkersFromSessionFacts } = await ADMIT;
    const root = '/home/orca/mirasim-worktrees/windsurf-dao';
    const treePaths = [
      root, // 一层仓目录：认不出，不进在途
      `${root}/dao-1007`,
      `${root}/dao-1008`,
      `${root}/dao-review-pr-1064`,
      `${root}/tmp-scratch`,
    ];
    const r = countLiveWorkersFromSessionFacts({
      treePaths,
      sessionFacts: [
        { cwd: `${root}/dao-1007`, state: 'active' },
        { cwd: `${root}/dao-1008`, state: 'silent' }, // 僵尸，不算真工人
        { cwd: `${root}/dao-review-pr-1064`, state: 'active' }, // 审官不算
        { cwd: `${root}/dao-1007/scripts`, state: 'active' }, // 同一棵树，不双计
      ],
    });
    assert.equal(r.ok, true);
    assert.equal(r.count, 1);
  });

  it('工人树对上 unscanned 会话 → 整闸 fail-close，不当成目录数', async () => {
    const { countLiveWorkersFromSessionFacts } = await ADMIT;
    const tree = '/home/orca/mirasim-worktrees/windsurf-dao/dao-1007';
    const r = countLiveWorkersFromSessionFacts({
      treePaths: [tree],
      sessionFacts: [{ cwd: tree, state: 'unscanned' }],
    });
    assert.equal(r.ok, false);
    assert.equal(r.unscanned, true);
    assert.equal(r.count, null);
    assert.match(r.error, /没查成/);
  });

  it('会话事实不是数组 → 不当成 0 在途', async () => {
    const { countLiveWorkersFromSessionFacts } = await ADMIT;
    const r = countLiveWorkersFromSessionFacts({
      treePaths: ['/home/orca/mirasim-worktrees/windsurf-dao/dao-1007'],
      sessionFacts: null,
    });
    assert.equal(r.ok, false);
    assert.equal(r.unscanned, true);
    assert.equal(r.count, null);
  });
});

function writeTree(root, rel) {
  fs.mkdirSync(path.join(root, rel), { recursive: true });
  return path.join(root, rel);
}
function writeSession(root, agent, id, rec) {
  const dir = path.join(root, agent, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'record.json'), JSON.stringify(rec), 'utf8');
}

describe('enumerateMirasimWorktrees / collectMirasimSessionFacts / countInflightWorkers', () => {
  it('两层枚举；一层仓目录本身不进清单', async () => {
    const { enumerateMirasimWorktrees } = await COMMANDER();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mira-trees-'));
    writeTree(root, 'windsurf-dao/dao-1007');
    writeTree(root, 'windsurf-dao/dao-1008');
    writeTree(root, 'windsurf-dao/dao-review-pr-1064');
    writeTree(root, 'other-repo/dao-1010');
    const r = enumerateMirasimWorktrees(root);
    assert.equal(r.ok, true);
    const names = r.paths.map((p) => p.replace(/\\/g, '/').split('/').slice(-2).join('/')).sort();
    assert.deepEqual(names, [
      'other-repo/dao-1010',
      'windsurf-dao/dao-1007',
      'windsurf-dao/dao-1008',
      'windsurf-dao/dao-review-pr-1064',
    ]);
    assert.ok(!r.paths.some((p) => /windsurf-dao$/.test(p.replace(/\\/g, '/'))),
      '一层仓目录不许进清单——那会把多棵树算成 1');
  });

  it('工作树根不在 → fail-close，不当成 0 在途', async () => {
    const { enumerateMirasimWorktrees } = await COMMANDER();
    const r = enumerateMirasimWorktrees(path.join(os.tmpdir(), 'mira-missing-' + Date.now()));
    assert.equal(r.ok, false);
    assert.equal(r.unscanned, true);
  });

  it('record 读不了 → 整闸没查成，不当成活着', async () => {
    const { collectMirasimSessionFacts } = await COMMANDER();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mira-sess-'));
    const dir = path.join(root, 'pi', 'bad');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'record.json'), '{not-json', 'utf8');
    const r = collectMirasimSessionFacts(root);
    assert.equal(r.ok, false);
    assert.equal(r.unscanned, true);
    assert.match(r.error, /record 读不了/);
  });

  it('生产入口：orca 卡面空时按会话存活数，不按仓目录数、不把僵尸当活', async () => {
    const { countInflightWorkers } = await COMMANDER();
    const trees = fs.mkdtempSync(path.join(os.tmpdir(), 'mira-inflight-t-'));
    const sess = fs.mkdtempSync(path.join(os.tmpdir(), 'mira-inflight-s-'));
    const w1 = writeTree(trees, 'windsurf-dao/dao-1007');
    const w2 = writeTree(trees, 'windsurf-dao/dao-1008');
    writeTree(trees, 'windsurf-dao/dao-review-pr-1064');
    writeSession(sess, 'pi', 'alive', {
      sessionId: 'alive', workdir: w1, runState: 'incomplete',
      updatedAt: new Date().toISOString(),
    });
    writeSession(sess, 'pi', 'zombie', {
      sessionId: 'zombie', workdir: w2, runState: 'incomplete',
      updatedAt: '2020-01-01T00:00:00.000Z', // 远超静默阈值 → silent，不算真工人
    });
    writeSession(sess, 'pi', 'reviewer', {
      sessionId: 'reviewer',
      workdir: path.join(trees, 'windsurf-dao', 'dao-review-pr-1064'),
      runState: 'incomplete',
      updatedAt: new Date().toISOString(),
    });
    const r = countInflightWorkers({ worktrees: [], treeRoot: trees, sessionsRoot: sess });
    assert.equal(r.ok, true, r.error);
    assert.equal(r.count, 1, '只算 active 工人；僵尸 + 审官 + 仓目录都不算');
  });

  it('orca 只返回主树时仍走 mirasim 会话数，不当成 0 在途放开闸', async () => {
    const { countInflightWorkers } = await COMMANDER();
    const trees = fs.mkdtempSync(path.join(os.tmpdir(), 'mira-main-t-'));
    const sess = fs.mkdtempSync(path.join(os.tmpdir(), 'mira-main-s-'));
    const w1 = writeTree(trees, 'windsurf-dao/dao-1007');
    writeSession(sess, 'pi', 'alive', {
      sessionId: 'alive', workdir: w1, runState: 'incomplete',
      updatedAt: new Date().toISOString(),
    });
    const r = countInflightWorkers({
      worktrees: [{ id: 'main', isMainWorktree: true, displayName: 'master' }],
      treeRoot: trees,
      sessionsRoot: sess,
    });
    assert.equal(r.ok, true, r.error);
    assert.equal(r.count, 1);
  });
});

describe('dispatch-policy-check：minSamplePairs / sampleWindow 故意违规当场拦', () => {
  const BASE = {
    preflight: { enabled: true, timeoutMs: 5000, maxCandidates: 4, useHealthTable: true },
    breaker: { windowHours: 24, failuresToTrip: 3, cooldownHours: 24, halfOpenProbes: 1 },
    hubChat: {
      enabled: true,
      allowedActions: ['situation', 'decision', 'guide'],
      upstream: { redThreshold: 2, decisions: true, digest: false },
    },
  };

  it('minSamplePairs: 0 红，不是绿后静默回退', async () => {
    const { inspectDispatchPolicySource } = await POLICY_CHECK;
    const r = inspectDispatchPolicySource(JSON.stringify({
      ...BASE,
      commander: { requireModelInRouting: true, minSamplePairs: 0 },
    }));
    assert.equal(r.ok, false);
    assert.equal(r.unscanned, false);
    assert.ok(r.problems.some((p) => /minSamplePairs/.test(p)), JSON.stringify(r.problems));
  });

  it('sampleWindow: 1 红', async () => {
    const { inspectDispatchPolicySource } = await POLICY_CHECK;
    const r = inspectDispatchPolicySource(JSON.stringify({
      ...BASE,
      commander: { requireModelInRouting: true, sampleWindow: 1 },
    }));
    assert.equal(r.ok, false);
    assert.equal(r.unscanned, false);
    assert.ok(r.problems.some((p) => /sampleWindow/.test(p)), JSON.stringify(r.problems));
  });

  it('合范围的余量参数过校验', async () => {
    const { inspectDispatchPolicySource } = await POLICY_CHECK;
    const r = inspectDispatchPolicySource(JSON.stringify({
      ...BASE,
      commander: {
        requireModelInRouting: true,
        loadThreshold: 0.85,
        memReserveMb: 1536,
        conservativeWorkerMb: 400,
        minSamplePairs: 4,
        sampleWindow: 12,
      },
    }));
    assert.equal(r.ok, true, JSON.stringify(r.problems));
  });
});
