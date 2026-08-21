// #679 起审官同厂硬闸：纯函数三态 + CLI 故意同厂样本 + 检查器判别力
const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..');
const CLI = path.join(REPO, 'scripts', 'dao.mjs');
const FAKE_GH = path.join(REPO, 'tests', 'fixtures', 'fake-gh.mjs');
const GATE_LOAD = import('file://' + path.join(REPO, 'scripts', 'lib', 'reviewer-vendor-gate.mjs').replace(/\\/g, '/'));
const SLOT_LOAD = import('file://' + path.join(REPO, 'scripts', 'lib', 'dianjiangtai-reviewer-slot.mjs').replace(/\\/g, '/'));
const CMD_LOAD = import('file://' + path.join(REPO, 'scripts', 'lib', 'dao-cmd.mjs').replace(/\\/g, '/'));
const CHECK_LOAD = import('file://' + path.join(REPO, 'scripts', 'lib', 'reviewer-vendor-gate-check.mjs').replace(/\\/g, '/'));

function payload(r) {
  try { return JSON.parse(String(r.stdout || '').trim().split(/\r?\n/).pop()); }
  catch { return { raw: r.stdout, err: r.stderr }; }
}

const MODELS = [
  { id: 'grok-4.6', provider: 'grok', roles: ['写码'] },
  { id: 'gpt-5.6-sol', provider: 'gpt', roles: ['审查'] },
  { id: 'claude-opus', provider: 'claude', roles: ['审查'] },
  { id: 'kimi-k3', provider: 'cursor', roles: ['审查'] },
];
const POLICY_LOAD = import('file://' + path.join(REPO, 'scripts', 'lib', 'model-routing-json.mjs').replace(/\\/g, '/'));

