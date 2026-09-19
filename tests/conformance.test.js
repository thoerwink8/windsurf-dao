// T37 ③：跨仓符合性判据。喂样本，不联网、不起进程。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const MOD = import('file://' + path.resolve(__dirname, '..', 'scripts', 'lib', 'conformance.mjs').replace(/\\/g, '/'));

const repo = (over) => ({ fullName: 'o/r', must: ['convention-block'], exempt: [], ...over });
const sample = (over) => ({
  docText: `# 子仓\n\n<!-- dao-conventions: v1 sha256:abcdef12 -->\n`,
  docPath: 'AGENTS.md', docAbsent: false, docError: null,
  pin: { version: 1, sha256: 'abcdef12' }, pinAbsent: false, pinError: null,
  ...over,
});

test('判绿：块与 pin 对得上', async () => {
  const { judgeRepo } = await MOD;
  const r = judgeRepo({ repo: repo(), sample: sample() });
  assert.equal(r.state, 'green');
});

test('判红：戳被改旧（验收样本）/ 没 doc / 没块 / 没 pin', async () => {
  const { judgeRepo } = await MOD;
  const stale = judgeRepo({ repo: repo(), sample: sample({ docText: '# 子仓\n\n<!-- dao-conventions: v1 sha256:00000000 -->\n' }) });
  assert.equal(stale.state, 'red');
  assert.equal(stale.code, 'stale-stamp');

  const noDoc = judgeRepo({ repo: repo(), sample: sample({ docText: null, docAbsent: true }) });
  assert.equal(noDoc.state, 'red');
  assert.equal(noDoc.code, 'no-doc');

  // 有 doc 但没贴块 → 报 no-block（别指错地方说「没 pin」）
  const noBlock = judgeRepo({ repo: repo(), sample: sample({ docText: '# 子仓\n\n随便写点\n' }) });
  assert.equal(noBlock.state, 'red');
  assert.equal(noBlock.code, 'no-block');

  const noPin = judgeRepo({ repo: repo(), sample: sample({ pin: null, pinAbsent: true }) });
  assert.equal(noPin.state, 'red');
  assert.equal(noPin.code, 'no-pin');
});

test('「确定不存在」是红，「取不到」是没查成——两者不许混', async () => {
  const { judgeRepo } = await MOD;
  assert.equal(judgeRepo({ repo: repo(), sample: sample({ docAbsent: true, docText: null }) }).state, 'red');
  assert.equal(judgeRepo({ repo: repo(), sample: sample({ docText: null, docError: 'HTTP 500' }) }).state, 'unscanned');
  assert.equal(judgeRepo({ repo: repo(), sample: sample({ pinAbsent: true, pin: null }) }).state, 'red');
  assert.equal(judgeRepo({ repo: repo(), sample: sample({ pin: null, pinError: '超时' }) }).state, 'unscanned');
  assert.equal(judgeRepo({ repo: repo(), sample: null }).state, 'unscanned');
});

test('豁免带理由才算豁免；没理由的豁免照旧往下判', async () => {
  const { judgeRepo } = await MOD;
  const ok = judgeRepo({ repo: repo({ exempt: [{ item: 'convention-block', reason: '该仓没有 CI，走人读' }] }), sample: null });
  assert.equal(ok.state, 'green');
  assert.equal(ok.code, 'exempt');

  const noReason = judgeRepo({ repo: repo({ exempt: [{ item: 'convention-block', reason: '' }] }), sample: sample({ docAbsent: true, docText: null }) });
  assert.equal(noReason.state, 'red');
});

test('落后真相源版本 → 红（expectedVersion）', async () => {
  const { judgeRepo } = await MOD;
  const r = judgeRepo({ repo: repo(), sample: sample(), expectedVersion: 3 });
  assert.equal(r.state, 'red');
  assert.equal(r.code, 'version-behind');
});

test('整份报告：红 > 没查成 > 绿；清单空/读不到 = 没查成（不许当「没有子仓」）', async () => {
  const { judgeConformance } = await MOD;
  const okOne = judgeConformance({ repos: [repo()], samples: { 'o/r': sample() } });
  assert.equal(okOne.state, 'green');
  assert.deepEqual(okOne.counts, { green: 1, red: 0, unscanned: 0 });

  const mixed = judgeConformance({
    repos: [repo({ fullName: 'o/a' }), repo({ fullName: 'o/b' })],
    samples: { 'o/a': sample(), 'o/b': sample({ docAbsent: true, docText: null }) },
  });
  assert.equal(mixed.state, 'red');
  assert.match(mixed.why, /1\/2 符合/);

  const un = judgeConformance({ repos: [repo()], samples: {} });
  assert.equal(un.state, 'unscanned');

  assert.equal(judgeConformance({ repos: null, samples: {} }).state, 'unscanned');
  assert.equal(judgeConformance({ repos: [], samples: {} }).state, 'unscanned');
});
