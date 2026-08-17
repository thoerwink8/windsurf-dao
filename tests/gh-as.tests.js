// gh-as / lib/gh.mjs 回归（issue #573）
//
// 不打真 GitHub：fetch / spawn / git 全部注入。真机 whoami 与 --body 送达
// 写在 PR 正文，不在这套里冒充。

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { generateKeyPairSync } = require('crypto');

const REPO = path.resolve(__dirname, '..');
const LIB = path.join(REPO, 'scripts', 'lib', 'gh.mjs');
const CLI = path.join(REPO, 'scripts', 'gh-as.mjs');

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? '  →  ' + detail : ''}`); }
}

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

async function main() {
  const G = await import('file://' + LIB.replace(/\\/g, '/'));

  console.log('\n=== 角色 / 凭据缺失 fail-loud ===');
  {
    check('未知角色', G.loadRoleCreds('ghost').ok === false && /reviewer\|worker\|marshal/.test(G.loadRoleCreds('ghost').error));
    const empty = tmpDir('gh-as-empty-');
    const miss = G.loadRoleCreds('worker', { dir: empty });
    check('缺 pem/json → not_installed', miss.ok === false && miss.code === 'not_installed', JSON.stringify(miss));
    check('缺凭据说「这台机器没装」', /这台机器没装/.test(miss.error), miss.error);
    check('缺凭据不说「配置错了」', !/配置错了/.test(miss.error), miss.error);

    const half = tmpDir('gh-as-half-');
    fs.writeFileSync(path.join(half, 'worker.json'), JSON.stringify({ slug: 'dao-worker' }));
    fs.writeFileSync(path.join(half, 'worker.pem'), 'not-a-key');
    const bad = G.loadRoleCreds('worker', { dir: half });
    check('json 缺 appId → bad_config', bad.ok === false && bad.code === 'bad_config', JSON.stringify(bad));
    check('配置错了 ≠ 没装', /配置错了/.test(bad.error) && !/这台机器没装/.test(bad.error), bad.error);
  }

  console.log('\n=== JWT / 缓存 10 分钟门槛 ===');
  {
    const dir = tmpDir('gh-as-jwt-');
    writeKeypair(dir, 'worker');
    const creds = G.loadRoleCreds('worker', { dir });
    check('凭据齐全', creds.ok === true, JSON.stringify(creds));
    const pem = fs.readFileSync(creds.pemPath, 'utf8');
    const jwt = G.mintJwt(creds.appId, pem, { now: 1_700_000_000 });
    check('JWT 签得出', jwt.ok === true, jwt.error);
    const payload = JSON.parse(Buffer.from(jwt.jwt.split('.')[1], 'base64url').toString('utf8'));
    check('iss=appId', payload.iss === creds.appId, JSON.stringify(payload));
    check('exp-iat ≤ 600s（GitHub 硬限）', payload.exp - payload.iat <= 600, JSON.stringify(payload));
    check('exp-iat ≥ 500s', payload.exp - payload.iat >= 500, JSON.stringify(payload));
    const badPem = G.mintJwt(creds.appId, 'hello');
    check('坏 pem fail-loud', badPem.ok === false, JSON.stringify(badPem));

    const future = new Date(Date.now() + 40 * 60 * 1000).toISOString();
    fs.writeFileSync(path.join(dir, 'worker.token'), JSON.stringify({ token: 'cached-token', expires_at: future, permissions: { contents: 'write' } }));
    const hit = G.readCachedToken(path.join(dir, 'worker.token'));
    check('剩余 >10 分钟走缓存', hit.ok === true && hit.token === 'cached-token', JSON.stringify(hit));
    const stale = G.readCachedToken(path.join(dir, 'worker.token'), { now: Date.parse(future) - 5 * 60 * 1000 });
    check('剩余 <10 分钟当过期', stale.ok === false && stale.reason === 'stale', JSON.stringify(stale));
    check('没缓存 ≠ 坏缓存', G.readCachedToken(path.join(dir, 'nope.token')).reason === 'no_cache');
  }

  console.log('\n=== spawn 不走 shell，参数原样送达 ===');
  {
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
    check('ghAs 成功', r.ok === true, JSON.stringify(r));
    check('只 spawn 一次', calls.length === 1, String(calls.length));
    check('Windows 用 gh.exe / 其他用 gh', calls[0].cmd === G.ghExecutable(), calls[0].cmd);
    check('不设 shell:true', calls[0].opts.shell !== true, JSON.stringify(calls[0].opts));
    check('--body 多行仍是一个参数', calls[0].args.includes(multiline) && calls[0].args.filter(a => a === multiline).length === 1, JSON.stringify(calls[0].args));
    check('GH_TOKEN 盖住本人', calls[0].opts.env.GH_TOKEN === 't-live', String(calls[0].opts.env.GH_TOKEN));
  }

  console.log('\n=== 换 token / whoami：扫成 vs 没扫成 ===');
  {
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
    check('无缓存则换 token', minted.ok && minted.token === 'minted' && minted.cached === false, JSON.stringify(minted));
    check('token 落了盘', fs.existsSync(path.join(dir, 'reviewer.token')));
    const again = G.resolveToken('reviewer', { dir, fetchImpl });
    check('二次走缓存不再 fetch', again.ok && again.cached === true && fetches === 1, `fetches=${fetches} cached=${again.cached}`);

    const info = G.whoami('reviewer', { dir, fetchImpl });
    check('whoami 成功', info.ok === true, JSON.stringify(info));
    check('仓库扫成且 1 个（不是没扫成）', info.repoScan.scanned === true && info.repoScan.count === 1, JSON.stringify(info.repoScan));
    check('权限 0 条差异（扫完是 0）', info.perm.ok && info.perm.unscanned === false && info.perm.mismatches.length === 0, JSON.stringify(info.perm));

    const noPerm = G.diffExpectedPermissions('reviewer', null);
    check('权限没读到 = 没扫成，不是 0 差异', noPerm.unscanned === true && noPerm.ok === false, JSON.stringify(noPerm));
    const wrong = G.diffExpectedPermissions('reviewer', { contents: 'write', pull_requests: 'write', issues: 'read', checks: 'read' });
    check('权限不对是扫完有差', wrong.unscanned === false && wrong.mismatches.some(m => m.key === 'contents'), JSON.stringify(wrong));

    const emptyRepos = G.whoami('reviewer', {
      dir,
      fetchImpl: (url) => {
        if (String(url).includes('/access_tokens')) {
          return { ok: true, status: 201, body: JSON.stringify({ token: 'x', expires_at: new Date(Date.now() + 3600_000).toISOString(), permissions: {} }) };
        }
        return { ok: true, status: 200, body: JSON.stringify({ repositories: [] }) };
      },
    });
    check('0 个仓库是扫成的 0', emptyRepos.ok && emptyRepos.repoScan.scanned && emptyRepos.repoScan.count === 0, JSON.stringify(emptyRepos.repoScan));
  }

  console.log('\n=== git 身份跟角色走 ===');
  {
    const repo = tmpDir('gh-as-git-');
    const gitInit = spawnSync('git', ['init'], { cwd: repo, encoding: 'utf8' });
    check('临时仓 git init', gitInit.status === 0, gitInit.stderr);
    spawnSync('git', ['config', 'user.email', 'human@example.com'], { cwd: repo });
    spawnSync('git', ['config', 'user.name', 'human'], { cwd: repo });
    const ident = G.applyGitIdentity('worker', { cwd: repo });
    check('applyGitIdentity 成功', ident.ok === true, ident.error);
    check('name=dao-worker[bot]', ident.name === 'dao-worker[bot]', ident.name);
    check('email 跟 appId 走', ident.email === G.ROLE_META.worker.email, ident.email);
    const got = spawnSync('git', ['config', '--worktree', '--get', 'user.name'], { cwd: repo, encoding: 'utf8' });
    check('worktree 级读回 bot', got.stdout.trim() === 'dao-worker[bot]', got.stdout);
    const local = spawnSync('git', ['config', '--local', '--get', 'user.name'], { cwd: repo, encoding: 'utf8' });
    check('local 仍是 human（不污染共用 config）', local.stdout.trim() === 'human', local.stdout);

    const noCwd = G.applyGitIdentity('worker', {});
    check('没给 cwd = 没设成', noCwd.ok === false && /没设成/.test(noCwd.error), noCwd.error);
  }

  console.log('\n=== CLI：缺凭据 / 缺参数 ===');
  {
    const empty = tmpDir('gh-as-cli-');
    const miss = spawnSync(process.execPath, [CLI, 'worker', '--whoami'], {
      encoding: 'utf8', env: { ...process.env, DAO_APPS_DIR: empty },
    });
    check('CLI --whoami 缺凭据非零', miss.status !== 0, String(miss.status));
    check('CLI 报这台机器没装', /这台机器没装/.test(miss.stderr || ''), miss.stderr);
    const badRole = spawnSync(process.execPath, [CLI, 'ghost', '--whoami'], { encoding: 'utf8' });
    check('CLI 未知角色 exit 2', badRole.status === 2, String(badRole.status));
    const noArgs = spawnSync(process.execPath, [CLI, 'worker'], { encoding: 'utf8' });
    check('CLI 缺 gh 参数 exit 2', noArgs.status === 2, String(noArgs.status));
  }

  console.log('\n=== 过期「同账号不能 approve」注释不得再当现行约束 ===');
  {
    const files = [
      path.join(REPO, 'scripts', 'calibrate.mjs'),
      path.join(REPO, 'scripts', 'lib', 'judgment.mjs'),
    ];
    const present = files.filter(f => fs.existsSync(f));
    check('点名的两份文件都扫到（不是 0 样本）', present.length === files.length, `got ${present.length}`);
    for (const f of present) {
      const txt = fs.readFileSync(f, 'utf8');
      const rel = path.relative(REPO, f);
      if (!/同账号不能/.test(txt)) {
        check(`${rel} 已不再写同账号限制`, true);
        continue;
      }
      // 允许当历史出现，但必须同时点出 #573 已废。
      check(`${rel} 若提同账号限制须标明 #573 已废`, /#573/.test(txt), '还在当现行约束');
    }
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