describe('#679 起审官同厂硬闸', () => {
  let REVIEWER_ORDER;
  async function reviewerOrder() {
    if (!REVIEWER_ORDER) {
      const { loadRoutingPolicy } = await POLICY_LOAD;
      REVIEWER_ORDER = loadRoutingPolicy().reviewerOrder || [];
    }
    return REVIEWER_ORDER;
  }
  it('纯函数三态：通过 / 同厂拒绝 / 没查成', async (t) => {
    const { assertCrossVendor } = await GATE_LOAD;
    const pass = assertCrossVendor({ workerId: 'grok-4.6', reviewerId: 'gpt-5.6-sol', models: MODELS });
    await t.test('grok 工人 + gpt 审官 → 通过', () => {
      assert.ok(pass.ok === true && pass.state === 'pass', '通过  →  ' + JSON.stringify(pass));
    });
    const same = assertCrossVendor({ workerId: 'grok-4.6', reviewerId: 'grok-4.6', models: MODELS });
    await t.test('grok 工人 + grok 审官 → 同厂拒绝', () => {
      assert.ok(same.ok === false && same.state === 'same_vendor' && /同厂/.test(same.error),
        '同厂  →  ' + JSON.stringify(same));
    });
    const miss = assertCrossVendor({ workerId: 'grok-4.6', reviewerId: 'gpt-5.6-sol', models: null });
    await t.test('路由表没拿到 → 没查成，不是同厂', () => {
      assert.ok(miss.ok === false && miss.state === 'unscanned' && miss.state !== 'same_vendor',
        '没查成  →  ' + JSON.stringify(miss));
    });
    const unknown = assertCrossVendor({ workerId: 'no-such', reviewerId: 'gpt-5.6-sol', models: MODELS });
    await t.test('工人不在表 → 没查成', () => {
      assert.ok(unknown.ok === false && unknown.state === 'unscanned',
        '工人不在表  →  ' + JSON.stringify(unknown));
    });
    await t.test('三态互不相同', () => {
      assert.ok(pass.state !== same.state && same.state !== miss.state && pass.state !== miss.state);
    });
  });

  it('工人模型列表没拿到 ≠ 扫完没有 model/*', async (t) => {
    const S = await CMD_LOAD;
    const unscanned = S.requireWorkerModel(null);
    const none = S.requireWorkerModel([]);
    const none2 = S.requireWorkerModel(['type/写码', 'reviewer/gpt-5.6-sol']);
    await t.test('没拿到列表 → unscanned，话面含没查成', () => {
      assert.ok(unscanned.ok === false && unscanned.state === 'unscanned' && /没拿到|没查成/.test(unscanned.error),
        JSON.stringify(unscanned));
    });
    await t.test('扫完 0 条 → none，话面含没有 model', () => {
      assert.ok(none.ok === false && none.state === 'none' && /扫完没有 model/.test(none.error),
        JSON.stringify(none));
    });
    await t.test('有别的 label 但没有 model/* → none', () => {
      assert.ok(none2.ok === false && none2.state === 'none' && /扫完没有 model/.test(none2.error),
        JSON.stringify(none2));
    });
    await t.test('两种拒绝话面不同', () => {
      assert.ok(unscanned.error !== none.error && unscanned.state !== none.state);
    });
    const one = S.requireWorkerModel(['model/grok-4.6', 'reviewer/gpt-5.6-sol']);
    await t.test('有且仅有一个 model/* → 放行', () => {
      assert.ok(one.ok === true && one.modelId === 'grok-4.6', JSON.stringify(one));
    });
  });

  it('注入失败换人跳过工人那一厂；走完仍同厂则升级', async (t) => {
    const slot = await SLOT_LOAD;
    const order = await reviewerOrder();
    const passerIds = ['gpt-5.6-sol', 'claude-opus', 'kimi-k3'];
    const grokWorker = slot.nextReviewerAfter({
      currentId: 'gpt-5.6-sol', models: MODELS, passerIds, workerId: 'grok-4.6', order,
    });
    await t.test('工人 grok、当前 GPT → 下一位 kimi，不是 grok', () => {
      assert.ok(grokWorker.ok && grokWorker.next === 'kimi-k3' && grokWorker.next !== 'grok-4.6',
        JSON.stringify(grokWorker));
    });
    const skipKimi = slot.nextReviewerAfter({
      currentId: 'gpt-5.6-sol',
      models: MODELS,
      passerIds: ['gpt-5.6-sol', 'kimi-k3'],
      workerId: 'kimi-k3',
      order,
    });
    await t.test('选型序走完仍同厂 → 升级，不落到工人那一厂', () => {
      assert.ok(skipKimi.ok === false && skipKimi.exhausted === true && /同厂/.test(skipKimi.error),
        JSON.stringify(skipKimi));
    });
  });

  it('容量换人同一条：跳过工人那一厂；没查成工人则升级', async (t) => {
    const slot = await SLOT_LOAD;
    const order = await reviewerOrder();
    const models = MODELS;
    const passerIds = ['gpt-5.6-sol', 'kimi-k3'];
    const ok = slot.planCapacitySwitch({
      displayName: 'PR-#664 审官·gpt-5.6-sol',
      models,
      passerIds,
      workerId: 'grok-4.6',
      order,
    });
    await t.test('工人 grok 时 GPT 下一档仍是 kimi', () => {
      assert.ok(ok.ok && ok.action === 'switch' && ok.to === 'kimi-k3' && ok.pr === 664, JSON.stringify(ok));
    });
    const same = slot.planCapacitySwitch({
      displayName: 'PR-#664 审官·gpt-5.6-sol',
      models,
      passerIds,
      workerId: 'kimi-k3',
      order,
    });
    await t.test('下一档就是工人那一厂 → 升级，不换过去', () => {
      assert.ok(same.ok === false && same.action === 'escalate' && /同厂/.test(same.error), JSON.stringify(same));
    });
    const miss = slot.planCapacitySwitch({
      displayName: 'PR-#664 审官·gpt-5.6-sol',
      models,
      passerIds,
      order,
    });
    await t.test('没查成工人模型 → 升级不许换人', () => {
      assert.ok(miss.ok === false && miss.action === 'escalate' && miss.unscanned === true, JSON.stringify(miss));
    });
  });

  it('fallback 实际模型与卡名过期：按实际工人闸，不读卡名', async (t) => {
    const order = await reviewerOrder();
    const {
      filterSlateSameVendor, assertLaunchedWorkers, resolveActualWorkerModel, assertCrossVendor,
    } = await GATE_LOAD;
    const slot = await SLOT_LOAD;
    const slate = [
      { id: 'grok-4.6', pipes: [{ provider: 'grok' }] },
      { id: 'gpt-5.6-sol', pipes: [{ provider: 'gpt' }] },
      { id: 'kimi-k3', pipes: [{ provider: 'cursor' }] },
    ];
    const filtered = filterSlateSameVendor({
      slate, reviewerId: 'gpt-5.6-sol', models: MODELS, startIndex: 0,
    });
    await t.test('slate 预先剔除与审官同厂的 GPT', () => {
      assert.ok(filtered.ok === true && filtered.dropped.includes('gpt-5.6-sol'), JSON.stringify(filtered));
      assert.deepEqual(filtered.slate.map(s => s.id), ['grok-4.6', 'kimi-k3']);
      assert.ok(filtered.startIndex === 0);
    });
    const fallbackSame = assertLaunchedWorkers({
      workerIds: ['gpt-5.6-sol'], reviewerId: 'gpt-5.6-sol', models: MODELS,
    });
    await t.test('请求 grok 后 fallback 到 GPT、审官也是 GPT → 同厂拒绝', () => {
      assert.ok(fallbackSame.ok === false && fallbackSame.state === 'same_vendor', JSON.stringify(fallbackSame));
    });
    const splitSame = assertLaunchedWorkers({
      workerIds: ['grok-4.6', 'gpt-5.6-sol'], reviewerId: 'gpt-5.6-sol', models: MODELS,
    });
    await t.test('split 子工人之一 fallback 到审官同厂 → 拒绝', () => {
      assert.ok(splitSame.ok === false && splitSame.state === 'same_vendor', JSON.stringify(splitSame));
    });
    const splitPass = assertLaunchedWorkers({
      workerIds: ['grok-4.6', 'kimi-k3'], reviewerId: 'gpt-5.6-sol', models: MODELS,
    });
    await t.test('split 子工人都异厂 → 通过', () => {
      assert.ok(splitPass.ok === true && splitPass.state === 'pass', JSON.stringify(splitPass));
    });
    const hole = assertCrossVendor({
      workerId: 'gpt-5.6-sol', reviewerId: 'gpt-5.6-sol', models: MODELS,
    });
    await t.test('未剔除时 fallback 到 GPT 会同厂（回归样本）', () => {
      assert.ok(hole.state === 'same_vendor');
    });

    const actual = resolveActualWorkerModel({ dispatchModel: 'kimi-k3' });
    await t.test('Dispatch 元数据优先于卡名：实际是 kimi', () => {
      assert.ok(actual.ok && actual.source === 'dispatch' && actual.modelId === 'kimi-k3', JSON.stringify(actual));
    });
    const fromLabel = resolveActualWorkerModel({ labels: ['model/kimi-k3', 'type/写码'] });
    await t.test('无 Dispatch 时认唯一 model/*', () => {
      assert.ok(fromLabel.ok && fromLabel.source === 'label' && fromLabel.modelId === 'kimi-k3', JSON.stringify(fromLabel));
    });
    const unscanned = resolveActualWorkerModel({});
    await t.test('两边都没有 → 没查成，不许从卡名猜', () => {
      assert.ok(unscanned.ok === false && unscanned.state === 'unscanned' && /不许从卡名猜|没查成/.test(unscanned.error),
        JSON.stringify(unscanned));
    });
    const none = resolveActualWorkerModel({ labels: ['type/写码'] });
    await t.test('扫完没有 model/* → none，不是从卡名补', () => {
      assert.ok(none.ok === false && none.state === 'none' && /不许从卡名猜/.test(none.error), JSON.stringify(none));
    });
    const staleCard = slot.parseWorkerModelFromCard('PR-#680 工人·grok-4.6 写闸');
    await t.test('卡名仍是请求模型 grok（过期）', () => {
      assert.ok(staleCard.ok && staleCard.model === 'grok-4.6', JSON.stringify(staleCard));
    });
    const wrong = slot.planCapacitySwitch({
      displayName: 'PR-#680 审官·gpt-5.6-sol',
      models: MODELS,
      passerIds: ['gpt-5.6-sol', 'kimi-k3'],
      workerId: staleCard.model,
      order,
    });
    await t.test('误读过期卡名 grok → 会换到实际工人同厂的 kimi', () => {
      assert.ok(wrong.ok && wrong.to === 'kimi-k3', JSON.stringify(wrong));
    });
    const right = slot.planCapacitySwitch({
      displayName: 'PR-#680 审官·gpt-5.6-sol',
      models: MODELS,
      passerIds: ['gpt-5.6-sol', 'kimi-k3'],
      workerId: actual.modelId,
      order,
    });
    await t.test('按实际 kimi 换人 → 升级，不换到同厂', () => {
      assert.ok(right.ok === false && right.action === 'escalate' && /同厂/.test(right.error), JSON.stringify(right));
    });
  });

  it('不改 pinReviewerSlotA 顶位', async (t) => {
    const slot = await SLOT_LOAD;
    const order = await reviewerOrder();
    await t.test('门闩有 GPT 仍顶 GPT', () => {
      const p = slot.pinReviewerSlotA({
        models: MODELS,
        passerIds: ['grok-4.6', 'claude-opus', 'kimi-k3', 'gpt-5.6-sol'],
        order,
      });
      assert.ok(p.model === 'gpt-5.6-sol', JSON.stringify(p));
    });
    await t.test('无 GPT 按 JSON 序顶 grok', () => {
      const p = slot.pinReviewerSlotA({
        models: MODELS,
        passerIds: ['grok-4.6', 'claude-opus'],
        order,
      });
      assert.ok(p.model === 'grok-4.6', JSON.stringify(p));
    });
  });

  it('CLI：故意同厂样本被拦；异厂通过', async (t) => {
    function dispatch(model, reviewer) {
      return spawnSync(process.execPath, [
        CLI, 'dispatch', '--model', model, '--reviewer', reviewer,
        '--name', 'x', '--spec', '短摘要', '--split', 'no', '--split-reason', '单测', '--dry-run',
      ], { encoding: 'utf8', cwd: REPO });
    }
    const same = dispatch('grok-4.6', 'grok-4.6');
    const pSame = payload(same);
    await t.test('dispatch grok+grok 非零且话面含同厂', () => {
      assert.ok(same.status !== 0 && /同厂/.test(String(pSame.error || '')), JSON.stringify(pSame));
    });
    const pass = dispatch('grok-4.6', 'gpt-5.6-sol');
    const pPass = payload(pass);
    await t.test('dispatch grok+gpt dry-run 通过', () => {
      assert.ok(pass.status === 0 && pPass.ok === true, JSON.stringify(pPass));
    });

    const attachSame = spawnSync(process.execPath, [
      CLI, 'reviewer-attach', '--pr', '42', '--worktree', 'wt_w', '--reviewer', 'grok-4.6', '--dry-run',
    ], { encoding: 'utf8', cwd: REPO, env: { ...process.env, DAO_GH_FAKE: FAKE_GH } });
    const pAttachSame = payload(attachSame);
    await t.test('attach grok 到 grok 工人 → 非零且同厂', () => {
      assert.ok(attachSame.status !== 0 && /同厂/.test(String(pAttachSame.error || '')), JSON.stringify(pAttachSame));
    });
    const attachPass = spawnSync(process.execPath, [
      CLI, 'reviewer-attach', '--pr', '42', '--worktree', 'wt_w', '--reviewer', 'gpt-5.6-sol', '--dry-run',
    ], { encoding: 'utf8', cwd: REPO, env: { ...process.env, DAO_GH_FAKE: FAKE_GH } });
    const pAttachPass = payload(attachPass);
    await t.test('attach gpt 到 grok 工人 → dry-run 通过', () => {
      assert.ok(attachPass.status === 0 && pAttachPass.ok === true, JSON.stringify(pAttachPass));
    });

    const createSame = spawnSync(process.execPath, [
      CLI, 'reviewer-create', '--pr', '47', '--dry-run',
    ], { encoding: 'utf8', cwd: REPO, env: { ...process.env, DAO_GH_FAKE: FAKE_GH } });
    const pCreateSame = payload(createSame);
    await t.test('reviewer-create 自读同厂 label → 非零且同厂', () => {
      assert.ok(createSame.status !== 0 && /同厂/.test(String(pCreateSame.error || '')),
        `status=${createSame.status} ${JSON.stringify(pCreateSame)} stderr=${createSame.stderr}`);
    });

    const createNone = spawnSync(process.execPath, [
      CLI, 'reviewer-create', '--pr', '45', '--dry-run',
    ], { encoding: 'utf8', cwd: REPO, env: { ...process.env, DAO_GH_FAKE: FAKE_GH } });
    const pCreateNone = payload(createNone);
    await t.test('reviewer-create 扫完没有 model/* → 拒绝起审官', () => {
      assert.ok(createNone.status !== 0 && /扫完没有 model/.test(String(pCreateNone.error || '')),
        JSON.stringify(pCreateNone));
    });
  });

  it('检查器红/绿/空有判别力，且不 import 闸自己', async (t) => {
    const checkSrc = require('fs').readFileSync(
      path.join(REPO, 'scripts', 'lib', 'reviewer-vendor-gate-check.mjs'), 'utf8',
    );
    await t.test('检查器不 import reviewer-vendor-gate.mjs', () => {
      assert.ok(!/reviewer-vendor-gate\.mjs/.test(checkSrc.replace(/不 import reviewer-vendor-gate\.mjs/, '')),
        '检查器 import 了被查对象');
    });
    const {
      inspectVendorGateFixtures, inspectVendorGateWiring, probeSameVendorDispatch,
      inspectReviewerNoForceCommand,
    } = await CHECK_LOAD;
    const fx = inspectVendorGateFixtures(path.join(REPO, 'tests', 'fixtures', 'reviewer-vendor-gate'));
    await t.test('夹具红/绿/空各一份', () => {
      assert.ok(fx.ok === true && fx.kinds.red && fx.kinds.ok && fx.kinds.empty, JSON.stringify(fx));
    });
    const empty = inspectVendorGateWiring({});
    await t.test('缺正文 → 没查成，不是绿', () => {
      assert.ok(empty.unscanned === true && empty.ok === false, JSON.stringify(empty));
    });
    const probe = probeSameVendorDispatch(REPO);
    await t.test('live 故意同厂样本被拦住', () => {
      assert.ok(probe.ok === true, JSON.stringify(probe));
    });
    const noForceMiss = inspectReviewerNoForceCommand({});
    await t.test('审官 forceCommand 扫描缺正文 → 没查成', () => {
      assert.ok(noForceMiss.unscanned === true && noForceMiss.ok === false, JSON.stringify(noForceMiss));
    });
    const noForceLive = inspectReviewerNoForceCommand({
      daoSrc: require('fs').readFileSync(CLI, 'utf8'),
    });
    await t.test('live dao.mjs 审官路径不写 forceCommand', () => {
      assert.ok(noForceLive.ok === true, JSON.stringify(noForceLive));
    });
    const noForceRed = inspectReviewerNoForceCommand({
      daoSrc: 'function cmdReviewerCreate(args) {\n  forceCommand: true,\n}\nfunction cmdReviewerAttach(args) {\n  launchAgentInWorktree({ forceCommand: true });\n}\nfunction cmdSend() {}\n',
    });
    await t.test('故意 forceCommand 样本被扫到', () => {
      assert.ok(noForceRed.ok === false && noForceRed.problems.length >= 1, JSON.stringify(noForceRed));
    });
  });
});
