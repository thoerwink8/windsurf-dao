// #683 自停留痕：落盘 + dao-watchdog[bot] 报 GitHub。扫完 0 ≠ 没扫成。
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const LIB = path.join(__dirname, '..', 'scripts', 'lib', 'guard-halt.mjs');
const LIB_LOAD = import('file://' + LIB.replace(/\\/g, '/'));
const REV = path.join(__dirname, '..', 'scripts', 'lib', 'guard-revision.mjs');
const REV_LOAD = import('file://' + REV.replace(/\\/g, '/'));

function rec(extra = {}) {
  return {
    at: '2026-08-21T00:00:00.000Z',
    tag: '[watchdog] STALE_CODE',
    message: 'STALE_CODE：守卫代码落后 origin/master 1 个 commit——落后自停，不许继续跑旧代码',
    pid: 42,
    rev: {
      state: 'behind',
      behind: 1,
      startupSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      originSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      reason: '落后 origin/master 1 个 commit',
    },
    ...extra,
  };
}

describe('guard-halt', () => {
  it('事故键稳定、同一 sha 去重、sha 变了是新事故', async (t) => {
    const H = await LIB_LOAD;
    const a = H.haltAccidentKey(rec());
    const b = H.haltAccidentKey(rec());
    await t.test('同一记录同一键', () => {
      assert.ok(a === b && /^guard-halt\|watchdog\|behind\|aaaaaaaaaaaa$/.test(a), '同一记录同一键  →  ' + a);
    });
    const c = H.haltAccidentKey(rec({ rev: { state: 'behind', startupSha: 'cccccccccccccccccccccccccccccccccccccccc' } }));
    await t.test('sha 变了键变了', () => {
      assert.ok(c !== a && /cccccccccccc/.test(c), 'sha 变了键变了  →  ' + c);
    });
    const u = H.haltAccidentKey(rec({ rev: { state: 'unknown', reason: 'git fetch 失败：Could not resolve host' } }));
    await t.test('查不成键含 unknown 和原因', () => {
      assert.ok(/unknown/.test(u) && /fetch/.test(u), '查不成键  →  ' + u);
    });
  });

  it('落盘：写 jsonl；缺文件是 0 条不是没查成；坏行是没查成', async (t) => {
    const H = await LIB_LOAD;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-halt-'));
    t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });
    const env = { NODE_TEST_CONTEXT: '1', DAO_GUARD_HALT_DIR: dir };
    const r = H.persistHalt(rec(), { env });
    await t.test('persist ok', () => {
      assert.ok(r.ok && r.path && fs.existsSync(r.path), 'persist ok  →  ' + JSON.stringify(r));
    });
    const log = H.readHaltLog(r.path);
    await t.test('读回 1 条且含 key', () => {
      assert.ok(log.scanned && log.count === 1 && log.records[0].key && /behind/.test(log.records[0].key),
        '读回  →  ' + JSON.stringify(log));
    });
    const missing = H.readHaltLog(path.join(dir, 'nope.jsonl'));
    await t.test('文件不在 = 扫完 0，不是没查成', () => {
      assert.ok(missing.scanned === true && missing.count === 0 && missing.missing === true, '缺文件  →  ' + JSON.stringify(missing));
    });
    const badPath = path.join(dir, 'bad.jsonl');
    fs.writeFileSync(badPath, 'not-json\n', 'utf8');
    const bad = H.readHaltLog(badPath);
    await t.test('坏行是没查成', () => {
      assert.ok(bad.scanned === false && /没查成/.test(bad.error), '坏行  →  ' + JSON.stringify(bad));
    });
  });

  it('GitHub：空列表开台账再评论；同一键去重；列表没扫成不得开单', async (t) => {
    const H = await LIB_LOAD;
    const env = { NODE_TEST_CONTEXT: '1', DAO_GUARD_FORCE_HALT_NOTIFY: '1' };

    const calls = [];
    const first = H.reportGuardHalt(rec(), {
      env,
      now: 1_700_000_000_000,
      loadCreds: () => ({ ok: true }),
      runGh: (a) => {
        calls.push(a);
        if (a[0] === 'issue' && a[1] === 'list') return { ok: true, out: '[]' };
        if (a[0] === 'issue' && a[1] === 'create') return { ok: true, out: 'https://github.com/thoerwink8/windsurf-dao/issues/700' };
        if (a[0] === 'api') return { ok: true, out: '[]' };
        if (a[0] === 'issue' && a[1] === 'comment') return { ok: true, out: '{"id":1}' };
        return { ok: false, error: `unexpected ${a.join(' ')}` };
      },
    });
    await t.test('空列表 → 开台账 issue 700 并评论', () => {
      assert.ok(first.ok && first.posted && first.number === 700, '开台账  →  ' + JSON.stringify(first));
    });
    await t.test('create 在 list 之后，没扫成不会 create', () => {
      const kinds = calls.map((a) => `${a[0]} ${a[1]}`);
      assert.ok(kinds[0] === 'issue list' && kinds.includes('issue create') && kinds.includes('issue comment'),
        '顺序  →  ' + kinds.join(','));
    });
    await t.test('评论含【看门狗】和事故键', () => {
      const comment = calls.find((a) => a[0] === 'issue' && a[1] === 'comment');
      const body = comment[comment.indexOf('--body') + 1];
      assert.ok(body.startsWith('【看门狗】') && /事故键：guard-halt\|watchdog\|behind/.test(body), '正文  →  ' + body);
    });

    const noScanCalls = [];
    const noScan = H.reportGuardHalt(rec(), {
      env,
      loadCreds: () => ({ ok: true }),
      runGh: (a) => {
        noScanCalls.push(a);
        return { ok: false, error: 'timeout' };
      },
    });
    await t.test('列表没扫成 → 失败且含没查成，不 create', () => {
      assert.ok(noScan.ok === false && /没查成/.test(noScan.error), '没扫成  →  ' + JSON.stringify(noScan));
    });
    await t.test('没扫成一次 create 都不调', () => {
      assert.ok(!noScanCalls.some((a) => a[1] === 'create'), '不 create  →  ' + JSON.stringify(noScanCalls));
    });

    const dupCalls = [];
    const dup = H.reportGuardHalt(rec(), {
      env,
      loadCreds: () => ({ ok: true }),
      runGh: (a) => {
        dupCalls.push(a);
        if (a[0] === 'issue' && a[1] === 'list') {
          return { ok: true, out: JSON.stringify([{ number: 700, title: '【看门狗】守卫自停', state: 'OPEN' }]) };
        }
        if (a[0] === 'api') {
          return { ok: true, out: JSON.stringify([{ body: '【看门狗】\n事故键：guard-halt|watchdog|behind|aaaaaaaaaaaa' }]) };
        }
        return { ok: false, error: `unexpected ${a.join(' ')}` };
      },
    });
    await t.test('同一键已报过 → deduped，不再 comment', () => {
      assert.ok(dup.ok && dup.deduped && !dupCalls.some((a) => a[1] === 'comment'), '去重  →  ' + JSON.stringify({ dup, dupCalls }));
    });
  });

  it('没凭据 fail-loud，含「这台机器没装」（注入 loadCreds 不给兜底 = 直验失败形）', async () => {
    const H = await LIB_LOAD;
    const r = H.reportGuardHalt(rec(), {
      env: { NODE_TEST_CONTEXT: '1', DAO_GUARD_FORCE_HALT_NOTIFY: '1' },
      loadCreds: () => ({ ok: false, error: '缺凭据: watchdog.json（不是没配好，是这台机器没装——见 NEW-MACHINE）' }),
      runGh: () => ({ ok: true, out: '[]' }),
    });
    assert.ok(r.ok === false && /这台机器没装/.test(r.error), '没凭据  →  ' + JSON.stringify(r));
  });

  it('watchdog 没装 → marshal 兜底留可读记录，via 标明身份；兜底也没装才失败', async (t) => {
    const H = await LIB_LOAD;
    const env = { NODE_TEST_CONTEXT: '1', DAO_GUARD_FORCE_HALT_NOTIFY: '1' };
    const noWatchdog = () => ({ ok: false, error: '缺凭据: watchdog.json（这台机器没装）' });

    const calls = [];
    const r = H.reportGuardHalt(rec(), {
      env,
      now: 1_700_000_000_000,
      loadCreds: noWatchdog,
      loadFallbackCreds: () => ({ ok: true, role: 'marshal' }),
      runGh: (a) => {
        calls.push(a);
        if (a[0] === 'issue' && a[1] === 'list') return { ok: true, out: '[]' };
        if (a[0] === 'issue' && a[1] === 'create') return { ok: true, out: 'https://github.com/thoerwink8/windsurf-dao/issues/700' };
        if (a[0] === 'api') return { ok: true, out: '[]' };
        if (a[0] === 'issue' && a[1] === 'comment') return { ok: true, out: '{"id":1}' };
        return { ok: false, error: `unexpected ${a.join(' ')}` };
      },
    });
    await t.test('兜底写成，via=marshal-fallback', () => {
      assert.ok(r.ok && r.posted && r.via === 'marshal-fallback' && r.number === 700, '兜底  →  ' + JSON.stringify(r));
    });
    await t.test('评论正文仍是【看门狗】+ 事故键（身份可辨认）', () => {
      const comment = calls.find((a) => a[0] === 'issue' && a[1] === 'comment');
      const body = comment[comment.indexOf('--body') + 1];
      assert.ok(body.startsWith('【看门狗】') && /事故键：guard-halt\|/.test(body), '正文  →  ' + body);
    });

    const both = H.reportGuardHalt(rec(), {
      env,
      loadCreds: noWatchdog,
      loadFallbackCreds: () => ({ ok: false, error: '缺凭据: marshal.json（这台机器没装）' }),
      runGh: () => ({ ok: true, out: '[]' }),
    });
    await t.test('watchdog 与 marshal 都没装 → 失败且两个错误都带上', () => {
      assert.ok(both.ok === false && /watchdog\.json/.test(both.error) && /marshal\.json/.test(both.error), '双缺  →  ' + JSON.stringify(both));
    });
  });

  it('notifyGuardHalt 落盘的 github 块带 via（marshal 兜底可辨认）', async (t) => {
    const H = await LIB_LOAD;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-halt-via-'));
    t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });
    const env = { NODE_TEST_CONTEXT: '1', DAO_GUARD_HALT_DIR: dir, DAO_GUARD_FORCE_HALT_NOTIFY: '1' };
    H.notifyGuardHalt(rec(), {
      env,
      loadCreds: () => ({ ok: false, error: '缺凭据: watchdog.json（这台机器没装）' }),
      loadFallbackCreds: () => ({ ok: true, role: 'marshal' }),
      runGh: (a) => {
        if (a[0] === 'issue' && a[1] === 'list') return { ok: true, out: '[]' };
        if (a[0] === 'issue' && a[1] === 'create') return { ok: true, out: 'https://github.com/thoerwink8/windsurf-dao/issues/700' };
        if (a[0] === 'api') return { ok: true, out: '[]' };
        if (a[0] === 'issue' && a[1] === 'comment') return { ok: true, out: '{"id":1}' };
        return { ok: false, error: `unexpected ${a.join(' ')}` };
      },
    });
    const log = H.readHaltLog(path.join(dir, 'halt.jsonl'));
    await t.test('jsonl 里 github.ok=true 且 via=marshal-fallback', () => {
      assert.ok(log.scanned && log.count === 1 && log.records[0].github
        && log.records[0].github.ok === true && log.records[0].github.via === 'marshal-fallback',
      '落盘  →  ' + JSON.stringify(log.records[0]?.github));
    });
  });

  it('haltIfStale 会调用 notify；测试默认不写本机 halt.jsonl', async (t) => {
    const R = await REV_LOAD;
    const notes = [];
    const exits = [];
    const r = R.haltIfStale({
      state: 'behind', alarm: true, behind: 1,
      startupSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      originSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      reason: '落后 origin/master 1 个 commit',
    }, {
      log: (m) => notes.push(m),
      exit: (c) => exits.push(c),
      notify: (rec) => notes.push('notified:' + rec.tag),
    });
    await t.test('自停仍 exit 4', () => {
      assert.ok(r.halted && exits[0] === R.STALE_EXIT_CODE, 'exit 4  →  ' + JSON.stringify({ r, exits }));
    });
    await t.test('notify 被调用', () => {
      assert.ok(notes.some((n) => /^notified:/.test(n)), 'notify  →  ' + notes.join(' | '));
    });
  });
});
