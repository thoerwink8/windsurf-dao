// #682 微通道 quick-fix：纯函数三态 + CLI 故意样本 + 检查器判别力
const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..');
const CLI = path.join(REPO, 'scripts', 'quick-fix.mjs');
const FAKE_GH = path.join(REPO, 'tests', 'fixtures', 'fake-gh.mjs');
const LIB_LOAD = import('file://' + path.join(REPO, 'scripts', 'lib', 'quick-fix.mjs').replace(/\\/g, '/'));
const CHECK_LOAD = import('file://' + path.join(REPO, 'scripts', 'lib', 'quick-fix-check.mjs').replace(/\\/g, '/'));
const GATE_LOAD = import('file://' + path.join(REPO, 'scripts', 'lib', 'reviewer-vendor-gate.mjs').replace(/\\/g, '/'));

function payload(r) {
  try { return JSON.parse(String(r.stdout || '').trim().split(/\r?\n/).pop()); }
  catch { return { raw: r.stdout, err: r.stderr }; }
}

function runCli(args, env = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8', cwd: REPO, env: { ...process.env, ...env }, timeout: 60000,
  });
}

const MODELS = [
  { id: 'grok-4.6', provider: 'grok' },
  { id: 'gpt-5.6-sol', provider: 'gpt' },
  { id: 'devin-deepseek-v4-flash-max', provider: 'devin' },
];

