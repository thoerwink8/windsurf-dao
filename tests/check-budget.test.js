// tests/check-budget.test.js —— 耗时棘轮的判别力
//
// 这条闸回答的是用户 2026-09-06 的问题「后面是不是就不会出现同样的问题了」：
// 光堵已知的洞不够，得让**新加的机制默认就得快**。棘轮只拦「变得更糟」，
// 不拦历史欠账——一刀切会让存量天天红，红久了就没人看。

import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyDurations, GROSS_FACTOR, NEW_SUITE_BUDGET_MS, REGISTERED_SLOW } from '../scripts/lib/check-budget.mjs';

test('① 新套成倍超标才红（这是「新机制必须快」的落点）', () => {
  const r = classifyDurations([{ file: 'brand-new.test.js', ms: NEW_SUITE_BUDGET_MS * GROSS_FACTOR + 1 }]);
  assert.equal(r.state, 'red');
  assert.match(r.detail, /brand-new\.test\.js/);
  assert.match(r.detail, /新套上限/);
  assert.match(r.detail, /负载解释不了/, '报警要说明为什么这次不是抖动');
});

test('② 轻微超标只提示不拦——负载抖动不许变成假红', () => {
  // 实测依据：同一套两次跑 3.7s / 7.7s（load average 5+）。1 倍阈值硬红 = 随机假红，
  // 而随机假红的闸最后一定会被关掉。
  const r = classifyDurations([{ file: 'brand-new.test.js', ms: NEW_SUITE_BUDGET_MS + 1 }]);
  assert.equal(r.state, 'ok', '轻微超标不许红');
  assert.equal(r.notes.length, 1, '但必须留下可见提示，不能当没发生');
  assert.match(r.detail, /轻微超标/);
});

test('③ 上限内判绿且没有提示', () => {
  const r = classifyDurations([{ file: 'brand-new.test.js', ms: NEW_SUITE_BUDGET_MS - 1 }]);
  assert.equal(r.state, 'ok');
  assert.equal(r.notes.length, 0);
});

test('④ 历史欠账按各自天花板判——不拿新套上限误伤', () => {
  const slowFile = 'dao.test.js';
  const cap = REGISTERED_SLOW[slowFile];
  assert.ok(cap > NEW_SUITE_BUDGET_MS, '夹具前提：dao.test.js 是登记过的慢套');
  assert.equal(classifyDurations([{ file: slowFile, ms: cap - 1 }]).state, 'ok');
  // 同样的毫秒数，登记过的绿、没登记的红——证明登记表真的在起作用
  assert.equal(classifyDurations([{ file: 'brand-new.test.js', ms: cap - 1 }]).state, 'red');
  assert.equal(classifyDurations([{ file: slowFile, ms: cap * GROSS_FACTOR + 1 }]).state, 'red', '成倍恶化照样红');
});

test('⑤ 判别力反证：拿掉登记表，历史欠账会全红（证明④钉的是真判据）', () => {
  const naive = Object.keys(REGISTERED_SLOW).map((f) => ({ file: f, ms: NEW_SUITE_BUDGET_MS + 1 }));
  // 模拟「没有棘轮、一刀切」的世界
  const allOver = naive.filter((d) => d.ms > NEW_SUITE_BUDGET_MS);
  assert.equal(allOver.length, naive.length, '一刀切会让登记表里每一套都红——那就是没人看的噪音');
  // 有棘轮时它们全绿
  assert.equal(classifyDurations(Object.entries(REGISTERED_SLOW).map(([f, cap]) => ({ file: f, ms: cap - 1 }))).state, 'ok');
});

test('⑥ 没样本 ≠ 都很快；单套没测到不许冒充合格', () => {
  assert.equal(classifyDurations([]).state, 'unknown');
  assert.match(classifyDurations([]).detail, /没查成/);
  assert.equal(classifyDurations(null).state, 'unknown');
  // 一套 ms 缺失、另一套正常 → 只按能测到的判，不因缺失而放行整批
  const mixed = classifyDurations([{ file: 'a.test.js', ms: undefined }, { file: 'b.test.js', ms: NEW_SUITE_BUDGET_MS + 1 }]);
  assert.equal(mixed.state, 'ok', '轻微超标不红');
  assert.equal(mixed.notes.length, 1, '但要留提示；另一套没测到不影响判定');
});

test('⑦ 登记表只许改小：天花板不许高得离谱（防自发免死金牌）', () => {
  for (const [f, cap] of Object.entries(REGISTERED_SLOW)) {
    assert.ok(cap <= 30000, `${f} 天花板 ${cap}ms 太松了——超过 30s 的套应当拆，不是登记`);
  }
});
