// memory-sync 纯判官：时间门 / 干净 / 同步 / rebase / 没查成 五态分形。
const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const LIB = path.join(__dirname, '..', 'scripts', 'lib', 'memory-sync.mjs');
const LIB_LOAD = import('file://' + LIB.replace(/\\/g, '/'));

const NOW = 1_800_000_000_000;

describe('memory-sync', () => {
  it('planMemorySync 五态', async (t) => {
    const S = await LIB_LOAD;

    const skip = S.planMemorySync({ connected: false });
    await t.test('未接 memory = skip（不是干净）', () => {
      assert.ok(skip.action === 'skip' && /未接/.test(skip.reason), 'skip  →  ' + JSON.stringify(skip));
    });

    const fresh = S.planMemorySync({ connected: true, dirtyCount: 3, ahead: 1, behind: 0, now: NOW, lastSyncMs: NOW - 5 * 60 * 1000 });
    await t.test('时间门内：有改动也跳过', () => {
      assert.ok(fresh.action === 'skip-fresh', '门内  →  ' + JSON.stringify(fresh));
    });

    const clean = S.planMemorySync({ connected: true, dirtyCount: 0, ahead: 0, behind: 0, now: NOW, lastSyncMs: null });
    await t.test('干净 = noop-clean（扫完，不是没查成）', () => {
      assert.ok(clean.action === 'noop-clean' && /扫完/.test(clean.reason), '干净  →  ' + JSON.stringify(clean));
    });

    const dirty = S.planMemorySync({ connected: true, dirtyCount: 2, ahead: 0, behind: 0, now: NOW, lastSyncMs: null });
    await t.test('有改动 = sync（commit + push）', () => {
      assert.ok(dirty.action === 'sync' && dirty.needCommit === true && dirty.needPush === true, 'sync  →  ' + JSON.stringify(dirty));
    });

    const ahead = S.planMemorySync({ connected: true, dirtyCount: 0, ahead: 2, behind: 0, now: NOW, lastSyncMs: null });
    await t.test('只领先 = sync 但不 commit', () => {
      assert.ok(ahead.action === 'sync' && ahead.needCommit === false && ahead.needPush === true, 'ahead  →  ' + JSON.stringify(ahead));
    });

    const behind = S.planMemorySync({ connected: true, dirtyCount: 1, ahead: 0, behind: 2, now: NOW, lastSyncMs: null });
    await t.test('远端领先 = 先 pull-rebase', () => {
      assert.ok(behind.action === 'pull-rebase' && behind.needCommit === true, 'behind  →  ' + JSON.stringify(behind));
    });

    const bad = S.planMemorySync({ connected: true, dirtyCount: 'x', ahead: 0, behind: 0, now: NOW, lastSyncMs: null });
    await t.test('字段不是数字 = 没查成', () => {
      assert.ok(bad.action === 'unscanned' && /没查成/.test(bad.reason), 'bad  →  ' + JSON.stringify(bad));
    });
  });

  it('parseAheadBehind：三种头行形态', async (t) => {
    const S = await LIB_LOAD;
    await t.test('ahead+behind', () => {
      const r = S.parseAheadBehind('## main...origin/main [ahead 2, behind 1]');
      assert.ok(r.ok && r.ahead === 2 && r.behind === 1, JSON.stringify(r));
    });
    await t.test('无方括号 = 0/0', () => {
      const r = S.parseAheadBehind('## main...origin/main');
      assert.ok(r.ok && r.ahead === 0 && r.behind === 0 && r.noUpstream === false, JSON.stringify(r));
    });
    await t.test('无 upstream 显形', () => {
      const r = S.parseAheadBehind('## main');
      assert.ok(r.ok && r.noUpstream === true, JSON.stringify(r));
    });
    await t.test('空行 = 没查成', () => {
      const r = S.parseAheadBehind('');
      assert.ok(r.ok === false && /不认识/.test(r.error), JSON.stringify(r));
    });
  });
});
