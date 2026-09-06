// #1007 派单准入 + ready 优先级。纯函数夹具，不碰 /proc / GitHub。
const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

const REPO = path.resolve(__dirname, '..');
const ADMIT = import('file://' + path.join(REPO, 'scripts', 'lib', 'admission.mjs').replace(/\\/g, '/'));
const CORE = import('file://' + path.join(REPO, 'scripts', 'lib', 'commander-core.mjs').replace(/\\/g, '/'));

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
