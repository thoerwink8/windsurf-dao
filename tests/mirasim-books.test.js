// #880 卡 F：士兵/审官任务书 mirasim 化。
// 守两件事：①buildSoldierInject/buildReviewerInject 按 executor 选书（mirasim 版 vs orca 默认，
// orca 默认渲染逐字不变）；②ask/notify/send 三动词的 mirasim 分支（mirasimVerbGuard）——
// mirasim 会话没有 Run/卡/dispatch 身份，这三条 orchestration 通道明确拒绝并指路（不造第二套信箱）。
// 判别力：每组都配 mirasim 该拒 + orca 该透传两面，改一边正则就红。

const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const TEMPLATE = path.join(REPO, 'scripts', 'lib', 'dispatch', 'template.mjs');
const VERBS = path.join(REPO, 'scripts', 'lib', 'dispatch', 'mirasim-verbs.mjs');
const T_LOAD = import('file://' + TEMPLATE.replace(/\\/g, '/'));
const V_LOAD = import('file://' + VERBS.replace(/\\/g, '/'));

describe('#880 卡 F：任务书 mirasim 化', () => {
  it('buildSoldierInject 按 executor 选书；orca 默认逐字不变', async () => {
    const { buildSoldierInject } = await T_LOAD;
    const mira = buildSoldierInject({ spec: 'x', issue: '880', executor: 'mirasim' });
    assert.match(mira, /soldier-book-mirasim\.md/, 'mirasim 选 mirasim 士兵书');
    assert.ok(mira.includes('spec=x'), 'mirasim 前言带 spec');
    assert.ok(mira.includes('#880'), 'mirasim 前言带 issue');

    const orca = buildSoldierInject({ spec: 'x', issue: '880' });
    assert.equal(
      orca,
      '读 host/skills/dispatch/templates/soldier-book.md spec=x #880',
      'orca 默认渲染逐字不变',
    );
    assert.ok(!/mirasim/.test(orca), 'orca 默认不指 mirasim 书');
  });

  it('buildReviewerInject 按 executor 选书；mirasim 无 d=/s=/fb=，orca 有 d=', async () => {
    const { buildReviewerInject } = await T_LOAD;
    const mira = buildReviewerInject({
      spec: 'x', issue: '880', pr: '900', mergePolicy: 'auto', executor: 'mirasim',
    });
    assert.match(mira, /reviewer-book-mirasim\.md/, 'mirasim 选 mirasim 审官书');
    assert.ok(mira.includes('p=900'), 'mirasim 带 PR 号');
    assert.ok(mira.includes('m=auto'), 'mirasim 带 merge-policy');
    assert.ok(!/\bd=/.test(mira), 'mirasim 审官注入没有对方 dispatch（无 orchestration）');
    assert.ok(!/\bs=1/.test(mira), 'mirasim 审官注入没有 skip-wait');
    assert.ok(!/\bfb=/.test(mira), 'mirasim 审官注入没有 fallback');

    const miraManual = buildReviewerInject({
      spec: 'x', issue: '880', pr: '900', mergePolicy: 'manual', mergeReason: 'foo', executor: 'mirasim',
    });
    assert.ok(miraManual.includes('m=manual') && miraManual.includes('r=foo'), 'mirasim manual 带理由');

    const orca = buildReviewerInject({
      spec: 'x', issue: '880', pr: '900', soldierDispatchId: 'DISP1', mergePolicy: 'auto',
    });
    assert.match(orca, /reviewer-book\.md/, 'orca 选 orca 审官书');
    assert.ok(orca.includes('d=DISP1'), 'orca 默认仍带对方 dispatch d=');
    assert.ok(!/mirasim/.test(orca), 'orca 默认不指 mirasim 书');
  });

  it('mirasim 士兵注入仍受 500 字节闸（超长 spec 抛）', async () => {
    const { buildSoldierInject } = await T_LOAD;
    const big = 'x'.repeat(600);
    assert.throws(() => buildSoldierInject({ spec: big, issue: '880', executor: 'mirasim' }), /超过上限/);
  });
});

describe('#880 卡 F：ask/notify/send 的 mirasim 分支', () => {
  it('ask：mirasim 拒绝并指回会话正文提问；orca 透传', async () => {
    const { mirasimVerbGuard } = await V_LOAD;
    const m = mirasimVerbGuard('ask', { executor: 'mirasim' });
    assert.equal(m.mirasim, true);
    assert.equal(m.refuse, true);
    assert.equal(m.pointTo, 'reply-in-session');
    assert.match(m.error, /interact/, '指路提到 interact');

    const o = mirasimVerbGuard('ask', { executor: undefined });
    assert.equal(o.mirasim, false, 'orca 透传，不拒');
    assert.ok(!o.refuse);
  });

  it('send：mirasim 拒绝并指回 interact；orca 透传', async () => {
    const { mirasimVerbGuard } = await V_LOAD;
    const m = mirasimVerbGuard('send', { executor: 'mirasim' });
    assert.equal(m.refuse, true);
    assert.equal(m.pointTo, 'mirasim-interact');

    const o = mirasimVerbGuard('send', { executor: 'orca' });
    assert.equal(o.mirasim, false);
  });

  it('notify：worker_done 指 PR+判据、其余指 GitHub 评论；orca 透传', async () => {
    const { mirasimVerbGuard } = await V_LOAD;
    const wd = mirasimVerbGuard('notify', { executor: 'mirasim', type: 'worker_done' });
    assert.equal(wd.refuse, true);
    assert.equal(wd.pointTo, 'pr-and-review');
    assert.match(wd.error, /结算/, 'worker_done 指路点明无结算');

    const gen = mirasimVerbGuard('notify', { executor: 'mirasim' });
    assert.equal(gen.refuse, true);
    assert.equal(gen.pointTo, 'github-comment');

    const o = mirasimVerbGuard('notify', {});
    assert.equal(o.mirasim, false, 'orca 透传');
  });

  it('未知动词在 mirasim 下 mirasim:true 但不拒（不误伤）', async () => {
    const { mirasimVerbGuard } = await V_LOAD;
    const r = mirasimVerbGuard('reply', { executor: 'mirasim' });
    assert.equal(r.mirasim, true);
    assert.ok(!r.refuse);
  });
});
