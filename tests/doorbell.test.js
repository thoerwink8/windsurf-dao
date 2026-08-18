// 空闲短门铃核心逻辑回归（issue #645）
//
// 验的层：①relay 日志行解析（JSON 行 / 非 JSON / heartbeat / archive-exec 排除）
// ②按 id 去重收新信 ③响门铃决策：必须新鲜信 + pi 空闲 + 输入框空 + 冷却外
// ④pollOnce 端到端：写假 inbox 日志 → 首轮建游标不响 → 追加新信响一次 → 打字不响 → 冷却不响
//
// 判别力：把「打字也响」「忙也响」「同 id 重响」任一放宽，必有一条断言变红。
// 纯逻辑在 host/pi-extensions/doorbell-core.mjs 与 doorbell.ts（node 22 只 import .mjs，
// 不 import .ts——CI 是 node 22，见 .github/workflows/check.yml）。

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CORE = path.resolve(__dirname, '..', 'host', 'pi-extensions', 'doorbell-core.mjs');
const CORE_LOAD = import('file://' + CORE.replace(/\\/g, '/'));

function line(id, type, extra = {}) {
  return JSON.stringify({ ts: '2026-08-18T00:00:00Z', id, type, from: 'term_x', to: 'run:r', subject: 's', body: 'b', ...extra });
}

