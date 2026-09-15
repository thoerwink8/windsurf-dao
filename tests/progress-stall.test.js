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
  it('#966 挂「将来某版」的已消歧单不算未派出停滞', async () => {
    const S = await load(LIB);
    const snap = {
      github: {
        scanned: true,
        prs: [],
        issues: [{
          number: 819,
          title: '先过渡',
          labels: [{ name: '已消歧' }],
          milestone: { title: '将来某版' },
        }],
      },
      orca: { scanned: true, worktrees: [] },
      reviewPending: { scanned: true, items: [] },
    };
    const extracted = S.extractObjects(snap);
    assert.equal(extracted.scanned, true, extracted.error);
    assert.equal(extracted.objects.length, 0);
    assert.equal(extracted.idle, true);
    const snaps = Array.from({ length: 5 }, () => snap);
    const got = S.detectProgressStall(snaps, { minRounds: 5 });
    assert.equal(got.scanned, true, got.error);
    assert.equal(got.stalled, false);
    assert.equal(got.reason, 'idle');
  });

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
    // 同指纹 + 有墙钟 → 节流期内不重推（2026-09-11 起 planWake 需要时间戳才能判节流；
    // 不给时间戳一律不重推——宁可少喊一次，也不要每轮都喊）
    const T0 = '2026-09-11T00:00:00.000Z';
    const w2 = S.planWake({
      fingerprint: first.fingerprint, prevFingerprint: first.fingerprint,
      prevAt: T0, now: '2026-09-11T01:00:00.000Z', stalled: true,
    });
    assert.equal(w2.wake, false);
    assert.equal(w2.reason, 'same-fingerprint');
    const changed = `${first.fingerprint}\nextra`;
    const w3 = S.planWake({ fingerprint: changed, prevFingerprint: first.fingerprint, stalled: true });
    assert.equal(w3.wake, true);
    assert.equal(w3.reason, 'fingerprint-changed');
  });

  // 2026-09-11 实咬：原来同指纹就永久静音，于是「盘面停滞 5 轮（23 个对象没动）」
  // 09:12 推过一次之后每轮只写 journal，23 个对象冻了几小时而用户侧一片安静。
  // 去重防刷屏是对的，但它把「一直没解决」也一起静音了——那才是最该反复说的。
  it('【停在原地也要重喊】同指纹超过节流窗 → still-stalled 再推一次', async () => {
    const S = await load(LIB);
    const fp = 'same-fingerprint-abc';
    const t0 = '2026-09-11T00:00:00.000Z';
    const soon = S.planWake({ fingerprint: fp, prevFingerprint: fp, prevAt: t0, now: '2026-09-11T05:59:00.000Z', stalled: true });
    assert.equal(soon.wake, false, '节流窗内不重推');
    assert.equal(soon.reason, 'same-fingerprint');
    const later = S.planWake({ fingerprint: fp, prevFingerprint: fp, prevAt: t0, now: '2026-09-11T06:01:00.000Z', stalled: true });
    assert.equal(later.wake, true, '过 6 小时必须再喊');
    assert.equal(later.reason, 'still-stalled');
  });

  it('【反证】没停滞不喊；时间读不出不重推（宁少喊一次也不刷屏）', async () => {
    const S = await load(LIB);
    const fp = 'x';
    assert.equal(S.planWake({ fingerprint: fp, prevFingerprint: null, stalled: false }).wake, false);
    const noTime = S.planWake({ fingerprint: fp, prevFingerprint: fp, stalled: true });
    assert.equal(noTime.wake, false);
    assert.equal(noTime.reason, 'prev-at-unscanned');
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

  it('独立 timer 已退役：安装脚本卸载，指挥官每轮自己跑', () => {
    const installer = fs.readFileSync(path.join(REPO, 'scripts', 'install-progress-watch.sh'), 'utf8');
    assert.match(installer, /disable --now dao-progress-watch\.timer/);
    assert.match(installer, /retired dao-progress-watch\.timer/);
    assert.doesNotMatch(installer, /enable --now dao-progress-watch/);
    const unitDir = path.join(REPO, 'host', 'machine', 'systemd');
    assert.equal(fs.existsSync(path.join(unitDir, 'dao-progress-watch.service')), false);
    assert.equal(fs.existsSync(path.join(unitDir, 'dao-progress-watch.timer')), false);
    const commander = fs.readFileSync(path.join(REPO, 'scripts', 'commander.mjs'), 'utf8');
    assert.match(commander, /runProgressWatch\s*\(/);
    const index = fs.readFileSync(path.join(REPO, 'host', 'machine', 'INDEX.md'), 'utf8');
    assert.match(index, /~\/\.dao\/progress-watch\.json/);
  });
});

// 2026-09-15 实咬：播报的去重键跟被报告的事实同构，两头一起坏。
//   · progress-watch 的键带 stallFingerprint（轮数 + 每个停滞对象 key=sig）
//     ⇒ 清单抖一下就是新键，播报账里攒出约 300 个 `progress-watch:rounds:5\npr:…`
//   · digest-stuck 的键带 digest（这一套动作）
//     ⇒ 停滞的定义就是这套动作不变，越是真停住越只发一条；实测 10 小时冻死只发过 1 条
// 判据：键是常量、严重度只进文案。两条方向相反的断言都要有，只钉一头会漏另一头。
describe('#1285 停滞播报的去重键不带内容', () => {
  it('两个播报键都是常量，不含轮数 / 对象 / digest', async () => {
    const M = await import('file://' + LIB.replace(/\\/g, '/'));
    assert.equal(M.STALL_ALERT_KEY, 'progress-watch:stall');
    assert.equal(M.DIGEST_STUCK_ALERT_KEY, 'digest-stuck');
    for (const k of [M.STALL_ALERT_KEY, M.DIGEST_STUCK_ALERT_KEY]) {
      assert.doesNotMatch(k, /rounds:|=|\n/, '键里不许有内容，否则内容一变就是新键  →  ' + k);
    }
  });

  it('commander 不再把指纹 / digest 拼进 hubOnce 的键', () => {
    const src = fs.readFileSync(path.join(REPO, 'scripts', 'commander.mjs'), 'utf8');
    // 禁的是把**内容快照**拼进键：指纹（含轮数+每个对象的 key=sig）和 digest（整套动作）。
    // 不禁 wakeReason —— 它是个有界的小枚举（first / still-stalled / exhausted …），
    // 不随盘面内容膨胀，正是用来把「停滞」和「认输唤醒」分成两路的（审官第 2 条）。
    assert.doesNotMatch(src, /key: `progress-watch:\$\{progressWatch\.fingerprint/, '指纹进键就是 300 条的来源');
    assert.doesNotMatch(src, /key: `digest-stuck:\$\{/, 'digest 进键就是 10 小时只发 1 条的来源');
    assert.doesNotMatch(src, /key: `[^`]*\$\{vac\.digest/, 'digest 换个写法进键同样不行');
    assert.match(src, /key: progressWatch\.stalled \? STALL_ALERT_KEY/);
    assert.match(src, /key: DIGEST_STUCK_ALERT_KEY/);
  });

  it('严重度随停滞轮数升级，且只用于文案', async () => {
    const M = await import('file://' + LIB.replace(/\\/g, '/'));
    assert.equal(M.stallSeverity(5, 5), '注意');
    assert.equal(M.stallSeverity(9, 5), '注意');
    assert.equal(M.stallSeverity(10, 5), '警告');
    assert.equal(M.stallSeverity(20, 5), '故障');
    assert.equal(M.stallSeverity(100, 5), '故障', '再久也只是故障，不许再分档——分档进不了键，多分没用');
  });

  it('阈值非法时不许崩，按 1 算（没查成不许当没事）', async () => {
    const M = await import('file://' + LIB.replace(/\\/g, '/'));
    assert.equal(M.stallSeverity(4, 0), '故障');
    assert.equal(M.stallSeverity(0, 5), '注意');
  });

  // 审官（#1285 第 2 条）指出的真问题：wake 不等于 stalled。
  // runProgressWatch 的 wake = `!!planned.wake || exhaustedLines.length > 0`，
  // 认输 PR 推送会让 wake=true 而 stalled=false、wakeReason='exhausted'。
  // 两类事混用同一个键，会互相挤占对方的 6 小时去重窗口。
  it('停滞与认输唤醒分流到不同的键（wake=true 不代表 stalled）', () => {
    const src = fs.readFileSync(path.join(REPO, 'scripts', 'commander.mjs'), 'utf8');
    assert.match(
      src,
      /key: progressWatch\.stalled \? STALL_ALERT_KEY : `progress-watch:\$\{progressWatch\.wakeReason/,
      '停滞才用 STALL_ALERT_KEY；非停滞的 wake 另走一个键  →  没找到分流写法',
    );
  });

  // 审官（#1285 第 1 条）用 100 份相同快照证伪了我原来的升级承诺。
  // 这条把那个上限钉死，防止有人看着「注意」两个字又去给 progress-watch 加分档。
  it('runProgressWatch 的 rounds 被快照窗口封顶——不许拿它做严重度分档', async () => {
    const M = await import('file://' + LIB.replace(/\\/g, '/'));
    // 快照形状照 extractObjects 的要求造：github + reviewPending 两段都要 scanned:true。
    const snap = {
      github: { scanned: true, prs: [{ number: 909, headRefOid: 'a'.repeat(40), mergeable: 'MERGEABLE' }], issues: [] },
      reviewPending: { scanned: true, items: [] },
    };
    const snapshots = Array.from({ length: 100 }, () => snap);
    const v = M.detectProgressStall(snapshots, { minRounds: 5 });
    assert.equal(v.stalled, true, '100 份相同快照当然是停滞');
    assert.equal(v.rounds, 5, 'rounds 等于窗口长度，不是真实停滞轮数  →  ' + v.rounds);
    assert.equal(M.stallSeverity(v.rounds, 5), '注意',
      '拿它分档永远只能得出「注意」——这就是那个做不到的承诺');
    assert.equal(M.stallSeverity(100, 5), '故障',
      '真实不封顶的轮数（digestStreak）才分得出档');
  });

  it('commander 只给 digest-stuck 挂严重度，不给 progress-watch 挂', () => {
    const src = fs.readFileSync(path.join(REPO, 'scripts', 'commander.mjs'), 'utf8');
    const stallBlock = src.slice(src.indexOf('key: progressWatch.stalled'), src.indexOf('key: progressWatch.stalled') + 400);
    assert.doesNotMatch(stallBlock, /stallSeverity/,
      'progress-watch 分支不许用 stallSeverity（rounds 封顶，分不出档）');
    assert.match(src, /key: DIGEST_STUCK_ALERT_KEY[\s\S]{0,200}stallSeverity\(state\.digestStreak/,
      'digest-stuck 分支要用 digestStreak 分档（它不封顶）');
  });

  it('stallFingerprint 仍在（它还用来判「这轮和上轮是不是同一批」，只是不再当播报键）', async () => {
    const M = await import('file://' + LIB.replace(/\\/g, '/'));
    assert.equal(typeof M.stallFingerprint, 'function');
    const a = M.stallFingerprint([{ key: 'pr:1', sig: 'x' }], 5);
    const b = M.stallFingerprint([{ key: 'pr:1', sig: 'y' }], 5);
    assert.notEqual(a, b, '指纹本身仍要能分辨内容变化');
  });
});

describe('commander-inventory 退役：stale-pr 被推进量覆盖', () => {
  it('源码不再跑超龄 PR 那一项；其余项还在，inbox 也在', () => {
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
    assert.match(src, /function checkInbox/);
  });
});
