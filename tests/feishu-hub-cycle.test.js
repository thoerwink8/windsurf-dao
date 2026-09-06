// #1029 + #1052：对账计划与日报计划走同一轮。判别：GitHub 没查成不抹卡不发报。
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '..');
const toUrl = (p) => 'file://' + p.replace(/\\/g, '/');
const LIB = import(toUrl(path.join(ROOT, 'scripts', 'lib', 'feishu-hub-cycle.mjs')));
const ASK = import(toUrl(path.join(ROOT, 'scripts', 'lib', 'ask-gate.mjs')));

const REPO = 'thoerwink8/windsurf-dao';
const POLICY_TEXT = fs.readFileSync(path.join(ROOT, 'docs', 'release-policy.json'), 'utf8');

async function policy() {
  const { parsePolicy } = await ASK;
  return parsePolicy(POLICY_TEXT);
}

function situation({ issues = [], prs = [], admission } = {}) {
  return {
    github: { scanned: true, issues, prs },
    admission: admission || { inFlight: 2 },
  };
}

describe('githubFromSituation / snapshotFromSituation', () => {
  it('GitHub 没查成 → scanned:false，不是 0 件', async () => {
    const { githubFromSituation, snapshotFromSituation } = await LIB;
    const sit = { github: { scanned: false, error: '超时' } };
    const g = githubFromSituation(sit, REPO);
    assert.equal(g.scanned, false);
    assert.match(g.error, /超时/);
    const s = snapshotFromSituation(sit);
    assert.equal(s.scanned, false);
  });

  it('待拍板件数从标签数，冲突从 mergeable', async () => {
    const { snapshotFromSituation } = await LIB;
    const s = snapshotFromSituation(situation({
      issues: [
        { number: 1, title: '花钱', labels: [{ name: '待拍板' }] },
        { number: 2, title: '别的', labels: [{ name: '已消歧' }] },
      ],
      prs: [
        { number: 10, mergeable: 'CONFLICTING' },
        { number: 11, mergeable: 'MERGEABLE' },
      ],
    }));
    assert.equal(s.scanned, true);
    assert.equal(s.pending, 1);
    assert.equal(s.openPrs, 2);
    assert.equal(s.conflicts, 1);
    assert.equal(s.workers, 2);
  });
});

describe('planHubCycle', () => {
  it('GitHub 没查成：对账无 decide，日报不发', async () => {
    const { planHubCycle } = await LIB;
    const r = planHubCycle({
      situation: { github: { scanned: false, error: '挂了' } },
      repo: REPO,
      hubPending: { om_x: { repo: REPO, number: 1 } },
      policy: await policy(),
      digestState: { queue: { day: '2026-09-06', items: [] }, lastSentDay: '', lastSnapshot: null },
      now: '2026-09-07',
    });
    assert.equal(r.reconcile.unscanned, true);
    assert.equal((r.reconcile.actions || []).some((a) => a.kind === 'decide'), false);
    assert.equal(r.daily.send, false);
    assert.match(r.daily.why, /没查成/);
    assert.equal(r.card, null);
  });

  it('GitHub 有待拍板、飞书没有 → 补发卡；换日有变化 → 出日报卡 schema 2.0', async () => {
    const { planHubCycle } = await LIB;
    const r = planHubCycle({
      situation: situation({
        issues: [{ number: 1052, title: '要不要花钱买机器', labels: [{ name: '待拍板' }] }],
        prs: [{ number: 1, mergeable: 'MERGEABLE' }],
      }),
      repo: REPO,
      hubPending: {},
      policy: await policy(),
      digestState: {
        queue: { day: '2026-09-07', items: [{ source: 'heartbeat', text: '连续 7 天静默' }] },
        lastSentDay: '2026-09-06',
        lastSnapshot: { scanned: true, pending: 0, openPrs: 0, workers: 0, conflicts: 0, headlines: [] },
      },
      now: '2026-09-07',
    });
    assert.equal(r.reconcile.ok, true);
    assert.equal(r.reconcile.actions[0].kind, 'issue');
    assert.equal(r.daily.send, true);
    assert.equal(r.card.schema, '2.0');
    assert.match(r.card.header.title.content, /道·日报/);
  });

  it('apply：日报发送口失败不假装发成了', async () => {
    const { planHubCycle, applyHubCycle } = await LIB;
    const plan = planHubCycle({
      situation: situation({ issues: [], prs: [] }),
      repo: REPO,
      hubPending: {},
      policy: await policy(),
      digestState: { queue: { day: '', items: [] }, lastSentDay: '', lastSnapshot: null },
      now: '2026-09-07',
    });
    const applied = applyHubCycle(plan, {
      sendDaily: () => ({ ok: false, error: '没送进群：缺群号' }),
    });
    if (plan.daily.send) {
      assert.equal(applied.daily.ok, false);
      assert.equal(applied.daily.sent, false);
      assert.match(applied.daily.error, /没送进群/);
    }
  });
});