describe('doorbell-core', () => {
  it('① 日志行解析', async (t) => {
    const C = await CORE_LOAD;
    await t.test('普通业务行可解析', () => {
      const m = C.parseLogLine(line('msg_1', 'worker_done'));
      assert.ok(m && m.id === 'msg_1' && m.type === 'worker_done', '业务行应解析出 id/type');
    });
    await t.test('非 JSON 行返回 null', () => {
      assert.strictEqual(C.parseLogLine('INBOX_STATION_READY run=xxx'), null, 'READY 历史行不是消息');
      assert.strictEqual(C.parseLogLine('随便一行'), null, '普通文本不是消息');
    });
    await t.test('缺 id 返回 null', () => {
      assert.strictEqual(C.parseLogLine('{"type":"worker_done"}'), null, '缺 id 不是可响消息');
    });
    await t.test('heartbeat 排除', () => {
      assert.strictEqual(C.parseLogLine(line('msg_h', 'heartbeat')), null, 'heartbeat 不落盘且不响');
    });
    await t.test('archive-exec 排除（机器动作不是工人来信）', () => {
      assert.strictEqual(C.parseLogLine(line('msg_a', 'archive-exec')), null, '可归档执行记录不叫醒');
    });
  });

  it('② 按 id 去重收新信', async (t) => {
    const C = await CORE_LOAD;
    const seen = new Set();
    const fresh1 = C.collectNewMessages([line('msg_1', 'worker_done'), line('msg_2', 'escalation')], seen);
    await t.test('首轮收两条', () => {
      assert.strictEqual(fresh1.length, 2, '两条新信都应收');
      assert.deepStrictEqual(fresh1.map((m) => m.id).sort(), ['msg_1', 'msg_2'], 'id 正确');
    });
    await t.test('同批重复喂不再返回', () => {
      const fresh2 = C.collectNewMessages([line('msg_1', 'worker_done'), line('msg_3', 'question')], seen);
      assert.deepStrictEqual(fresh2.map((m) => m.id), ['msg_3'], 'msg_1 已见不再返回，msg_3 收');
    });
    await t.test('非数组安全', () => {
      assert.deepStrictEqual(C.collectNewMessages(null, new Set()), [], 'null 输入返回空');
    });
  });

  it('③ 响门铃决策', async (t) => {
    const C = await CORE_LOAD;
    const base = { hasFresh: true, idle: true, editorText: '', now: 5000, lastRingAt: 0, cooldownMs: 10000 };
    await t.test('空闲 + 框空 + 新鲜 → 响', () => {
      assert.ok(C.shouldRing(base), '空闲且框空应响门铃');
    });
    await t.test('人在打字（框非空）→ 不响', () => {
      assert.ok(!C.shouldRing({ ...base, editorText: '我正在打字' }), '打字绝不占输入框');
    });
    await t.test('pi 忙（agent 在跑）→ 不响', () => {
      assert.ok(!C.shouldRing({ ...base, idle: false }), '正在干活不打断');
    });
    await t.test('无新信 → 不响', () => {
      assert.ok(!C.shouldRing({ ...base, hasFresh: false }), '没新信不响');
    });
    await t.test('冷却期内 → 不响', () => {
      assert.ok(!C.shouldRing({ ...base, lastRingAt: 4000, now: 8000 }), '10s 冷却内不重复响');
    });
    await t.test('冷却期外 → 响', () => {
      assert.ok(C.shouldRing({ ...base, lastRingAt: 4000, now: 15000 }), '冷却外可响');
    });
  });

  it('④ pollOnce 端到端（假日志 + 假 ctx）', async () => {
    const S = await CORE_LOAD;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doorbell-e2e-'));
    const log = path.join(dir, 'inbox-run_test.log');
    const rings = [];
    const ctx = {
      isIdle: () => true,
      ui: { getEditorText: () => '' },
    };
    const sendUserMessage = (t) => rings.push(t);
    const common = { dir, cooldownMs: 10000, ctx, sendUserMessage };
    try {
      // 存量：写入两行历史信，首轮只建游标不响
      fs.writeFileSync(log, line('msg_old1', 'worker_done') + '\n' + line('msg_old2', 'escalation') + '\n', 'utf8');
      const offsets = new Map();
      const seen = new Set();
      let r1 = S.pollOnce({ ...common, offsets, seenIds: seen, lastRingAt: 0, now: 1000, prime: true });
      assert.strictEqual(r1.rang, false, '首轮（存量）不应响');
      assert.deepStrictEqual(rings, [], '首轮不应发消息');
      assert.ok(seen.has('msg_old1') && seen.has('msg_old2'), '存量 id 应进去重集');

      // 追加新信 → 响一次
      fs.appendFileSync(log, line('msg_new1', 'worker_done') + '\n', 'utf8');
      const r2 = S.pollOnce({ ...common, offsets, seenIds: seen, lastRingAt: 0, now: 2000 });
      assert.strictEqual(r2.rang, true, '新信应响门铃');
      assert.strictEqual(r2.newCount, 1, '新信计数 1');
      assert.deepStrictEqual(rings, ['你有来信'], '门铃短句 = 你有来信');

      // 冷却内再来一批 → 不响（同 id 也不重复）
      fs.appendFileSync(log, line('msg_new2', 'question') + '\n', 'utf8');
      const r3 = S.pollOnce({ ...common, offsets, seenIds: seen, lastRingAt: 2000, now: 3000 });
      assert.strictEqual(r3.rang, false, '冷却期内不响');
      assert.deepStrictEqual(rings, ['你有来信'], '冷却内不重复发');

      // 人在打字 → 新信不响
      fs.appendFileSync(log, line('msg_new3', 'worker_done') + '\n', 'utf8');
      const r4 = S.pollOnce({ ...common, offsets, seenIds: seen, lastRingAt: 2000, now: 15000, ctx: { ...ctx, ui: { getEditorText: () => 'x' } } });
      assert.strictEqual(r4.rang, false, '打字时不响');
      assert.deepStrictEqual(rings, ['你有来信'], '打字不碰框');

      // 冷却外 + 框空 + 再来新信 → 再响
      fs.appendFileSync(log, line('msg_new4', 'worker_done') + '\n', 'utf8');
      const r5 = S.pollOnce({ ...common, offsets, seenIds: seen, lastRingAt: 2000, now: 20000 });
      assert.strictEqual(r5.rang, true, '冷却外应再响');
      assert.strictEqual(rings.length, 2, '第二次响');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
