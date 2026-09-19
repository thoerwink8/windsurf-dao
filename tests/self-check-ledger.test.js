// tests/self-check-ledger.test.js —— 自检账（dao-check 写、server-check ⑪ 读）的契约。
// 钉的是 2026-09-20 立的三条：一树一文件且 realpath 归一；写失败不抛；读三态（没账 / 格式不对 / 有账）。

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ledgerPathFor, readSelfCheckRecord, writeSelfCheckRecord } from '../scripts/lib/self-check-ledger.mjs';

test('self-check-ledger', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'scl-home-'));
  const root = mkdtempSync(join(tmpdir(), 'scl-root-'));
  t.after(() => { rmSync(home, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true }); });

  await t.test('一树一文件：同一棵树两条写法落同一份；不同树不同份', () => {
    const a = ledgerPathFor(root, home);
    const b = ledgerPathFor(join(root, '.', 'sub', '..'), home);
    assert.equal(a, b);
    assert.notEqual(a, ledgerPathFor(home, home));
    assert.match(a, /[\\/]\.dao[\\/]dao-check[\\/][0-9a-f]{12}\.json$/);
  });

  await t.test('没账 → probed:false，带路径与原因', () => {
    const r = readSelfCheckRecord(root, { home });
    assert.equal(r.probed, false);
    assert.match(r.reason, /还没跑过/);
    assert.equal(r.path, ledgerPathFor(root, home));
  });

  await t.test('写后可读：ts 由写方补，其余字段原样', () => {
    const w = writeSelfCheckRecord({ root, head: 'c'.repeat(40), code: 1, ms: 91000, red: 3, green: 200, skip: 5 }, { home });
    assert.equal(w.ok, true);
    const r = readSelfCheckRecord(root, { home });
    assert.equal(r.probed, true);
    assert.equal(r.record.head, 'c'.repeat(40));
    assert.equal(r.record.code, 1);
    assert.equal(r.record.red, 3);
    assert.match(r.record.ts, /^\d{4}-\d{2}-\d{2}T/);
  });

  await t.test('账不是 dao-check 的格式（没 head）→ probed:false，不当有账', () => {
    writeFileSync(ledgerPathFor(root, home), JSON.stringify({ code: 0 }));
    const r = readSelfCheckRecord(root, { home });
    assert.equal(r.probed, false);
    assert.match(r.reason, /head/);
  });

  await t.test('账是坏 JSON → probed:false', () => {
    writeFileSync(ledgerPathFor(root, home), '{not json');
    assert.equal(readSelfCheckRecord(root, { home }).probed, false);
  });

  await t.test('写不进去不抛：home 位置被一个文件占住', () => {
    const blocked = mkdtempSync(join(tmpdir(), 'scl-blocked-'));
    t.after(() => rmSync(blocked, { recursive: true, force: true }));
    writeFileSync(join(blocked, '.dao'), 'a file, not a dir');
    const w = writeSelfCheckRecord({ root, head: 'd'.repeat(40), code: 0, ms: 1 }, { home: blocked });
    assert.equal(w.ok, false);
    assert.ok(w.reason);
  });
});
