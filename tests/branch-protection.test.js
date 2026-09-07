// 合并闸形状（dao-check ㉞，issue #999）
//
// 验 scripts/lib/branch-protection-check.mjs：
//   纯函数三态：绿（形状对）/ 红（缺闸或形状错）/ 没查成（空清单、探头失败、字段读不成）；
//   故意违规必须拦：缺保护、required contexts 不对、enforce_admins: true、strict: true；
//   绿样本必须绿；空清单 / 探头失败 = 没查成，不是绿；
//   扫描面不手写仓名单；归档 / 私有 / Pages 站不进判定面；
//   live：本仓 master 形状对得上；缺 gh / 无权限 SKIP 不是绿；
//   检查器自持解析，不 import INDEX / 群映射 / 发布策略的消费方。
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const LIB = path.join(REPO, 'scripts', 'lib', 'branch-protection-check.mjs');
const LOAD = import('file://' + LIB.replace(/\\/g, '/'));

function okShape(over = {}) {
  return {
    required_status_checks: { strict: false, contexts: ['check'], ...(over.rsc || {}) },
    enforce_admins: over.enforce_admins === undefined ? false : over.enforce_admins,
  };
}

function publicMeta(name) {
  return { private: false, archived: false, has_pages: false, name: name || 'live' };
}

