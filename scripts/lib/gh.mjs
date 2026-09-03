// scripts/lib/gh.mjs —— 以 GitHub App 身份跑 gh 的统一入口（issue #573）
//
// 仓内其余裸 gh 先不改。全量替换另开单（一次改 43 处必然出错，没法逐处验证）。
// 本单示范：dao.mjs reviewer-create 走 role=reviewer。
//
// 两个已经踩过的坑，别再踩：
//   1. 不能 spawnSync(..., { shell: true })。Windows 上 cmd 会把参数重新分词，
//      带换行的 --body / --comment 会被拆开（实测 gh issue close --comment "多行"
//      报 accepts 1 arg(s), received 10）。gh 在 Windows 上是 gh.exe，直接 spawn。
//   2. 凭据缺失要 fail-loud，报「这台机器没装」而不是「配置错了」——处置完全不同。
//
// App token 硬性 1 小时过期。缓存剩余不足 10 分钟即重换，免得长任务跑一半 401。

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createSign } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

export const ROLES = ['reviewer', 'worker', 'marshal', 'watchdog'];

// 权限表以 issue #573 正文为准。metadata:read 是 GitHub 给每个 installation token
// 自动加上的，不算我们声明的权限，比对时忽略。
//
// dao-worker 的 pull_requests 现在是 write（自动开 PR 的 workflow 还没写，#480）。
// workflow 上线后降回 read——不做这一步，权限隔离是装饰。
export const ROLE_META = {
  reviewer: {
    appId: 4616659,
    installationId: 154244051,
    slug: 'dao-reviewer',
    name: 'dao-reviewer[bot]',
    email: '4616659+dao-reviewer[bot]@users.noreply.github.com',
    expectedPermissions: {
      contents: 'read',
      pull_requests: 'write',
      issues: 'read',
      checks: 'read',
    },
  },
  worker: {
    appId: 4616929,
    installationId: 154249581,
    slug: 'dao-worker',
    name: 'dao-worker[bot]',
    email: '4616929+dao-worker[bot]@users.noreply.github.com',
    expectedPermissions: {
      contents: 'write',
      pull_requests: 'write',
      issues: 'write',
      checks: 'read',
    },
  },
  marshal: {
    appId: 4616953,
    installationId: 154249976,
    slug: 'dao-marshal',
    name: 'dao-marshal[bot]',
    email: '4616953+dao-marshal[bot]@users.noreply.github.com',
    expectedPermissions: {
      contents: 'write',
      pull_requests: 'write',
      issues: 'write',
      checks: 'read',
    },
  },
  // App ID / Installation ID 以 ~/.dao/apps/watchdog.json 为准。
  // 人在 GitHub 建 App，工人不建（#673）。仓库不硬编码未建的号。
  watchdog: {
    slug: 'dao-watchdog',
    name: 'dao-watchdog[bot]',
    email: 'dao-watchdog[bot]@users.noreply.github.com',
    expectedPermissions: {
      contents: 'read',
      pull_requests: 'write',
      issues: 'write',
      checks: 'read',
    },
  },
};

const TOKEN_RENEW_MS = 10 * 60 * 1000;
const JWT_IAT_SKEW = 60;
const JWT_EXP_LIFE = 540; // 9 分钟，GitHub 硬限 10 分钟

export function appsDir(override) {
  return override || process.env.DAO_APPS_DIR || join(homedir(), '.dao', 'apps');
}

export function unknownRoleError(role) {
  return `用法: node scripts/gh-as.mjs <${ROLES.join('|')}> -- <gh 参数...>`;
}

function missingCredError(p) {
  return `缺凭据: ${p}（不是没配好，是这台机器没装——见 NEW-MACHINE）`;
}