describe('#682 微通道 quick-fix', () => {
  it('resolveQuickFixReviewer：显式优先；无 label 列表 / 0 条 / 多条分开', async (t) => {
    const L = await LIB_LOAD;
    const flag = L.resolveQuickFixReviewer({ explicit: 'gpt-5.6-sol' });
    await t.test('显式 --reviewer 优先', () => {
      assert.ok(flag.ok && flag.modelId === 'gpt-5.6-sol' && flag.source === 'flag', JSON.stringify(flag));
    });
    const unscanned = L.resolveQuickFixReviewer({ labels: null });
    await t.test('label 列表没拿到 → 没查成，不是 0 条', () => {
      assert.ok(unscanned.ok === false && unscanned.state === 'unscanned' && /没查成/.test(unscanned.error),
        JSON.stringify(unscanned));
    });
    const none = L.resolveQuickFixReviewer({ labels: ['type/写码', 'model/grok-4.6'] });
    await t.test('扫完没有 reviewer/* → none', () => {
      assert.ok(none.ok === false && none.state === 'none' && /没有 reviewer/.test(none.error), JSON.stringify(none));
    });
    const many = L.resolveQuickFixReviewer({ labels: ['reviewer/gpt-5.6-sol', 'reviewer/claude-opus'] });
    await t.test('有多个 reviewer/* → many，不许猜', () => {
      assert.ok(many.ok === false && many.state === 'many', JSON.stringify(many));
    });
    const one = L.resolveQuickFixReviewer({ labels: ['reviewer/gpt-5.6-sol'] });
    await t.test('唯一 reviewer/* → 放行', () => {
      assert.ok(one.ok && one.modelId === 'gpt-5.6-sol', JSON.stringify(one));
    });
    await t.test('三种失败话面互不相同', () => {
      assert.ok(unscanned.error !== none.error && none.error !== many.error && unscanned.error !== many.error);
    });
  });

  it('planQuickFixGate：#679 三态照走，工人模型未声明单独可辨', async (t) => {
    const L = await LIB_LOAD;
    const noWorker = L.planQuickFixGate({ reviewerId: 'gpt-5.6-sol', models: MODELS });
    await t.test('主会话模型未声明 → 没查成，话面含未声明', () => {
      assert.ok(noWorker.ok === false && noWorker.state === 'unscanned' && /未声明/.test(noWorker.error),
        JSON.stringify(noWorker));
    });
    const noReviewer = L.planQuickFixGate({ workerModel: 'grok-4.6', models: MODELS });
    await t.test('审官没查成 → 没查成', () => {
      assert.ok(noReviewer.ok === false && noReviewer.state === 'unscanned' && /审官模型没查成/.test(noReviewer.error),
        JSON.stringify(noReviewer));
    });
    const same = L.planQuickFixGate({ workerModel: 'grok-4.6', reviewerId: 'grok-4.6', models: MODELS });
    await t.test('同厂 → same_vendor', () => {
      assert.ok(same.ok === false && same.state === 'same_vendor' && /同厂/.test(same.error), JSON.stringify(same));
    });
    const miss = L.planQuickFixGate({ workerModel: 'no-such', reviewerId: 'gpt-5.6-sol', models: MODELS });
    await t.test('工人不在路由表 → 没查成', () => {
      assert.ok(miss.ok === false && miss.state === 'unscanned' && miss.state !== 'same_vendor', JSON.stringify(miss));
    });
    const pass = L.planQuickFixGate({ workerModel: 'grok-4.6', reviewerId: 'gpt-5.6-sol', models: MODELS });
    await t.test('异厂 → 通过', () => {
      assert.ok(pass.ok && pass.state === 'pass' && pass.workerProvider === 'grok' && pass.reviewerProvider === 'gpt',
        JSON.stringify(pass));
    });
    await t.test('未声明 / 同厂 / 没查成 话面互不相同', () => {
      assert.ok(noWorker.error !== same.error && same.error !== miss.error && noWorker.error !== miss.error);
      assert.ok(noWorker.state === miss.state && miss.state === 'unscanned' && same.state === 'same_vendor',
        '未声明与没查成同属 unscanned，靠话面分开；同厂是独立态');
    });
  });

  it('quickFixBranchName / quickFixLabels / commit message', async (t) => {
    const L = await LIB_LOAD;
    const b = L.quickFixBranchName({ issue: '682', slug: '  修 注入 轮询！回归？  ' });
    await t.test('slug 清洗 + 截断 + 前缀', () => {
      assert.ok(b === 'thoerwink8/quickfix-682-修-注入-轮询-回归', `实际 ${b}`);
    });
    const empty = L.quickFixBranchName({ issue: '7', slug: '   ' });
    await t.test('空 slug 兜底 fix', () => {
      assert.ok(empty === 'thoerwink8/quickfix-7-fix', `实际 ${empty}`);
    });
    assert.throws(() => L.quickFixBranchName({ issue: 'x', slug: 'a' }));
    const labels = L.quickFixLabels({ model: 'devin-deepseek-v4-flash-max', reviewer: 'gpt-5.6-sol' });
    await t.test('label 组合含 model/* type/微修 reviewer/*', () => {
      assert.deepEqual(labels, ['model/devin-deepseek-v4-flash-max', 'type/微修', 'reviewer/gpt-5.6-sol']);
    });
    const msg = L.quickFixCommitMessage({ issue: '682', message: '修 typo' });
    await t.test('commit 前缀 [qf] + 单号', () => {
      assert.ok(msg === '[qf] 微修 #682：修 typo', `实际 ${msg}`);
    });
  });

  it('buildQuickFixPrBody：三段式 + 署名 issue；自定义正文缺署名要拒', async (t) => {
    const L = await LIB_LOAD;
    const auto = L.buildQuickFixPrBody({ issue: '682', message: '修 typo', files: ['docs/a.md'], seconds: 12.3 });
    await t.test('自动正文含 目标/验收标准/进展 + 署名 issue #682', () => {
      assert.ok(auto.ok, JSON.stringify(auto));
      assert.ok(/## 目标/.test(auto.body) && /## 验收标准/.test(auto.body) && /## 进展/.test(auto.body));
      assert.ok(/署名 issue #682/.test(auto.body), auto.body);
      assert.ok(/12\.3s/.test(auto.body), '实测计时在正文');
      assert.ok(!/Closes|Fixes|Resolves/i.test(auto.body), '不许带 GitHub 自动关单关键词');
    });
    const badCustom = L.buildQuickFixPrBody({ issue: '682', message: 'x', custom: '## 目标\n没有署名' });
    await t.test('自定义正文缺署名 issue → 拒', () => {
      assert.ok(badCustom.ok === false && /署名 issue/.test(badCustom.error), JSON.stringify(badCustom));
    });
    const goodCustom = L.buildQuickFixPrBody({
      issue: '682', message: 'x',
      custom: '## 目标\nx\n\n署名 issue #682，关单交给 scripts/close-issues.mjs。',
    });
    await t.test('自定义正文含署名 → 放行', () => {
      assert.ok(goodCustom.ok && goodCustom.custom === true, JSON.stringify(goodCustom));
    });
  });

  it('planIssueLabelStamps：model/* 缺失补全；不一致拒绝；type/reviewer 只补缺', async (t) => {
    const L = await LIB_LOAD;
    const missing = L.planIssueLabelStamps({ labels: [], model: 'devin-deepseek-v4-flash-max', reviewer: 'gpt-5.6-sol' });
    await t.test('issue 无 model/* → 补 model/type/reviewer', () => {
      assert.ok(missing.ok && missing.source === 'model-missing', JSON.stringify(missing));
      assert.deepEqual(missing.add, ['model/devin-deepseek-v4-flash-max', 'type/微修', 'reviewer/gpt-5.6-sol']);
    });
    const match = L.planIssueLabelStamps({
      labels: ['model/devin-deepseek-v4-flash-max', 'type/写码', 'reviewer/gpt-5.6-sol'],
      model: 'devin-deepseek-v4-flash-max', reviewer: 'gpt-5.6-sol',
    });
    await t.test('model 一致且 type/reviewer 都在 → 不补', () => {
      assert.ok(match.ok && match.add.length === 0, JSON.stringify(match));
    });
    const conflict = L.planIssueLabelStamps({ labels: ['model/grok-4.6'], model: 'devin-deepseek-v4-flash-max', reviewer: 'gpt-5.6-sol' });
    await t.test('model/* 与 --model 不一致 → 拒绝，不覆盖既有派工标签', () => {
      assert.ok(conflict.ok === false && conflict.state === 'conflict' && /不一致/.test(conflict.error),
        JSON.stringify(conflict));
    });
    const many = L.planIssueLabelStamps({
      labels: ['model/grok-4.6', 'model/gpt-5.6-sol'],
      model: 'devin-deepseek-v4-flash-max', reviewer: 'gpt-5.6-sol',
    });
    await t.test('多个 model/* → many，不许猜', () => {
      assert.ok(many.ok === false && many.state === 'many', JSON.stringify(many));
    });
    const unscanned = L.planIssueLabelStamps({ labels: null, model: 'x', reviewer: 'y' });
    await t.test('label 列表没拿到 → 没查成', () => {
      assert.ok(unscanned.ok === false && unscanned.state === 'unscanned', JSON.stringify(unscanned));
    });
  });

  it('CLI：缺 --issue / 缺 --model / 同厂 / 模型查不到，全部非零且话面分开', async (t) => {
    const noIssue = runCli(['--model', 'grok-4.6', '--dry-run']);
    const pNoIssue = payload(noIssue);
    await t.test('缺 --issue → 非零 + 要 --issue', () => {
      assert.ok(noIssue.status !== 0 && /--issue/.test(String(pNoIssue.error || '')), JSON.stringify(pNoIssue));
    });
    const noModel = runCli(['--issue', '1', '--dry-run']);
    const pNoModel = payload(noModel);
    await t.test('缺 --model → 非零 + 未声明', () => {
      assert.ok(noModel.status !== 0 && /未声明/.test(String(pNoModel.error || '')), JSON.stringify(pNoModel));
    });
    const same = runCli(['--issue', '1', '--model', 'grok-4.6', '--reviewer', 'grok-4.6', '--dry-run']);
    const pSame = payload(same);
    await t.test('同厂样本 → 非零 + 同厂（闸在 gh 前，CI 无 token 也拦）', () => {
      assert.ok(same.status !== 0 && /同厂/.test(String(pSame.error || '')), `status=${same.status} ${JSON.stringify(pSame)}`);
    });
    const miss = runCli(['--issue', '1', '--model', 'no-such', '--reviewer', 'gpt-5.6-sol', '--dry-run']);
    const pMiss = payload(miss);
    await t.test('模型不在路由表 → 非零 + 没查成', () => {
      assert.ok(miss.status !== 0 && /没查成|不在路由表/.test(String(pMiss.error || '')), JSON.stringify(pMiss));
    });
    await t.test('同厂与没查成话面不同', () => {
      assert.ok(pSame.error !== pMiss.error);
    });
  });

  it('CLI（假 gh）：issue 自读审官同厂被拦；异厂 dry-run 出计划；gh 失败没查成', async (t) => {
    const env = { DAO_GH_FAKE: FAKE_GH };
    const viaLabelSame = runCli(['--issue', '571', '--model', 'grok-4.6', '--dry-run'], env);
    const pVia = payload(viaLabelSame);
    await t.test('issue 571（model+grok reviewer+grok）自读审官 → 非零 + 同厂', () => {
      assert.ok(viaLabelSame.status !== 0 && /同厂/.test(String(pVia.error || '')), JSON.stringify(pVia));
    });
    const ok = runCli(['--issue', '565', '--model', 'grok-4.6', '--dry-run'], env);
    const pOk = payload(ok);
    await t.test('issue 565（model/grok + reviewer/gpt）dry-run → 0 且计划齐', () => {
      assert.ok(ok.status === 0 && pOk.ok === true && pOk.dryRun === true, JSON.stringify(pOk));
      assert.ok(pOk.reviewer === 'gpt-5.6-sol' && pOk.branch === 'thoerwink8/quickfix-565-微修', JSON.stringify(pOk));
      assert.ok(pOk.labels.includes('type/微修') && pOk.labels.includes('model/grok-4.6'), JSON.stringify(pOk.labels));
      assert.ok(pOk.gate && pOk.gate.state === 'pass', JSON.stringify(pOk.gate));
    });
    const noReviewer = runCli(['--issue', '568', '--model', 'grok-4.6', '--dry-run'], env);
    const pNoRev = payload(noReviewer);
    await t.test('issue 568 无 reviewer/* → 非零 + 扫完没有', () => {
      assert.ok(noReviewer.status !== 0 && /没有 reviewer/.test(String(pNoRev.error || '')), JSON.stringify(pNoRev));
    });
    const ghFail = runCli(['--issue', '999', '--model', 'grok-4.6', '--dry-run'], env);
    const pGhFail = payload(ghFail);
    await t.test('gh 读 issue 失败 → 非零 + 没查成，不是放行', () => {
      assert.ok(ghFail.status !== 0 && /没查成/.test(String(pGhFail.error || '')), JSON.stringify(pGhFail));
    });
    const conflict = runCli(['--issue', '565', '--model', 'devin-deepseek-v4-flash-max', '--dry-run'], env);
    const pConflict = payload(conflict);
    await t.test('issue model/* 与 --model 不一致 → 非零 + 不一致', () => {
      assert.ok(conflict.status !== 0 && /不一致/.test(String(pConflict.error || '')), JSON.stringify(pConflict));
    });
  });

  it('检查器红/绿/空有判别力，且不 import 被查对象', async (t) => {
    const fs = require('node:fs');
    const checkSrc = fs.readFileSync(path.join(REPO, 'scripts', 'lib', 'quick-fix-check.mjs'), 'utf8');
    await t.test('检查器源码不含 import 被查对象', () => {
      assert.ok(!/from\s+['"]\.\/quick-fix\.mjs['"]/.test(checkSrc), '检查器 import 了被查对象');
      assert.ok(!/from\s+['"]\.\/reviewer-vendor-gate\.mjs['"]/.test(checkSrc), '检查器 import 了闸本身');
    });
    const { inspectQuickFixSource, inspectDispatchRedLine, inspectQuickFixFixtures, probeQuickFixGate } = await CHECK_LOAD;
    const missing = inspectQuickFixSource({});
    await t.test('缺正文 → 没查成，不是绿', () => {
      assert.ok(missing.unscanned === true && missing.ok === false, JSON.stringify(missing));
    });
    const red = inspectQuickFixSource({ qfSrc: 'export function plan() { return 1; }', qfLibSrc: 'export const x = 1;' });
    await t.test('缺闸样本被扫到', () => {
      assert.ok(red.ok === false && red.problems.length >= 7, JSON.stringify(red));
    });
    const realSrc = fs.readFileSync(path.join(REPO, 'scripts', 'quick-fix.mjs'), 'utf8');
    const realLib = fs.readFileSync(path.join(REPO, 'scripts', 'lib', 'quick-fix.mjs'), 'utf8');
    const live = inspectQuickFixSource({ qfSrc: realSrc, qfLibSrc: realLib });
    await t.test('live quick-fix.mjs 全绿', () => {
      assert.ok(live.ok === true, JSON.stringify(live));
    });
    const skillLive = inspectDispatchRedLine({
      skillSrc: fs.readFileSync(path.join(REPO, 'host', 'skills', 'dispatch', 'SKILL.md'), 'utf8'),
    });
    await t.test('live dispatch SKILL 红线写例外', () => {
      assert.ok(skillLive.ok === true, JSON.stringify(skillLive));
    });
    const fx = inspectQuickFixFixtures(path.join(REPO, 'tests', 'fixtures', 'quick-fix'));
    await t.test('夹具红/绿/空各一份', () => {
      assert.ok(fx.ok === true && fx.kinds.red && fx.kinds.ok && fx.kinds.empty, JSON.stringify(fx));
    });
    const probe = probeQuickFixGate(REPO);
    await t.test('live 故意同厂样本被拦', () => {
      assert.ok(probe.ok === true, JSON.stringify(probe));
    });
    await t.test('GATE 纯函数仍可直接复用', async () => {
      const { assertCrossVendor } = await GATE_LOAD;
      assert.ok(assertCrossVendor({ workerId: 'grok-4.6', reviewerId: 'gpt-5.6-sol', models: MODELS }).state === 'pass');
    });
  });
});
