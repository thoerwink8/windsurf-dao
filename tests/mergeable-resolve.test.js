// #1017：list / 多字段 view 上 mergeable 恒 UNKNOWN。
// 门面 resolveMergeable：已知态直接用；UNKNOWN/空才单张重查。
// 不许把 UNKNOWN 当 MERGEABLE；重查仍 UNKNOWN 交上游 fail-close。
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const GIT = import('file://' + path.join(__dirname, '..', 'scripts', 'lib', 'dispatch', 'git.mjs').replace(/\\/g, '/'));

describe('resolveMergeable：列表 UNKNOWN 才单张重查', () => {
  it('① 列表 UNKNOWN、单张 MERGEABLE ⇒ MERGEABLE，且 refreshed', async () => {
    const { resolveMergeable, assessPrMergeable } = await GIT;
    const seen = [];
    const r = resolveMergeable(
      { number: 1013, mergeable: 'UNKNOWN' },
      { viewMergeable: (n) => { seen.push(n); return { ok: true, mergeable: 'MERGEABLE' }; } },
    );
    assert.deepEqual(seen, [1013]);
    assert.equal(r.mergeable, 'MERGEABLE');
    assert.equal(r.refreshed, true);
    assert.equal(assessPrMergeable(r.mergeable).ok, true);
  });

  it('② 列表 UNKNOWN、单张 CONFLICTING ⇒ CONFLICTING', async () => {
    const { resolveMergeable } = await GIT;
    const r = resolveMergeable(
      { number: 1010, mergeable: 'UNKNOWN' },
      { viewMergeable: () => ({ ok: true, mergeable: 'CONFLICTING' }) },
    );
    assert.equal(r.mergeable, 'CONFLICTING');
    assert.equal(r.refreshed, true);
  });

  it('③ 列表 UNKNOWN、单张也 UNKNOWN ⇒ 仍 UNKNOWN（没查成，不猜）', async () => {
    const { resolveMergeable, assessPrMergeable } = await GIT;
    const r = resolveMergeable(
      { number: 99, mergeable: 'UNKNOWN' },
      { viewMergeable: () => ({ ok: true, mergeable: 'UNKNOWN' }) },
    );
    assert.equal(r.mergeable, 'UNKNOWN');
    assert.equal(r.refreshed, true);
    const a = assessPrMergeable(r.mergeable);
    assert.equal(a.ok, false);
    assert.equal(a.unscanned, true);
  });

  it('④ 列表直接 MERGEABLE ⇒ 不发起单张重查', async () => {
    const { resolveMergeable } = await GIT;
    const seen = [];
    const r = resolveMergeable(
      { number: 42, mergeable: 'MERGEABLE' },
      { viewMergeable: (n) => { seen.push(n); return { ok: true, mergeable: 'CONFLICTING' }; } },
    );
    assert.deepEqual(seen, []);
    assert.equal(r.mergeable, 'MERGEABLE');
    assert.equal(r.refreshed, false);
  });

  it('列表直接 CONFLICTING ⇒ 也不重查', async () => {
    const { resolveMergeable } = await GIT;
    const seen = [];
    const r = resolveMergeable(
      { number: 7, mergeable: 'CONFLICTING' },
      { viewMergeable: (n) => { seen.push(n); return { ok: true, mergeable: 'MERGEABLE' }; } },
    );
    assert.deepEqual(seen, []);
    assert.equal(r.mergeable, 'CONFLICTING');
    assert.equal(r.refreshed, false);
  });

  it('空值也重查；没注入 viewMergeable 就停在列表值（不猜）', async () => {
    const { resolveMergeable } = await GIT;
    const seen = [];
    const r = resolveMergeable(
      { number: 1, mergeable: '' },
      { viewMergeable: (n) => { seen.push(n); return { ok: true, mergeable: 'MERGEABLE' }; } },
    );
    assert.deepEqual(seen, [1]);
    assert.equal(r.mergeable, 'MERGEABLE');

    const noView = resolveMergeable({ number: 2, mergeable: 'UNKNOWN' });
    assert.equal(noView.mergeable, 'UNKNOWN');
    assert.equal(noView.refreshed, false);
  });

  it('单张重查失败 ⇒ 不把 UNKNOWN 当 MERGEABLE，unscanned', async () => {
    const { resolveMergeable, assessPrMergeable } = await GIT;
    const r = resolveMergeable(
      { number: 3, mergeable: 'UNKNOWN' },
      { viewMergeable: () => ({ ok: false, error: 'gh 超时' }) },
    );
    assert.equal(r.mergeable, 'UNKNOWN');
    assert.equal(r.unscanned, true);
    assert.equal(assessPrMergeable(r.mergeable).ok, false);
  });

  it('fetchPrMergeable 只查 --json mergeable', async () => {
    const { fetchPrMergeable } = await GIT;
    const argv = [];
    const r = fetchPrMergeable((a) => {
      argv.push(a.slice());
      return { ok: true, out: JSON.stringify({ mergeable: 'CONFLICTING' }) };
    }, 1010);
    assert.equal(r.ok, true);
    assert.equal(r.mergeable, 'CONFLICTING');
    assert.deepEqual(argv, [['pr', 'view', '1010', '--json', 'mergeable']]);
  });
});
