// #1029：总控群只留待拍板。飞书是投影，真相源是 GitHub「待拍板」标签。
// 判别：没查成不许判已办结；发卡过滤只复用 ask-gate；一件一卡。
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const toUrl = (p) => 'file://' + p.replace(/\\/g, '/');
const LIB = import(toUrl(path.join(ROOT, 'scripts', 'lib', 'hub-pending.mjs')));
const ASK = import(toUrl(path.join(ROOT, 'scripts', 'lib', 'ask-gate.mjs')));
const CARD = import(toUrl(path.join(ROOT, 'scripts', 'lib', 'feishu-hub-card.mjs')));

const REPO = 'thoerwink8/windsurf-dao';

const GOOD_POLICY_DOC = {
  human_holds: ['对用户发布(minor/major)', '花钱', '删数据', '改规则(协作约定/本文件/model-routing)'],
  confirm: {
    patch: { who: 'auto' },
    minor: { who: 'admin:1' },
    major: { who: 'admin:1' },
  },
  version: { bump_by_commit_type: { fix: 'patch', docs: 'patch', chore: 'patch', feat: 'minor', 'feat!': 'major' } },
};

async function policy() {
  const { parsePolicy } = await ASK;
  return parsePolicy(JSON.stringify(GOOD_POLICY_DOC));
}

function issue(n, over = {}) {
  return {
    repo: REPO,
    number: n,
    title: over.title || `单 ${n}`,
    body: over.body || '',
    url: `https://github.com/${REPO}/issues/${n}`,
    labels: over.labels || ['待拍板'],
  };
}

function kinds(plan) {
  return (plan.actions || []).map((a) => a.kind);
}

describe('parseIssueListJson / githubFromIssueList：没查成 ≠ 0 件', () => {
  it('坏 JSON → scanned:false，没有 issues', async () => {
    const { parseIssueListJson } = await LIB;
    const r = parseIssueListJson('这不是 JSON');
    assert.equal(r.scanned, false);
    assert.match(r.error, /不是 JSON/);
    assert.equal(r.issues, undefined);
  });

  it('顶层不是数组 → scanned:false', async () => {
    const { parseIssueListJson } = await LIB;
    const r = parseIssueListJson('{"number":1}');
    assert.equal(r.scanned, false);
    assert.match(r.error, /不是数组/);
  });

  it('gh 失败 → scanned:false，错误原文留下', async () => {
    const { githubFromIssueList } = await LIB;
    const r = githubFromIssueList({ ok: false, error: 'gh 超时' });
    assert.equal(r.scanned, false);
    assert.match(r.error, /gh 超时/);
  });

  it('合法数组 → scanned:true，带上单号和仓库', async () => {
    const { parseIssueListJson } = await LIB;
    const r = parseIssueListJson(JSON.stringify([
      { number: 1029, title: '总控', labels: [{ name: '待拍板' }] },
    ]), REPO);
    assert.equal(r.scanned, true);
    assert.equal(r.issues.length, 1);
    assert.equal(r.issues[0].number, 1029);
    assert.equal(r.issues[0].repo, REPO);
    assert.equal(r.issues[0].labels.includes('待拍板'), true);
  });
});

describe('planReconcile：GitHub 没查成不许 decide', () => {
  it('scanned 缺省 / false → actions 空，没有任何 decide', async () => {
    const { planReconcile } = await LIB;
    const r = planReconcile({
      github: { scanned: false, error: '网络挂了' },
      hubPending: {
        om_old: { repo: REPO, number: 1, title: '还在飞书' },
      },
      policy: await policy(),
      repo: REPO,
    });
    assert.equal(r.ok, false);
    assert.equal(r.unscanned, true);
    assert.equal(r.actions.length, 0);
    assert.match(r.error, /网络挂了/);
  });

  it('github 整个没传 → 同样 unscanned，不抹卡', async () => {
    const { planReconcile } = await LIB;
    const r = planReconcile({ hubPending: { om_x: { repo: REPO, number: 2 } } });
    assert.equal(r.unscanned, true);
    assert.equal(kinds(r).includes('decide'), false);
  });
});

