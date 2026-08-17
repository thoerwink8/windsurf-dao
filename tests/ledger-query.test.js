// #588 ledger-query：按 ts 排序、按结构化字段匹配、0 条 ≠ 没查成
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const LIB = path.join(__dirname, '..', 'scripts', 'lib', 'ledger-query.mjs');
const CLI = path.join(__dirname, '..', 'scripts', 'dao.mjs');
const { spawnSync } = require('child_process');
const LIB_LOAD = import('file://' + LIB.replace(/\\/g, '/'));

function ev(partial) {
  return {
    type: partial.type || 'job.dispatch',
    ts: partial.ts,
    machine: partial.machine || 't',
    seq: partial.seq ?? 0,
    event_id: partial.event_id || `id-${partial.ts}`,
    job_id: partial.job_id,
    pr_number: partial.pr_number,
    issue: partial.issue,
    model: partial.model || 'grok-4.6',
  };
}

describe('ledger-query', () => {
  const events = [
    ev({ ts: '2026-08-17T10:00:00+08:00', job_id: 'dispatch-aaa', seq: 1 }),
    ev({ ts: '2026-08-17T11:00:00+08:00', job_id: 'gh-pr-588', pr_number: 590, seq: 2 }),
    ev({ ts: '2026-08-17T12:00:00+08:00', type: 'job.closed', job_id: 'gh-pr-588', pr_number: 590, seq: 3 }),
    ev({ ts: '2026-08-17T13:00:00+08:00', job_id: 'gh-pr-591', pr_number: 591, seq: 4 }),
  ];

  it('排序按事件 ts，不按插入/文件顺序', async (t) => {
    const S = await LIB_LOAD;
    const shuffled = [events[3], events[0], events[2], events[1]];
    const listed = { events: shuffled.slice().sort(S.compareEvents) };
    await t.test('ts 升序', () => {
      assert.ok(listed.events.map(e => e.seq).join(',') === '1,2,3,4', 'ts 升序  →  ' + listed.events.map(e => e.seq).join(','));
    });
  });

  it('--recent 取最晚 N 条', async (t) => {
    const S = await LIB_LOAD;
    const r = S.queryLedger({ events, recent: 2 });
    await t.test('recent 2 条', () => {
      assert.ok(r.kind === 'ok' && r.count === 2, 'recent 2 条  →  ' + JSON.stringify(r));
    });
    await t.test('是最晚两条', () => {
      assert.ok(r.events[0].job_id === 'gh-pr-588' && r.events[1].job_id === 'gh-pr-591', '是最晚两条  →  ' + r.events.map(e => e.job_id).join(','));
    });
  });

  it('--issue 认 job_id / pr_number，不认 event_id 里的数字', async (t) => {
    const S = await LIB_LOAD;
    const trap = ev({
      ts: '2026-08-17T14:00:00+08:00', job_id: 'dispatch-zzz',
      event_id: 'deadbeef588cafe', seq: 9,
    });
    const r = S.queryLedger({ events: [...events, trap], issue: 588 });
    await t.test('issue 588 命中 gh-pr-588 两条', () => {
      assert.ok(r.count === 2 && r.events.every(e => e.job_id === 'gh-pr-588'), 'issue 588 命中 gh-pr-588 两条  →  ' + JSON.stringify(r.events.map(e => e.job_id)));
    });
    await t.test('event_id 含 588 不算', () => {
      assert.ok(!r.events.some(e => e.job_id === 'dispatch-zzz'), 'event_id 含 588 不算  →  ' + JSON.stringify(r));
    });
  });

  it('--unclosed：有 dispatch 无 closed', async (t) => {
    const S = await LIB_LOAD;
    const r = S.queryLedger({ events, unclosed: true });
    await t.test('只剩 591 和 dispatch-aaa', () => {
      assert.ok(r.count === 2 && r.events.every(e => e.type === 'job.dispatch'), '只剩 591 和 dispatch-aaa  →  ' + r.events.map(e => e.job_id).join(','));
    });
    await t.test('已关闭的 588 不在', () => {
      assert.ok(!r.events.some(e => e.job_id === 'gh-pr-588'), '已关闭的 588 不在  →  ' + JSON.stringify(r.events));
    });
    const linked = [
      ...events,
      ev({ ts: '2026-08-17T10:30:00+08:00', type: 'job.handoff', job_id: 'dispatch-aaa', event_id: 'h1', seq: 5 }),
    ];
    linked[linked.length - 1].kind = 'job_id_rename';
    linked[linked.length - 1].from_job_id = 'dispatch-aaa';
    linked[linked.length - 1].to_job_id = 'gh-pr-588';
    const after = S.queryLedger({ events: linked, unclosed: true });
    await t.test('handoff 接续后 dispatch-aaa 不再未结', () => {
      assert.ok(after.events.every(e => e.job_id !== 'dispatch-aaa'), 'handoff 接续后 dispatch-aaa 不再未结  →  ' + after.events.map(e => e.job_id).join(','));
    });
    const detail = S.describeUnclosedJobs(events);
    await t.test('未结明细带缺失项', () => {
      assert.ok(detail.some(d => d.job_id === 'dispatch-aaa' && d.missing.length > 0), '未结明细带缺失项  →  ' + JSON.stringify(detail));
    });
  });

  it('三态：0 条 ≠ 没查成', async (t) => {
    const S = await LIB_LOAD;
    const zero = S.queryLedger({ events, issue: 999 });
    await t.test('查到 0 条 kind=zero', () => {
      assert.ok(zero.kind === 'zero' && /查到 0 条/.test(zero.line) && /不是没查成/.test(zero.line), '查到 0 条 kind=zero  →  ' + zero.line);
    });
    const bad = S.queryLedger({ events, recent: 'nope' });
    await t.test('非法 recent → unscanned', () => {
      assert.ok(bad.kind === 'unscanned', '非法 recent → unscanned  →  ' + bad.line);
    });
    const none = S.queryLedger({});
    await t.test('没给数组 → unscanned', () => {
      assert.ok(none.kind === 'unscanned', '没给数组 → unscanned  →  ' + none.line);
    });
    await t.test('zero 与 unscanned 话面不同', () => {
      assert.ok(zero.line !== none.line, 'zero 与 unscanned 话面不同');
    });
  });

  it('目录扫描：缺目录 / 坏 JSON 是没查成', async (t) => {
    const S = await LIB_LOAD;
    const missing = S.readLedgerEvents(path.join(os.tmpdir(), 'no-such-ledger-588'));
    await t.test('目录不在 → unscanned', () => {
      assert.ok(missing.unscanned === true, '目录不在 → unscanned  →  ' + missing.error);
    });
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-q-'));
    fs.writeFileSync(path.join(tmp, 'ok.json'), JSON.stringify(events[0]));
    fs.writeFileSync(path.join(tmp, 'bad.json'), '{not json');
    const mixed = S.readLedgerEvents(tmp);
    await t.test('有坏文件 → unscanned', () => {
      assert.ok(mixed.unscanned === true && /不是 JSON/.test(mixed.error), '有坏文件 → unscanned  →  ' + mixed.error);
    });
  });

  it('CLI 接线', async (t) => {
    const miss = spawnSync(process.execPath, [CLI, 'ledger-query'], { encoding: 'utf8' });
    await t.test('缺参数非零', () => {
      assert.ok(miss.status !== 0, '缺参数非零  →  ' + (miss.stdout || miss.stderr));
    });
    const recent = spawnSync(process.execPath, [CLI, 'ledger-query', '--recent', '2'], { encoding: 'utf8' });
    await t.test('recent CLI 退出 0', () => {
      assert.ok(recent.status === 0, 'recent CLI 退出 0  →  ' + (recent.stderr || recent.stdout));
    });
    let doc;
    try { doc = JSON.parse(recent.stdout); } catch { doc = null; }
    await t.test('recent CLI 吐 JSON 且有 line', () => {
      assert.ok(doc && doc.ok && typeof doc.line === 'string' && doc.count === 2, 'recent CLI 吐 JSON 且有 line  →  ' + recent.stdout);
    });
    const zero = spawnSync(process.execPath, [CLI, 'ledger-query', '--issue', '1'], { encoding: 'utf8' });
    await t.test('查到 0 条仍退出 0（不是没查成）', () => {
      assert.ok(zero.status === 0, '查到 0 条仍退出 0（不是没查成）  →  ' + (zero.stderr || zero.stdout));
    });
    let z;
    try { z = JSON.parse(zero.stdout); } catch { z = null; }
    await t.test('0 条 kind=zero', () => {
      assert.ok(z && z.kind === 'zero' && /查到 0 条/.test(z.line), '0 条 kind=zero  →  ' + zero.stdout);
    });
  });
});