// #1359 审官顺位加席 terra/astra：判别性实验（不是「测试全绿」）。
// 正控：grok 工人 + 当前 sol → 下一位 terra（今天这里是 exhausted）。
// 负控：工人是 GPT 家族时四个 GPT 席全被同厂闸剔除。
// 实机：reviewer-create --dry-run 能点到新席位。
// unverified 不当绿：执行目录没探过的席位不得进 usable。
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
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
const NEW_SEAT_PROFILES = new Set(['codex-relay-gpt-5.6-terra', 'codex-relay-gpt-6-astra']);

// 「unverified 不当绿」测的是闸的性质，不是目录今天的状态：terra/astra 2026-09-18 已拿到执行证据
// （docs/evidence/1370-*-relay-execution.json，#1370），活目录里它们是 available。下面这些用例把两席
// 在夹具里钉回 unverified，闸才有东西可拦；读活目录的正控另起一条（见「已探过的席位进 usable」）。
function withUnverifiedNewSeats(profiles) {
  return profiles.map((p) => (NEW_SEAT_PROFILES.has(p.id)
    ? { ...p, availability: { ...p.availability, status: 'unverified', evidenceKind: 'inventory', sourceId: 'fixture-inventory', reason: 'fixture: 未探过' } }
    : p));
}

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
    const profiles = withUnverifiedNewSeats(loadExecutionProfiles());
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

  it('已探过的席位进 usable：活目录里 terra/astra 带执行级证据（#1370），四席 GPT 全可用', async () => {
    const { usableReviewerOrder, loadRoutingPolicy } = await POLICY_LOAD;
    const { loadExecutionProfiles } = await RUNTIME_LOAD;
    const profiles = loadExecutionProfiles();
    for (const id of NEW_SEAT_PROFILES) {
      const p = profiles.find((x) => x.id === id);
      assert.equal(p.availability.evidenceKind, 'execution', id);
      const evidence = JSON.parse(fs.readFileSync(path.join(REPO, 'docs', 'evidence', p.availability.sourceId + '.json'), 'utf8'));
      assert.equal(evidence.probe.tokenEchoed, true, id + ' 的证据文件必须记着 token 回显');
      assert.equal(evidence.sessionKey.startsWith('codex:'), true, id);
    }
    const r = usableReviewerOrder(loadRoutingPolicy().reviewerOrder, { profiles });
    assert.equal(r.unscanned, undefined, JSON.stringify(r));
    for (const seat of GPT_SEATS) assert.equal(r.usable.includes(seat), true, seat + ' 应可用  →  ' + JSON.stringify(r));
  });

  it('生产容量换人：未验证席位不得被选中（sol 满载不得落到 terra/astra）', async () => {
    const slot = await SLOT_LOAD;
    const { loadRoutingPolicy, orderForCapacityFailover, usableReviewerOrder } = await POLICY_LOAD;
    const { loadExecutionProfiles, resolveExecutionProfile } = await RUNTIME_LOAD;
    const policy = loadRoutingPolicy();
    const profiles = withUnverifiedNewSeats(loadExecutionProfiles());
    const DEAD = 'Selected model is at capacity. Please try a different model.';
    const base = {
      deadModelId: 'gpt-5.6-sol',
      deadError: DEAD,
      workerId: 'grok-4.6',
      models: policy.models,
    };

    // 审官复现：裸策略顺位仍会选中 terra（策略纯函数正控保留）。
    const policyPlan = slot.planReviewerOnCapacityDeath({
      requested: 'gpt-5.6-sol',
      capacityFailover: { ...base, passerIds: policy.reviewerOrder, order: policy.reviewerOrder },
    });
    assert.equal(policyPlan.ok, true, JSON.stringify(policyPlan));
    assert.equal(policyPlan.reviewerId, 'gpt-5.6-terra', JSON.stringify(policyPlan));
    assert.throws(
      () => resolveExecutionProfile({ model: 'gpt-5.6-terra' }, profiles),
      /unverified/,
    );

    const productionOrder = orderForCapacityFailover(policy.reviewerOrder, { profiles });
    const usable = usableReviewerOrder(policy.reviewerOrder, { profiles });
    assert.equal(usable.unscanned, undefined, '执行目录必须读得到  →  ' + JSON.stringify(usable));
    assert.deepEqual(productionOrder, usable.usable);
    assert.equal(productionOrder.includes('gpt-5.6-terra'), false, JSON.stringify(productionOrder));
    assert.equal(productionOrder.includes('gpt-6-astra'), false, JSON.stringify(productionOrder));

    const got = slot.planReviewerOnCapacityDeath({
      requested: 'gpt-5.6-sol',
      capacityFailover: { ...base, passerIds: productionOrder, order: productionOrder },
    });
    assert.notEqual(got.reviewerId, 'gpt-5.6-terra', JSON.stringify(got));
    assert.notEqual(got.reviewerId, 'gpt-6-astra', JSON.stringify(got));
    // grok 工人 + 已验证 GPT 席只剩刚死的 sol → 剩余 grok 同厂。
    // #1354：换厂无合法目标时留原席重试（原席与工人本就跨厂，#679 不破）；
    // 不得落到 unverified 的 terra/astra（上面两条 notEqual 已钉）。
    assert.equal(got.ok, true, JSON.stringify(got));
    assert.equal(got.reviewerId, 'gpt-5.6-sol', JSON.stringify(got));
    assert.equal(got.switched, false, JSON.stringify(got));
    assert.match(String(got.why), /换厂无合法目标，留在原席位重试/);
  });

  it('生产容量换人：已验证的下一位仍能换到（claude 工人 + sol 满载、terra/astra 未探 → grok）', async () => {
    const slot = await SLOT_LOAD;
    const { loadRoutingPolicy, orderForCapacityFailover } = await POLICY_LOAD;
    const { loadExecutionProfiles } = await RUNTIME_LOAD;
    const policy = loadRoutingPolicy();
    const order = orderForCapacityFailover(policy.reviewerOrder, { profiles: withUnverifiedNewSeats(loadExecutionProfiles()) });
    const got = slot.planReviewerOnCapacityDeath({
      requested: 'gpt-5.6-sol',
      capacityFailover: {
        deadModelId: 'gpt-5.6-sol',
        deadError: 'Selected model is at capacity. Please try a different model.',
        workerId: 'claude-opus-5',
        models: policy.models,
        passerIds: order,
        order,
      },
    });
    assert.equal(got.ok, true, JSON.stringify(got));
    assert.equal(got.reviewerId, 'grok-4.6', JSON.stringify(got));
  });

  it('审官位闸换厂候选也认可用性子序列（sol 死了点 grok，terra unverified 不算跳级）', async () => {
    const { assertReviewerSeat } = await import('file://' + path.join(REPO, 'scripts', 'lib', 'dispatch', 'reviewer.mjs').replace(/\\/g, '/'));
    const { loadRoutingPolicy, orderForCapacityFailover } = await POLICY_LOAD;
    const { loadExecutionProfiles } = await RUNTIME_LOAD;
    const policy = loadRoutingPolicy();
    const order = orderForCapacityFailover(policy.reviewerOrder, { profiles: withUnverifiedNewSeats(loadExecutionProfiles()) });
    const DEAD = 'Selected model is at capacity. Please try a different model.';
    const got = assertReviewerSeat({
      reviewerId: 'grok-4.6',
      routing: policy,
      capacityFailover: {
        deadModelId: 'gpt-5.6-sol',
        deadError: DEAD,
        workerId: 'claude-opus-5',
        order,
      },
    });
    assert.equal(got.ok, true, JSON.stringify(got));
    assert.equal(got.crossVendor, true, JSON.stringify(got));

    const skip = assertReviewerSeat({
      reviewerId: 'grok-4.6',
      routing: policy,
      capacityFailover: {
        deadModelId: 'gpt-5.6-sol',
        deadError: DEAD,
        workerId: 'claude-opus-5',
      },
    });
    assert.equal(skip.ok, false, '没给过滤后的序时 terra 仍在策略顺位里，点 grok 是跳级  →  ' + JSON.stringify(skip));
    assert.match(skip.error, /不许跳级点名|按顺位该换/);
  });

  it('生产接线：reviewer-create / worker-done 容量换人走过滤后的序，不是裸 reviewerOrder', () => {
    const src = fs.readFileSync(path.join(REPO, 'scripts', 'dao.mjs'), 'utf8');
    assert.match(src, /function capacityFailoverReviewerOrder\(/);
    assert.match(src, /function capacityFailoverCtx\(/);
    assert.match(src, /orderForCapacityFailover/);
    const createSeg = src.slice(
      src.indexOf('async function cmdReviewerCreateMirasim('),
      src.indexOf('async function cmdWorkerDoneMirasim('),
    );
    const doneStart = src.indexOf('async function cmdWorkerDoneMirasim(');
    const doneEnd = src.indexOf('\nasync function cmd', doneStart + 10);
    const doneSeg = src.slice(doneStart, doneEnd > doneStart ? doneEnd : doneStart + 12000);
    for (const [name, seg] of [['reviewer-create', createSeg], ['worker-done', doneSeg]]) {
      assert.match(seg, /capacityFailoverCtx\(/, `${name} 没走 capacityFailoverCtx`);
      assert.doesNotMatch(seg, /passerIds:\s*reviewerOrderOf\(routing\)/,
        `${name} 仍把裸顺位塞进换人凭证`);
    }
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
