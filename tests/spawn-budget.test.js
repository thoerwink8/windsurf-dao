// tests/spawn-budget.test.js —— spawn 预算闸的判别力
//
// 这条闸是「第二刀没做完」的报警器（见 scripts/lib/spawn-budget.mjs 头部）。
// 它唯一的失效方式是：扫描面坏了却报绿——那时「没有 spawn」和「没扫到」看起来一样。

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifySpawnBudget, countSpawnCalls, SPAWN_BUDGET } from '../scripts/lib/spawn-budget.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

test('① 超预算判红并点名大头', () => {
  const r = classifySpawnBudget([{ file: 'a.test.js', count: SPAWN_BUDGET + 1 }]);
  assert.equal(r.state, 'red');
  assert.match(r.detail, /超预算/);
  assert.match(r.detail, /a\.test\.js×/, '要点名是谁占大头，否则没人知道从哪下手');
  assert.match(r.detail, /第二刀/, '报警要带「该怎么办」，只报数字没用');
});

test('② 「没扫到」不许当成「没有 spawn」', () => {
  assert.equal(classifySpawnBudget([]).state, 'unknown');
  assert.match(classifySpawnBudget([]).detail, /没查成/);
  assert.equal(classifySpawnBudget(null).state, 'unknown');
  // 扫完确实是 0 处 → 绿（与上面必须分得开）
  assert.equal(classifySpawnBudget([{ file: 'a.test.js', count: 0 }]).state, 'ok');
});

test('③ 预算内判绿，卡线上如实说', () => {
  assert.equal(classifySpawnBudget([{ file: 'a.test.js', count: SPAWN_BUDGET - 10 }]).state, 'ok');
  const exact = classifySpawnBudget([{ file: 'a.test.js', count: SPAWN_BUDGET }]);
  assert.equal(exact.state, 'ok');
  assert.match(exact.detail, /正好卡在预算上/);
});

test('④ 只数调用不数「提到」（首版把 import 行和注释都算了进去）', () => {
  // 样例里的调用形态要拼出来，不能直接写字面量——本文件自己也在扫描面内，
  // 写死的样例会被真实扫描（⑤）数进去，检查器的产出污染自己的判据。
  const S = 'spawn' + 'Sync';
  const src = [
    `import { ${S} } from "node:child_process";`,   // 提到，不算
    `// 这里说明 ${S} 的坑`,                          // 注释，不算
    `const r = ${S}("git", []);`,                    // 算
    `${S} ( "node", [] );`,                          // 带空格也算
  ].join('\n');
  assert.equal(countSpawnCalls(src), 2, `只该数出 2 处调用，实际 ${countSpawnCalls(src)}`);
});

test('⑤ 真实扫描：本仓当前 spawn 数在预算内（第二刀往下做要同步降预算）', () => {
  const counts = readdirSync(HERE)
    .filter((f) => /\.test\.(js|mjs|cjs)$/.test(f))
    .map((f) => ({ file: f, count: countSpawnCalls(readFileSync(join(HERE, f), 'utf8')) }));
  const r = classifySpawnBudget(counts);
  assert.notEqual(r.state, 'unknown', '扫描面坏了——本条等于没查');
  assert.equal(r.state, 'ok', r.detail);
});
