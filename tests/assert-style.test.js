// tests/assert-style.test.js —— 断言写法闸的判别力
//
// 闸只看**新增行**（存量 1471 处复合断言不进判定面，理由见 lib/assert-style.mjs）。
// 所以本套要钉两头：新增的复合断言必须抓到；存量的不许被误伤。

import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyAssertStyle, COMPOUND_OK_RE } from '../scripts/lib/assert-style.mjs';

const OK_LINE = "  assert.ok(r.status === 0 && /x/.test(r.out), 'msg  →  ' + JSON.stringify(r));";
const CLEAN_EQ = '  assert.deepStrictEqual(r, { pr: 43, state: 42 });';
const CLEAN_OK = '  assert.ok(Array.isArray(r.list));';

test('① 新增的复合 assert.ok → 红并点名', () => {
  const v = classifyAssertStyle([{ file: 'tests/x.test.js', added: [OK_LINE] }]);
  assert.equal(v.state, 'red');
  assert.equal(v.hits.length, 1);
  assert.match(v.detail, /tests\/x\.test\.js/);
});

test('② 结构化断言与单条件 ok 都放行', () => {
  const v = classifyAssertStyle([{ file: 'tests/x.test.js', added: [CLEAN_EQ, CLEAN_OK] }]);
  assert.equal(v.state, 'ok');
});

test('③ 只管测试文件——源码里的复合 ok 不归本闸', () => {
  const v = classifyAssertStyle([{ file: 'scripts/x.mjs', added: [OK_LINE] }]);
  assert.equal(v.state, 'ok');
});

test('④ 「没查成」不许当成「没有违规」', () => {
  assert.equal(classifyAssertStyle(null).state, 'unknown');
  assert.match(classifyAssertStyle(null).detail, /没查成/);
  // 扫完 0 个文件 → ok（与上面必须分得开）
  assert.equal(classifyAssertStyle([]).state, 'ok');
});

test('⑤ 判别力：|| 不拦（二选一皆可是合法写法），&& 才拦', () => {
  const or = "  assert.ok(a === 1 || a === 2, 'either');";
  assert.equal(classifyAssertStyle([{ file: 'tests/x.test.js', added: [or] }]).state, 'ok');
  assert.equal(COMPOUND_OK_RE.test(or), false);
  assert.equal(COMPOUND_OK_RE.test(OK_LINE), true);
});

test('⑥ 判别力反证：拿掉「只看新增行」这条，存量会被误伤', () => {
  // 模拟把整份存量文件当 added 喂进来——闸会红一大片，那就是没人看的噪音
  const legacy = Array.from({ length: 50 }, () => OK_LINE);
  const v = classifyAssertStyle([{ file: 'tests/dao.test.js', added: legacy }]);
  assert.equal(v.hits.length, 50, '证明：判定面若扩到存量，一个文件就红 50 条');
});
