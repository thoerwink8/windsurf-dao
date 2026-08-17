// #588 strikes 机械闸：基准后 ≥2 且无闸必须红；存量豁免不长红；0 样本 ≠ 绿。
const fs = require('fs');
const path = require('path');
const os = require('os');

const LIB = path.join(__dirname, '..', 'scripts', 'lib', 'memory-strikes-check.mjs');
const FIX = path.join(__dirname, 'fixtures', 'memory-strikes');

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? '  →  ' + detail : ''}`); }
}

function mem({ name, strikes, gate, modified, extra = '' }) {
  const g = gate === undefined ? '' : `  gate: ${gate}\n`;
  const s = strikes === undefined ? '' : `  strikes: ${strikes}\n`;
  const m = modified ? `  modified: ${modified}\n` : '';
  return {
    name,
    text: `---\nname: ${name.replace(/\\.md$/, '')}\nmetadata:\n  node_type: memory\n${s}${g}${m}---\n${extra}\n`,
  };
}

async function main() {
  const S = await import('file://' + LIB.replace(/\\/g, '/'));

  console.log('\n=== frontmatter 自己拆，不靠 yaml-min ===');
  {
    const p = S.parseMemoryFrontmatter(mem({ name: 'a.md', strikes: 9, gate: 'null' }).text);
    check('抽得出 metadata.strikes', p.ok && p.fields['metadata.strikes'] === '9', JSON.stringify(p.fields));
    const f = S.readStrikesFields(p.fields);
    check('gate: null 当成空', f.ok && f.strikes === 9 && f.gate === null && f.hasGateKey, JSON.stringify(f));
  }

  console.log('\n=== 基准后：≥2 无闸红 / 有闸绿 / 缺字段红 ===');
  {
    const baseline = { names: ['legacy.md'], at: '2026-08-17T12:00:00.000Z' };
    const red = S.inspectStrikes({
      entries: [mem({ name: 'new-ungated.md', strikes: 2, gate: 'null' })],
      baselineNames: baseline.names,
      baselineAt: baseline.at,
    });
    check('新条目 strikes=2 gate 空 → 红', red.kind === 'red' && /new-ungated/.test(red.line), red.line);

    const ok = S.inspectStrikes({
      entries: [mem({ name: 'new-gated.md', strikes: 9, gate: 'scripts/lib/board-hook.mjs' })],
      baselineNames: baseline.names,
      baselineAt: baseline.at,
    });
    check('新条目有闸 → 绿', ok.kind === 'ok', ok.line);

    const miss = S.inspectStrikes({
      entries: [mem({ name: 'new-bare.md' })],
      baselineNames: baseline.names,
      baselineAt: baseline.at,
    });
    check('新条目缺字段 → 红', miss.kind === 'red' && miss.line.includes('缺 strikes/gate'), miss.line);
  }

  console.log('\n=== 存量豁免：≥2 无闸是 note 不是红 ===');
  {
    const r = S.inspectStrikes({
      entries: [mem({ name: 'legacy.md', strikes: 9, gate: 'null', modified: '2026-08-17T05:00:00.000Z' })],
      baselineNames: ['legacy.md'],
      baselineAt: '2026-08-17T23:59:59.000Z',
    });
    check('存量无闸不红', r.kind === 'ok', r.line);
    check('存量进待补闸名单', r.notes.some(n => /legacy/.test(n)), JSON.stringify(r.notes));
  }

  console.log('\n=== 存量被更新（modified 晚于基准）→ 纳入 ===');
  {
    const r = S.inspectStrikes({
      entries: [mem({ name: 'legacy.md', strikes: 3, gate: 'null', modified: '2026-08-18T00:00:01.000Z' })],
      baselineNames: ['legacy.md'],
      baselineAt: '2026-08-17T23:59:59.000Z',
    });
    check('更新后无闸变红', r.kind === 'red' && /legacy/.test(r.line), r.line);
  }

  console.log('\n=== 红 3：基准不得晚于上线提交，当天午后更新必须纳入 ===');
  {
    const live = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'scripts', 'lib', 'memory-strikes-baseline.json'), 'utf8'));
    check('live baselineAt 不晚于 #590 提交 07:19:21Z', live.baselineAt <= '2026-08-17T07:19:21.000Z', live.baselineAt);
    const r = S.inspectStrikes({
      entries: [mem({ name: 'legacy.md', strikes: 3, gate: 'null', modified: '2026-08-17T12:00:00.000Z' })],
      baselineNames: ['legacy.md'],
      baselineAt: live.baselineAt,
    });
    check('上线后、旧 23:59 窗口内的更新 → 红（不再豁免）', r.kind === 'red', r.line);
  }

  console.log('\n=== 0 样本与没查成不同形 ===');
  {
    const empty = S.inspectStrikes({ entries: [] });
    check('0 条 → unscanned 不是 ok', empty.kind === 'unscanned' && /没查成/.test(empty.line), empty.line);
    const noArr = S.inspectStrikes({});
    check('没给数组 → unscanned', noArr.kind === 'unscanned', noArr.line);
    const bad = S.inspectStrikes({ entries: [{ name: 'x.md', text: 'no fence' }] });
    check('坏 frontmatter → unscanned', bad.kind === 'unscanned', bad.line);
  }

  console.log('\n=== 夹具目录：红/绿两套都要有判别力 ===');
  {
    const redDir = path.join(FIX, 'red');
    const okDir = path.join(FIX, 'ok');
    check('红夹具目录在', fs.existsSync(redDir), redDir);
    check('绿夹具目录在', fs.existsSync(okDir), okDir);
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
    check('红夹具必须红（否则检查器没判别力）', redR.kind === 'red', redR.line);
    check('绿夹具必须绿（否则检查器恒红）', okR.kind === 'ok', okR.line);
  }

  console.log('\n=== 目录扫描：跳过 MEMORY.md / README.md；空目录没查成 ===');
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'strikes-'));
    fs.writeFileSync(path.join(tmp, 'MEMORY.md'), '# idx\n');
    fs.writeFileSync(path.join(tmp, 'README.md'), 'x\n');
    const skipOnly = S.listMemoryEntries(tmp);
    check('只剩索引文件 → 0 条 entries（调用方当没扫到）', skipOnly.unscanned === false && skipOnly.entries.length === 0, JSON.stringify(skipOnly));
    const missing = S.listMemoryEntries(path.join(tmp, 'no-such'));
    check('目录不在 → unscanned', missing.unscanned === true, missing.error);
  }

  console.log(`\n${fail === 0 ? 'OK' : 'FAIL'}  ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
