// #665 守卫只读镜像：fetch + reset --hard origin/master 再 exec；查不成自停。
const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const {
  planGuardMirror, applyGuardMirror, skipGuardMirror, isPathInside, defaultMirrorPath, bootGuardOrHalt,
} = require('../scripts/lib/guard-mirror.mjs');
const { STALE_EXIT_CODE } = require('../scripts/lib/guard-revision.mjs');

function fakeGit(script) {
  return (args, { cwd } = {}) => {
    const key = `${cwd || ''}::${args.join(' ')}`;
    if (Object.prototype.hasOwnProperty.call(script, key)) return script[key];
    const short = args.join(' ');
    if (Object.prototype.hasOwnProperty.call(script, short)) return script[short];
    return { ok: false, error: `unexpected git ${key}` };
  };
}

const NEW = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const ORIGIN = 'git@github.com:thoerwink8/windsurf-dao.git';
const DEST = 'C:/Users/Administrator/.dao/guard-mirror';
const ROOT = 'D:/frank/windsurf-dao';
const SCRIPT = path.join(ROOT, 'scripts', 'inbox-station.mjs');
const MIRROR_SCRIPT = path.join(DEST, 'scripts', 'inbox-station.mjs');

describe('guard-mirror', () => {
  it('DAO_GUARD_SKIP_MIRROR 跳过', async (t) => {
    await t.test('env=1 → skip', () => {
      assert.ok(skipGuardMirror({ env: { DAO_GUARD_SKIP_MIRROR: '1' } }) === true, 'env=1');
    });
    const plan = planGuardMirror({ env: { DAO_GUARD_SKIP_MIRROR: '1' }, cwd: ROOT, scriptFile: SCRIPT });
    await t.test('plan action=skip', () => {
      assert.ok(plan.ok && plan.action === 'skip', 'plan action=skip  →  ' + JSON.stringify(plan));
    });
  });

  it('dest 不存在 → clone + fetch + reset + reexec', async (t) => {
    const git = fakeGit({
      [`${ROOT}::remote get-url origin`]: { ok: true, out: ORIGIN },
      [`clone -- ${ORIGIN} ${DEST}`]: { ok: true, out: '' },
      [`${DEST}::fetch --quiet origin master`]: { ok: true, out: '' },
      [`${DEST}::reset --hard origin/master`]: { ok: true, out: '' },
      [`${DEST}::rev-parse HEAD`]: { ok: true, out: NEW },
    });
    const exists = (p) => false;
    const plan = planGuardMirror({
      cwd: ROOT, scriptFile: SCRIPT, argv: ['relay'], git, exists, mirrorPath: DEST,
    });
    await t.test('reexec 到镜像脚本', () => {
      assert.ok(plan.ok && plan.action === 'reexec' && plan.script.replace(/\\/g, '/').endsWith('scripts/inbox-station.mjs') && plan.sha === NEW, 'reexec  →  ' + JSON.stringify(plan));
    });
    const spawned = [];
    const exits = [];
    applyGuardMirror(plan, {
      spawn: (exe, args, opts) => {
        spawned.push({ exe, args, cwd: opts.cwd });
        return { status: 0 };
      },
      exit: (c) => exits.push(c),
      execPath: 'node',
    });
    await t.test('apply 以镜像为 cwd reexec', () => {
      assert.ok(spawned[0] && spawned[0].cwd === DEST && spawned[0].args[0].replace(/\\/g, '/').includes('guard-mirror') && exits[0] === 0, 'apply reexec  →  ' + JSON.stringify(spawned));
    });
  });

  it('已在镜像内 → action=run，不再 reexec', async (t) => {
    const git = fakeGit({
      'remote get-url origin': { ok: true, out: ORIGIN },
      'fetch --quiet origin master': { ok: true, out: '' },
      'reset --hard origin/master': { ok: true, out: '' },
      'rev-parse HEAD': { ok: true, out: NEW },
    });
    const exists = (p) => String(p).replace(/\\/g, '/').includes('guard-mirror');
    const plan = planGuardMirror({
      cwd: DEST, scriptFile: MIRROR_SCRIPT, git, exists, mirrorPath: DEST,
    });
    await t.test('action=run', () => {
      assert.ok(plan.ok && plan.action === 'run' && plan.sha === NEW, 'action=run  →  ' + JSON.stringify(plan));
    });
  });

  it('fetch 失败 → halt，不是当最新', async (t) => {
    const git = fakeGit({
      'remote get-url origin': { ok: true, out: ORIGIN },
      'fetch --quiet origin master': { ok: false, error: 'Could not resolve host' },
    });
    const exists = (p) => String(p).replace(/\\/g, '/').includes('.git') || String(p) === DEST;
    const plan = planGuardMirror({
      cwd: ROOT, scriptFile: SCRIPT, git, exists, mirrorPath: DEST,
    });
    await t.test('fetch 失败 ok=false', () => {
      assert.ok(plan.ok === false && /fetch 失败/.test(plan.error) && !/已是最新/.test(plan.error), 'fetch 失败  →  ' + JSON.stringify(plan));
    });
    const exits = [];
    const logs = [];
    bootGuardOrHalt({
      repoRoot: ROOT, scriptFile: SCRIPT, git, exists, mirrorPath: DEST,
      exit: (c) => exits.push(c), log: (m) => logs.push(m),
    });
    await t.test('boot 自停 exit 4', () => {
      assert.ok(exits[0] === STALE_EXIT_CODE && /查不成|fetch/.test(logs[0] || ''), 'boot 自停  →  ' + JSON.stringify({ exits, logs }));
    });
  });

  it('origin URL 没查成 → halt', async (t) => {
    const plan = planGuardMirror({
      cwd: ROOT, scriptFile: SCRIPT, git: fakeGit({ 'remote get-url origin': { ok: false, error: 'not a git repository' } }),
      exists: () => false, mirrorPath: DEST,
    });
    await t.test('没查成不许跑', () => {
      assert.ok(plan.ok === false && /没查成/.test(plan.error), '没查成不许跑  →  ' + JSON.stringify(plan));
    });
  });

  it('isPathInside / defaultMirrorPath', async (t) => {
    await t.test('子路径认镜像', () => {
      assert.ok(isPathInside(MIRROR_SCRIPT, DEST) && !isPathInside(SCRIPT, DEST), '子路径认镜像');
    });
    await t.test('默认路径落 .dao/guard-mirror', () => {
      assert.ok(/guard-mirror$/.test(defaultMirrorPath('/home/u').replace(/\\/g, '/')), defaultMirrorPath('/home/u'));
    });
  });
});
