// #1359 审官顺位加席 terra/astra：判别性实验（不是「测试全绿」）。
// 正控：grok 工人 + 当前 sol → 下一位 terra（今天这里是 exhausted）。
// 负控：工人是 GPT 家族时四个 GPT 席全被同厂闸剔除。
// 实机：reviewer-create --dry-run 能点到新席位。
// unverified 不当绿：执行目录没探过的席位不得进 usable。
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..');
const CLI = path.join(REPO, 'scripts', 'dao.mjs');
const FAKE_GH = path.join(REPO, 'tests', 'fixtures', 'fake-gh.mjs');

const SLOT_LOAD = import('file://' + path.join(REPO, 'scripts', 'lib', 'dianjiangtai-reviewer-slot.mjs').replace(/\\/g, '/'));
const POLICY_LOAD = import('file://' + path.join(REPO, 'scripts', 'lib', 'model-routing-json.mjs').replace(/\\/g, '/'));
const GATE_LOAD = import('file://' + path.join(REPO, 'scripts', 'lib', 'reviewer-vendor-gate.mjs').replace(/\\/g, '/'));
const RUNTIME_LOAD = import('file://' + path.join(REPO, 'scripts', 'lib', 'execution-runtime.mjs').replace(/\\/g, '/'));

function payload(r) {
  try { return JSON.parse(String(r.stdout || '').trim().split(/\r?\n/).pop()); }
  catch { return { raw: r.stdout, err: r.stderr }; }
}

const GPT_SEATS = ['gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-6-astra'];

describe('#1359 审官顺位加 terra/astra 两席', () => {
  it('reviewerOrder 变成 5 席：前 4 席 GPT，grok 仍在最后', async () => {
    const { loadRoutingPolicy } = await POLICY_LOAD;
    const { vendorFamilyOf } = await GATE_LOAD;
    const order = loadRoutingPolicy().reviewerOrder || [];
    assert.equal(order.length, 5, '席位数  →  ' + JSON.stringify(order));
    assert.deepEqual(order, [...GPT_SEATS, 'grok-4.6']);
    assert.deepEqual(order.slice(0, 4).map(vendorFamilyOf), ['gpt', 'gpt', 'gpt', 'gpt']);
    assert.equal(vendorFamilyOf(order[4]), 'grok');
  });

  it('关键正控：worker=grok-4.6、current=gpt-5.6-sol → next=gpt-5.6-terra', async () => {
    const slot = await SLOT_LOAD;
    const { loadRoutingPolicy } = await POLICY_LOAD;
    const policy = loadRoutingPolicy();
    const order = policy.reviewerOrder;
    const got = slot.nextReviewerAfter({
      currentId: 'gpt-5.6-sol',
      models: policy.models,
      passerIds: order,
      workerId: 'grok-4.6',
      order,
    });
    assert.equal(got.ok, true, JSON.stringify(got));
    assert.equal(got.next, 'gpt-5.6-terra', JSON.stringify(got));
    assert.equal(got.exhausted, undefined);
  });

  it('负控：工人是 GPT 家族时四个 GPT 席全部剔除（#679 不因加席被绕过）', async () => {
    const slot = await SLOT_LOAD;
    const { loadRoutingPolicy } = await POLICY_LOAD;
    const { vendorFamilyOf } = await GATE_LOAD;
    const policy = loadRoutingPolicy();
    const order = policy.reviewerOrder;
    const workerId = 'gpt-5.6-sol';
    assert.equal(vendorFamilyOf(workerId), 'gpt');

    for (const currentId of GPT_SEATS) {
      const got = slot.nextReviewerAfter({
        currentId,
        models: policy.models,
        passerIds: order,
        workerId,
        order,
      });
      if (got.ok) {
        assert.notEqual(vendorFamilyOf(got.next), 'gpt',
          `工人 GPT 时不得落到 GPT 席  current=${currentId}  →  ` + JSON.stringify(got));
      }
    }

    const afterLuna = slot.nextReviewerAfter({
      currentId: 'gpt-5.6-luna', models: policy.models, passerIds: order, workerId, order,
    });
    assert.equal(afterLuna.ok, true, JSON.stringify(afterLuna));
    assert.equal(afterLuna.next, 'grok-4.6', '四个 GPT 席跳过后才到 grok  →  ' + JSON.stringify(afterLuna));

    const afterGrok = slot.nextReviewerAfter({
      currentId: 'grok-4.6', models: policy.models, passerIds: order, workerId, order,
    });
    assert.equal(afterGrok.ok, false, JSON.stringify(afterGrok));
    assert.equal(afterGrok.exhausted, true);
  });

  it('实机：reviewer-create --dry-run 能点到新席位 terra', () => {
    const r = spawnSync(process.execPath, [
      CLI, 'reviewer-create', '--pr', '42', '--reviewer', 'gpt-5.6-terra', '--dry-run',
    ], { encoding: 'utf8', cwd: REPO, env: { ...process.env, DAO_GH_FAKE: FAKE_GH } });
    const p = payload(r);
    assert.equal(r.status, 0, `status=${r.status} ` + JSON.stringify(p).slice(0, 400));
    assert.equal(p.ok, true, JSON.stringify(p).slice(0, 400));
    assert.equal(p.reviewer, 'gpt-5.6-terra', JSON.stringify(p).slice(0, 400));
    assert.equal(p.dryRun, true);
  });

  it('新席位没探过不得当绿：terra/astra 在 usable 里不许出现（availability=unverified）', async () => {
    const { usableReviewerOrder, loadRoutingPolicy } = await POLICY_LOAD;
    const { loadExecutionProfiles } = await RUNTIME_LOAD;
    const order = loadRoutingPolicy().reviewerOrder;
    const profiles = loadExecutionProfiles();
    const r = usableReviewerOrder(order, { profiles });
    assert.equal(r.unscanned, undefined, '执行目录必须读得到  →  ' + JSON.stringify(r));
    assert.equal(r.usable.includes('gpt-5.6-terra'), false, 'terra unverified 不当绿  →  ' + JSON.stringify(r));
    assert.equal(r.usable.includes('gpt-6-astra'), false, 'astra unverified 不当绿  →  ' + JSON.stringify(r));
    const terraSkip = r.skipped.find((s) => s.id === 'gpt-5.6-terra');
    const astraSkip = r.skipped.find((s) => s.id === 'gpt-6-astra');
    assert.equal(terraSkip != null, true, JSON.stringify(r.skipped));
    assert.match(terraSkip.why, /unverified/);
    assert.equal(astraSkip != null, true, JSON.stringify(r.skipped));
    assert.match(astraSkip.why, /unverified/);
  });

  it('负控：新 GPT 席位进既有 UI 禁令名单（加席不许绕开 GPT 禁入 UI）', async () => {
    const { loadRoutingPolicy } = await POLICY_LOAD;
    const bans = loadRoutingPolicy().policyBans || [];
    const ui = bans.find((b) => b.id === 'ban-gpt-ui');
    assert.ok(ui, '找不到 ban-gpt-ui');
    assert.ok(ui.models.includes('gpt-5.6-terra'), JSON.stringify(ui.models));
    assert.ok(ui.models.includes('gpt-6-astra'), JSON.stringify(ui.models));
    assert.ok((ui.work_types || []).includes('UI'), JSON.stringify(ui.work_types));
  });
});
