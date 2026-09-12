// #1029 + #1052：对账计划与日报计划走同一轮。判别：GitHub 没查成不抹卡不发报。
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..');
const toUrl = (p) => 'file://' + p.replace(/\\/g, '/');
const LIB = import(toUrl(path.join(ROOT, 'scripts', 'lib', 'feishu-hub-cycle.mjs')));
const ASK = import(toUrl(path.join(ROOT, 'scripts', 'lib', 'ask-gate.mjs')));
const SCAN = import(toUrl(path.join(ROOT, 'scripts', 'lib', 'shuai-scan.mjs')));

const REPO = 'thoerwink8/windsurf-dao';
const POLICY_TEXT = fs.readFileSync(path.join(ROOT, 'docs', 'release-policy.json'), 'utf8');

describe('confirmed card projections persist across commander rounds', () => {
  it('57 cached cards converge: successful PATCHes disappear, failed ones alone retry', async (t) => {
    const { createStateStore } = await import('../scripts/feishu-triage.mjs');
    const { planHubCycle, applyHubCycle } = await LIB;
    const { updateCardViaLark } = await import('../scripts/lib/broadcast-io.mjs');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-projection-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'threads.json');
    const seed = createStateStore(file);
    const human = { choice: 'recommend', who: 'human', at: '2026-09-12T00:00:00Z' };
    for (let n = 1; n <= 57; n++) seed.hubPending['om_' + n] = {
      repo: REPO, number: n, title: 'old card ' + n, chatId: 'oc_hub',
      ...(n === 57 ? { decided: human } : {}),
    };
    seed.save();
    const askPolicy = await policy();
    function round(fail) {
      const store = createStateStore(file), calls = [];
      const plan = planHubCycle({ situation: situation(), repo: REPO,
        hubPending: store.hubPending, policy: askPolicy,
        digestState: { lastSentDay: '2026-09-12' }, now: '2026-09-12' });
      const applied = applyHubCycle(plan, { store, now: '2026-09-12T01:00:00Z',
        decideCard: ({ messageId, card }) => {
          calls.push(messageId);
          return updateCardViaLark({ messageId, card, spawn: () => fail(messageId) });
        },
        sendDaily: () => { throw Error('same day must not send'); },
      });
      store.save();
      return { calls, applied, saved: createStateStore(file) };
    }
    const first = round(id => id === 'om_1'
      ? { status: 0, stdout: '{"ok":false,"error":{"message":"denied"}}' }
      : id === 'om_2' ? { status: 1, stderr: 'timeout' }
        : { status: 0, stdout: '{"code":0}' });
    assert.equal(first.calls.length, 56);
    assert.equal(first.saved.hubPending.om_1.decided, undefined);
    assert.equal(first.saved.hubPending.om_2.decided, undefined);
    assert.equal(first.saved.hubPending.om_3.decided.choice, '已办结');
    assert.equal(first.saved.hubPending.om_3.chatId, 'oc_hub');
    assert.deepEqual(first.saved.hubPending.om_57.decided, human);
    const second = round(() => ({ status: 0, stdout: '{"ok":true}' }));
    assert.deepEqual(second.calls, ['om_1', 'om_2']);
    const third = round(() => { throw Error('settled cards must not be patched again'); });
    assert.deepEqual(third.calls, []);
    assert.equal(Object.keys(third.saved.hubPending).length, 57);
  });

  it('unconfirmed results cannot create entries or replace a human choice made during PATCH', async () => {
    const { applyHubCycle } = await LIB;
    const human = { choice: 'wait', who: 'human' };
    const store = { hubPending: { om_live: { repo: REPO, number: 1 },
      om_failed: { repo: REPO, number: 2 }, om_unknown: { repo: REPO, number: 3 } } };
    const actions = ['om_live', 'om_failed', 'om_unknown', 'om_missing'].map((messageId, i) => ({
      kind: 'decide', key: REPO + '#' + (i + 1), messageId,
      pending: { repo: REPO, number: i + 1 },
    }));
    applyHubCycle({ reconcile: { ok: true, actions }, daily: { send: false } }, {
      store, decideCard: ({ messageId }) => {
        if (messageId === 'om_live') store.hubPending.om_live.decided = human;
        if (messageId === 'om_failed') return { ok: false };
        if (messageId === 'om_unknown') return { ok: 'true' };
        return { ok: true };
      },
    });
    assert.deepEqual(store.hubPending.om_live.decided, human);
    assert.equal(store.hubPending.om_failed.decided, undefined);
    assert.equal(store.hubPending.om_unknown.decided, undefined);
    assert.equal(store.hubPending.om_missing, undefined);
  });
});

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

  it('admission.unscanned → 整张 scanned:false，不发假报', async () => {
    const { snapshotFromSituation, planHubCycle } = await LIB;
    const sit = {
      github: { scanned: true, issues: [], prs: [] },
      admission: { unscanned: true, why: '在途数没查成，不派' },
    };
    const s = snapshotFromSituation(sit);
    assert.equal(s.scanned, false);
    assert.match(s.error, /在跑工人没查成|在途数没查成/);
    const r = planHubCycle({
      situation: sit,
      repo: REPO,
      hubPending: {},
      policy: await policy(),
      digestState: { queue: { day: '', items: [] }, lastSentDay: '', lastSnapshot: null },
      now: '2026-09-07',
    });
    assert.equal(r.daily.send, false);
    assert.match(r.daily.why, /没查成/);
    assert.equal(r.snapshot.workers, undefined);
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

describe('GraphQL 归一化把 issue 正文交给发卡过滤', () => {
  it('标题普通、正文「依据：花钱」、待拍板 → ask / 发卡', async () => {
    const { GITHUB_GRAPHQL, normalizeGithubGraphql } = await SCAN;
    const { planHubCycle } = await LIB;
    assert.match(GITHUB_GRAPHQL, /issues\([\s\S]*?nodes \{[\s\S]*?\bbody\b/);

    const gh = normalizeGithubGraphql({
      repository: {
        issues: {
          nodes: [{
            number: 1103,
            title: '随便修一下',
            body: '依据：花钱',
            updatedAt: '2026-09-07T00:00:00Z',
            labels: { nodes: [{ name: '待拍板' }] },
          }],
        },
        pullRequests: { nodes: [] },
      },
    });
    assert.equal(gh.ok, true);
    assert.equal(gh.issues.length, 1);
    assert.equal(gh.issues[0].body, '依据：花钱');

    const r = planHubCycle({
      situation: {
        github: { scanned: true, issues: gh.issues, prs: gh.prs },
        admission: { inFlight: 0 },
      },
      repo: REPO,
      hubPending: {},
      policy: await policy(),
      digestState: { queue: { day: '', items: [] }, lastSentDay: '', lastSnapshot: null },
      now: '2026-09-07',
    });
    assert.equal(r.reconcile.ok, true);
    assert.equal(r.reconcile.actions.length, 1);
    assert.equal(r.reconcile.actions[0].kind, 'issue');
    assert.equal(r.reconcile.actions[0].issue.number, 1103);
    assert.equal(r.reconcile.actions[0].issue.body, '依据：花钱');
    assert.match(r.reconcile.actions[0].why, /human_holds/);
  });
});