export function loadRoleCreds(role, { dir } = {}) {
  if (!role || !ROLES.includes(role)) {
    return { ok: false, error: unknownRoleError(role), code: 'bad_role' };
  }
  const root = appsDir(dir);
  const cfgPath = join(root, `${role}.json`);
  const pemPath = join(root, `${role}.pem`);
  const missing = [cfgPath, pemPath].filter(p => !existsSync(p));
  if (missing.length) {
    return {
      ok: false,
      error: missingCredError(missing[0]),
      code: 'not_installed',
      missing,
    };
  }
  let cfg;
  try {
    cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  } catch (e) {
    return { ok: false, error: `${cfgPath} 不是 JSON：${String(e.message || e).slice(0, 120)}`, code: 'bad_config' };
  }
  if (!cfg.appId || !cfg.installationId) {
    return { ok: false, error: `${cfgPath} 缺 appId/installationId（这是配置错了，不是没装）`, code: 'bad_config' };
  }
  return {
    ok: true,
    role,
    dir: root,
    cfgPath,
    pemPath,
    appId: cfg.appId,
    installationId: cfg.installationId,
    slug: cfg.slug || ROLE_META[role].slug,
    meta: ROLE_META[role],
    cachePath: join(root, `${role}.token`),
  };
}

export function readCachedToken(cachePath, { now = Date.now() } = {}) {
  if (!cachePath || !existsSync(cachePath)) return { ok: false, reason: 'no_cache' };
  let c;
  try {
    c = JSON.parse(readFileSync(cachePath, 'utf8'));
  } catch (e) {
    return { ok: false, reason: 'bad_cache', error: String(e.message || e).slice(0, 120) };
  }
  if (!c || typeof c.token !== 'string' || !c.expires_at) {
    return { ok: false, reason: 'bad_cache' };
  }
  const exp = Date.parse(c.expires_at);
  if (!Number.isFinite(exp)) return { ok: false, reason: 'bad_cache' };
  if (exp - now <= TOKEN_RENEW_MS) return { ok: false, reason: 'stale', expires_at: c.expires_at };
  return { ok: true, token: c.token, expires_at: c.expires_at, permissions: c.permissions || null };
}

export function mintJwt(appId, pem, { now = Math.floor(Date.now() / 1000) } = {}) {
  if (!appId) return { ok: false, error: 'mintJwt 缺 appId' };
  if (!pem || !/BEGIN [\w ]*PRIVATE KEY/.test(pem)) {
    return { ok: false, error: 'pem 不是私钥（缺 BEGIN PRIVATE KEY）' };
  }
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iat: now - JWT_IAT_SKEW, exp: now + JWT_EXP_LIFE, iss: appId })}`;
  let sig;
  try {
    sig = createSign('RSA-SHA256').update(unsigned).end().sign(pem).toString('base64url');
  } catch (e) {
    return { ok: false, error: `JWT 签名失败：${String(e.message || e).slice(0, 160)}` };
  }
  return { ok: true, jwt: `${unsigned}.${sig}`, iat: now - JWT_IAT_SKEW, exp: now + JWT_EXP_LIFE };
}

function defaultFetchSync(url, { method = 'GET', headers = {}, body } = {}) {
  const spec = JSON.stringify({ url, method, headers, body: body ?? null });
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    const spec = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const init = { method: spec.method, headers: spec.headers };
    if (spec.body != null) init.body = spec.body;
    const res = await fetch(spec.url, init);
    const text = await res.text();
    process.stdout.write(JSON.stringify({ status: res.status, body: text }));
  `], {
    encoding: 'utf8',
    input: spec,
    timeout: 30000,
  });
  if (r.error || (r.status !== 0 && r.status != null)) {
    return { ok: false, error: String(r.error?.message || r.stderr || `fetch exit ${r.status}`).trim().slice(0, 240) };
  }
  try {
    const parsed = JSON.parse(r.stdout);
    return { ok: true, status: parsed.status, body: parsed.body };
  } catch (e) {
    return { ok: false, error: `fetch 返回不是 JSON：${String(r.stdout || e.message).slice(0, 120)}` };
  }
}

