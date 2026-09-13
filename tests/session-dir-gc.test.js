import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judgeSession, planSessionGc, planOrphanGc, markOrphanInUse, refsOf } from '../scripts/lib/session-dir-gc.mjs';

const now = Date.parse('2026-09-10T01:00:00Z');
const H = 3600000;

function sess(over = {}) {
  return {
    id: 'uuid-x',
    agent: 'pi',
    dir: '/home/orca/.mirasim/sessions/pi/x',
    alive: false,
    updatedAtMs: now - 20 * H,
    record: { workdir: 'dao-1145', title: 'issue #1145', preview: '' },
    ...over,
  };
}

test('refsOf 从 workdir 认编号', () => {
  assert.deepEqual([...refsOf({ workdir: 'dao-1145' })], ['1145']);
});

test('refsOf 认审官树的 pr 编号', () => {
  assert.deepEqual([...refsOf({ workdir: 'dao-review-pr-1032-2' })], ['1032']);
});

test('refsOf 从标题认编号', () => {
  assert.deepEqual([...refsOf({ title: '看 #1122 正文' })], ['1122']);
});

test('refsOf 认不出编号时回空集，不是猜一个', () => {
  assert.equal(refsOf({ workdir: '/tmp/scratch' }).size, 0);
});

test('有活进程永远保留——单已关且超时效也不删', () => {
  const j = judgeSession(sess({ alive: true, updatedAtMs: now - 100 * H }), {
    closedRefs: new Set(['1145']), boardScanned: true, now,
  });
  assert.equal(j.verdict, 'keep');
});

test('盘面没查成时 fail-closed，超时效也不删', () => {
  const j = judgeSession(sess({ updatedAtMs: now - 100 * H }), {
    closedRefs: new Set(['1145']), boardScanned: false, now,
  });
  assert.equal(j.verdict, 'keep');
});

test('planSessionGc 盘面没查成 → 名单全留，文案不是「只按时效清」', () => {
  const p = planSessionGc({
    sessions: [sess({ updatedAtMs: now - 100 * H })],
    now, boardScanned: false, closedRefs: new Set(),
  });
  assert.equal(p.remove.length, 0);
  assert.match(p.detail, /本轮不删/);
  assert.doesNotMatch(p.detail, /时效清/);
});

test('引用的单全部关闭就删', () => {
  const j = judgeSession(sess({ record: { workdir: 'dao-1145' } }), {
    closedRefs: new Set(['1145']), boardScanned: true, now,
  });
  assert.equal(j.verdict, 'remove');
});

test('引用 OPEN 单但超保留窗口的历史会话也删', () => {
  const j = judgeSession(sess({ record: { workdir: 'dao-1122' } }), {
    closedRefs: new Set(['1145']), boardScanned: true, now,
  });
  assert.equal(j.verdict, 'remove');
});

test('保留窗口内有活动就留，哪怕单已关', () => {
  const j = judgeSession(sess({ updatedAtMs: now - 1 * H, record: { workdir: 'dao-1145' } }), {
    closedRefs: new Set(['1145']), boardScanned: true, now,
  });
  assert.equal(j.verdict, 'keep');
});

// #1175 审官第三条：时间戳读不出 = 「多老」这个事实没查成，跟「很老」不是一回事。
// 旧判据把它直接归 remove，一次 stat 抖动/半写记录就会在 --apply 里被归档——fail-open。
test('时间戳读不出 → 保留并标 unknown，绝不当坏记录删', () => {
  const j = judgeSession(sess({ updatedAtMs: NaN }), { closedRefs: new Set(), boardScanned: true, now });
  assert.equal(j.verdict, 'keep');
  assert.equal(j.unknown, true);
  assert.match(j.why, /没查成/);
});

test('时间戳读不出时，即使盘面也扫成了，也不进 remove 名单', () => {
  const p = planSessionGc({ sessions: [sess({ id: 'broken', updatedAtMs: NaN })], now, boardScanned: true, closedRefs: new Set() });
  assert.deepEqual(p.remove, []);
  assert.equal(p.keep.some((k) => k.id === 'broken'), true, '坏记录要出现在保留名单里，不能凭空消失');
});

