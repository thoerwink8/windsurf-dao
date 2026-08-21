// ledger 本机化：默认落点 ~/.dao/ledger/events（不进 git）+ 仓内历史种子（幂等，同名跳过）
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const LIB = path.join(__dirname, '..', 'scripts', 'lib', 'ledger-home.mjs');
const LIB_LOAD = import('file://' + LIB.replace(/\\/g, '/'));

describe('ledger-home', () => {
  it('默认落点是 <home>/.dao/ledger/events，LEDGER_EVENTS_DIR 可覆盖', async (t) => {
    const S = await LIB_LOAD;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lh-home-'));
    const r = S.defaultLedgerDir({ home, env: {} });
    await t.test('默认路径拼对', () => {
      assert.ok(r.dir === path.join(home, '.dao', 'ledger', 'events') && !r.overridden, '默认路径拼对  →  ' + r.dir);
    });
    const o = S.defaultLedgerDir({ home, env: { LEDGER_EVENTS_DIR: path.join(home, 'elsewhere') } });
    await t.test('LEDGER_EVENTS_DIR 覆盖', () => {
      assert.ok(o.overridden && path.resolve(o.dir) === path.resolve(path.join(home, 'elsewhere')), 'LEDGER_EVENTS_DIR 覆盖  →  ' + o.dir);
    });
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('种子：拷缺失、跳过同名、再跑幂等；覆盖目录不播种子', async (t) => {
    const S = await LIB_LOAD;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lh-root-'));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lh-home-'));
    const src = path.join(root, 'ledger', 'events');
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(src, 'a.json'), '{"event_id":"a"}');
    fs.writeFileSync(path.join(src, 'b.json'), '{"event_id":"b"}');
    fs.writeFileSync(path.join(src, 'note.txt'), 'not an event');

    const first = S.ensureLocalLedger({ root, home, env: {} });
    await t.test('第一次种子 2 个 json', () => {
      assert.ok(first.seeded === 2 && first.sourceFound, '第一次种子 2 个 json  →  ' + JSON.stringify(first));
    });
    const second = S.ensureLocalLedger({ root, home, env: {} });
    await t.test('第二次 0 种子 2 跳过（幂等）', () => {
      assert.ok(second.seeded === 0 && second.skipped === 2, '幂等  →  ' + JSON.stringify(second));
    });
    await t.test('非 json 不拷', () => {
      assert.ok(!fs.existsSync(path.join(first.dir, 'note.txt')), '非 json 不拷');
    });
    const elsewhere = path.join(home, 'ovr');
    const third = S.ensureLocalLedger({ root, home, env: { LEDGER_EVENTS_DIR: elsewhere } });
    await t.test('LEDGER_EVENTS_DIR 覆盖时不播种子', () => {
      assert.ok(third.overridden && third.seeded === 0 && fs.existsSync(elsewhere) && fs.readdirSync(elsewhere).length === 0, '覆盖时不播种子  →  ' + JSON.stringify(third));
    });
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('仓内没有 ledger/events = 没种子可播，不是错', async (t) => {
    const S = await LIB_LOAD;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lh-root-'));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lh-home-'));
    const r = S.ensureLocalLedger({ root, home, env: {} });
    await t.test('sourceFound=false 且目录照建', () => {
      assert.ok(!r.sourceFound && r.seeded === 0 && fs.existsSync(r.dir), '没种子可播  →  ' + JSON.stringify(r));
    });
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });
});