export function mintInstallationToken(creds, { fetchImpl, nowSec } = {}) {
  const pem = readFileSync(creds.pemPath, 'utf8');
  const jwt = mintJwt(creds.appId, pem, { now: nowSec });
  if (!jwt.ok) return jwt;
  const fetch = fetchImpl || defaultFetchSync;
  const r = fetch(`https://api.github.com/app/installations/${creds.installationId}/access_tokens`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${jwt.jwt}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'windsurf-dao-gh-as',
    },
  });
  if (!r.ok) return { ok: false, error: `换 token 没查成：${r.error}` };
  if (r.status !== 201) {
    return { ok: false, error: `换 token 失败 ${r.status}: ${String(r.body || '').slice(0, 300)}` };
  }
  let j;
  try { j = JSON.parse(r.body); }
  catch { return { ok: false, error: `换 token 返回不是 JSON：${String(r.body).slice(0, 120)}` }; }
  if (!j.token || !j.expires_at) {
    return { ok: false, error: '换 token 成功形态不对（缺 token/expires_at）' };
  }
  try {
    mkdirSync(creds.dir, { recursive: true });
    writeFileSync(creds.cachePath, JSON.stringify({
      token: j.token,
      expires_at: j.expires_at,
      permissions: j.permissions || null,
    }), { mode: 0o600 });
  } catch (e) {
    return { ok: false, error: `写 token 缓存失败：${String(e.message || e).slice(0, 160)}` };
  }
  return { ok: true, token: j.token, expires_at: j.expires_at, permissions: j.permissions || null, cached: false };
}

export function resolveToken(role, opts = {}) {
  const creds = loadRoleCreds(role, opts);
  if (!creds.ok) return creds;
  const cached = readCachedToken(creds.cachePath, { now: opts.now });
  if (cached.ok) {
    return { ok: true, token: cached.token, expires_at: cached.expires_at, permissions: cached.permissions, cached: true, creds };
  }
  const minted = mintInstallationToken(creds, opts);
  if (!minted.ok) return minted;
  return { ...minted, creds };
}

export function ghExecutable() {
  return process.platform === 'win32' ? 'gh.exe' : 'gh';
}

export function spawnGh(args, { token, cwd, inherit = false, spawnImpl } = {}) {
  if (!Array.isArray(args) || args.length === 0) {
    return { ok: false, error: '缺 gh 参数' };
  }
  const spawn = spawnImpl || spawnSync;
  const exe = ghExecutable();
  const opts = {
    cwd,
    env: { ...process.env, GH_TOKEN: token, GITHUB_TOKEN: token },
  };
  if (inherit) opts.stdio = 'inherit';
  else opts.encoding = 'utf8';
  // 故意不设 shell。见文件头坑 1。
  const r = spawn(exe, args, opts);
  if (r.error) return { ok: false, error: `执行 gh 失败: ${r.error.message}` };
  const status = r.status == null ? 1 : r.status;
  if (status !== 0) {
    return {
      ok: false,
      status,
      out: inherit ? '' : String(r.stdout || ''),
      error: inherit ? `gh exit ${status}` : String(r.stderr || r.stdout || `gh exit ${status}`).trim().slice(0, 240),
    };
  }
  return { ok: true, status: 0, out: inherit ? '' : String(r.stdout || '') };
}

export function ghAs(role, args, opts = {}) {
  const tok = resolveToken(role, opts);
  if (!tok.ok) return tok;
  return spawnGh(args, { token: tok.token, cwd: opts.cwd, inherit: opts.inherit, spawnImpl: opts.spawnImpl });
}

// 扫完 0 条差异 vs 没扫成：actual 读不到 → unscanned；扫到且完全吻合 → mismatches=[]。
export function diffExpectedPermissions(role, actual) {
  const meta = ROLE_META[role];
  if (!meta) return { ok: false, unscanned: true, error: unknownRoleError(role) };
  if (!actual || typeof actual !== 'object') {
    return { ok: false, unscanned: true, error: '权限表没读到——不是 0 条差异，是没扫成' };
  }
  const expected = meta.expectedPermissions;
  const mismatches = [];
  for (const [k, v] of Object.entries(expected)) {
    if (actual[k] !== v) mismatches.push({ key: k, expected: v, actual: actual[k] ?? null });
  }
  const extra = Object.keys(actual).filter(k => !(k in expected) && k !== 'metadata');
  return { ok: mismatches.length === 0, unscanned: false, mismatches, extra, expected, actual };
}