test('时间戳读不出与「旧但正常」分得开：后者照删', () => {
  const p = planSessionGc({
    sessions: [sess({ id: 'old', updatedAtMs: now - 100 * H }), sess({ id: 'broken', updatedAtMs: NaN })],
    now, boardScanned: true, closedRefs: new Set(),
  });
  assert.deepEqual(p.remove.map((r) => r.id), ['old']);
});

test('扫完 0 个报 unknown，不当成「没有会话」', () => {
  const p = planSessionGc({ sessions: [], now });
  assert.equal(p.state, 'unknown');
});

test('清单不是数组也报 unknown', () => {
  const p = planSessionGc({ sessions: undefined, now });
  assert.equal(p.state, 'unknown');
});

test('planSessionGc 汇总删的条数', () => {
  const p = planSessionGc({
    sessions: [
      sess({ record: { workdir: 'dao-1145' } }),
      sess({ alive: true }),
      sess({ updatedAtMs: now - 1 * H }),
      sess({ record: { workdir: 'dao-999' } }),
    ],
    closedRefs: new Set(['1145', '999']),
    boardScanned: true,
    now,
  });
  assert.equal(p.remove.length, 2);
});

test('planSessionGc 汇总留的条数', () => {
  const p = planSessionGc({
    sessions: [
      sess({ record: { workdir: 'dao-1145' } }),
      sess({ alive: true }),
      sess({ updatedAtMs: now - 1 * H }),
      sess({ record: { workdir: 'dao-999' } }),
    ],
    closedRefs: new Set(['1145', '999']),
    boardScanned: true,
    now,
  });
  assert.equal(p.keep.length, 2);
});

test('planOrphanGc 删超时效的临时目录', () => {
  const p = planOrphanGc({
    entries: [
      { path: '/a', mtimeMs: now - 30 * H },
      { path: '/b', mtimeMs: now - 1 * H },
    ],
    now,
    procsScanned: true,
  });
  assert.deepEqual(p.remove.map((e) => e.path), ['/a']);
});

test('planOrphanGc 时间读不出的目录宁可留着', () => {
  const p = planOrphanGc({ entries: [{ path: '/c', mtimeMs: NaN }], now, procsScanned: true });
  assert.equal(p.remove.length, 0);
});

test('planOrphanGc 清单不是数组报 unknown', () => {
  const p = planOrphanGc({ entries: null, now });
  assert.equal(p.state, 'unknown');
});

test('planOrphanGc 进程面没查成 → 超时效也不删（fail-closed）', () => {
  const p = planOrphanGc({
    entries: [{ path: '/a', mtimeMs: now - 30 * H }],
    now,
  });
  assert.equal(p.state, 'unknown');
  assert.equal(p.remove.length, 0);
  assert.match(p.detail, /进程面没查成/);
});

test('planOrphanGc 有进程正在用 → 超时效也不删', () => {
  const p = planOrphanGc({
    entries: [{ path: '/a', mtimeMs: now - 30 * H, inUse: true }],
    now,
    procsScanned: true,
  });
  assert.equal(p.remove.length, 0);
  assert.equal(p.keep.length, 1);
  assert.match(p.keep[0].why, /正在用/);
});

test('markOrphanInUse：cwd 落在子目录里就标这条', () => {
  const r = markOrphanInUse(
    [{ path: '/tmp/x/git-old' }, { path: '/tmp/x/git-new' }],
    ['/tmp/x/git-new/objects', '/home/other'],
    '/tmp/x',
  );
  assert.equal(r.rootInUse, false);
  assert.equal(r.entries.find((e) => e.path === '/tmp/x/git-new').inUse, true);
  assert.equal(r.entries.find((e) => e.path === '/tmp/x/git-old').inUse, false);
});

test('markOrphanInUse：cwd 就在根上 → 整批都标占用', () => {
  const r = markOrphanInUse(
    [{ path: '/tmp/x/git-old' }, { path: '/tmp/x/git-new' }],
    ['/tmp/x'],
    '/tmp/x',
  );
  assert.equal(r.rootInUse, true);
  assert.equal(r.entries.every((e) => e.inUse), true);
});