describe('planReconcile：多的补发卡、少的改已办结、一件一卡', () => {
  it('GitHub 有、飞书没有 → issue 一张', async () => {
    const { planReconcile } = await LIB;
    const r = planReconcile({
      github: { scanned: true, issues: [issue(11, { title: '花钱买机器', body: '依据：花钱' })] },
      hubPending: {},
      policy: await policy(),
      repo: REPO,
    });
    assert.equal(r.ok, true);
    assert.equal(r.unscanned, false);
    assert.equal(r.actions.length, 1);
    assert.equal(r.actions[0].kind, 'issue');
    assert.equal(r.actions[0].issue.number, 11);
  });

  it('两边都有 → 不新发，keep 那张活卡', async () => {
    const { planReconcile } = await LIB;
    const r = planReconcile({
      github: { scanned: true, issues: [issue(12, { title: '花钱' })] },
      hubPending: { om_live: { repo: REPO, number: 12, title: '花钱' } },
      policy: await policy(),
      repo: REPO,
    });
    assert.equal(r.actions.length, 0);
    assert.equal(r.keep.length, 1);
    assert.equal(r.keep[0].messageId, 'om_live');
  });

  it('飞书有、GitHub 已经没有待拍板 → decide（别处办结）', async () => {
    const { planReconcile } = await LIB;
    const r = planReconcile({
      github: { scanned: true, issues: [] },
      hubPending: { om_gone: { repo: REPO, number: 13, title: '已关' } },
      policy: await policy(),
      repo: REPO,
    });
    assert.equal(r.actions.length, 1);
    assert.equal(r.actions[0].kind, 'decide');
    assert.equal(r.actions[0].messageId, 'om_gone');
    assert.match(r.actions[0].why, /没有待拍板/);
  });

  it('已办结的旧卡不算「还在投影里」——GitHub 没了也不再 decide', async () => {
    const { planReconcile } = await LIB;
    const r = planReconcile({
      github: { scanned: true, issues: [] },
      hubPending: {
        om_done: { repo: REPO, number: 14, decided: { choice: '已办结', who: '别处' } },
      },
      policy: await policy(),
      repo: REPO,
    });
    assert.equal(r.actions.length, 0);
  });

  it('同一单两张活卡 → 留一张，多的 decide', async () => {
    const { planReconcile } = await LIB;
    const r = planReconcile({
      github: { scanned: true, issues: [issue(15, { title: '花钱' })] },
      hubPending: {
        om_a: { repo: REPO, number: 15, title: '花钱' },
        om_b: { repo: REPO, number: 15, title: '花钱副本' },
      },
      policy: await policy(),
      repo: REPO,
    });
    const decides = r.actions.filter((a) => a.kind === 'decide');
    assert.equal(decides.length, 1);
    assert.equal(r.keep.length, 1);
    assert.equal(r.keep[0].messageId, 'om_a');
    assert.equal(decides[0].messageId, 'om_b');
  });
});

describe('发卡过滤复用 ask-gate：ask/unscanned 发卡，auto 不发卡只进摘要', () => {
  it('命中花钱 → ask → 发卡', async () => {
    const { cardFilter } = await LIB;
    const f = cardFilter(issue(21, { title: '要不要花钱买服务器' }), { policy: await policy() });
    assert.equal(f.verdict, 'ask');
    assert.equal(f.card, true);
  });

  it('拦错基线的 PR → auto → 不发卡', async () => {
    const { cardFilter } = await LIB;
    const f = cardFilter(issue(22, { title: '要不要拦下这个明显切错基线的 PR？' }), { policy: await policy() });
    assert.equal(f.verdict, 'auto');
    assert.equal(f.card, false);
  });

  it('策略没拿到 → unscanned → 发卡（没查成不许自己拍）', async () => {
    const { cardFilter } = await LIB;
    const f = cardFilter(issue(23, { title: '随便' }), { policy: { unscanned: '策略文件不在' } });
    assert.equal(f.verdict, 'unscanned');
    assert.equal(f.card, true);
  });

  it('classify 自己落 unscanned → 也发卡', async () => {
    const { cardFilter } = await LIB;
    const f = cardFilter(issue(24), {
      policy: await policy(),
      classify: () => ({ verdict: 'unscanned', why: '级都定不了' }),
    });
    assert.equal(f.verdict, 'unscanned');
    assert.equal(f.card, true);
  });

  it('auto 的单：对账不发卡，改成 digest；已有卡还要 decide 掉', async () => {
    const { planReconcile } = await LIB;
    const r = planReconcile({
      github: { scanned: true, issues: [issue(25, { title: '要不要拦下这个明显切错基线的 PR？' })] },
      hubPending: { om_auto: { repo: REPO, number: 25, title: '旧卡' } },
      policy: await policy(),
      repo: REPO,
    });
    const kindsNow = kinds(r);
    assert.equal(kindsNow.includes('issue'), false);
    assert.equal(kindsNow.includes('digest'), true);
    assert.equal(kindsNow.includes('decide'), true);
    assert.equal(r.actions.find((a) => a.kind === 'digest').issue.number, 25);
  });
});

