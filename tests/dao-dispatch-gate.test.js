// tests/dao-dispatch-gate.test.js —— dao 派工硬闸
//
// 2026-09-06 从 dao.test.js 拆出（原 4220 行 / 1058 用例一个文件）。
// 本套管：merge-policy / 消歧门 / --split 必填——都是「缺参数必须报错」的约束层
// 共享前置在 tests/helpers/dao-harness.js，各套逐字复用，行为与拆分前一致。

const { describe, it } = require('node:test');
const { assert, fs, os, path, spawnSync, REPO, CLI, LIB, S_LOAD, DAO_LOAD, cliInProc, ROUTING_LOAD, waitForOutJson } = require('./helpers/dao-harness');

describe('dao 派工硬闸', () => {
  it('④⑤⑥ 派工硬闸（merge-policy 默认 auto；manual 必带理由；缺 model/reviewer 报错）', async (t) => {
    const S = await S_LOAD;
    const routing = await ROUTING_LOAD;
    function withSplit(extra) {
      if (extra.includes('--split')) return extra;
      return [...extra, '--split', 'no', '--split-reason', '单测默认：不测拆分'];
    }
    function dispatch(extra, opts = {}) {
      const args = opts.raw ? extra : withSplit(extra);
      return spawnSync(process.execPath, [CLI, 'dispatch', ...args], { encoding: 'utf8', cwd: REPO });
    }
    function payload(r) {
      try { return JSON.parse((r.stdout || '').trim().split(/\r?\n/).pop()); }
      catch { return { raw: r.stdout, err: r.stderr }; }
    }

    const noMerge = dispatch(['--model', 'grok-4.6', '--reviewer', 'gpt-5.6-sol', '--confirm', '--name', 'x', '--spec', '短摘要', '--dry-run']);
    const p1 = payload(noMerge);
    await t.test('缺 --merge-policy → 默认 auto 通过', () => {
      assert.ok(noMerge.status === 0 && p1.mergePolicy === 'auto', '缺 --merge-policy → 默认 auto 通过  →  ' + JSON.stringify(p1));
    });

    const noReason = dispatch(['--merge-policy', 'manual', '--model', 'grok-4.6', '--reviewer', 'gpt-5.6-sol', '--name', 'x', '--spec', '短摘要', '--dry-run']);
    const p1b = payload(noReason);
    await t.test('manual 无 --merge-reason → 非零', () => {
      assert.ok(noReason.status !== 0, 'manual 无 --merge-reason → 非零  →  ' + `status=${noReason.status}`);
    });
    await t.test('manual 无 --merge-reason → 打印缺什么', () => {
      assert.ok(p1b.error && String(p1b.error).includes('--merge-reason'), 'manual 无 --merge-reason → 打印缺什么  →  ' + JSON.stringify(p1b));
    });

    const withReason = dispatch(['--merge-policy', 'manual', '--merge-reason', '改协作约定 CLAUDE.md', '--model', 'grok-4.6', '--reviewer', 'gpt-5.6-sol', '--confirm', '--name', 'x', '--spec', '短摘要', '--dry-run']);
    const p1c = payload(withReason);
    await t.test('manual 带理由 → 通过且理由落 comment', () => {
      assert.ok(withReason.status === 0 && p1c.mergePolicy === 'manual' && /manual 理由: 改协作约定/.test(p1c.comment), 'manual 带理由 → 通过且理由落 comment  →  ' + JSON.stringify(p1c));
    });
    await t.test('manual 带理由 → mergeReason 透传', () => {
      assert.ok(p1c.mergeReason === '改协作约定 CLAUDE.md', 'manual 带理由 → mergeReason 透传  →  ' + JSON.stringify(p1c));
    });

    const emptyReason = dispatch(['--merge-policy', 'manual', '--merge-reason', '  ', '--model', 'grok-4.6', '--reviewer', 'gpt-5.6-sol', '--name', 'x', '--spec', '短摘要', '--dry-run']);
    const p1d = payload(emptyReason);
    await t.test('manual 理由为空白 → 非零（理由为空即退出）', () => {
      assert.ok(emptyReason.status !== 0 && /--merge-reason/.test(p1d.error || ''), 'manual 理由为空白 → 非零（理由为空即退出）  →  ' + JSON.stringify(p1d));
    });

    const autoExplicit = dispatch(['--merge-policy', 'auto', '--model', 'grok-4.6', '--reviewer', 'gpt-5.6-sol', '--confirm', '--name', 'x', '--spec', '短摘要', '--dry-run']);
    const p1e = payload(autoExplicit);
    await t.test('显式 auto 无需理由 → 通过', () => {
      assert.ok(autoExplicit.status === 0 && p1e.mergePolicy === 'auto', '显式 auto 无需理由 → 通过  →  ' + JSON.stringify(p1e));
    });
    await t.test('#615 dry-run 带 slate 且 grok 在名单里', () => {
      assert.ok(Array.isArray(p1e.slate) && p1e.slate.some(s => s && s.id === 'grok-4.6' && Array.isArray(s.pipes)), '#615 dry-run 带 slate 且 grok 在名单里  →  ' + JSON.stringify(p1e.slate));
    });

    const noModel = dispatch(['--merge-policy', 'auto', '--reviewer', 'gpt-5.6-sol', '--name', 'x', '--dry-run']);
    const p2 = payload(noModel);
    await t.test('缺 --model/--role → 非零', () => {
      assert.ok(noModel.status !== 0, '缺 --model/--role → 非零  →  ' + `status=${noModel.status}`);
    });
    await t.test('缺 --model/--role → 打印缺什么', () => {
      assert.ok(p2.error && String(p2.error).includes('--model'), '缺 --model/--role → 打印缺什么  →  ' + JSON.stringify(p2));
    });

    const noRev = dispatch(['--merge-policy', 'auto', '--model', 'grok-4.6', '--name', 'x', '--dry-run']);
    const p3 = payload(noRev);
    await t.test('缺 --reviewer → 非零', () => {
      assert.ok(noRev.status !== 0, '缺 --reviewer → 非零  →  ' + `status=${noRev.status}`);
    });
    await t.test('缺 --reviewer → 打印缺什么', () => {
      assert.ok(p3.error && String(p3.error).includes('--reviewer'), '缺 --reviewer → 打印缺什么  →  ' + JSON.stringify(p3));
    });

    const noSpec = dispatch(['--merge-policy', 'auto', '--model', 'grok-4.6', '--reviewer', 'gpt-5.6-sol', '--confirm', '--name', 'x', '--dry-run']);
    const pSpec = payload(noSpec);
    await t.test('R5 缺 --spec → 非零', () => {
      assert.ok(noSpec.status !== 0, 'R5 缺 --spec → 非零  →  ' + `status=${noSpec.status}`);
    });
    await t.test('R5 缺 --spec → 打印缺什么', () => {
      assert.ok(pSpec.error && String(pSpec.error).includes('--spec'), 'R5 缺 --spec → 打印缺什么  →  ' + JSON.stringify(pSpec));
    });

    const ok = dispatch(['--merge-policy', 'auto', '--model', 'grok-4.6', '--reviewer', 'gpt-5.6-sol', '--confirm', '--name', 'x', '--spec', '短摘要：修命令库', '--dry-run']);
    const pOk = payload(ok);
    await t.test('三参数齐 + --spec → dry-run 过', () => {
      assert.ok(ok.status === 0 && pOk.ok === true, '三参数齐 + --spec → dry-run 过  →  ' + JSON.stringify(pOk));
    });
    await t.test('dry-run 不再预建审官卡（#586 按需起）', () => {
      assert.ok(pOk.reviewerDeferred === true && pOk.reviewerCard == null, 'dry-run 不再预建审官卡（#586 按需起）  →  ' + JSON.stringify(pOk));
    });
    await t.test('dry-run 仍校验审官 launch（不建卡但选型要合法）', () => {
      assert.ok(/codex/.test(pOk.reviewerLaunchChecked) && String(pOk.reviewerLaunchChecked || '').includes(S.CODEX_CAPABLE_FLAG), 'dry-run 仍校验审官 launch（不建卡但选型要合法）  →  ' + JSON.stringify(pOk));
    });
    await t.test('dry-run 工人走 pi gw/grok-4.6', () => {
      assert.ok(/pi --model gw\/grok-4\.6/.test(pOk.workerLaunch), 'dry-run 工人走 pi gw  →  ' + JSON.stringify(pOk));
    });

    const okIssue = dispatch(['--merge-policy', 'auto', '--model', 'grok-4.6', '--reviewer', 'gpt-5.6-sol', '--confirm', '--name', '修地基', '--issue', '565', '--spec', '短摘要', '--dry-run']);
    const pIssue = payload(okIssue);
    await t.test('#589：dry-run 带 --issue → 工人卡 ISSUE- + 角色·模型（审官卡推迟到 worker-done）', () => {
      assert.ok(okIssue.status === 0 && pIssue.workerCard === 'ISSUE-#565 工人·grok-4.6 修地基' && pIssue.reviewerDeferred === true, '#589：dry-run 带 --issue → 工人卡 ISSUE-# + 角色·模型  →  ' + JSON.stringify(pIssue));
    });
    await t.test('#559 追加：dry-run 带 --issue → issue 字段透出', () => {
      assert.ok(pIssue.issue === '565', '#559 追加：dry-run 带 --issue → issue 字段透出  →  ' + JSON.stringify(pIssue));
    });

    const peak = '2026-08-15T02:00:00.000Z'; // 北京 10:00 峰时
    const roleOnly = dispatch(['--merge-policy', 'auto', '--role', '写码', '--reviewer', 'gpt-5.6-sol', '--now', peak, '--name', 'x', '--spec', '短摘要', '--dry-run']);
    const pRole = payload(roleOnly);
    await t.test('峰时只给 --role 不给 --model → 非零（禁静默默认）', () => {
      assert.ok(roleOnly.status !== 0, '峰时只给 --role 不给 --model → 非零（禁静默默认）  →  ' + JSON.stringify(pRole));
    });
    await t.test('写码推荐 grok-4.6 通道条目不是 ds-flash', () => {
      assert.ok(pRole.recommendation && pRole.recommendation.model === 'grok-4.6', '写码推荐 grok 通道条目  →  ' + JSON.stringify(pRole));
    });
    await t.test('写码推荐不是 deepseek-v4-flash（误推钉）', () => {
      assert.ok(!(pRole.recommendation && pRole.recommendation.model === 'deepseek-v4-flash'), '写码推荐不是 deepseek-v4-flash（误推钉）  →  ' + JSON.stringify(pRole));
    });

    const roleConfirm = dispatch(['--merge-policy', 'auto', '--role', '写码', '--reviewer', 'gpt-5.6-sol', '--now', peak, '--confirm', '--name', 'x', '--spec', '短摘要', '--dry-run']);
    const pConf = payload(roleConfirm);
    await t.test('--role + --confirm 采用写码推荐 grok-4.6', () => {
      assert.ok(roleConfirm.status === 0 && pConf.model === 'grok-4.6', '--role + --confirm 采用写码推荐 grok  →  ' + JSON.stringify(pConf));
    });

    // #754 偏离闸：手写 --model 偏离该工种顺位 1（默认写码；给了 --role 按那个工种），
    // 与 --role 走同一条 --confirm，禁第三种确认旗标。
    const fnDeviation = S.resolveDispatchConstraints({
      model: 'deepseek-v4-flash', reviewer: 'gpt-5.6-sol', routing,
    });
    await t.test('函数层：#754 写码 --model deepseek-v4-flash 偏离 1 号 → 失败要 --confirm', () => {
      assert.ok(fnDeviation.ok === false && fnDeviation.needsConfirm === true && (fnDeviation.missing || []).includes('--confirm'),
        '偏离 1 号 → 失败要 --confirm  →  ' + JSON.stringify(fnDeviation));
    });
    await t.test('函数层：偏离话面点名 1 号模型、手写模型与 --confirm', () => {
      assert.ok(/grok-4\.6/.test(fnDeviation.error) && /deepseek-v4-flash/.test(fnDeviation.error) && /--confirm/.test(fnDeviation.error),
        '话面点名 1 号/手写/--confirm  →  ' + fnDeviation.error);
    });
    const fnDeviationConfirm = S.resolveDispatchConstraints({
      model: 'deepseek-v4-flash', reviewer: 'gpt-5.6-sol', confirm: true, routing,
    });
    await t.test('函数层：偏离 1 号带 --confirm → 放行', () => {
      assert.ok(fnDeviationConfirm.ok === true && fnDeviationConfirm.model === 'deepseek-v4-flash',
        '偏离 1 号带 --confirm → 放行  →  ' + JSON.stringify(fnDeviationConfirm));
    });
    const fnRankOne = S.resolveDispatchConstraints({
      model: 'grok-4.6', reviewer: 'gpt-5.6-sol', routing,
    });
    await t.test('函数层：--model 正是顺位 1 → 不用 confirm', () => {
      assert.ok(fnRankOne.ok === true && fnRankOne.model === 'grok-4.6',
        '--model 正是顺位 1 → 不用 confirm  →  ' + JSON.stringify(fnRankOne));
    });
    const fnRoleDeviation = S.resolveDispatchConstraints({
      model: 'gpt-5.6-sol', role: '查证', reviewer: 'gpt-5.6-sol', routing,
    });
    await t.test('函数层：#754 给了 --role 按那个工种对账（查证 1 号 grok，gpt 偏离要 --confirm）', () => {
      assert.ok(fnRoleDeviation.ok === false && fnRoleDeviation.needsConfirm === true && /查证配置单顺位 1 是 grok-4\.6/.test(fnRoleDeviation.error),
        '按 --role 工种对账  →  ' + JSON.stringify(fnRoleDeviation));
    });
    const fnRoleRankOne = S.resolveDispatchConstraints({
      model: 'grok-4.6', role: '查证', reviewer: 'gpt-5.6-sol', routing,
    });
    await t.test('函数层：--role 工种顺位 1 的 --model → 不用 confirm', () => {
      assert.ok(fnRoleRankOne.ok === true && fnRoleRankOne.model === 'grok-4.6',
        '查证 1 号 grok 直接过  →  ' + JSON.stringify(fnRoleRankOne));
    });

    const devFlash = dispatch(['--merge-policy', 'auto', '--model', 'deepseek-v4-flash', '--reviewer', 'gpt-5.6-sol', '--name', 'x', '--spec', '短摘要', '--dry-run']);
    const pDevFlash = payload(devFlash);
    await t.test('#754 dispatch --dry-run：写码 --model deepseek-v4-flash 无 --confirm → 非零', () => {
      assert.ok(devFlash.status !== 0, '#754 无 --confirm → 非零  →  ' + `status=${devFlash.status} ${JSON.stringify(pDevFlash)}`);
    });
    await t.test('#754 dispatch --dry-run：错误点名 1 号 / 手写 / --confirm', () => {
      assert.ok(/grok-4\.6/.test(pDevFlash.error || '') && /deepseek-v4-flash/.test(pDevFlash.error || '') && /--confirm/.test(pDevFlash.error || ''),
        '错误点名  →  ' + JSON.stringify(pDevFlash));
    });
    const devFlashConf = dispatch(['--merge-policy', 'auto', '--model', 'deepseek-v4-flash', '--reviewer', 'gpt-5.6-sol', '--confirm', '--name', 'x', '--spec', '短摘要', '--dry-run']);
    const pDevFlashConf = payload(devFlashConf);
    await t.test('#754 dispatch --dry-run：写码 --model deepseek-v4-flash 带 --confirm → 过', () => {
      assert.ok(devFlashConf.status === 0 && pDevFlashConf.ok === true && pDevFlashConf.model === 'deepseek-v4-flash',
        '#754 带 --confirm → 过  →  ' + JSON.stringify(pDevFlashConf));
    });
    const rankOne = dispatch(['--merge-policy', 'auto', '--model', 'grok-4.6', '--reviewer', 'gpt-5.6-sol', '--name', 'x', '--spec', '短摘要', '--dry-run']);
    const pRankOne = payload(rankOne);
    await t.test('#754 dispatch --dry-run：--model grok-4.6（顺位 1）不用 confirm', () => {
      assert.ok(rankOne.status === 0 && pRankOne.ok === true && pRankOne.model === 'grok-4.6',
        '顺位 1 直接过  →  ' + JSON.stringify(pRankOne));
    });

    const fnDefault = S.resolveDispatchConstraints({
      model: 'grok-4.6', reviewer: 'gpt-5.6-sol', routing,
    });
    await t.test('函数层不给 mergePolicy → 默认 auto', () => {
      assert.ok(fnDefault.ok === true && fnDefault.mergePolicy === 'auto', '函数层不给 mergePolicy → 默认 auto  →  ' + JSON.stringify(fnDefault));
    });
    const fnManualNoReason = S.resolveDispatchConstraints({
      mergePolicy: 'manual', model: 'grok-4.6', reviewer: 'gpt-5.6-sol', routing,
    });
    await t.test('函数层 manual 无理由 → 失败', () => {
      assert.ok(fnManualNoReason.ok === false && (fnManualNoReason.missing || []).includes('--merge-reason'), '函数层 manual 无理由 → 失败  →  ' + JSON.stringify(fnManualNoReason));
    });

    const fnMiss = S.resolveDispatchConstraints({
      mergePolicy: 'auto', model: 'grok-4.6', routing,
    });
    await t.test('函数层缺 --reviewer 也失败', () => {
      assert.ok(fnMiss.ok === false && (fnMiss.missing || []).includes('--reviewer'), '函数层缺 --reviewer 也失败  →  ' + JSON.stringify(fnMiss));
    });

    const ws = spawnSync(process.execPath, [
      CLI, 'worker-start', '--task', 't', '--worktree', 'w', '--terminal', 'h',
    ], { encoding: 'utf8', cwd: REPO });
    const pWs = payload(ws);
    await t.test('worker-start 缺 model/reviewer → 非零', () => {
      assert.ok(ws.status !== 0 && String(pWs.error || '').includes('--model'), 'worker-start 缺 model/reviewer → 非零  →  ' + JSON.stringify(pWs));
    });

    const wsManual = spawnSync(process.execPath, [
      CLI, 'worker-start', '--task', 't', '--worktree', 'w', '--terminal', 'h',
      '--merge-policy', 'manual', '--model', 'grok-4.6', '--reviewer', 'gpt-5.6-sol',
    ], { encoding: 'utf8', cwd: REPO });
    const pWsManual = payload(wsManual);
    await t.test('worker-start manual 无理由 → 非零', () => {
      assert.ok(wsManual.status !== 0 && /--merge-reason/.test(pWsManual.error || ''), 'worker-start manual 无理由 → 非零  →  ' + JSON.stringify(pWsManual));
    });
  });

  it('#565 消歧门：dispatch/worker-start 带 --issue 时缺「已消歧」label 拒派', async (t) => {
    const S = await S_LOAD;
    // 纯函数三态判别（假 gh，不碰网络）：查成有 label / 查成没 label / 没查成（gh 失败 / 非 JSON）。
    const ghHas = () => ({ ok: true, out: JSON.stringify({ labels: [{ name: '已消歧' }, { name: '任务' }] }) });
    const ghNone = () => ({ ok: true, out: JSON.stringify({ labels: [{ name: '任务' }] }) });
    const ghFail = () => ({ ok: false, error: 'gh exit 1: network down' });
    const ghBroken = () => ({ ok: true, out: 'not json at all' });

    const ok1 = S.checkIssueDisambiguated({ issue: '565', runGh: ghHas });
    await t.test('消歧门：有 已消歧 label → 放行', () => {
      assert.ok(ok1.ok === true && ok1.hasLabel === true && ok1.gated === true, '消歧门：有 已消歧 label → 放行  →  ' + JSON.stringify(ok1));
    });
    const no1 = S.checkIssueDisambiguated({ issue: '559', runGh: ghNone });
    await t.test('消歧门：查成但没 label → 拒派并点名缺什么', () => {
      assert.ok(no1.ok === false && no1.hasLabel === false && /已消歧/.test(no1.error) && /补消歧记录|label/.test(no1.error), '消歧门：查成但没 label → 拒派并点名缺什么  →  ' + JSON.stringify(no1));
    });
    const ghSynonym = () => ({ ok: true, out: JSON.stringify({ labels: [{ name: '已拍板' }, { name: '已澄清' }, { name: 'disambiguated' }, { name: '待拍板' }] }) });
    const syn1 = S.checkIssueDisambiguated({ issue: '559', runGh: ghSynonym });
    await t.test('消歧门：近义标不算已消歧 → 拒派（不是没查成）', () => {
      assert.ok(syn1.ok === false && syn1.hasLabel === false && syn1.unscanned !== true && /已消歧/.test(syn1.error), '消歧门：近义标不算已消歧 → 拒派（不是没查成）  →  ' + JSON.stringify(syn1));
    });
    await t.test('消歧门：没 label ≠ 没查成（两态分开）', () => {
      assert.ok(no1.unscanned !== true, '消歧门：没 label ≠ 没查成（两态分开）  →  ' + JSON.stringify(no1));
    });
    const f1 = S.checkIssueDisambiguated({ issue: '559', runGh: ghFail });
    await t.test('消歧门：gh 失败 → 没查成，不许当没 label 放行', () => {
      assert.ok(f1.ok === false && f1.unscanned === true && /没查成/.test(f1.error), '消歧门：gh 失败 → 没查成，不许当没 label 放行  →  ' + JSON.stringify(f1));
    });
    const b1 = S.checkIssueDisambiguated({ issue: '559', runGh: ghBroken });
    await t.test('消歧门：gh 返回非 JSON → 没查成', () => {
      assert.ok(b1.ok === false && b1.unscanned === true, '消歧门：gh 返回非 JSON → 没查成  →  ' + JSON.stringify(b1));
    });
    const noIssue = S.checkIssueDisambiguated({ issue: '', runGh: ghNone });
    await t.test('消歧门：无 --issue → 不受门控', () => {
      assert.ok(noIssue.ok === true && noIssue.gated === false, '消歧门：无 --issue → 不受门控  →  ' + JSON.stringify(noIssue));
    });
    const badIssue = S.checkIssueDisambiguated({ issue: 'abc', runGh: ghNone });
    await t.test('消歧门：--issue 非数字 → 拒派', () => {
      assert.ok(badIssue.ok === false && /issue 号/.test(badIssue.error), '消歧门：--issue 非数字 → 拒派  →  ' + JSON.stringify(badIssue));
    });

    // CLI 级：假 gh（CI 无 GH_TOKEN，dao.mjs 消歧门读 DAO_GH_FAKE 用它替真 gh；
    // 判据固定：565 有「已消歧」、559 无、999 = gh 失败）。真 gh 的端到端验收在合并证据里手跑。
    // #565 返工：--dry-run 不实际派工，门控对预览无意义——disambiguation 只作报告，不影响退出码。
    const FAKE_GH = path.join(REPO, 'tests', 'fixtures', 'fake-gh.mjs');
    const cliEnv = { ...process.env, DAO_GH_FAKE: FAKE_GH };
    const cliHas = await cliInProc(['dispatch', '--merge-policy', 'auto', '--model', 'grok-4.6', '--reviewer', 'gpt-5.6-sol', '--confirm', '--name', '修地基', '--issue', '565', '--spec', '短摘要', '--split', 'no', '--split-reason', '单测默认：不测拆分', '--dry-run'], cliEnv);
    const pHas = (() => { try { return JSON.parse((cliHas.stdout || '').trim().split(/\r?\n/).pop()); } catch { return {}; } })();
    await t.test('消歧门：dispatch --issue 565（有 label）--dry-run 过且报告为绿', () => {
      assert.ok(cliHas.status === 0 && pHas.disambiguation && pHas.disambiguation.ok === true, '消歧门：dispatch --issue 565（有 label）--dry-run 过且报告为绿  →  ' + `status=${cliHas.status} ${String(pHas.error || '')}`);
    });

    const cliNo = await cliInProc(['dispatch', '--merge-policy', 'auto', '--model', 'grok-4.6', '--reviewer', 'gpt-5.6-sol', '--confirm', '--name', 'x', '--issue', '559', '--spec', '短摘要', '--split', 'no', '--split-reason', '单测默认：不测拆分', '--dry-run'], cliEnv);
    const pNo = (() => { try { return JSON.parse((cliNo.stdout || '').trim().split(/\r?\n/).pop()); } catch { return {}; } })();
    await t.test('消歧门：dry-run --issue 559（无 label）→ exit 0，报告 hasLabel:false（门控不影响预览）', () => {
      assert.ok(cliNo.status === 0 && pNo.disambiguation && pNo.disambiguation.ok === false && pNo.disambiguation.hasLabel === false, '消歧门：dry-run --issue 559（无 label）→ exit 0，报告 hasLabel:false（门控不影响预览）  →  ' + `status=${cliNo.status} ${JSON.stringify(pNo)}`);
    });
    await t.test('消歧门：dry-run 报告仍说清去哪补', () => {
      assert.ok(/消歧记录|label/.test(String(pNo.disambiguation && pNo.disambiguation.error || '')), '消歧门：dry-run 报告仍说清去哪补  →  ' + String(pNo.disambiguation && pNo.disambiguation.error || ''));
    });

    // 真派工（非 dry-run）：async-launch 后热路只受理，消歧门在后台执行体里拦——
    // 拒派证据从退出码挪到 <id>.out.json（ok:false）。门仍在碰 orca / 建卡之前（#565 硬约束）。
    // 队列/账本都指临时目录：不许把真派工单和记账写进本仓 _flow/ 和本机账本。
    const realQueue = fs.mkdtempSync(path.join(os.tmpdir(), 'dao-565-queue-'));
    const realLedger = fs.mkdtempSync(path.join(os.tmpdir(), 'dao-565-ledger-'));
    const realEnv = { ...cliEnv, DAO_DISPATCH_QUEUE_DIR: realQueue, LEDGER_EVENTS_DIR: realLedger };
    const cliReal = await cliInProc(['dispatch', '--merge-policy', 'auto', '--model', 'grok-4.6', '--reviewer', 'gpt-5.6-sol', '--confirm', '--name', 'x', '--issue', '559', '--spec', '短摘要', '--split', 'no', '--split-reason', '单测默认：不测拆分'], realEnv);
    const pReal = (() => { try { return JSON.parse((cliReal.stdout || '').trim().split(/\r?\n/).pop()); } catch { return {}; } })();
    const rReal = waitForOutJson(pReal.resultPath) || {};
    await t.test('消歧门：真派工 --issue 559（无 label）→ 热路受理，执行体结果 ok:false 拒派', () => {
      assert.ok(cliReal.status === 0 && pReal.queued === true, '热路受理  →  ' + `status=${cliReal.status} ${JSON.stringify(pReal).slice(0, 240)}`);
      assert.ok(rReal.ok === false && /已消歧/.test(String(rReal.error || '')), '执行体拒派  →  ' + JSON.stringify(rReal).slice(0, 300));
    });
    await t.test('消歧门：真派工被拦时错误说清去哪补', () => {
      assert.ok(/消歧记录|label/.test(String(rReal.error || '')), '消歧门：真派工被拦时错误说清去哪补  →  ' + String(rReal.error || ''));
    });
    await t.test('消歧门：真派工被拦发生在建卡前（disambiguation.hasLabel=false，无 workerId）', () => {
      assert.ok((rReal.disambiguation || {}).hasLabel === false && !rReal.workerId, '消歧门：真派工被拦发生在建卡前（disambiguation.hasLabel=false，无 workerId）  →  ' + JSON.stringify(rReal).slice(0, 300));
    });

    // worker-start 带 --issue 同样受门控：559 无 label → 在碰 orca 之前就被拦（非 0）。
    const wsNo = await cliInProc(['worker-start', '--task', 't', '--worktree', 'w', '--terminal', 'h', '--issue', '559', '--model', 'grok-4.6', '--reviewer', 'gpt-5.6-sol', '--confirm'], cliEnv);
    const pWsNo = (() => { try { return JSON.parse((wsNo.stdout || '').trim().split(/\r?\n/).pop()); } catch { return {}; } })();
    await t.test('消歧门：worker-start --issue 559（无 label）→ 非 0 拒派', () => {
      assert.ok(wsNo.status !== 0 && /已消歧/.test(String(pWsNo.error || '')), '消歧门：worker-start --issue 559（无 label）→ 非 0 拒派  →  ' + `status=${wsNo.status} ${JSON.stringify(pWsNo)}`);
    });
    await t.test('worker-start 的 FLAGS_BY_VERB 登记了 --issue', () => {
      assert.ok(S.FLAGS_BY_VERB['worker-start'].has('--issue'), 'worker-start 的 FLAGS_BY_VERB 登记了 --issue');
    });

    // CI 场景（无 GH_TOKEN → gh 失败）：真派工必须报「没查成」拒派，不许放行（#565 硬约束）。
    const cliFail = await cliInProc(['dispatch', '--merge-policy', 'auto', '--model', 'grok-4.6', '--reviewer', 'gpt-5.6-sol', '--confirm', '--name', 'x', '--issue', '999', '--spec', '短摘要', '--split', 'no', '--split-reason', '单测默认：不测拆分'], realEnv);
    const pFail = (() => { try { return JSON.parse((cliFail.stdout || '').trim().split(/\r?\n/).pop()); } catch { return {}; } })();
    const rFail = waitForOutJson(pFail.resultPath) || {};
    await t.test('消歧门：gh 失败（CI 无 token）真派工 → 执行体结果报「没查成」拒派', () => {
      assert.ok(rFail.ok === false && /没查成/.test(String(rFail.error || '')) && (rFail.disambiguation || {}).unscanned === true,
        '消歧门：gh 失败（CI 无 token）真派工 → 执行体结果报「没查成」拒派  →  ' + JSON.stringify(rFail).slice(0, 300));
    });

    const daoSrc565 = fs.readFileSync(CLI, 'utf8');
    await t.test('dao.mjs dispatch 与 worker-start 都调消歧门', () => {
      assert.ok((daoSrc565.match(/checkIssueDisambiguated/g) || []).length >= 2, 'dao.mjs dispatch 与 worker-start 都调消歧门  →  ' + daoSrc565.slice(0, 60));
    });

    // 2026-08-23 fire-and-forget 拍板：信箱台 ensure 挪出派工路（一次 ensure 最慢 300s，
    // 是派工分钟级耗时大头）。dao.mjs 不再有 ensureInboxStation。#807 起本机守卫保活已删。
    await t.test('dao.mjs 不再有 ensureInboxStation（ensure 挪出派工路）', () => {
      assert.ok(!/function ensureInboxStation/.test(daoSrc565) && !/ensureInboxStation\(/.test(daoSrc565),
        'dao.mjs 不该再有 ensureInboxStation');
    });
  });

  it('#611 dispatch --split 必填（fail-close + 三单回归 + 建卡计划）', async (t) => {
    const S = await S_LOAD;
    function dispatchRaw(extra) {
      return spawnSync(process.execPath, [CLI, 'dispatch', ...extra], { encoding: 'utf8', cwd: REPO });
    }
    function payload(r) {
      try { return JSON.parse((r.stdout || '').trim().split(/\r?\n/).pop()); }
      catch { return { raw: r.stdout, err: r.stderr }; }
    }
    const base = ['--merge-policy', 'auto', '--model', 'grok-4.6', '--reviewer', 'gpt-5.6-sol', '--confirm', '--name', 'x', '--spec', '短摘要', '--dry-run'];

    const noSplit = dispatchRaw(base);
    const pNo = payload(noSplit);
    await t.test('② 不给 --split → 非零', () => {
      assert.ok(noSplit.status !== 0, '② 不给 --split → 非零  →  status=' + noSplit.status);
    });
    await t.test('② 不给 --split → 报缺 --split', () => {
      assert.ok(pNo.error && String(pNo.error).includes('--split'), '② 不给 --split → 报缺 --split  →  ' + JSON.stringify(pNo));
    });

    const noReason = dispatchRaw([...base, '--split', 'no']);
    const pReason = payload(noReason);
    await t.test('② --split no 不给 --split-reason → 非零', () => {
      assert.ok(noReason.status !== 0, '② --split no 不给 --split-reason → 非零  →  status=' + noReason.status);
    });
    await t.test('② --split no 不给理由 → 报 --split-reason', () => {
      assert.ok(pReason.error && String(pReason.error).includes('--split-reason'), '② --split no 不给理由 → 报 --split-reason  →  ' + JSON.stringify(pReason));
    });

    const emptyReason = dispatchRaw([...base, '--split', 'no', '--split-reason', '  ']);
    await t.test('② --split no 理由空白 → 非零', () => {
      assert.ok(emptyReason.status !== 0 && /--split-reason/.test(payload(emptyReason).error || ''), '② --split no 理由空白 → 非零  →  ' + JSON.stringify(payload(emptyReason)));
    });

    const one = dispatchRaw([...base, '--split', '1']);
    await t.test('--split 1 → 非零（N≥2）', () => {
      assert.ok(one.status !== 0 && /≥2/.test(payload(one).error || ''), '--split 1 → 非零（N≥2）  →  ' + JSON.stringify(payload(one)));
    });

    const fnMiss = S.resolveSplitConstraint({});
    await t.test('函数层缺 --split → 失败', () => {
      assert.ok(fnMiss.ok === false && (fnMiss.missing || []).includes('--split'), '函数层缺 --split → 失败  →  ' + JSON.stringify(fnMiss));
    });
    const fnNoReason = S.resolveSplitConstraint({ split: 'no' });
    await t.test('函数层 --split no 无理由 → 失败', () => {
      assert.ok(fnNoReason.ok === false && (fnNoReason.missing || []).includes('--split-reason'), '函数层 --split no 无理由 → 失败  →  ' + JSON.stringify(fnNoReason));
    });
    const fnOk = S.resolveSplitConstraint({ split: 'no', splitReason: '同几个文件反复改' });
    await t.test('函数层 --split no + 理由 → 过', () => {
      assert.ok(fnOk.ok === true && fnOk.split === 'no' && fnOk.childCount === 0, '函数层 --split no + 理由 → 过  →  ' + JSON.stringify(fnOk));
    });
    const fnN = S.resolveSplitConstraint({ split: '2' });
    await t.test('函数层 --split 2 → childCount=2', () => {
      assert.ok(fnN.ok === true && fnN.split === 2 && fnN.childCount === 2, '函数层 --split 2 → childCount=2  →  ' + JSON.stringify(fnN));
    });

    const cases = [
      { issue: 608, title: '迁24套测试', filesSeparable: true, chunkCount: 24, eachChunkEnoughWork: true, n: 4, expect: 4, reason: null },
      { issue: 604, title: '拆提示词整层', filesSeparable: false, chunkCount: 3, eachChunkEnoughWork: true, expect: 'no', reason: '同几个文件反复改' },
      { issue: 603, title: '归档收口', filesSeparable: false, chunkCount: 3, eachChunkEnoughWork: true, expect: 'no', reason: '三个红项互相关联' },
    ];
    for (const c of cases) {
      const decided = S.decideSplit(c);
      await t.test(`① #${c.issue} 判据 → ${c.expect}`, () => {
        assert.ok(decided.split === c.expect, `① #${c.issue} 判据 → ${c.expect}  →  ` + JSON.stringify(decided));
      });
      const flags = decided.split === 'no'
        ? ['--split', 'no', '--split-reason', c.reason]
        : ['--split', String(decided.split),
          '--slice', 'tests/a.test.js', '--slice', 'tests/b.test.js',
          '--slice', 'tests/c.test.js', '--slice', 'tests/d.test.js'];
      const r = dispatchRaw([
        '--merge-policy', 'auto', '--model', 'grok-4.6', '--reviewer', 'gpt-5.6-sol', '--confirm',
        '--name', c.title, '--issue', String(c.issue), '--spec', `短摘要：#${c.issue}`,
        ...flags, '--dry-run',
      ]);
      const p = payload(r);
      await t.test(`① #${c.issue} dry-run 结论 ${c.expect}`, () => {
        assert.ok(r.status === 0 && p.split === c.expect, `① #${c.issue} dry-run 结论 ${c.expect}  →  ` + JSON.stringify(p));
      });
    }
    await t.test('① 判据挑出 #608、不误伤另两单', () => {
      assert.ok(
        S.decideSplit(cases[0]).split === 4
        && S.decideSplit(cases[1]).split === 'no'
        && S.decideSplit(cases[2]).split === 'no',
        '① 判据挑出 #608、不误伤另两单',
      );
    });

    const noSlice = dispatchRaw([
      '--merge-policy', 'auto', '--model', 'grok-4.6', '--reviewer', 'gpt-5.6-sol', '--confirm',
      '--name', '并行两块', '--spec', '改 a.js 和 b.js', '--split', '2', '--dry-run',
    ]);
    await t.test('--split 2 不给 --slice → 非零', () => {
      assert.ok(noSlice.status !== 0 && /--slice/.test(payload(noSlice).error || ''), '--split 2 不给 --slice → 非零  →  ' + JSON.stringify(payload(noSlice)));
    });
    const overlap = dispatchRaw([
      '--merge-policy', 'auto', '--model', 'grok-4.6', '--reviewer', 'gpt-5.6-sol', '--confirm',
      '--name', '并行两块', '--spec', '改 a.js 和 b.js', '--split', '2',
      '--slice', '改 a.js', '--slice', '也改 a.js', '--dry-run',
    ]);
    await t.test('a.js 跨两块 → 非零（边界重叠）', () => {
      assert.ok(overlap.status !== 0 && /重叠/.test(payload(overlap).error || '') && /a\.js/.test(payload(overlap).error || ''), 'a.js 跨两块 → 非零  →  ' + JSON.stringify(payload(overlap)));
    });

    const split2 = dispatchRaw([
      '--merge-policy', 'auto', '--model', 'grok-4.6', '--reviewer', 'gpt-5.6-sol', '--confirm',
      '--name', '并行两块', '--spec', '改 a.js 和 b.js', '--split', '2',
      '--slice', '改 a.js', '--slice', '改 b.js', '--dry-run',
    ]);
    const p2 = payload(split2);
    const kids = Array.isArray(p2.childCards) ? p2.childCards : [];
    const kidsText = JSON.stringify(p2);
    await t.test('④ --split 2 dry-run 过', () => {
      assert.ok(split2.status === 0 && p2.split === 2, '④ --split 2 dry-run 过  →  ' + JSON.stringify(p2));
    });
    await t.test('④ 输出有父卡', () => {
      assert.ok(p2.parentCard && p2.parentCard.noParent === true && p2.workerCard, '④ 输出有父卡  →  ' + JSON.stringify(p2.parentCard));
    });
    await t.test('④ 输出有 2 张子卡', () => {
      assert.ok(kids.length === 2, '④ 输出有 2 张子卡  →  ' + kidsText);
    });
    await t.test('④ 子卡带 --parent-worktree', () => {
      assert.ok(kids.every(c => (c.flags || []).includes('--parent-worktree')) && /--parent-worktree/.test(kidsText), '④ 子卡带 --parent-worktree  →  ' + kidsText);
    });
    await t.test('④ 子卡带 --base-branch', () => {
      assert.ok(kids.every(c => (c.flags || []).includes('--base-branch')) && /--base-branch/.test(kidsText), '④ 子卡带 --base-branch  →  ' + kidsText);
    });
    await t.test('④ dry-run 子卡标明 willStart 且带分块职责', () => {
      assert.ok(kids.every(c => c.willStart === true && /块\d+\/2/.test(c.spec || '')), '④ dry-run 子卡标明 willStart 且带分块职责  →  ' + kidsText);
    });
    await t.test('a.js/b.js 反例：两个子工人拿到不同可执行职责', () => {
      assert.ok(
        /a\.js/.test(kids[0].spec) && !/b\.js/.test(kids[0].spec)
        && /b\.js/.test(kids[1].spec) && !/a\.js/.test(kids[1].spec),
        'a.js/b.js 反例  →  ' + kidsText,
      );
    });
    await t.test('④ dry-run 父卡是头工人', () => {
      assert.ok(p2.parentCard && p2.parentCard.role === '头工人' && /头工人/.test(p2.parentCard.spec || ''), '④ dry-run 父卡是头工人  →  ' + JSON.stringify(p2.parentCard));
    });

    const headSpec = S.buildSplitRoleSpec({ spec: '短摘要', role: 'head', total: 2 });
    const child1 = S.buildSplitRoleSpec({ spec: '改 a.js 和 b.js', role: 'child', index: 1, total: 2, slice: '改 a.js' });
    await t.test('分块职责：头工人不独占文件块', () => {
      assert.ok(/头工人/.test(headSpec) && /不独占/.test(headSpec), '分块职责：头工人不独占文件块  →  ' + headSpec);
    });
    await t.test('分块职责：子工人写明第几块', () => {
      assert.ok(/块1\/2/.test(child1) && /改 a\.js/.test(child1), '分块职责：子工人写明第几块  →  ' + child1);
    });

    const missSlice = S.resolveSliceAssignments({ childCount: 2, slices: ['改 a.js'] });
    await t.test('函数层 --split 2 只给 1 个 --slice → 失败', () => {
      assert.ok(missSlice.ok === false && (missSlice.missing || []).includes('--slice'), JSON.stringify(missSlice));
    });
    const fileOverlap = S.resolveSliceAssignments({ childCount: 2, slices: ['改 a.js', '也改 a.js'] });
    await t.test('函数层 a.js 跨块 → 失败', () => {
      assert.ok(fileOverlap.ok === false && /a\.js/.test(fileOverlap.error || ''), JSON.stringify(fileOverlap));
    });
    const okSlices = S.resolveSliceAssignments({ childCount: 2, slices: ['改 a.js', '改 b.js'] });
    await t.test('函数层 a.js / b.js 各一块 → 过', () => {
      assert.ok(okSlices.ok && okSlices.slices[0] === '改 a.js' && okSlices.slices[1] === '改 b.js', JSON.stringify(okSlices));
    });

    const calls = [];
    const okStart = S.startSplitChildren({
      children: [{ id: 'c1', name: 'a · 1' }, { id: 'c2', name: 'a · 2' }],
      spec: '改 a.js 和 b.js',
      slices: ['改 a.js', '改 b.js'],
      startOne: (req) => {
        calls.push(req);
        return { ok: true, handle: `h-${req.index}`, dispatchId: `d-${req.index}`, taskId: `t-${req.index}` };
      },
    });
    await t.test('真路径：--split 2 起父卡之外的 2 个独立子工人', () => {
      assert.ok(okStart.ok && okStart.started.length === 2 && okStart.started.every(s => s.handle && s.dispatchId), '真路径：--split 2 起 2 个子工人  →  ' + JSON.stringify(okStart));
    });
    await t.test('真路径：两个子工人职责不同', () => {
      assert.ok(
        calls.length === 2
        && /a\.js/.test(calls[0].spec) && !/b\.js/.test(calls[0].spec)
        && /b\.js/.test(calls[1].spec) && !/a\.js/.test(calls[1].spec)
        && calls[0].worktreeId === 'c1' && calls[1].worktreeId === 'c2',
        '真路径：两个子工人职责不同  →  ' + JSON.stringify(calls),
      );
    });

    const failCalls = [];
    const failStart = S.startSplitChildren({
      children: [{ id: 'c1', name: 'a · 1' }, { id: 'c2', name: 'a · 2' }],
      spec: '改 a.js 和 b.js',
      slices: ['改 a.js', '改 b.js'],
      startOne: (req) => {
        failCalls.push(req);
        if (req.index === 2) return { ok: false, error: 'boom', handle: 'h-fail' };
        return { ok: true, handle: 'h-1', dispatchId: 'd-1', taskId: 't-1' };
      },
    });
    await t.test('真路径：第二子工人失败时保留已起的人供回滚', () => {
      assert.ok(
        failStart.ok === false
        && failStart.started.some(s => s.handle === 'h-1' && s.dispatchId === 'd-1')
        && failStart.started.some(s => s.handle === 'h-fail'),
        '真路径：第二子工人失败时保留已起的人供回滚  →  ' + JSON.stringify(failStart),
      );
    });
    const rbFail = S.planDispatchRollback({
      workerId: 'w1',
      workerHandle: 'th1',
      childIds: failStart.started.map(s => s.id).filter(Boolean).concat(['c2']),
      childHandles: failStart.started.map(s => s.handle).filter(Boolean),
      dispatchIds: ['d-parent', 'd-1'],
      taskIds: ['t-parent', 't-1'],
    });
    await t.test('真路径：子工人失败回滚含关终端+删子卡+删父卡', () => {
      const text = JSON.stringify(rbFail);
      assert.ok(/h-1/.test(text) && /h-fail/.test(text) && /c2/.test(text) && /w1/.test(text), '真路径：子工人失败回滚完整  →  ' + text);
    });
    await t.test('真路径：回滚先 worker-stop / task-update failed 再删树', () => {
      const text = rbFail.map(s => s.join(' ')).join(' | ');
      const stopAt = text.indexOf('worker-stop');
      const taskAt = text.indexOf('task-update');
      const rmAt = text.indexOf('worktree rm');
      assert.ok(
        stopAt >= 0 && taskAt >= 0 && /--dispatch d-parent/.test(text) && /--dispatch d-1/.test(text)
        && /--status failed/.test(text) && /--id t-parent/.test(text)
        && stopAt < rmAt && taskAt < rmAt,
        '回滚先停 Dispatch/Task  →  ' + text,
      );
    });

    await t.test('FLAGS 登记 --split / --split-reason', () => {
      assert.ok(S.FLAGS_BY_VERB.dispatch.has('--split') && S.FLAGS_BY_VERB.dispatch.has('--split-reason') && S.FLAGS_BY_VERB.dispatch.has('--slice'), 'FLAGS 登记 --split / --split-reason');
    });
    await t.test('USAGE 有 --split <no|N>', () => {
      assert.ok(/--split <no\|N>/.test(S.USAGE), 'USAGE 有 --split <no|N>');
    });
    await t.test('USAGE 写了判据真相源', () => {
      assert.ok(/能不能按文件切开/.test(S.USAGE) && /块数/.test(S.USAGE), 'USAGE 写了判据真相源');
    });
    await t.test('skill 只留指针不复制判据全文', () => {
      const skill = fs.readFileSync(path.join(REPO, 'host', 'skills', 'dispatch', 'SKILL.md'), 'utf8');
      assert.ok(/#611/.test(skill) && /dispatch --help/.test(skill) && !/能切 \+ 块数/.test(skill), 'skill 只留指针不复制判据全文');
    });
  });

  it('#984：dispatch --dry-run 不打网', async (t) => {
    const dry = spawnSync(process.execPath, [CLI,
      'dispatch', '--merge-policy', 'auto', '--model', 'grok-4.6', '--reviewer', 'gpt-5.6-sol',
      '--confirm', '--name', 'x', '--spec', '短摘要', '--split', 'no', '--split-reason', '单测默认：不测拆分', '--dry-run',
    ], { encoding: 'utf8', cwd: REPO });
    let p = {};
    try { p = JSON.parse((dry.stdout || '').trim().split(/\r?\n/).pop()); } catch { p = { raw: dry.stdout }; }
    await t.test('dry-run 退出 0', () => {
      assert.ok(dry.status === 0 && p.ok === true && p.dryRun === true, 'dry-run 退出 0  →  ' + JSON.stringify(p).slice(0, 300));
    });
    await t.test('dry-run 声明 skipped，不假装探过', () => {
      assert.ok(p.preflight && p.preflight.skipped === true && /dry-run/.test(String(p.preflight.why || (p.preflight.reasons || []).join(','))),
        'dry-run 不探网  →  ' + JSON.stringify(p.preflight));
    });
    await t.test('dao.mjs dry-run 默认不调 preflightWorkerSlate（要预览加 --preflight）', () => {
      const src = fs.readFileSync(CLI, 'utf8');
      const dryFn = src.slice(src.indexOf('if (args.dryRun) {'), src.indexOf('const queueDir'));
      assert.ok(/dry-run 默认不探/.test(dryFn) && /args\.preflight === true/.test(dryFn),
        'dry-run 默认不探、显式 --preflight 才探  →  ' + dryFn.slice(0, 280));
    });
  });
});
