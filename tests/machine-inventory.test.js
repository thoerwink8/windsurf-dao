// machine-inventory：清单本身的不变量（id 唯一、每项都写清「为什么/装法/怎么探」）。
// 探测结果依赖机器，不在单测里断言；这里只保证「清单不会退化成一张没用的表」。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const MOD = import('file://' + path.resolve(__dirname, '..', 'scripts', 'machine-inventory.mjs').replace(/\\/g, '/'));

test('清单每一项都有 id / 组 / 为什么 / 装法 / 探测函数', async () => {
  const { INVENTORY } = await MOD;
  assert.ok(INVENTORY.length > 0, '清单为空 = 没查成');
  for (const item of INVENTORY) {
    assert.equal(typeof item.id, 'string');
    assert.ok(item.id.length > 0, 'id 不能为空');
    assert.equal(typeof item.group, 'string');
    assert.ok(item.why && item.why.length > 5, `${item.id} 没写清为什么需要`);
    assert.ok(item.how && item.how.length > 2, `${item.id} 没写装法指针`);
    assert.equal(typeof item.probe, 'function', `${item.id} 没有探测函数`);
  }
});

test('id 唯一（重复 id 会让报告两行同名、对不上机器）', async () => {
  const { INVENTORY } = await MOD;
  const ids = INVENTORY.map(i => i.id);
  assert.equal(new Set(ids).size, ids.length, `有重复 id：${ids.filter((v, i) => ids.indexOf(v) !== i).join(', ')}`);
});

test('执行体分组覆盖在役腿的 CLI（新增执行体时要同步清单）', async () => {
  const { INVENTORY } = await MOD;
  const executors = INVENTORY.filter(i => i.group === '执行体').map(i => i.id);
  for (const needed of ['cli:codex', 'cli:grok', 'cli:pi', 'shim:cursor-agent', 'shim:devin', 'shim:reclaude']) {
    assert.ok(executors.includes(needed), `执行体清单缺 ${needed}`);
  }
});
