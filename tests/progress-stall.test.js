// tests/progress-stall.test.js —— 盘面推进量判别力（chain:progress-stall#0 / #1004）
//
// 正反样本：真实停滞窗口必须报 PR #909；对象 A 停、对象 B 动只报 A；
// 全空闲 / 全在换不许报；同一指纹只推一次；读不清必须说没查成。不出网。
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

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

  it('05:11→05:19 树在变、#909 合掉：动的不报，冻着的对象仍报', async () => {
    const S = await load(LIB);
    const snaps = readFixture(MOVING_FIXTURE);
    const got = S.detectProgressStall(snaps, { minRounds: snaps.length });
    assert.equal(got.scanned, true, got.error);
    assert.equal(got.stalled, true, '冻着的 PR 被整盘进度藏掉了：' + JSON.stringify(got));
    const pr909 = got.items.find((i) => i.kind === 'pr' && String(i.id) === '909');
    assert.equal(pr909, undefined, '已经合掉的 #909 不许当停滞');
    const pr884 = got.items.find((i) => i.kind === 'pr' && String(i.id) === '884');
    assert.equal(pr884 != null, true, '一直没动的 #884 必须报');
  });
});

// 2026-09-06 用户拍板「删掉整层」后的判别性实验：orca 已退役，快照的 orca 段每轮都是
// scanned:false。改动之前 extractObjects 拿它当硬门，装上 progress-watch 也只会每轮
// exit 2——「能不能在 orca 段死掉的情况下判出停滞」就是这次改对没改对的唯一判据。
describe('progress-detect：orca 段死了照样判（屏面指纹层退役）', () => {
  it('orca 段 scanned:false 不再拖垮整轮——GitHub 面照判', async () => {
    const S = await load(LIB);
    const snaps = readFixture(STALL_FIXTURE).map((s) => ({
      ...s,
      orca: { scanned: false, error: 'Could not read Orca runtime metadata（已退役）' },
    }));
    const got = S.detectProgressStall(snaps, { minRounds: 5 });
    assert.equal(got.scanned, true, got.error);
    assert.equal(got.stalled, true);
    const prIds = got.items.filter((i) => i.kind === 'pr').map((i) => String(i.id));
    assert.equal(prIds.includes('909'), true, 'orca 段死了就判不出 PR #909：' + prIds.join(','));
  });

  it('树面整类不再产出对象——orca.worktrees 有货也不看', async () => {
    const S = await load(LIB);
    const snap = {
      github: { scanned: true, prs: [], issues: [] },
      orca: { scanned: true, worktrees: [{ worktreeId: 'w1', displayName: 'ISSUE-#1 工人', liveTerminalCount: 0 }] },
      reviewPending: { scanned: true, items: [] },
    };
    const got = S.extractObjects(snap);
    assert.equal(got.scanned, true, got.error);
    assert.deepEqual(got.objects, []);
    assert.equal(got.idle, true);
  });

  it('github / reviewPending 段没查成仍然是硬门（别把门全拆了）', async () => {
    const S = await load(LIB);
    const noGh = S.extractObjects({ github: { scanned: false, error: 'gh 超时' }, reviewPending: { scanned: true, items: [] } });
    assert.equal(noGh.scanned, false);
    assert.match(noGh.error, /gh 超时/);
    const noRp = S.extractObjects({ github: { scanned: true, prs: [], issues: [] }, reviewPending: { scanned: false, error: '票面没读到' } });
    assert.equal(noRp.scanned, false);
    assert.match(noRp.error, /票面没读到/);
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

  it('#909 冻着、旁边有推进：只报 #909，不许整盘 progress 把它藏掉', async () => {
    const S = await load(LIB);
    const frozen = {
      number: 909,
      headRefOid: 'e1113ced6b0b340becd50d53cd4b19288f74fe53',
      mergeable: 'CONFLICTING',
      isDraft: false,
      reviewDecision: null,
    };
    const snaps = [];
    for (let i = 0; i < 5; i++) {
      snaps.push(prSnap([
        frozen,
        {
          number: 1000,
          headRefOid: `moving-${i}`,
          mergeable: 'MERGEABLE',
          isDraft: false,
          reviewDecision: null,
        },
      ]));
    }
    const got = S.detectProgressStall(snaps, { minRounds: 5 });
    assert.equal(got.scanned, true, got.error);
    assert.equal(got.stalled, true, JSON.stringify(got));
    const pr909 = got.items.find((i) => i.kind === 'pr' && String(i.id) === '909');
    assert.equal(pr909 != null, true, '必须点名冻结的 PR #909：' + got.items.map((i) => i.key).join(','));
    assert.match(pr909.why, /PR #909 连续 5 轮没动/);
    const pr1000 = got.items.find((i) => String(i.id) === '1000');
    assert.equal(pr1000, undefined, '旁边在动的 #1000 不许进停滞清单');
  });

  it('#909 连冻、复审票 1↔0 抖动，不许把 #909 藏掉', async () => {
    const S = await load(LIB);
    const frozenPr = {
      number: 909,
      headRefOid: 'e1113ced6b0b340becd50d53cd4b19288f74fe53',
      mergeable: 'CONFLICTING',
      isDraft: false,
      reviewDecision: null,
    };
    const snaps = [];
    for (let i = 0; i < 5; i++) {
      snaps.push({
        github: { scanned: true, prs: [frozenPr], issues: [] },
        orca: { scanned: true, worktrees: [] },
        reviewPending: {
          scanned: true,
          items: i % 2 === 0
            ? [{ pr: 909, head: { oid: frozenPr.headRefOid } }]
            : [],
        },
      });
    }
    const got = S.detectProgressStall(snaps, { minRounds: 5 });
    assert.equal(got.scanned, true, got.error);
    assert.equal(got.stalled, true, '票抖动把冻结 PR 藏掉了：' + JSON.stringify(got));
    const pr909 = got.items.find((i) => i.kind === 'pr' && String(i.id) === '909');
    assert.equal(pr909 != null, true, '必须点名 PR #909');
    const jitterTicket = got.items.find((i) => i.kind === 'ticket');
    assert.equal(jitterTicket, undefined, '抖动的票自己不该报停滞');
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

  it('#1055：orca 段没扫到 / scanned:false 不当没查成（退役后这一节永远扫不出来）', async () => {
    const S = await load(LIB);
    const noOrca = S.extractObjects({
      github: { scanned: true, prs: [], issues: [] },
      reviewPending: { scanned: true, items: [] },
    });
    assert.equal(noOrca.scanned, true, noOrca.error);
    const dead = S.extractObjects({
      github: { scanned: true, prs: [], issues: [] },
      orca: { scanned: false, error: 'orca-serve disabled' },
      reviewPending: { scanned: true, items: [] },
    });
    assert.equal(dead.scanned, true, dead.error);
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
    const W = await load(CLI);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'progress-empty-'));
    const state = path.join(dir, 'state.json');
    const r = W.runProgressWatch({ dir, state, rounds: 5, dryRun: false });
    assert.equal(r.ok, false);
    assert.equal(r.exit, 2);
    assert.match(String(r.report || r.error || ''), /没查成/);
    assert.equal(r.wake, false);
  });

  it('文件损坏必须报没查成，不许当成没停滞', async () => {
    const W = await load(CLI);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'progress-bad-'));
    fs.writeFileSync(path.join(dir, 'situation-2026-09-06T00-00-00-000Z.json'), '{', 'utf8');
    const state = path.join(dir, 'state.json');
    const r = W.runProgressWatch({ dir, state, rounds: 5, dryRun: false });
    assert.equal(r.ok, false);
    assert.equal(r.exit, 2);
    assert.match(String(r.report || r.error || ''), /没查成/);
    assert.equal(r.wake, false);
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

  // 认输推送从 agent-stall-watch 搬过来（那个宿主 2026-09-06 删了）。默认不接线：
  // 它要打 gh，纯函数级测试不许出网，CLI 的 main() 才把真实现传进来。
  it('认输 PR 有推送 → 报告带上它，并叫醒帅位（哪怕盘面没停滞）', async () => {
    const W = await load(CLI);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'progress-exhausted-'));
    for (let i = 0; i < 5; i++) {
      fs.writeFileSync(path.join(dir, `situation-2026-09-06T0${i}-00-00-000Z.json`), JSON.stringify(emptySnap()), 'utf8');
    }
    const state = path.join(dir, 'state.json');
    const r = W.runProgressWatch({
      dir, state, rounds: 5, dryRun: false,
      exhaustedPush: ({ lines }) => { lines.push('PR #1018 自动化认输，等你拍'); return { ok: true, pushed: 1 }; },
    });
    assert.equal(r.ok, true, r.error);
    assert.equal(r.stalled, false, '盘面空闲，停滞判定不该被认输推送带偏');
    assert.equal(r.wake, true, '认输的 PR 需要人处置，必须叫醒');
    assert.equal(r.wakeReason, 'exhausted');
    assert.match(r.report, /PR #1018 自动化认输/);
  });

  it('不注入就不查认输——默认一个子进程都不起（不出网）', async () => {
    const W = await load(CLI);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'progress-noexh-'));
    for (let i = 0; i < 5; i++) {
      fs.writeFileSync(path.join(dir, `situation-2026-09-06T0${i}-00-00-000Z.json`), JSON.stringify(emptySnap()), 'utf8');
    }
    const r = W.runProgressWatch({ dir, state: path.join(dir, 'state.json'), rounds: 5, dryRun: false });
    assert.equal(r.ok, true, r.error);
    assert.equal(r.exhausted, null);
    assert.equal(r.wake, false);
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
    const stallGap = empty.decide.unscanned.find((g) => /推进量|停滞/.test(g.source) || /没查成/.test(g.why));
    assert.equal(stallGap != null, true, '推进量没查成必须进缺口');
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
    const stallItem = stalled.decide.items.find((i) => i.kind === 'progress-stall');
    assert.equal(stallItem != null, true, '待你拍必须有 progress-stall');
    assert.match(stallItem.why, /#909/);
    const text = B.formatNow(stalled);
    assert.match(text, /PR #909 连续 5 轮没动/);
  });
});

describe('叫醒主路：shuai-scan CLI 吃 progress-watch', () => {
  const SHUAI_CLI = path.join(REPO, 'scripts', 'shuai-scan.mjs');

  it('真实停滞窗口主路打出 AGENT_LOOP_TICK_PANMIAN；同一指纹第二轮不打', async () => {
    const C = await load(SHUAI_CLI);
    const snaps = readFixture(STALL_FIXTURE);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shuai-progress-wake-'));
    snaps.forEach((s, i) => {
      fs.writeFileSync(path.join(dir, `situation-2026-09-06T0${i}-00-00-000Z.json`), JSON.stringify(s), 'utf8');
    });
    const state = path.join(dir, 'state.json');
    const argv = ['node', SHUAI_CLI, '--dir', dir, '--state', state, '--rounds', '5'];
    const a = C.runShuaiScan(argv);
    assert.equal(a.exit, 0, a.stderr);
    assert.match(String(a.stdout || ''), /AGENT_LOOP_TICK_PANMIAN/);
    assert.match(String(a.stdout || ''), /PR #909/);
    const b = C.runShuaiScan(argv);
    assert.equal(b.exit, 0, b.stderr);
    assert.doesNotMatch(String(b.stdout || ''), /AGENT_LOOP_TICK_PANMIAN/);
  });

  it('timer 单元进 INDEX 装机面：service 调 progress-watch，timer 有 OnCalendar', () => {
    const unitDir = path.join(REPO, 'host', 'machine', 'systemd');
    const service = fs.readFileSync(path.join(unitDir, 'dao-progress-watch.service'), 'utf8');
    const timer = fs.readFileSync(path.join(unitDir, 'dao-progress-watch.timer'), 'utf8');
    assert.match(service, /ExecStart=.*scripts\/progress-watch\.mjs/);
    assert.match(service, /^User=orca$/m);
    assert.match(timer, /^OnCalendar=/m);
    const installer = fs.readFileSync(path.join(REPO, 'scripts', 'install-progress-watch.sh'), 'utf8');
    assert.match(installer, /dao-progress-watch\.timer/);
    const index = fs.readFileSync(path.join(REPO, 'host', 'machine', 'INDEX.md'), 'utf8');
    assert.match(index, /~\/\.dao\/progress-watch\.json/);
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
