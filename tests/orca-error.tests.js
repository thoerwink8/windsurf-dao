// #595 ③ orca 错误对象必须抽出真因，不得变成 [object Object]
const { orcaErrorText } = require('../scripts/lib/orca-error.mjs');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? '  →  ' + detail : ''}`); }
}

console.log('\n=== #595 ③ orcaErrorText ===');
{
  const dirty = { code: 'dirty_worktree', files: ['ledger/events/x.json', 'scratchpad/a'] };
  const out = orcaErrorText(dirty);
  check('无 message 的对象不含 [object Object]', !String(out).includes('[object Object]'), out);
  check('无 message 时落到 code 或 JSON', /dirty_worktree|ledger\/events/.test(out), out);

  const both = { code: 'tab_not_found', message: 'terminal gone' };
  check('有 message+code', orcaErrorText(both).includes('terminal gone') && orcaErrorText(both).includes('tab_not_found'), orcaErrorText(both));

  check('纯字符串原样', orcaErrorText('orca boom') === 'orca boom');
  check('null 空串', orcaErrorText(null) === '');
  check('只 message', orcaErrorText({ message: '只这一句' }) === '只这一句');

  const cyclic = { code: 'loop' };
  cyclic.self = cyclic;
  const cyc = orcaErrorText(cyclic);
  check('循环引用也不出 [object Object]', !String(cyc).includes('[object Object]'), cyc);
}

console.log(`\n${fail === 0 ? 'OK' : 'FAIL'}  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