describe('branch-protection-check', () => {
  it('检查器不复用被检查对象', () => {
    const src = fs.readFileSync(LIB, 'utf8');
    const imports = [...src.matchAll(/^import\s+[\s\S]*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);
    assert.equal(imports.every((s) => s.startsWith('node:')), true, JSON.stringify(imports));
    assert.equal(/feishu-groups-check|release-policy-check|machine-path-check/.test(src), false);
  });

  it('repoSlugFromRemote：HTTPS / SSH / 抽不出', async () => {
    const S = await LOAD;
    assert.equal(S.repoSlugFromRemote('https://github.com/thoerwink8/windsurf-dao.git'), 'thoerwink8/windsurf-dao');
    assert.equal(S.repoSlugFromRemote('git@github.com:thoerwink8/windsurf-dao.git'), 'thoerwink8/windsurf-dao');
    assert.equal(S.repoSlugFromRemote(''), null);
    assert.equal(S.repoSlugFromRemote('https://example.com/x'), null);
  });

  it('扫描面：INDEX E 类 / 群映射 / 发布策略并集，空 = 没查成', async () => {
    const S = await LOAD;
    assert.deepEqual(
      S.extractReposFromIndex('| E | ~/.x | 归 `ai-gateway-stack`。\n| E | ~/.y | 归 `miraquota-win`。'),
      ['ai-gateway-stack', 'miraquota-win'],
    );

    const groups = S.extractReposFromGroups({
      _comment: 'skip',
      oc_a: { repo: 'thoerwink8/windsurf-dao' },
      oc_b: { repo: 'miraquota-win' },
      oc_h: { kind: 'hub' },
    });
    assert.equal(groups.ok, true);
    assert.deepEqual(groups.slugs, ['thoerwink8/windsurf-dao']);

    const groupsBad = S.extractReposFromGroups([]);
    assert.equal(groupsBad.unscanned, true);

    const policy = S.extractReposFromPolicy({ demo: { 'windsurf-dao': {}, _skip: {} } });
    assert.equal(policy.ok, true);
    assert.deepEqual(policy.names, ['windsurf-dao']);

    const empty = S.collectManagedRepos({});
    assert.equal(empty.unscanned, true);
    assert.equal(empty.ok, false);
    assert.match(empty.error, /没查成/);

    const originOnly = S.collectManagedRepos({ originSlug: 'thoerwink8/windsurf-dao' });
    assert.equal(originOnly.ok, true);
    assert.deepEqual(originOnly.slugs, ['thoerwink8/windsurf-dao']);

    const merged = S.collectManagedRepos({
      indexText: '归 `miraquota-win`',
      groupsDoc: { oc: { repo: 'thoerwink8/ai-gateway-stack' } },
      policyDoc: { demo: { 'windsurf-dao': { kind: 'app' } } },
      originSlug: 'thoerwink8/windsurf-dao',
    });
    assert.equal(merged.ok, true);
    assert.deepEqual(merged.slugs, [
      'thoerwink8/ai-gateway-stack',
      'thoerwink8/miraquota-win',
      'thoerwink8/windsurf-dao',
    ]);
  });

  it('判定面：私有 / 归档 / Pages 站出局；缺字段没查成', async () => {
    const S = await LOAD;
    assert.equal(S.inJudgmentSurface(publicMeta('live')).in, true);
    assert.equal(S.inJudgmentSurface({ private: true, archived: false, has_pages: false }).in, false);
    assert.equal(S.inJudgmentSurface({ private: false, archived: true, has_pages: false }).in, false);
    assert.equal(S.inJudgmentSurface({ private: false, archived: false, has_pages: true }).in, false);
    assert.equal(S.inJudgmentSurface({ private: false, archived: false, has_pages: false, name: 'x.github.io' }).in, false);
    assert.equal(S.inJudgmentSurface({ private: false }).unscanned, true);
    assert.equal(S.inJudgmentSurface(null).unscanned, true);
  });

  it('judgeProtection：绿形状 / 四类违规 / 字段读不成', async () => {
    const S = await LOAD;

    const green = S.judgeProtection(okShape());
    assert.equal(green.kind, 'ok');

    const viaChecks = S.judgeProtection({
      required_status_checks: { strict: false, checks: [{ context: 'check' }] },
      enforce_admins: { enabled: false },
    });
    assert.equal(viaChecks.kind, 'ok');

    const missing = S.judgeProtection(null);
    assert.equal(missing.kind, 'red');
    assert.match(missing.why, /缺保护/);

    const badCtx = S.judgeProtection(okShape({ rsc: { contexts: ['ci'] } }));
    assert.equal(badCtx.kind, 'red');
    assert.match(badCtx.why, /required contexts/);

    const admins = S.judgeProtection(okShape({ enforce_admins: true }));
    assert.equal(admins.kind, 'red');
    assert.match(admins.why, /enforce_admins=true/);

    const strict = S.judgeProtection(okShape({ rsc: { strict: true, contexts: ['check'] } }));
    assert.equal(strict.kind, 'red');
    assert.match(strict.why, /strict=true/);

    const noBool = S.judgeProtection({
      required_status_checks: { contexts: ['check'] },
      enforce_admins: false,
    });
    assert.equal(noBool.kind, 'unscanned');
    assert.match(noBool.why, /没查成/);
  });

  it('classifyProtectionProbe：ENOENT skip / 403 skip / 404 缺保护 / 失败没查成', async () => {
    const S = await LOAD;
    const enoent = new Error('spawn gh ENOENT');
    enoent.code = 'ENOENT';
    const skipCli = S.classifyProtectionProbe({ error: enoent });
    assert.equal(skipCli.kind, 'skip');
    assert.match(skipCli.why, /ENOENT/);

    const skip403 = S.classifyProtectionProbe({
      status: 1,
      stdout: '',
      stderr: JSON.stringify({ message: 'Upgrade to GitHub Pro or make this repository public' }),
    });
    assert.equal(skip403.kind, 'skip');

    const missing = S.classifyProtectionProbe({
      status: 1,
      stdout: '',
      stderr: JSON.stringify({ message: 'Branch not protected' }),
    });
    assert.equal(missing.kind, 'missing');

    const fail = S.classifyProtectionProbe({ status: 2, stdout: '', stderr: 'boom' });
    assert.equal(fail.kind, 'unscanned');

    const ok = S.classifyProtectionProbe({ status: 0, stdout: JSON.stringify(okShape()), stderr: '' });
    assert.equal(ok.kind, 'ok');
    assert.equal(ok.protection.enforce_admins, false);
  });

  it('inspectBranchProtection：空清单没查成；全出局没查成；skip 不是绿；有红则红', async () => {
    const S = await LOAD;

    const empty = S.inspectBranchProtection({ repos: [] });
    assert.equal(empty.unscanned, true);
    assert.equal(empty.ok, false);

    const none = S.inspectBranchProtection();
    assert.equal(none.unscanned, true);

    const allOut = S.inspectBranchProtection({
      repos: [{ slug: 'org/priv', meta: { private: true, archived: false, has_pages: false }, protection: null }],
    });
    assert.equal(allOut.unscanned, true);
    assert.match(allOut.error, /判定面 0/);

    const skip = S.inspectBranchProtection({
      repos: [{
        slug: 'org/live',
        meta: publicMeta('live'),
        probe: { kind: 'skip', why: '无权限（403）' },
      }],
    });
    assert.equal(skip.skip, true);
    assert.equal(skip.ok, false);
    assert.equal(skip.unscanned, false);

    const red = S.inspectBranchProtection({
      repos: [
        { slug: 'org/missing', meta: publicMeta('missing'), protection: null },
        { slug: 'org/ok', meta: publicMeta('ok'), protection: okShape() },
      ],
    });
    assert.equal(red.ok, false);
    assert.equal(red.unscanned, false);
    assert.equal(red.violations.length, 1);
    assert.match(red.violations[0].why, /缺保护/);

    const green = S.inspectBranchProtection({
      repos: [
        { slug: 'org/live', meta: publicMeta('live'), protection: okShape() },
        { slug: 'org/priv', meta: { private: true, archived: false, has_pages: false }, protection: null },
      ],
    });
    assert.equal(green.ok, true);
    assert.equal(green.judged, 1);
  });

  it('夹具红/绿/空有判别力；四类违规都被点出', async () => {
    const S = await LOAD;
    const exists = (rel) => fs.existsSync(path.join(REPO, rel));
    const readFile = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');
    const r = S.inspectBranchProtectionFixtures({ exists, readFile });
    assert.equal(r.ok, true, r.error || (r.problems || []).join('；'));
    assert.equal(r.kinds.red, 1);
    assert.equal(r.kinds.ok, 1);
    assert.equal(r.kinds.empty, 1);

    const red = S.inspectBranchProtection({
      repos: JSON.parse(fs.readFileSync(path.join(REPO, 'tests/fixtures/branch-protection/red/repos.json'), 'utf8')),
    });
    const whys = (red.violations || []).map((v) => v.why).join('｜');
    assert.match(whys, /缺保护/);
    assert.match(whys, /required contexts/);
    assert.match(whys, /enforce_admins=true/);
    assert.match(whys, /strict=true/);
  });

  it('仓内登记扫得出本仓；protectionPutPayload 与判据同一份常量', async () => {
    const S = await LOAD;
    const r = S.collectManagedReposFromRoot({
      root: REPO,
      originSlug: 'thoerwink8/windsurf-dao',
      exists: (p) => fs.existsSync(p),
      readFile: (p) => fs.readFileSync(p, 'utf8'),
    });
    assert.equal(r.ok, true, r.error);
    assert.equal(r.slugs.includes('thoerwink8/windsurf-dao'), true, JSON.stringify(r.slugs));

    const payload = S.protectionPutPayload();
    assert.deepEqual(payload.required_status_checks.contexts, S.REQUIRED_CONTEXTS);
    assert.equal(payload.required_status_checks.strict, S.REQUIRE_STRICT);
    assert.equal(payload.enforce_admins, S.REQUIRE_ENFORCE_ADMINS);
    assert.equal(S.judgeProtection(payload).kind, 'ok');
  });

  it('inspectThisRepoProtection：ENOENT skip 不是绿；形状对则绿', async () => {
    const S = await LOAD;
    const enoent = new Error('spawn gh ENOENT');
    enoent.code = 'ENOENT';
    const skip = S.inspectThisRepoProtection({
      originSlug: 'thoerwink8/windsurf-dao',
      spawnGh: () => ({ error: enoent, status: null, stdout: '', stderr: '' }),
    });
    assert.equal(skip.skip, true);
    assert.equal(skip.ok, false);

    const noProbe = S.inspectThisRepoProtection({ originSlug: 'thoerwink8/windsurf-dao' });
    assert.equal(noProbe.unscanned, true);

    const green = S.inspectThisRepoProtection({
      originSlug: 'thoerwink8/windsurf-dao',
      spawnGh: () => ({ status: 0, stdout: JSON.stringify(okShape()), stderr: '' }),
    });
    assert.equal(green.ok, true);
    assert.equal(green.skip, false);
  });
});
