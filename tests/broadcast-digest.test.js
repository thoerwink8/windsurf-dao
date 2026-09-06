// #1029：心跳 / 发布 / 熔断 / board-gc / stall 撤出总控，攒成每天一条。
// 判别：换日才吐；同一天只入队不发；渲染带条数。
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const toUrl = (p) => 'file://' + p.replace(/\\/g, '/');
const LIB = import(toUrl(path.join(ROOT, 'scripts', 'lib', 'broadcast-digest.mjs')));

describe('enqueueBroadcast：同一天只入队，换日才吐昨天', () => {
  it('空队列记一条 → 不 flush', async () => {
    const { enqueueBroadcast, emptyQueue } = await LIB;
    const r = enqueueBroadcast(emptyQueue(), { text: '心跳一条', source: 'heartbeat', now: '2026-09-06' });
    assert.equal(r.flush, null);
    assert.equal(r.queue.day, '2026-09-06');
    assert.equal(r.queue.items.length, 1);
    assert.equal(r.queue.items[0].source, 'heartbeat');
    assert.equal(r.queue.items[0].text, '心跳一条');
  });

  it('同一天第二条仍不 flush', async () => {
    const { enqueueBroadcast } = await LIB;
    const first = enqueueBroadcast({ day: '', items: [] }, { text: '心跳', source: 'heartbeat', now: '2026-09-06T08:00:00Z' });
    const r = enqueueBroadcast(first.queue, { text: '熔断', source: 'breaker', now: '2026-09-06T20:00:00Z' });
    assert.equal(r.flush, null);
    assert.equal(r.queue.items.length, 2);
  });

  it('换日且昨天有条目 → flush 昨天，新条进今天', async () => {
    const { enqueueBroadcast } = await LIB;
    const q = { day: '2026-09-06', items: [{ at: '2026-09-06', source: 'heartbeat', text: '心跳' }] };
    const r = enqueueBroadcast(q, { text: '发布 v1', source: 'release', now: '2026-09-07' });
    assert.equal(r.flush.day, '2026-09-06');
    assert.equal(r.flush.items.length, 1);
    assert.equal(r.flush.items[0].text, '心跳');
    assert.equal(r.queue.day, '2026-09-07');
    assert.equal(r.queue.items.length, 1);
    assert.equal(r.queue.items[0].text, '发布 v1');
  });

  it('空文本不入队', async () => {
    const { enqueueBroadcast } = await LIB;
    const r = enqueueBroadcast({ day: '2026-09-06', items: [] }, { text: '  ', now: '2026-09-06' });
    assert.equal(r.flush, null);
    assert.equal(r.queue.items.length, 0);
  });
});

describe('dueFlush：安静的新一天也要把昨天发出去', () => {
  it('换日有条目 → flush，今天队列空', async () => {
    const { dueFlush } = await LIB;
    const r = dueFlush(
      { day: '2026-09-06', items: [{ at: '2026-09-06', source: 'stall', text: '卡死 2 个' }] },
      '2026-09-07',
    );
    assert.equal(r.flush.day, '2026-09-06');
    assert.equal(r.flush.items.length, 1);
    assert.equal(r.queue.day, '2026-09-07');
    assert.equal(r.queue.items.length, 0);
  });

  it('还是同一天 → 不 flush', async () => {
    const { dueFlush } = await LIB;
    const q = { day: '2026-09-06', items: [{ at: '2026-09-06', source: 'x', text: 'y' }] };
    const r = dueFlush(q, '2026-09-06');
    assert.equal(r.flush, null);
    assert.equal(r.queue.items.length, 1);
  });

  it('换日但昨天空 → 不 flush', async () => {
    const { dueFlush } = await LIB;
    const r = dueFlush({ day: '2026-09-06', items: [] }, '2026-09-07');
    assert.equal(r.flush, null);
  });
});

describe('renderDigest', () => {
  it('抬头带日期和条数，每条带来源', async () => {
    const { renderDigest } = await LIB;
    const text = renderDigest({
      day: '2026-09-06',
      items: [
        { source: 'heartbeat', text: '连续 7 天静默' },
        { source: 'breaker', text: '全部路径 open' },
      ],
    });
    assert.match(text, /道·播报 2026-09-06（2 条）/);
    assert.match(text, /\[heartbeat\] 连续 7 天静默/);
    assert.match(text, /\[breaker\] 全部路径 open/);
  });

  it('空 flush → 空字符串，不许造一条假摘要', async () => {
    const { renderDigest } = await LIB;
    assert.equal(renderDigest(null), '');
    assert.equal(renderDigest({ day: '2026-09-06', items: [] }), '');
  });
});

describe('废弃群 / 播报群定位', () => {
  it('四个已废弃前缀都认', async () => {
    const { isAbandonedChatId } = await LIB;
    assert.equal(isAbandonedChatId('oc_37d7d3b10274c04eb5bf3d52d4246424'), true);
    assert.equal(isAbandonedChatId('oc_e779d49e6aa6f7f59ed719de2913f8a1'), true);
    assert.equal(isAbandonedChatId('oc_45c99a053f683457d59b0d581b18a1ee'), true);
    assert.equal(isAbandonedChatId('oc_dab285495f665f7639335e3fac1e9231'), true);
    assert.equal(isAbandonedChatId('oc_c0bc12f75dff4aa40e43eda8d1fa52e8'), false);
  });

  it('按名字找「道·播报」，找不到回空', async () => {
    const { findBroadcastChatId, BROADCAST_CHAT_NAME } = await LIB;
    assert.equal(BROADCAST_CHAT_NAME, '道·播报');
    assert.equal(findBroadcastChatId([
      { name: '总控', chat_id: 'oc_hub' },
      { name: '道·播报', chat_id: 'oc_digest' },
    ]), 'oc_digest');
    assert.equal(findBroadcastChatId([{ name: '别的', chat_id: 'oc_x' }]), '');
  });
});