export function whoami(role, opts = {}) {
  const tok = resolveToken(role, opts);
  if (!tok.ok) return tok;
  const fetch = opts.fetchImpl || defaultFetchSync;
  const r = fetch('https://api.github.com/installation/repositories', {
    method: 'GET',
    headers: {
      Authorization: `token ${tok.token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'windsurf-dao-gh-as',
    },
  });
  if (!r.ok) return { ok: false, error: `whoami 没查成：${r.error}` };
  let repos;
  try { repos = JSON.parse(r.body); }
  catch { return { ok: false, error: `whoami 返回不是 JSON：${String(r.body).slice(0, 120)}` }; }
  const permissions = tok.permissions;
  const perm = diffExpectedPermissions(role, permissions);
  const names = (repos.repositories || []).map(x => x.full_name);
  return {
    ok: true,
    role,
    appId: tok.creds.appId,
    installationId: tok.creds.installationId,
    permissions,
    perm,
    repositories: names,
    expires_at: tok.expires_at,
    cached: !!tok.cached,
    repoScan: Array.isArray(repos.repositories)
      ? { scanned: true, count: names.length }
      : { scanned: false, error: 'installation/repositories 形态不对——不是 0 个仓库，是没扫成' },
  };
}

export function formatWhoami(info) {
  const lines = [
    `${info.role}  app=${info.appId}  inst=${info.installationId}`,
    `  权限   ${JSON.stringify(info.permissions)}`,
    `  仓库   ${info.repoScan?.scanned ? (info.repositories.join(', ') || '（0 个）') : `没扫成：${info.repoScan?.error}`}`,
    `  到期   ${info.expires_at}${info.cached ? '  (缓存)' : ''}`,
  ];
  if (info.perm && !info.perm.unscanned && info.perm.mismatches.length) {
    lines.push(`  权限差 ${info.perm.mismatches.map(m => `${m.key}:${m.actual}≠${m.expected}`).join(', ')}`);
  }
  return lines.join('\n');
}

function gitRun(cwd, args, gitImpl) {
  if (gitImpl) return gitImpl(args);
  const r = spawnSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8', timeout: 15000,
  });
  if (r.error || (r.status !== 0 && r.status != null)) {
    return { ok: false, out: String(r.stdout || '').trim(), error: String(r.error?.message || r.stderr || `git exit ${r.status}`).trim().slice(0, 200) };
  }
  return { ok: true, out: String(r.stdout || '').trim() };
}

export function applyGitIdentity(role, { cwd, gitImpl } = {}) {
  const meta = ROLE_META[role];
  if (!meta) return { ok: false, error: unknownRoleError(role) };
  if (!cwd) return { ok: false, error: 'applyGitIdentity 没给工作区路径——没设成，不是设过没事' };
  const run = (args) => gitRun(cwd, args, gitImpl);

  const common = run(['rev-parse', '--git-common-dir']);
  if (!common.ok) return { ok: false, error: `git-common-dir 没查成：${common.error}` };
  const ext = run(['config', '--file', join(common.out, 'config'), 'extensions.worktreeConfig', 'true']);
  if (!ext.ok) return { ok: false, error: `开 worktreeConfig 失败：${ext.error}` };

  const name = run(['config', '--worktree', 'user.name', meta.name]);
  if (!name.ok) return { ok: false, error: `设 user.name 失败：${name.error}` };
  const email = run(['config', '--worktree', 'user.email', meta.email]);
  if (!email.ok) return { ok: false, error: `设 user.email 失败：${email.error}` };

  const gotName = run(['config', '--worktree', '--get', 'user.name']);
  const gotEmail = run(['config', '--worktree', '--get', 'user.email']);
  if (!gotName.ok || !gotEmail.ok || gotName.out !== meta.name || gotEmail.out !== meta.email) {
    return {
      ok: false,
      error: `回读身份对不上：name=${gotName.out || '?'} email=${gotEmail.out || '?'}（没设成）`,
    };
  }
  return { ok: true, name: meta.name, email: meta.email, cwd };
}
