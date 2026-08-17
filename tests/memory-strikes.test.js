// #588 strikes 机械闸：基准后 ≥2 且无闸必须红；存量豁免不长红；0 样本 ≠ 绿。
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const LIB = path.join(__dirname, '..', 'scripts', 'lib', 'memory-strikes-check.mjs');
const FIX = path.join(__dirname, 'fixtures', 'memory-strikes');
const LIB_LOAD = import('file://' + LIB.replace(/\\/g, '/'));

function mem({ name, strikes, gate, modified, extra = '' }) {
  const g = gate === undefined ? '' : `  gate: ${gate}\n`;
  const s = strikes === undefined ? '' : `  strikes: ${strikes}\n`;
  const m = modified ? `  modified: ${modified}\n` : '';
  return {
    name,
    text: `---\nname: ${name.replace(/\.md$/, '')}\nmetadata:\n  node_type: memory\n${s}${g}${m}---\n${extra}\n`,
  };
}

describe('memory-strikes', () => {
  it('frontmatter 自己拆，不靠 yaml-min', async (t) => {
    const S = await LIB_LOAD;
    const p = S.parseMemoryFrontmatter(mem({ name: 'a.md', strikes: 9, gate: 'null' }).text);
    await t.test('抽得出 metadata.strikes', () => {
      assert.ok(p.ok && p.fields['metadata.strikes'] === '9', '抽得出 metadata.strikes  →  ' + JSON.stringify(p.fields));
    });
    const f = S.readStrikesFields(p.fields);
    await t.test('gate: null 当成空', () => {
      assert.ok(f.ok && f.strikes === 9 && f.gate === null && f.hasGateKey, 'gate: null 当成空  →  ' + JSON.stringify(f));
    });
  });

  it('基准后：≥2 无闸红 / 有闸绿 / 缺字段红', async (t) => {
    const S = await LIB_LOAD;
    const baseline = { names: ['legacy.md'], at: '2026-08-17T12:00:00.000Z' };
    const red = S.inspectStrikes({
      entries: [mem({ name: 'new-ungated.md', strikes: 2, gate: 'null' })],
      baselineNames: baseline.names,
      baselineAt: baseline.at,
    });
    await t.test('新条目 strikes=2 gate 空 → 红', () => {
      assert.ok(red.kind === 'red' && /new-ungated/.test(red.line), '新条目 strikes=2 gate 空 → 红  →  ' + red.line);
    });

    const ok = S.inspectStrikes({
      entries: [mem({ name: 'new-gated.md', strikes: 9, gate: 'scripts/lib/board-hook.mjs' })],
      baselineNames: baseline.names,
      baselineAt: baseline.at,
    });
    await t.test('新条目有闸 → 绿', () => {
      assert.ok(ok.kind === 'ok', '新条目有闸 → 绿  →  ' + ok.line);
    });

    const miss = S.inspectStrikes({
      entries: [mem({ name: 'new-bare.md' })],
      baselineNames: baseline.names,
      baselineAt: baseline.at,
    });
    await t.test('新条目缺字段 → 红', () => {
      assert.ok(miss.kind === 'red' && miss.line.includes('缺 strikes/gate'), '新条目缺字段 → 红  →  ' + miss.line);
    });
  });

  it('存量豁免：≥2 无闸是 note 不是红', async (t) => {
    const S = await LIB_LOAD;
    const r = S.inspectStrikes({
      entries: [mem({ name: 'legacy.md', strikes: 9, gate: 'null', modified: '2026-08-17T05:00:00.000Z' })],
      baselineNames: ['legacy.md'],
      baselineAt: '2026-08-17T23:59:59.000Z',
    });
    await t.test('存量无闸不红', () => {
      assert.ok(r.kind === 'ok', '存量无闸不红  →  ' + r.line);
    });
    await t.test('存量进待补闸名单', () => {
      assert.ok(r.notes.some(n => /legacy/.test(n)), '存量进待补闸名单  →  ' + JSON.stringify(r.notes));
    });
  });

  it('存量被更新（modified 晚于基准）→ 纳入', async (t) => {
    const S = await LIB_LOAD;
    const r = S.inspectStrikes({
      entries: [mem({ name: 'legacy.md', strikes: 3, gate: 'null', modified: '2026-08-18T00:00:01.000Z' })],
      baselineNames: ['legacy.md'],
      baselineAt: '2026-08-17T23:59:59.000Z',
    });
    await t.test('更新后无闸变红', () => {
      assert.ok(r.kind === 'red' && /legacy/.test(r.line), '更新后无闸变红  →  ' + r.line);
    });
  });

  it('红 3：基准不得晚于上线提交，当天午后更新必须纳入', async (t) => {
    const S = await LIB_LOAD;
    const live = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'scripts', 'lib', 'memory-strikes-baseline.json'), 'utf8'));
    await t.test('live baselineAt 不晚于 #590 提交 07:19:21Z', () => {
      assert.ok(live.baselineAt <= '2026-08-17T07:19:21.000Z', 'live baselineAt 不晚于 #590 提交 07:19:21Z  →  ' + live.baselineAt);
    });
    const r = S.inspectStrikes({
      entries: [mem({ name: 'legacy.md', strikes: 3, gate: 'null', modified: '2026-08-17T12:00:00.000Z' })],
      baselineNames: ['legacy.md'],
      baselineAt: live.baselineAt,
    });
    await t.test('上线后、旧 23:59 窗口内的更新 → 红（不再豁免）', () => {
      assert.ok(r.kind === 'red', '上线后、旧 23:59 窗口内的更新 → 红（不再豁免）  →  ' + r.line);
    });
  });

  it('0 样本与没查成不同形', async (t) => {
    const S = await LIB_LOAD;
    const empty = S.inspectStrikes({ entries: [] });
    await t.test('0 条 → unscanned 不是 ok', () => {
      assert.ok(empty.kind === 'unscanned' && /没查成/.test(empty.line), '0 条 → unscanned 不是 ok  →  ' + empty.line);
    });
    const noArr = S.inspectStrikes({});
    await t.test('没给数组 → unscanned', () => {
      assert.ok(noArr.kind === 'unscanned', '没给数组 → unscanned  →  ' + noArr.line);
    });
    const bad = S.inspectStrikes({ entries: [{ name: 'x.md', text: 'no fence' }] });
    await t.test('坏 frontmatter → unscanned', () => {
      assert.ok(bad.kind === 'unscanned', '坏 frontmatter → unscanned  →  ' + bad.line);
    });
  });

  it('夹具目录：红/绿两套都要有判别力', async (t) => {
    const S = await LIB_LOAD;
    const redDir = path.join(FIX, 'red');
    const okDir = path.join(FIX, 'ok');
    await t.test('红夹具目录在', () => {
      assert.ok(fs.existsSync(redDir), '红夹具目录在  →  ' + redDir);
    });
    await t.test('绿夹具目录在', () => {
      assert.ok(fs.existsSync(okDir), '绿夹具目录在  →  ' + okDir);
    });
    const redList = S.listMemoryEntries(redDir);
    const okList = S.listMemoryEntries(okDir);
    const redBase = JSON.parse(fs.readFileSync(path.join(redDir, 'baseline.json'), 'utf8'));
    const okBase = JSON.parse(fs.readFileSync(path.join(okDir, 'baseline.json'), 'utf8'));
    const redR = S.inspectStrikes({
      entries: redList.entries, baselineNames: redBase.files, baselineAt: redBase.baselineAt,
    });
    const okR = S.inspectStrikes({
      entries: okList.entries, baselineNames: okBase.files, baselineAt: okBase.baselineAt,
    });
    await t.test('红夹具必须红（否则检查器没判别力）', () => {
      assert.ok(redR.kind === 'red', '红夹具必须红（否则检查器没判别力）  →  ' + redR.line);
    });
    await t.test('绿夹具必须绿（否则检查器恒红）', () => {
      assert.ok(okR.kind === 'ok', '绿夹具必须绿（否则检查器恒红）  →  ' + okR.line);
    });
  });

  it('目录扫描：跳过 MEMORY.md / README.md；空目录没查成', async (t) => {
    const S = await LIB_LOAD;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'strikes-'));
    fs.writeFileSync(path.join(tmp, 'MEMORY.md'), '# idx\n');
    fs.writeFileSync(path.join(tmp, 'README.md'), 'x\n');
    const skipOnly = S.listMemoryEntries(tmp);
    await t.test('只剩索引文件 → 0 条 entries（调用方当没扫到）', () => {
      assert.ok(skipOnly.unscanned === false && skipOnly.entries.length === 0, '只剩索引文件 → 0 条 entries（调用方当没扫到）  →  ' + JSON.stringify(skipOnly));
    });
    const missing = S.listMemoryEntries(path.join(tmp, 'no-such'));
    await t.test('目录不在 → unscanned', () => {
      assert.ok(missing.unscanned === true, '目录不在 → unscanned  →  ' + missing.error);
    });
  });
});