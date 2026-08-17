// gh-as / lib/gh.mjs 回归（issue #573）
//
// 不打真 GitHub：fetch / spawn / git 全部注入。真机 whoami 与 --body 送达
// 写在 PR 正文，不在这套里冒充。

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { generateKeyPairSync } = require('crypto');

const REPO = path.resolve(__dirname, '..');
const LIB = path.join(REPO, 'scripts', 'lib', 'gh.mjs');
const CLI = path.join(REPO, 'scripts', 'gh-as.mjs');
const LIB_LOAD = import('file://' + LIB.replace(/\\/g, '/'));

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeKeypair(dir, role, extraCfg = {}) {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${role}.pem`), privateKey.export({ type: 'pkcs8', format: 'pem' }));
  fs.writeFileSync(path.join(dir, `${role}.json`), JSON.stringify({
    appId: 4616929,
    installationId: 154249581,
    slug: `dao-${role}`,
    ...extraCfg,
  }));
}

describe('gh-as', () => {
  it('角色 / 凭据缺失 fail-loud', async (t) => {
    const G = await LIB_LOAD;
    await t.test('未知角色', () => {
      assert.ok(G.loadRoleCreds('ghost').ok === false && /reviewer\|worker\|marshal/.test(G.loadRoleCreds('ghost').error), '未知角色');
    });
    const empty = tmpDir('gh-as-empty-');
    const miss = G.loadRoleCreds('worker', { dir: empty });
    await t.test('缺 pem/json → not_installed', () => {
      assert.ok(miss.ok === false && miss.code === 'not_installed', '缺 pem/json → not_installed  →  ' + JSON.stringify(miss));
    });
    await t.test('缺凭据说「这台机器没装」', () => {
      assert.ok(/这台机器没装/.test(miss.error), '缺凭据说「这台机器没装」  →  ' + miss.error);
    });
    await t.test('缺凭据不说「配置错了」', () => {
      assert.ok(!/配置错了/.test(miss.error), '缺凭据不说「配置错了」  →  ' + miss.error);
    });

    const half = tmpDir('gh-as-half-');
    fs.writeFileSync(path.join(half, 'worker.json'), JSON.stringify({ slug: 'dao-worker' }));
    fs.writeFileSync(path.join(half, 'worker.pem'), 'not-a-key');
    const bad = G.loadRoleCreds('worker', { dir: half });
    await t.test('json 缺 appId → bad_config', () => {
      assert.ok(bad.ok === false && bad.code === 'bad_config', 'json 缺 appId → bad_config  →  ' + JSON.stringify(bad));
    });
    await t.test('配置错了 ≠ 没装', () => {
      assert.ok(/配置错了/.test(bad.error) && !/这台机器没装/.test(bad.error), '配置错了 ≠ 没装  →  ' + bad.error);
    });
  });

  it('JWT / 缓存 10 分钟门槛', async (t) => {
    const G = await LIB_LOAD;
    const dir = tmpDir('gh-as-jwt-');
    writeKeypair(dir, 'worker');
    const creds = G.loadRoleCreds('worker', { dir });
    await t.test('凭据齐全', () => {
      assert.ok(creds.ok === true, '凭据齐全  →  ' + JSON.stringify(creds));
    });
    const pem = fs.readFileSync(creds.pemPath, 'utf8');
    const jwt = G.mintJwt(creds.appId, pem, { now: 1_700_000_000 });
    await t.test('JWT 签得出', () => {
      assert.ok(jwt.ok === true, 'JWT 签得出  →  ' + jwt.error);
    });
    const payload = JSON.parse(Buffer.from(jwt.jwt.split('.')[1], 'base64url').toString('utf8'));
    await t.test('iss=appId', () => {
      assert.ok(payload.iss === creds.appId, 'iss=appId  →  ' + JSON.stringify(payload));
    });
    await t.test('exp-iat ≤ 600s（GitHub 硬限）', () => {
      assert.ok(payload.exp - payload.iat <= 600, 'exp-iat ≤ 600s（GitHub 硬限）  →  ' + JSON.stringify(payload));
    });
    await t.test('exp-iat ≥ 500s', () => {
      assert.ok(payload.exp - payload.iat >= 500, 'exp-iat ≥ 500s  →  ' + JSON.stringify(payload));
    });
    const badPem = G.mintJwt(creds.appId, 'hello');
    await t.test('坏 pem fail-loud', () => {
      assert.ok(badPem.ok === false, '坏 pem fail-loud  →  ' + JSON.stringify(badPem));
    });

    const future = new Date(Date.now() + 40 * 60 * 1000).toISOString();
    fs.writeFileSync(path.join(dir, 'worker.token'), JSON.stringify({ token: 'cached-token', expires_at: future, permissions: { contents: 'write' } }));
    const hit = G.readCachedToken(path.join(dir, 'worker.token'));
    await t.test('剩余 >10 分钟走缓存', () => {
      assert.ok(hit.ok === true && hit.token === 'cached-token', '剩余 >10 分钟走缓存  →  ' + JSON.stringify(hit));
    });
    const stale = G.readCachedToken(path.join(dir, 'worker.token'), { now: Date.parse(future) - 5 * 60 * 1000 });
    await t.test('剩余 <10 分钟当过期', () => {
      assert.ok(stale.ok === false && stale.reason === 'stale', '剩余 <10 分钟当过期  →  ' + JSON.stringify(stale));
    });
    await t.test('没缓存 ≠ 坏缓存', () => {
      assert.ok(G.readCachedToken(path.join(dir, 'nope.token')).reason === 'no_cache', '没缓存 ≠ 坏缓存');
    });
  });

  it('spawn 不走 shell，参数原样送达', async (t) => {
    const G = await LIB_LOAD;
    const dir = tmpDir('gh-as-spawn-');
    writeKeypair(dir, 'worker');
    fs.writeFileSync(path.join(dir, 'worker.token'), JSON.stringify({
      token: 't-live',
      expires_at: new Date(Date.now() + 40 * 60 * 1000).toISOString(),
      permissions: { contents: 'write' },
    }));
    const calls = [];
    const spawnImpl = (cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      return { status: 0, stdout: 'ok\n', stderr: '', error: null };
    };
    const multiline = '判定：绿，可合并\n\n第二行带 空格';
    const r = G.ghAs('worker', ['pr', 'review', '1', '--approve', '--body', multiline], { dir, spawnImpl });
    await t.test('ghAs 成功', () => {
      assert.ok(r.ok === true, 'ghAs 成功  →  ' + JSON.stringify(r));
    });
    await t.test('只 spawn 一次', () => {
      assert.ok(calls.length === 1, '只 spawn 一次  →  ' + String(calls.length));
    });
    await t.test('Windows 用 gh.exe / 其他用 gh', () => {
      assert.ok(calls[0].cmd === G.ghExecutable(), 'Windows 用 gh.exe / 其他用 gh  →  ' + calls[0].cmd);
    });
    await t.test('不设 shell:true', () => {
      assert.ok(calls[0].opts.shell !== true, '不设 shell:true  →  ' + JSON.stringify(calls[0].opts));
    });
    await t.test('--body 多行仍是一个参数', () => {
      assert.ok(calls[0].args.includes(multiline) && calls[0].args.filter(a => a === multiline).length === 1, '--body 多行仍是一个参数  →  ' + JSON.stringify(calls[0].args));
    });
    await t.test('GH_TOKEN 盖住本人', () => {
      assert.ok(calls[0].opts.env.GH_TOKEN === 't-live', 'GH_TOKEN 盖住本人  →  ' + String(calls[0].opts.env.GH_TOKEN));
    });
  });

  it('换 token / whoami：扫成 vs 没扫成', async (t) => {
    const G = await LIB_LOAD;
    const dir = tmpDir('gh-as-mint-');
    writeKeypair(dir, 'reviewer', { appId: 4616659, installationId: 154244051 });
    let fetches = 0;
    const fetchImpl = (url, opts) => {
      fetches += 1;
      if (String(url).includes('/access_tokens')) {
        if (opts.method !== 'POST') return { ok: true, status: 405, body: 'bad method' };
        return {
          ok: true,
          status: 201,
          body: JSON.stringify({
            token: 'minted',
            expires_at: new Date(Date.now() + 3600_000).toISOString(),
            permissions: {
              contents: 'read', pull_requests: 'write', issues: 'read', checks: 'read', metadata: 'read',
            },
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        body: JSON.stringify({ repositories: [{ full_name: 'thoerwink8/windsurf-dao' }] }),
      };
    };
    const minted = G.resolveToken('reviewer', { dir, fetchImpl });
    await t.test('无缓存则换 token', () => {
      assert.ok(minted.ok && minted.token === 'minted' && minted.cached === false, '无缓存则换 token  →  ' + JSON.stringify(minted));
    });
    await t.test('token 落了盘', () => {
      assert.ok(fs.existsSync(path.join(dir, 'reviewer.token')), 'token 落了盘');
    });
    const again = G.resolveToken('reviewer', { dir, fetchImpl });
    await t.test('二次走缓存不再 fetch', () => {
      assert.ok(again.ok && again.cached === true && fetches === 1, '二次走缓存不再 fetch  →  ' + `fetches=${fetches} cached=${again.cached}`);
    });

    const info = G.whoami('reviewer', { dir, fetchImpl });
    await t.test('whoami 成功', () => {
      assert.ok(info.ok === true, 'whoami 成功  →  ' + JSON.stringify(info));
    });
    await t.test('仓库扫成且 1 个（不是没扫成）', () => {
      assert.ok(info.repoScan.scanned === true && info.repoScan.count === 1, '仓库扫成且 1 个（不是没扫成）  →  ' + JSON.stringify(info.repoScan));
    });
    await t.test('权限 0 条差异（扫完是 0）', () => {
      assert.ok(info.perm.ok && info.perm.unscanned === false && info.perm.mismatches.length === 0, '权限 0 条差异（扫完是 0）  →  ' + JSON.stringify(info.perm));
    });

    const noPerm = G.diffExpectedPermissions('reviewer', null);
    await t.test('权限没读到 = 没扫成，不是 0 差异', () => {
      assert.ok(noPerm.unscanned === true && noPerm.ok === false, '权限没读到 = 没扫成，不是 0 差异  →  ' + JSON.stringify(noPerm));
    });
    const wrong = G.diffExpectedPermissions('reviewer', { contents: 'write', pull_requests: 'write', issues: 'read', checks: 'read' });
    await t.test('权限不对是扫完有差', () => {
      assert.ok(wrong.unscanned === false && wrong.mismatches.some(m => m.key === 'contents'), '权限不对是扫完有差  →  ' + JSON.stringify(wrong));
    });

    const emptyRepos = G.whoami('reviewer', {
      dir,
      fetchImpl: (url) => {
        if (String(url).includes('/access_tokens')) {
          return { ok: true, status: 201, body: JSON.stringify({ token: 'x', expires_at: new Date(Date.now() + 3600_000).toISOString(), permissions: {} }) };
        }
        return { ok: true, status: 200, body: JSON.stringify({ repositories: [] }) };
      },
    });
    await t.test('0 个仓库是扫成的 0', () => {
      assert.ok(emptyRepos.ok && emptyRepos.repoScan.scanned && emptyRepos.repoScan.count === 0, '0 个仓库是扫成的 0  →  ' + JSON.stringify(emptyRepos.repoScan));
    });
  });

  it('git 身份跟角色走', async (t) => {
    const G = await LIB_LOAD;
    const repo = tmpDir('gh-as-git-');
    const gitInit = spawnSync('git', ['init'], { cwd: repo, encoding: 'utf8' });
    await t.test('临时仓 git init', () => {
      assert.ok(gitInit.status === 0, '临时仓 git init  →  ' + gitInit.stderr);
    });
    spawnSync('git', ['config', 'user.email', 'human@example.com'], { cwd: repo });
    spawnSync('git', ['config', 'user.name', 'human'], { cwd: repo });
    const ident = G.applyGitIdentity('worker', { cwd: repo });
    await t.test('applyGitIdentity 成功', () => {
      assert.ok(ident.ok === true, 'applyGitIdentity 成功  →  ' + ident.error);
    });
    await t.test('name=dao-worker[bot]', () => {
      assert.ok(ident.name === 'dao-worker[bot]', 'name=dao-worker[bot]  →  ' + ident.name);
    });
    await t.test('email 跟 appId 走', () => {
      assert.ok(ident.email === G.ROLE_META.worker.email, 'email 跟 appId 走  →  ' + ident.email);
    });
    const got = spawnSync('git', ['config', '--worktree', '--get', 'user.name'], { cwd: repo, encoding: 'utf8' });
    await t.test('worktree 级读回 bot', () => {
      assert.ok(got.stdout.trim() === 'dao-worker[bot]', 'worktree 级读回 bot  →  ' + got.stdout);
    });
    const local = spawnSync('git', ['config', '--local', '--get', 'user.name'], { cwd: repo, encoding: 'utf8' });
    await t.test('local 仍是 human（不污染共用 config）', () => {
      assert.ok(local.stdout.trim() === 'human', 'local 仍是 human（不污染共用 config）  →  ' + local.stdout);
    });

    const noCwd = G.applyGitIdentity('worker', {});
    await t.test('没给 cwd = 没设成', () => {
      assert.ok(noCwd.ok === false && /没设成/.test(noCwd.error), '没给 cwd = 没设成  →  ' + noCwd.error);
    });
  });

  it('CLI：缺凭据 / 缺参数', async (t) => {
    const empty = tmpDir('gh-as-cli-');
    const miss = spawnSync(process.execPath, [CLI, 'worker', '--whoami'], {
      encoding: 'utf8', env: { ...process.env, DAO_APPS_DIR: empty },
    });
    await t.test('CLI --whoami 缺凭据非零', () => {
      assert.ok(miss.status !== 0, 'CLI --whoami 缺凭据非零  →  ' + String(miss.status));
    });
    await t.test('CLI 报这台机器没装', () => {
      assert.ok(/这台机器没装/.test(miss.stderr || ''), 'CLI 报这台机器没装  →  ' + miss.stderr);
    });
    const badRole = spawnSync(process.execPath, [CLI, 'ghost', '--whoami'], { encoding: 'utf8' });
    await t.test('CLI 未知角色 exit 2', () => {
      assert.ok(badRole.status === 2, 'CLI 未知角色 exit 2  →  ' + String(badRole.status));
    });
    const noArgs = spawnSync(process.execPath, [CLI, 'worker'], { encoding: 'utf8' });
    await t.test('CLI 缺 gh 参数 exit 2', () => {
      assert.ok(noArgs.status === 2, 'CLI 缺 gh 参数 exit 2  →  ' + String(noArgs.status));
    });
  });

  it('过期「同账号不能 approve」注释不得再当现行约束', async (t) => {
    const files = [
      path.join(REPO, 'scripts', 'calibrate.mjs'),
      path.join(REPO, 'scripts', 'lib', 'judgment.mjs'),
    ];
    const present = files.filter(f => fs.existsSync(f));
    await t.test('点名的两份文件都扫到（不是 0 样本）', () => {
      assert.ok(present.length === files.length, '点名的两份文件都扫到（不是 0 样本）  →  ' + `got ${present.length}`);
    });
    for (const f of present) {
      const txt = fs.readFileSync(f, 'utf8');
      const rel = path.relative(REPO, f);
      if (!/同账号不能/.test(txt)) {
        await t.test(`${rel} 已不再写同账号限制`, () => {
          assert.ok(true, `${rel} 已不再写同账号限制`);
        });
        continue;
      }
      // 允许当历史出现，但必须同时点出 #573 已废。
      await t.test(`${rel} 若提同账号限制须标明 #573 已废`, () => {
        assert.ok(/#573/.test(txt), `${rel} 若提同账号限制须标明 #573 已废  →  还在当现行约束`);
      });
    }
  });
});