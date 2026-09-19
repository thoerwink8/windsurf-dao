// T37：约定脊柱的纯判据 + 子仓检查器三态。喂样本、起临时目录，不联网。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const CORE_MOD = import('file://' + path.join(ROOT, 'host', 'conventions', 'kit', 'conventions-core.mjs').replace(/\\/g, '/'));
const KIT = path.join(ROOT, 'host', 'conventions', 'kit', 'check-conventions.mjs');

const block = (version, sha) => `<!-- dao-conventions: v${version} sha256:${sha} -->`;

test('版本戳：换行风格不影响；戳行自己不参与；改内容就变', async () => {
  const { coreStamp } = await CORE_MOD;
  const lf = '# 标题\n\n正文\n' + block(1, 'a'.repeat(8));
  const crlf = lf.replace(/\n/g, '\r\n');
  assert.equal(coreStamp(lf).sha256, coreStamp(crlf).sha256);
  assert.equal(coreStamp(lf).sha256, coreStamp('# 标题\n\n正文\n' + block(1, 'b'.repeat(8))).sha256);
  assert.notEqual(coreStamp(lf).sha256, coreStamp('# 标题\n\n改过的正文\n' + block(1, 'a'.repeat(8))).sha256);
});

test('数不可协商层：只认 `## C<数字>` 标题', async () => {
  const { countCoreRules } = await CORE_MOD;
  assert.equal(countCoreRules('## C1 a\n## C2 b\n### C3 不算\nC4 也不算\n'), 2);
  assert.equal(countCoreRules(''), 0);
});

test('解析约定块：有戳认得出，没戳就是没有', async () => {
  const { parseConventionBlock } = await CORE_MOD;
  assert.deepEqual(parseConventionBlock(block(3, 'deadbeef')), { found: true, version: 3, sha256: 'deadbeef' });
  assert.equal(parseConventionBlock('没有任何块').found, false);
  assert.equal(parseConventionBlock('<!-- dao-conventions: v3 -->').found, false);
});

test('解析豁免段：`- C1: 理由`；没理由的原样留下等判红', async () => {
  const { parseExemptions } = await CORE_MOD;
  const r = parseExemptions('## 豁免\n\n- C7: 本仓没有墙钟闸，不适用\n- C1\n\n## 下一节\n- C2: 不该被收进来\n');
  assert.deepEqual(r.entries, [{ rule: 'C7', reason: '本仓没有墙钟闸，不适用' }]);
  assert.deepEqual(r.withoutReason, [{ rule: 'C1', reason: '' }]);
  assert.deepEqual(parseExemptions('没有豁免段').entries, []);
});

test('判符合性：没有块=红；没 pin=没查成（不许折算成绿）', async () => {
  const { judgeConventions, parseConventionBlock } = await CORE_MOD;
  const noBlock = judgeConventions({ block: parseConventionBlock('随便'), pin: { version: 1, sha256: 'x' } });
  assert.equal(noBlock.state, 'red');
  assert.equal(noBlock.code, 'no-block');

  const noPin = judgeConventions({ block: parseConventionBlock(block(1, 'abc12345')), pin: null });
  assert.equal(noPin.state, 'unscanned');
  assert.equal(noPin.code, 'no-pin');
});

test('判符合性：**故意把戳改旧必须红**（验收样本）', async () => {
  const { judgeConventions, parseConventionBlock } = await CORE_MOD;
  const r = judgeConventions({
    block: parseConventionBlock(block(1, '11111111')),
    pin: { version: 1, sha256: '22222222' },
    exemptions: { entries: [], withoutReason: [] },
  });
  assert.equal(r.state, 'red');
  assert.equal(r.code, 'stale-stamp');
});

test('判符合性：版本不符 / 落后真相源 / 豁免没理由 都红；全对才绿', async () => {
  const { judgeConventions, parseConventionBlock } = await CORE_MOD;
  const ok = { entries: [], withoutReason: [] };
  const b = parseConventionBlock(block(1, 'abababab'));
  assert.equal(judgeConventions({ block: b, pin: { version: 2, sha256: 'abababab' }, exemptions: ok }).code, 'version-mismatch');
  assert.equal(judgeConventions({ block: b, pin: { version: 1, sha256: 'abababab' }, exemptions: ok, expectedVersion: 3 }).code, 'version-behind');
  assert.equal(judgeConventions({
    block: b, pin: { version: 1, sha256: 'abababab' },
    exemptions: { entries: [{ rule: 'C7', reason: '不适用' }], withoutReason: [{ rule: 'C1', reason: '' }] },
  }).code, 'exemption-without-reason');
  assert.equal(judgeConventions({ block: b, pin: { version: 1, sha256: 'abababab' }, exemptions: ok }).state, 'green');
});

test('真相源自检：core.md 条数在上限内，且版本戳与内容对得上', async () => {
  const { coreStamp, countCoreRules, CORE_RULE_LIMIT } = await CORE_MOD;
  const text = fs.readFileSync(path.join(ROOT, 'host', 'conventions', 'core.md'), 'utf8');
  const pin = JSON.parse(fs.readFileSync(path.join(ROOT, 'host', 'conventions', 'conventions.json'), 'utf8'));
  assert.equal(countCoreRules(text) <= CORE_RULE_LIMIT, true, '不可协商层超上限——进这层要举证');
  assert.equal(countCoreRules(text), 7);
  assert.equal(coreStamp(text).sha256, pin.sha256, '改了 core.md 没重算版本戳——跑 stamp.mjs --write');
});

test('子仓检查器：绿 0 / 红 1 / 没查成 2——三态在退出码上分得开', () => {
  const run = (dir) => spawnSync(process.execPath, [KIT, '--repo', dir, '--json'], { encoding: 'utf8' }).status;
  const mk = (name, { pin, blockLine }) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `conv-${name}-`));
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), `# 子仓\n\n${blockLine}\n`);
    if (pin) { fs.mkdirSync(path.join(dir, '.dao')); fs.writeFileSync(path.join(dir, '.dao', 'conventions.json'), JSON.stringify(pin)); }
    return dir;
  };

  const good = mk('good', { pin: { version: 1, sha256: 'abcdef12' }, blockLine: block(1, 'abcdef12') });
  assert.equal(run(good), 0);

  const stale = mk('stale', { pin: { version: 1, sha256: 'abcdef12' }, blockLine: block(1, '00000000') });
  assert.equal(run(stale), 1, '戳被改旧必须红');

  const noPin = mk('nopin', { pin: null, blockLine: block(1, 'abcdef12') });
  assert.equal(run(noPin), 2, '取不到 pin 是没查成，不许当绿也不许当红');

  const noBlock = mk('noblock', { pin: { version: 1, sha256: 'abcdef12' }, blockLine: '（没接约定脊柱）' });
  assert.equal(run(noBlock), 1);
});
