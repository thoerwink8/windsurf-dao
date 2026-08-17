// #595 ① 守卫版本闸：落后 / 最新 / 查不成 三态。故意违规必须当场拦住。
const { describe, it } = require('node:test');
const assert = require('node:assert');
const {
  recordStartupRevision, checkGuardRevision, formatRevisionAlarm, attachRevision,
} = require('../scripts/lib/guard-revision.mjs');

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
});