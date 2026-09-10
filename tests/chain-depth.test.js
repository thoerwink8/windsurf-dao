import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyChainDepth, maxDepthBySlug, DEPTH_LIMIT } from '../scripts/lib/chain-depth-check.mjs';

test('认出锚里的 slug 与层号', () => {
  const m = maxDepthBySlug(['abc123 fix(x): 修一处 [chain:foo-bar#2]']);
  assert.equal(m.get('foo-bar'), 2);
});

test('同一 slug 多条锚只取最大层号', () => {
  const m = maxDepthBySlug([
    'a1 [chain:foo#0]',
    'a2 [chain:foo#1]',
    'a3 [chain:foo#0]',
  ]);
  assert.equal(m.get('foo'), 1);
});

test('同一层的多次提交不算多层——19 条 #0 仍是第 0 层', () => {
  const lines = Array.from({ length: 19 }, (_, i) => `c${i} [chain:session-visibility#0]`);
  const m = maxDepthBySlug(lines);
  assert.equal(m.get('session-visibility'), 0);
});

test('19 条同层锚判绿，不误报成 19 层', () => {
  const lines = Array.from({ length: 19 }, (_, i) => `c${i} [chain:session-visibility#0]`);
  assert.equal(classifyChainDepth({ lines }).state, 'ok');
});

test('第 3 层判红', () => {
  const v = classifyChainDepth({ lines: ['a1 [chain:reviewer-entrance#3]'] });
  assert.equal(v.state, 'red');
});

test('判红时点名 slug 与层号', () => {
  const v = classifyChainDepth({ lines: ['a1 [chain:reviewer-entrance#3]'] });
  assert.match(v.detail, /reviewer-entrance#3/);
});

test('第 5 层照样判红并报出层号', () => {
  const v = classifyChainDepth({ lines: ['a1 [chain:dispatch-overinvest#5]'] });
  assert.equal(v.over[0].depth, 5);
});

test('第 2 层不判红——第 2 层是该停手的那一刻，闸只抓「停手没发生」', () => {
  assert.equal(classifyChainDepth({ lines: ['a1 [chain:foo#2]'] }).state, 'ok');
});

test('多条越线链全部列出', () => {
  const v = classifyChainDepth({ lines: [
    'a1 [chain:foo#3]',
    'a2 [chain:bar#4]',
    'a3 [chain:ok-one#1]',
  ] });
  assert.equal(v.over.length, 2);
});

test('越线链按层号从深到浅排', () => {
  const v = classifyChainDepth({ lines: ['a1 [chain:foo#3]', 'a2 [chain:bar#4]'] });
  assert.equal(v.over[0].slug, 'bar');
});

test('git 没查成报 unknown，不当成「没有补丁链」', () => {
  assert.equal(classifyChainDepth({ lines: null }).state, 'unknown');
});

test('没查成的说明里点明它不是「没有链」', () => {
  assert.match(classifyChainDepth({ lines: null }).detail, /没查成/);
});

test('扫完 0 条锚判绿，但说清扫描面多大', () => {
  const v = classifyChainDepth({ lines: ['a1 普通提交', 'a2 另一条'] });
  assert.equal(v.state, 'ok');
  assert.match(v.detail, /扫了 2 行/);
});

test('阈值可注入——收紧到 2 时第 2 层就红', () => {
  const v = classifyChainDepth({ lines: ['a1 [chain:foo#2]'], limit: 2 });
  assert.equal(v.state, 'red');
});

test('默认阈值是 3', () => {
  assert.equal(DEPTH_LIMIT, 3);
});

test('锚大小写不敏感', () => {
  const m = maxDepthBySlug(['a1 [CHAIN:Foo-Bar#2]']);
  assert.equal(m.get('foo-bar'), 2);
});

test('层号超两位不认——避免把版本号之类误当层号', () => {
  const m = maxDepthBySlug(['a1 [chain:foo#123]']);
  assert.equal(m.size, 0);
});

test('层号后带备注的锚也要认出层号——第一版正则要求数字紧贴 ] 曾整条漏掉', () => {
  const m = maxDepthBySlug(['d5d8011a [cc] test(inflight): 夹具 [chain:some-chain#5·见 #123]']);
  assert.equal(m.get('some-chain'), 5);
});

test('带普通备注的越线锚判红，不再漏报', () => {
  const v = classifyChainDepth({ lines: ['a1 [chain:some-chain#5·见 #123]'] });
  assert.equal(v.state, 'red');
});

test('后缀写「整层删除」的锚不算越线——它是已经停手重推的自证', () => {
  const v = classifyChainDepth({ lines: ['a1 [chain:agent-stall#7·整层删除]'] });
  assert.equal(v.state, 'ok');
});

test('后缀写「换方向」的锚不算越线', () => {
  const v = classifyChainDepth({ lines: ['a1 [chain:dispatch-overinvest#5·换方向]'] });
  assert.equal(v.state, 'ok');
});

test('别的备注不豁免——否则加一句话就能绕过闸', () => {
  const v = classifyChainDepth({ lines: ['a1 [chain:foo#4·2026-09-10 见 #123]'] });
  assert.equal(v.state, 'red');
});

test('同一链既有越线层又有换方向层：换方向的那次不把越线洗白', () => {
  const v = classifyChainDepth({ lines: [
    'a1 [chain:foo#4]',
    'a2 [chain:foo#5·换方向]',
  ] });
  assert.equal(v.state, 'red', '第 4 层没重推过，仍要报');
});
