// dao-check 判红时的证据栏要带断言正文，不能只剩测试名（来历见 scripts/lib/tap-failures.mjs 头部）。
const test = require('node:test');
const assert = require('node:assert/strict');

const LOAD = import('../scripts/lib/tap-failures.mjs');

// node 22 `--test-reporter=tap` 的真实形态：子测试缩进 4 格，YAML 块比 not ok 再深 2 格
const TAP = [
  'TAP version 13',
  '# Subtest: dao-mode',
  '    # Subtest: 专注注入带焦点原文',
  '    not ok 1 - 专注注入带焦点原文',
  '      ---',
  "      duration_ms: 3.1",
  "      location: '/srv/x/tests/dao-mode.test.js:120:5'",
  "      failureType: 'testCodeFailure'",
  '      error: |-',
  '        ENOENT: no such file or directory, open \'/srv/x/_tmp/mode-sandbox/state.json\'',
  "      code: 'ENOENT'",
  "      stack: |-",
  '        at Object.openSync (node:fs:573:18)',
  '      ...',
  '    ok 2 - 这条名字里带 fail 字样但其实过了',
  '    not ok 3 - 退出码四态',
  '      ---',
  '      duration_ms: 0.4',
  '      error: |-',
  '        Expected values to be strictly equal:',
  '        ',
  '        2 !== 0',
  "      code: 'ERR_ASSERTION'",
  '      ...',
  'not ok 1 - dao-mode',
  '  ---',
  '  duration_ms: 90',
  "  error: '2 subtests failed'",
  '  ...',
  '# tests 3',
  '# fail 2',
].join('\n');

test('每条红带上 error / code，不带 duration / location / stack', async () => {
  const { extractTapFailures } = await LOAD;
  const fails = extractTapFailures(TAP);
  assert.equal(fails.length, 3, JSON.stringify(fails.map(f => f.name)));
  assert.equal(fails[0].name, '专注注入带焦点原文');
  assert.deepEqual(fails[0].body, [
    'error: |-',
    "ENOENT: no such file or directory, open '/srv/x/_tmp/mode-sandbox/state.json'",
    "code: 'ENOENT'",
  ]);
  assert.deepEqual(fails[1].body, ['error: |-', 'Expected values to be strictly equal:', '2 !== 0', "code: 'ERR_ASSERTION'"]);
  assert.deepEqual(fails[2].body, ["error: '2 subtests failed'"]);
});

test('名字里带 fail 字样的 ok 行不算红（#566）', async () => {
  const { extractTapFailures } = await LOAD;
  const names = extractTapFailures(TAP).map(f => f.name);
  assert.equal(names.includes('这条名字里带 fail 字样但其实过了'), false);
});

test('退出非 0 却没有 not ok 行 → null，证据栏说「没查成」而不是编一条', async () => {
  const { extractTapFailures, tapFailuresEvidence } = await LOAD;
  assert.equal(extractTapFailures('node:internal/modules/cjs/loader:1228\n  throw err;\nError: Cannot find module'), null);
  assert.match(tapFailuresEvidence('boom'), /没查成/);
});

test('证据栏：名字一行、现场缩进跟在后面，人一眼看到断言差在哪', async () => {
  const { tapFailuresEvidence } = await LOAD;
  const text = tapFailuresEvidence(TAP);
  assert.match(text, /^测试输出 3 条红：/);
  assert.match(text, /退出码四态\n    error: \|-\n    Expected values to be strictly equal:\n    2 !== 0/);
});

test('现场最多 BODY_LINES_MAX 行——再多是刷屏', async () => {
  const { extractTapFailures, BODY_LINES_MAX } = await LOAD;
  const long = ['not ok 1 - x', '  ---', '  error: |-', ...Array.from({ length: 40 }, (_, i) => `    line ${i}`), '  ...'].join('\n');
  assert.equal(extractTapFailures(long)[0].body.length, BODY_LINES_MAX);
});
