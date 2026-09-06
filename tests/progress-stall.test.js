// tests/progress-stall.test.js —— 盘面推进量判别力（chain:progress-stall#0 / #1004）
//
// 正反样本：真实停滞窗口必须报 PR #909；正在推进 / 全空闲 / 只是总数不变
// 都不许报；同一指纹只推一次；读不清必须说没查成。不出网。
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..');
const LIB = path.join(REPO, 'scripts', 'lib', 'progress-detect.mjs');
const CLI = path.join(REPO, 'scripts', 'progress-watch.mjs');
const BOARD = path.join(REPO, 'scripts', 'lib', 'now-board.mjs');
const INV = path.join(REPO, 'scripts', 'lib', 'commander-inventory.mjs');
const STALL_FIXTURE = path.join(REPO, 'tests', 'fixtures', 'progress-stall', 'stall-2026-09-06-02-31-to-03-51.json');
const MOVING_FIXTURE = path.join(REPO, 'tests', 'fixtures', 'progress-stall', 'moving-2026-09-06-05-11-to-05-19.json');
const load = (p) => import('file://' + p.replace(/\\/g, '/'));

function readFixture(p) {
  const doc = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.ok(Array.isArray(doc.snapshots), p);
  return doc.snapshots;
}

function emptySnap() {
  return {
    github: { scanned: true, prs: [], issues: [] },
    orca: { scanned: true, worktrees: [] },
    reviewPending: { scanned: true, items: [] },
  };
}

function prSnap(prs) {
  return {
    github: { scanned: true, prs, issues: [] },
    orca: { scanned: true, worktrees: [] },
    reviewPending: { scanned: true, items: [] },
  };
}

describe('progress-detect：真实语料', () => {
  it('02:31→03:51 连续 5 轮必须判出 PR #909 没动', async () => {
    const S = await load(LIB);
    const snaps = readFixture(STALL_FIXTURE);
    assert.equal(snaps.length, 5);
    const got = S.detectProgressStall(snaps, { minRounds: 5 });
    assert.equal(got.scanned, true, got.error);
    assert.equal(got.stalled, true, JSON.stringify(got));
    assert.equal(got.rounds, 5);
    const pr909 = got.items.find((i) => i.kind === 'pr' && String(i.id) === '909');
    assert.ok(pr909, '必须点名 PR #909：' + got.items.map((i) => i.key).join(','));
    assert.match(pr909.why, /PR #909 连续 5 轮没动/);
  });

  it('05:11→05:19 PR 从 8 降到 7、树在变，不许报停滞', async () => {
    const S = await load(LIB);
    const snaps = readFixture(MOVING_FIXTURE);
    const got = S.detectProgressStall(snaps, { minRounds: snaps.length });
    assert.equal(got.scanned, true, got.error);
    assert.equal(got.stalled, false, '树在变还报停滞：' + JSON.stringify(got.items?.map((i) => i.key)));
    assert.equal(got.reason, 'progress');
  });
});

describe('progress-detect：误报闸与逐对象', () => {
  it('全空闲 20 轮不许报停滞', async () => {
    const S = await load(LIB);
    const snaps = Array.from({ length: 20 }, emptySnap);
    const got = S.detectProgressStall(snaps, { minRounds: 20 });
    assert.equal(got.scanned, true);
    assert.equal(got.stalled, false);
    assert.equal(got.reason, 'idle');
    assert.equal(got.items.length, 0);
  });

  it('聚合计数都是 8、但逐对象在换（#A 合了 #B 新开）不许报停滞', async () => {
    const S = await load(LIB);
    const snaps = [];
    for (let i = 0; i < 5; i++) {
      const prs = [];
      for (let k = 0; k < 8; k++) {
        prs.push({
          number: 100 + i + k,
          headRefOid: `oid-${i}-${k}`,
          mergeable: 'MERGEABLE',
          isDraft: false,
          reviewDecision: null,
        });
      }
      snaps.push(prSnap(prs));
    }
    const got = S.detectProgressStall(snaps, { minRounds: 5 });
    assert.equal(got.scanned, true);
    assert.equal(got.stalled, false, '换对象还当停滞说明在比总数');
    assert.equal(got.reason, 'progress');
  });

  it('快照不是数组 / 段没查成 → 没查成，不是没停滞', async () => {
    const S = await load(LIB);
    const bad = S.detectProgressStall(null);
    assert.equal(bad.scanned, false);
    assert.equal(bad.stalled, false);
    assert.match(bad.error, /没查成/);
    const half = S.detectProgressStall([
      { github: { scanned: false, error: 'gh 超时' }, orca: { scanned: true, worktrees: [] }, reviewPending: { scanned: true, items: [] } },
    ], { minRounds: 1 });
    assert.equal(half.scanned, false);
    assert.match(half.error, /没查成/);
  });
});

describe('progress-detect：推帅位指纹', () => {
  it('同一停滞指纹只推一次；指纹变了允许再推', async () => {
    const S = await load(LIB);
    const snaps = readFixture(STALL_FIXTURE);
    const first = S.detectProgressStall(snaps, { minRounds: 5 });
    assert.equal(first.stalled, true);
    const w1 = S.planWake({ fingerprint: first.fingerprint, prevFingerprint: null, stalled: true });
    assert.equal(w1.wake, true);
    assert.equal(w1.reason, 'first');
    const w2 = S.planWake({ fingerprint: first.fingerprint, prevFingerprint: first.fingerprint, stalled: true });
    assert.equal(w2.wake, false);
    assert.equal(w2.reason, 'same-fingerprint');
    const changed = `${first.fingerprint}\nextra`;
    const w3 = S.planWake({ fingerprint: changed, prevFingerprint: first.fingerprint, stalled: true });
    assert.equal(w3.wake, true);
    assert.equal(w3.reason, 'fingerprint-changed');
  });
});

describe('progress-watch：驱动三态', () => {
  it('目录空必须报没查成，exit 2，不许输出叫醒哨兵', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'progress-empty-'));
    const state = path.join(dir, 'state.json');
    const r = spawnSync(process.execPath, [CLI, '--dir', dir, '--state', state], {
      encoding: 'utf8',
      timeout: 10000,
      windowsHide: true,
    });
    assert.equal(r.status, 2);
    assert.match(String(r.stderr || ''), /没查成/);
    assert.doesNotMatch(String(r.stdout || ''), /AGENT_LOOP_TICK_PANMIAN/);
  });

  it('文件损坏必须报没查成，不许当成没停滞', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'progress-bad-'));
    fs.writeFileSync(path.join(dir, 'situation-2026-09-06T00-00-00-000Z.json'), '{', 'utf8');
    const state = path.join(dir, 'state.json');
    const r = spawnSync(process.execPath, [CLI, '--dir', dir, '--state', state, '--json'], {
      encoding: 'utf8',
      timeout: 10000,
      windowsHide: true,
    });
    assert.equal(r.status, 2);
    assert.match(String(r.stderr || ''), /没查成/);
    assert.doesNotMatch(String(r.stdout || ''), /AGENT_LOOP_TICK_PANMIAN/);
  });

  it('真实停滞窗口首次推帅位；同一指纹第二轮不推', async () => {
    const W = await load(CLI);
    const snaps = readFixture(STALL_FIXTURE);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'progress-wake-'));
    snaps.forEach((s, i) => {
      fs.writeFileSync(path.join(dir, `situation-2026-09-06T0${i}-00-00-000Z.json`), JSON.stringify(s), 'utf8');
    });
    const state = path.join(dir, 'state.json');
    const a = W.runProgressWatch({ dir, state, rounds: 5, dryRun: false });
    assert.equal(a.ok, true, a.error);
    assert.equal(a.stalled, true);
    assert.equal(a.wake, true);
    assert.match(a.report, /PR #909/);
    const b = W.runProgressWatch({ dir, state, rounds: 5, dryRun: false });
    assert.equal(b.ok, true, b.error);
    assert.equal(b.stalled, true);
    assert.equal(b.wake, false, '同一指纹不许再推');
  });
});

