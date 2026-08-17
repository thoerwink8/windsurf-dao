// #595 ③ orca 错误对象必须抽出真因，不得变成 [object Object]
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { orcaErrorText } = require('../scripts/lib/orca-error.mjs');

describe('orca-error', () => {
  it('#595 ③ orcaErrorText', async (t) => {
    const dirty = { code: 'dirty_worktree', files: ['ledger/events/x.json', 'scratchpad/a'] };
    const out = orcaErrorText(dirty);
    await t.test('无 message 的对象不含 [object Object]', () => {
      assert.ok(!String(out).includes('[object Object]'), '无 message 的对象不含 [object Object]  →  ' + out);
    });
    await t.test('无 message 时落到 code 或 JSON', () => {
      assert.ok(/dirty_worktree|ledger\/events/.test(out), '无 message 时落到 code 或 JSON  →  ' + out);
    });

    const both = { code: 'tab_not_found', message: 'terminal gone' };
    await t.test('有 message+code', () => {
      assert.ok(orcaErrorText(both).includes('terminal gone') && orcaErrorText(both).includes('tab_not_found'), '有 message+code  →  ' + orcaErrorText(both));
    });

    await t.test('纯字符串原样', () => {
      assert.ok(orcaErrorText('orca boom') === 'orca boom', '纯字符串原样');
    });
    await t.test('null 空串', () => {
      assert.ok(orcaErrorText(null) === '', 'null 空串');
    });
    await t.test('只 message', () => {
      assert.ok(orcaErrorText({ message: '只这一句' }) === '只这一句', '只 message');
    });

    const cyclic = { code: 'loop' };
    cyclic.self = cyclic;
    const cyc = orcaErrorText(cyclic);
    await t.test('循环引用也不出 [object Object]', () => {
      assert.ok(!String(cyc).includes('[object Object]'), '循环引用也不出 [object Object]  →  ' + cyc);
    });
  });
});