describe('planMenuList：看待拍板走同一条取数', () => {
  it('没查成不许回 0 件', async () => {
    const { planMenuList } = await LIB;
    const r = planMenuList({ github: { scanned: false, error: 'gh 挂了' } });
    assert.equal(r.unscanned, true);
    assert.equal(r.empty, false);
    assert.match(r.text, /没查成/);
    assert.equal(r.text.includes('当前没有'), false);
  });

  it('0 件要回一句，不许静默', async () => {
    const { planMenuList } = await LIB;
    const r = planMenuList({
      github: { scanned: true, issues: [] },
      hubPending: {},
      policy: await policy(),
      repo: REPO,
    });
    assert.equal(r.empty, true);
    assert.match(r.text, /当前没有要你拍的/);
    assert.equal(r.actions.length, 0);
  });

  it('已有卡 → bump 不新发；没有卡 → issue', async () => {
    const { planMenuList } = await LIB;
    const r = planMenuList({
      github: { scanned: true, issues: [
        issue(31, { title: '花钱 A' }),
        issue(32, { title: '花钱 B' }),
      ] },
      hubPending: { om_31: { repo: REPO, number: 31, title: '花钱 A' } },
      policy: await policy(),
      repo: REPO,
    });
    assert.equal(r.empty, false);
    const bump = r.actions.filter((a) => a.kind === 'bump');
    const issueActs = r.actions.filter((a) => a.kind === 'issue');
    assert.equal(bump.length, 1);
    assert.equal(bump[0].messageId, 'om_31');
    assert.equal(issueActs.length, 1);
    assert.equal(issueActs[0].issue.number, 32);
  });

  it('auto 的单不进菜单列表', async () => {
    const { planMenuList } = await LIB;
    const r = planMenuList({
      github: { scanned: true, issues: [issue(33, { title: '要不要拦下这个明显切错基线的 PR？' })] },
      hubPending: {},
      policy: await policy(),
      repo: REPO,
    });
    assert.equal(r.empty, true);
    assert.equal(r.actions.length, 0);
  });
});

describe('已办结卡片复用 buildDecidedHubCard，不许另写', () => {
  it('elsewhereDecided + decidedCardFor 就是那份绿卡', async () => {
    const { elsewhereDecided, decidedCardFor } = await LIB;
    const { buildDecidedHubCard } = await CARD;
    const pending = { repo: REPO, number: 41, title: '旧事', what: '旧事' };
    const decided = elsewhereDecided({ now: '2026-09-06T12:00:00.000Z', who: '别处处理' });
    assert.equal(decided.choice, '已办结');
    assert.equal(decided.who, '别处处理');
    assert.deepEqual(decidedCardFor(pending, decided), buildDecidedHubCard({ ...pending, decided }));
  });
});

describe('菜单事件：认 application.bot.menu_v6', () => {
  it('看待拍板菜单 → known', async () => {
    const { parseMenuEvent, MENU_LIST_PENDING } = await LIB;
    const r = parseMenuEvent({
      header: { event_type: 'application.bot.menu_v6' },
      event: {
        event_key: MENU_LIST_PENDING,
        operator: { operator_id: { open_id: 'ou_user' } },
        chat_id: 'oc_hub',
      },
    });
    assert.equal(r.ok, true);
    assert.equal(r.known, true);
    assert.equal(r.openId, 'ou_user');
    assert.equal(r.chatId, 'oc_hub');
  });

  it('普通消息不是菜单', async () => {
    const { parseMenuEvent } = await LIB;
    assert.equal(parseMenuEvent({
      header: { event_type: 'im.message.receive_v1' },
      event: { message: { message_id: 'om_1' } },
    }), null);
  });
});
