// #595 ① 守卫版本闸：落后 / 最新 / 查不成 三态。故意违规必须当场拦住。
const { describe, it } = require('node:test');
const assert = require('node:assert');
const {
  recordStartupRevision, checkGuardRevision, formatRevisionAlarm, attachRevision,
  haltIfStale, STALE_EXIT_CODE,
} = require('../scripts/lib/guard-revision.mjs');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

function fakeGit(script) {
  return (args) => {
    const key = args.join(' ');
    if (Object.prototype.hasOwnProperty.call(script, key)) return script[key];
    return { ok: false, error: `unexpected git ${key}` };
  };
}

const OLD = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const NEW = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

describe('guard-revision', () => {
  it('#595 ① 落后 1 个 commit → 报警', async (t) => {
    const git = fakeGit({
      'fetch --quiet origin master': { ok: true, out: '' },
      'rev-parse origin/master': { ok: true, out: NEW },
      'rev-list --count aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa..origin/master': { ok: true, out: '1' },
    });
    const rev = checkGuardRevision({ startup: { sha: OLD }, git });
    await t.test('state=behind', () => {
      assert.ok(rev.state === 'behind' && rev.behind === 1 && rev.alarm === true, 'state=behind  →  ' + JSON.stringify(rev));
    });
    const text = formatRevisionAlarm(rev);
    await t.test('日志含落后 1 个', () => {
      assert.ok(/落后 origin\/master 1 个 commit/.test(text), '日志含落后 1 个  →  ' + text);
    });
    const hb = attachRevision({ ts: 't', prs: [] }, rev);
    await t.test('heartbeat.revision.state=behind', () => {
      assert.ok(hb.revision && hb.revision.state === 'behind' && hb.revision.behind === 1, 'heartbeat.revision.state=behind  →  ' + JSON.stringify(hb.revision));
    });
  });

  it('#595 ① 已是最新 → 不报', async (t) => {
    const git = fakeGit({
      'fetch --quiet origin master': { ok: true, out: '' },
      'rev-parse origin/master': { ok: true, out: OLD },
    });
    const rev = checkGuardRevision({ startup: { sha: OLD }, git });
    await t.test('state=current 不报警', () => {
      assert.ok(rev.state === 'current' && rev.alarm === false && rev.behind === 0, 'state=current 不报警  →  ' + JSON.stringify(rev));
    });
    await t.test('报警文本为空（不报）', () => {
      assert.ok(formatRevisionAlarm(rev) === '', '报警文本为空（不报）  →  ' + formatRevisionAlarm(rev));
    });
  });

  it('#595 ① git fetch 失败 → 查不成，不含「已是最新」', async (t) => {
    const git = fakeGit({
      'fetch --quiet origin master': { ok: false, error: 'Could not resolve host' },
    });
    const rev = checkGuardRevision({ startup: { sha: OLD }, git });
    await t.test('state=unknown', () => {
      assert.ok(rev.state === 'unknown' && rev.alarm === true && rev.current === false, 'state=unknown  →  ' + JSON.stringify(rev));
    });
    const text = formatRevisionAlarm(rev);
    await t.test('含查不成', () => {
      assert.ok(/查不成/.test(text), '含查不成  →  ' + text);
    });
    await t.test('不含「已是最新」', () => {
      assert.ok(!/已是最新/.test(text), '不含「已是最新」  →  ' + text);
    });
  });

  it('#595 ① 非 git 仓 → 查不成，不含「已是最新」', async (t) => {
    const git = fakeGit({
      'fetch --quiet origin master': { ok: true, out: '' },
      'rev-parse origin/master': { ok: false, error: 'not a git repository' },
    });
    const rev = checkGuardRevision({ startup: { sha: OLD }, git });
    const text = formatRevisionAlarm(rev);
    await t.test('非 git 仓 unknown', () => {
      assert.ok(rev.state === 'unknown' && rev.alarm === true, '非 git 仓 unknown  →  ' + JSON.stringify(rev));
    });
    await t.test('非 git 仓含查不成', () => {
      assert.ok(/查不成/.test(text), '非 git 仓含查不成  →  ' + text);
    });
    await t.test('非 git 仓不含「已是最新」', () => {
      assert.ok(!/已是最新/.test(text), '非 git 仓不含「已是最新」  →  ' + text);
    });
  });

  it('启动没记下 HEAD', async (t) => {
    const rec = recordStartupRevision({ git: () => ({ ok: false, error: 'not a git repository' }) });
    await t.test('启动失败 ok=false', () => {
      assert.ok(rec.ok === false && !rec.sha, '启动失败 ok=false  →  ' + JSON.stringify(rec));
    });
    const rev = checkGuardRevision({ startup: rec, git: fakeGit({}) });
    await t.test('启动失败后每轮都是查不成', () => {
      assert.ok(rev.state === 'unknown' && !/已是最新/.test(formatRevisionAlarm(rev)), '启动失败后每轮都是查不成  →  ' + formatRevisionAlarm(rev));
    });
  });

  it('#665 落后自停：behind / unknown 退出 4，current 不退', async (t) => {
    const exits = [];
    const logs = [];
    const behind = checkGuardRevision({
      startup: { sha: OLD },
      git: fakeGit({
        'fetch --quiet origin master': { ok: true, out: '' },
        'rev-parse origin/master': { ok: true, out: NEW },
        'rev-list --count aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa..origin/master': { ok: true, out: '1' },
      }),
    });
    const r1 = haltIfStale(behind, { log: (m) => logs.push(m), exit: (c) => exits.push(c) });
    await t.test('behind 自停', () => {
      assert.ok(r1.halted === true && exits[0] === STALE_EXIT_CODE && /落后自停/.test(logs[0]), 'behind 自停  →  ' + JSON.stringify({ r1, logs, exits }));
    });
    const current = checkGuardRevision({
      startup: { sha: OLD },
      git: fakeGit({
        'fetch --quiet origin master': { ok: true, out: '' },
        'rev-parse origin/master': { ok: true, out: OLD },
      }),
    });
    const r2 = haltIfStale(current, { log: (m) => logs.push(m), exit: (c) => exits.push(c) });
    await t.test('current 不退', () => {
      assert.ok(r2.halted === false && exits.length === 1, 'current 不退  →  ' + JSON.stringify({ r2, exits }));
    });
    const unknown = checkGuardRevision({
      startup: { sha: OLD },
      git: fakeGit({ 'fetch --quiet origin master': { ok: false, error: 'Could not resolve host' } }),
    });
    const r3 = haltIfStale(unknown, { log: (m) => logs.push(m), exit: (c) => exits.push(c) });
    await t.test('unknown 也自停，不含已是最新', () => {
      assert.ok(r3.halted === true && exits[1] === STALE_EXIT_CODE && /查不成/.test(r3.message) && !/已是最新/.test(r3.message), 'unknown 也自停  →  ' + r3.message);
    });
  });

  it('#665 故意落后样本：真 git 仓被当场拦住', async (t) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-stale-'));
    t.after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } });
    const remote = path.join(tmp, 'remote');
    const local = path.join(tmp, 'local');
    fs.mkdirSync(remote);
    const git = (cwd, args) => spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
    const die = (r, step) => {
      if (r.status !== 0) throw new Error(`${step}: ${(r.stderr || r.stdout || '').slice(0, 240)}`);
    };
    die(git(remote, ['init', '-b', 'master']), 'init');
    die(git(remote, ['config', 'user.email', 't@t']), 'email');
    die(git(remote, ['config', 'user.name', 't']), 'name');
    fs.writeFileSync(path.join(remote, 'f'), 'a\n');
    die(git(remote, ['add', 'f']), 'add1');
    die(git(remote, ['commit', '-m', 'a']), 'c1');
    fs.writeFileSync(path.join(remote, 'f'), 'b\n');
    die(git(remote, ['add', 'f']), 'add2');
    die(git(remote, ['commit', '-m', 'b']), 'c2');
    die(git(tmp, ['clone', remote, local]), 'clone');
    die(git(local, ['reset', '--hard', 'HEAD~1']), 'behind');
    const lib = pathToFileURL(path.resolve(__dirname, '..', 'scripts', 'lib', 'guard-revision.mjs')).href;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { recordStartupRevision, checkGuardRevision, haltIfStale } from ${JSON.stringify(lib)};
      const cwd = process.env.STALE_CWD;
      const startup = recordStartupRevision({ cwd });
      const rev = checkGuardRevision({ startup, cwd, fetch: true });
      haltIfStale(rev);
      process.exit(0);
    `], { encoding: 'utf8', windowsHide: true, env: { ...process.env, STALE_CWD: local } });
    const out = (r.stdout || '') + (r.stderr || '');
    await t.test('落后样本退出码 4', () => {
      assert.ok(r.status === STALE_EXIT_CODE, '落后样本退出码 4  →  ' + `status=${r.status} ${out.slice(0, 300)}`);
    });
    await t.test('落后样本日志含落后自停', () => {
      assert.ok(/落后自停|落后 origin\/master/.test(out) && !/已是最新/.test(out), '落后样本日志含落后自停  →  ' + out.slice(0, 300));
    });
  });
});