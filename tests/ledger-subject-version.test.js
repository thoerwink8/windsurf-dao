// #1217：账本按 <主体>@<版本> 攒多条时，消费侧不许按主体取插入序第一条。
// 消费点二选一，不许 find 取最老：取最新（要比「最新一条」），或字典直查当前键（问的是「这一格」）。
// 本文件锁两件事：生产脚本不再出现 Object.keys(...).find 取键；
// 仅有的 Object.keys(...)[0] 必须是「恰好 1 个 key」且旁注 #1217。
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const SKIP_DIR = new Set(['node_modules', '.git', 'tests', 'coverage']);

function walk(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch (e) { throw new Error(`扫 ${dir} 失败（没查成，不是零命中）：${e.code || e.message}`); }
  for (const e of entries) {
    if (SKIP_DIR.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(js|mjs|cjs)$/.test(e.name)) out.push(p);
  }
  return out;
}

function lineHits(files, re) {
  const found = [];
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    const rel = path.relative(REPO, f).replace(/\\/g, '/');
    text.split(/\n/).forEach((line, i) => {
      if (re.test(line)) found.push({ rel, line: i + 1, text: line.trim() });
    });
  }
  return found;
}

describe('#1217 账本按主体@版本攒多条：取记录不许 find 最老', () => {
  const files = walk(path.join(REPO, 'scripts')).concat(walk(path.join(REPO, 'host')));

  it('生产脚本没有 Object.keys(...).find', () => {
    const found = lineHits(files, /Object\.keys\([^)]+\)\.find\s*\(/);
    assert.deepEqual(found, [],
      '新出现的按键 find 必须先写 #1217 结论（取最新或字典直查）。现查：' + JSON.stringify(found));
  });

  it('Object.keys(...)[0] 只允许「恰好 1 个 key」的非账本点，且旁注 #1217', () => {
    const found = lineHits(files, /Object\.keys\(.*\)\[0\]/);
    const extra = found.filter((h) => h.rel !== 'scripts/lib/execution-usage.mjs');
    assert.equal(extra.length, 0, '未登记的 [0]：' + JSON.stringify(extra));
    assert.ok(found.some((h) => h.rel === 'scripts/lib/execution-usage.mjs'),
      'execution-usage 的 [0] 还在（删了就把这条允许一起删）');
    const src = fs.readFileSync(path.join(REPO, 'scripts/lib/execution-usage.mjs'), 'utf8');
    assert.match(src, /#1217/, '允许点必须写扫描结论');
  });

  it('planExhaustedLabelClear 仍按 at 取最新，不是 find', () => {
    const src = fs.readFileSync(path.join(REPO, 'scripts/lib/exhausted.mjs'), 'utf8');
    const fn = src.split('export function planExhaustedLabelClear')[1];
    assert.ok(fn, '读不到 planExhaustedLabelClear（没查成，不是「已经不按 at 取」）');
    const body = fn.split(/\nexport function /)[0];
    assert.match(body, /b\.at\s*-\s*a\.at/);
    assert.doesNotMatch(body, /Object\.keys\([^)]*\)\.find/);
    assert.match(src, /#1217/);
  });

  it('drain 账仍是字典直查当前键（commander-verbs 在 EPOCH_FILES，结论写在调用点）', () => {
    const src = fs.readFileSync(path.join(REPO, 'scripts/lib/commander-verbs.mjs'), 'utf8');
    assert.match(src, /const key = drainLedgerKey\(/);
    assert.match(src, /ledger\[key\]/);
    assert.doesNotMatch(src, /Object\.keys\([^)]*\)\.find/);
  });

  it('带 @head/@epoch 的账本消费点都写了 #1217 结论', () => {
    const need = [
      'scripts/lib/exhausted.mjs',
      'scripts/lib/commander-core.mjs',
      'scripts/commander.mjs',
    ];
    for (const rel of need) {
      const p = path.join(REPO, rel);
      assert.equal(fs.existsSync(p), true, `读不到 ${rel}（没查成）`);
      const src = fs.readFileSync(p, 'utf8');
      assert.match(src, /#1217/, `${rel} 缺 #1217 取记录结论`);
    }
  });
});