describe('dao now：待你拍列出停滞对象', () => {
  it('推进量没查成进缺口；查成的停滞进待你拍', async () => {
    const B = await load(BOARD);
    const empty = B.renderNow({
      now: new Date('2026-09-06T04:00:00Z'),
      prs: { scanned: true, items: [] },
      reviews: { byPr: {} },
      merged: { prs: { scanned: true, items: [] }, commits: { scanned: true, items: [] } },
      issues: { scanned: true, items: [] },
      registries: { scanned: true, items: [] },
      worktrees: { scanned: true, items: [] },
      sessions: { scanned: true, items: [] },
      progressStalls: { scanned: false, error: '快照目录是空的（没查成，不是没停滞）' },
    });
    assert.ok(empty.decide.unscanned.some((g) => /推进量|停滞/.test(g.source) || /没查成/.test(g.why)));
    const stalled = B.renderNow({
      now: new Date('2026-09-06T04:00:00Z'),
      prs: { scanned: true, items: [] },
      reviews: { byPr: {} },
      merged: { prs: { scanned: true, items: [] }, commits: { scanned: true, items: [] } },
      issues: { scanned: true, items: [] },
      registries: { scanned: true, items: [] },
      worktrees: { scanned: true, items: [] },
      sessions: { scanned: true, items: [] },
      progressStalls: {
        scanned: true,
        items: [{ kind: 'progress-stall', why: 'PR #909 连续 5 轮没动（head e1113ced、合不上、无审官判定）' }],
      },
    });
    assert.ok(stalled.decide.items.some((i) => i.kind === 'progress-stall' && /#909/.test(i.why)));
    const text = B.formatNow(stalled);
    assert.match(text, /PR #909 连续 5 轮没动/);
  });
});

describe('commander-inventory 退役：stale-pr 被推进量覆盖', () => {
  it('源码不再跑超龄 PR 那一项；其余 7 项还在', () => {
    const src = fs.readFileSync(INV, 'utf8');
    assert.doesNotMatch(src, /function checkStalePrs/);
    assert.doesNotMatch(src, /key: 'stale-pr'/);
    assert.match(src, /orphan-cwd/);
    assert.match(src, /term-vs-agent/);
    assert.match(src, /key: 'timers'/);
    assert.match(src, /probe-red/);
    assert.match(src, /landing-empty/);
    assert.match(src, /stale-running/);
    assert.match(src, /pending-surface/);
  });
});
