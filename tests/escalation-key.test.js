import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escalationKeyOf, isGatewayKeySafe } from '../scripts/lib/escalation-key.mjs';

// 2026-09-10 真实咬过的那个 title：派工失败把整段 JSON 塞进 title，
// 回落当 key 时被网关拒成 missing_idempotency，于是 96 条故障一条都没报出来。
const REAL_BAD_TITLE = '#1146 自动派工失败：{"ok":false,"error":"mirasim 建树失败: 契约断言不通过，拒派：版本不符：钉死 0.0.282，服务端报 0.0.307","executor":"mirasim"}';

test('真实咬过的 title 原样不合法——正控，说明这条闸有判别力', () => {
  assert.equal(isGatewayKeySafe(REAL_BAD_TITLE), false);
});

test('规范化后合法', () => {
  assert.equal(isGatewayKeySafe(escalationKeyOf(REAL_BAD_TITLE)), true);
});

test('规范化后不含空白', () => {
  assert.doesNotMatch(escalationKeyOf(REAL_BAD_TITLE), /\s/);
});

test('长度在网关上限内', () => {
  assert.ok(escalationKeyOf(REAL_BAD_TITLE).length <= 200);
});

test('同一件事得到同一个 key（幂等的意义所在）', () => {
  assert.equal(escalationKeyOf(REAL_BAD_TITLE), escalationKeyOf(REAL_BAD_TITLE));
});

test('前缀相同但内容不同的两件事不许撞 key', () => {
  const a = '#1146 自动派工失败：{"error":"aaa"}';
  const b = '#1151 自动派工失败：{"error":"bbb"}';
  assert.notEqual(escalationKeyOf(a), escalationKeyOf(b));
});

test('长前缀完全相同、只在尾部不同，也不许撞 key', () => {
  const pad = '相同前缀'.repeat(40);
  assert.notEqual(escalationKeyOf(pad + 'X'), escalationKeyOf(pad + 'Y'));
});

test('保留可读前缀，人能看出是哪件事', () => {
  assert.match(escalationKeyOf(REAL_BAD_TITLE), /1146/);
});

test('空输入也给合法 key，不返回空串', () => {
  assert.equal(isGatewayKeySafe(escalationKeyOf('')), true);
});

test('null 输入不抛，给合法 key', () => {
  assert.equal(isGatewayKeySafe(escalationKeyOf(null)), true);
});

test('纯符号输入折没了也不返回空串', () => {
  assert.equal(isGatewayKeySafe(escalationKeyOf('！！！ ％％ &&&')), true);
});

test('已经合法的查重标记保持可读', () => {
  const marker = '[commander-open-issue]:dispatch-fail:1146';
  assert.match(escalationKeyOf(marker), /commander-open-issue/);
});

test('isGatewayKeySafe 认出超长 key', () => {
  assert.equal(isGatewayKeySafe('a'.repeat(201)), false);
});

test('isGatewayKeySafe 认出空 key', () => {
  assert.equal(isGatewayKeySafe(''), false);
});
