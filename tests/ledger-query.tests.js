// #588 ledger-query：按 ts 排序、按结构化字段匹配、0 条 ≠ 没查成
const fs = require('fs');
const os = require('os');
const path = require('path');

const LIB = path.join(__dirname, '..', 'scripts', 'lib', 'ledger-query.mjs');
const CLI = path.join(__dirname, '..', 'scripts', 'dao.mjs');
const { spawnSync } = require('child_process');

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? '  →  ' + detail : ''}`); }
}

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

async function main() {
  const S = await import('file://' + LIB.replace(/\\/g, '/'));

  const events = [
    ev({ ts: '2026-08-17T10:00:00+08:00', job_id: 'dispatch-aaa', seq: 1 }),
    ev({ ts: '2026-08-17T11:00:00+08:00', job_id: 'gh-pr-588', pr_number: 590, seq: 2 }),
    ev({ ts: '2026-08-17T12:00:00+08:00', type: 'job.closed', job_id: 'gh-pr-588', pr_number: 590, seq: 3 }),
    ev({ ts: '2026-08-17T13:00:00+08:00', job_id: 'gh-pr-591', pr_number: 591, seq: 4 }),
  ];

  console.log('\n=== 排序按事件 ts，不按插入/文件顺序 ===');
  {
    const shuffled = [events[3], events[0], events[2], events[1]];
    const listed = { events: shuffled.slice().sort(S.compareEvents) };
    check('ts 升序', listed.events.map(e => e.seq).join(',') === '1,2,3,4', listed.events.map(e => e.seq).join(','));
  }

  console.log('\n=== --recent 取最晚 N 条 ===');
  {
    const r = S.queryLedger({ events, recent: 2 });
    check('recent 2 条', r.kind === 'ok' && r.count === 2, JSON.stringify(r));
    check('是最晚两条', r.events[0].job_id === 'gh-pr-588' && r.events[1].job_id === 'gh-pr-591', r.events.map(e => e.job_id).join(','));
  }

  console.log('\n=== --issue 认 job_id / pr_number，不认 event_id 里的数字 ===');
  {
    const trap = ev({
      ts: '2026-08-17T14:00:00+08:00', job_id: 'dispatch-zzz',
      event_id: 'deadbeef588cafe', seq: 9,
    });
    const r = S.queryLedger({ events: [...events, trap], issue: 588 });
    check('issue 588 命中 gh-pr-588 两条', r.count === 2 && r.events.every(e => e.job_id === 'gh-pr-588'), JSON.stringify(r.events.map(e => e.job_id)));
    check('event_id 含 588 不算', !r.events.some(e => e.job_id === 'dispatch-zzz'), JSON.stringify(r));
  }

  console.log('\n=== --unclosed：有 dispatch 无 closed ===');
  {
    const r = S.queryLedger({ events, unclosed: true });
    check('只剩 591 和 dispatch-aaa', r.count === 2 && r.events.every(e => e.type === 'job.dispatch'), r.events.map(e => e.job_id).join(','));
    check('已关闭的 588 不在', !r.events.some(e => e.job_id === 'gh-pr-588'), JSON.stringify(r.events));
  }

  console.log('\n=== 三态：0 条 ≠ 没查成 ===');
  {
    const zero = S.queryLedger({ events, issue: 999 });
    check('查到 0 条 kind=zero', zero.kind === 'zero' && /查到 0 条/.test(zero.line) && /不是没查成/.test(zero.line), zero.line);
    const bad = S.queryLedger({ events, recent: 'nope' });
    check('非法 recent → unscanned', bad.kind === 'unscanned', bad.line);
    const none = S.queryLedger({});
    check('没给数组 → unscanned', none.kind === 'unscanned', none.line);
    check('zero 与 unscanned 话面不同', zero.line !== none.line);
  }

  console.log('\n=== 目录扫描：缺目录 / 坏 JSON 是没查成 ===');
  {
    const missing = S.readLedgerEvents(path.join(os.tmpdir(), 'no-such-ledger-588'));
    check('目录不在 → unscanned', missing.unscanned === true, missing.error);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-q-'));
    fs.writeFileSync(path.join(tmp, 'ok.json'), JSON.stringify(events[0]));
    fs.writeFileSync(path.join(tmp, 'bad.json'), '{not json');
    const mixed = S.readLedgerEvents(tmp);
    check('有坏文件 → unscanned', mixed.unscanned === true && /不是 JSON/.test(mixed.error), mixed.error);
  }

  console.log('\n=== CLI 接线 ===');
  {
    const miss = spawnSync(process.execPath, [CLI, 'ledger-query'], { encoding: 'utf8' });
    check('缺参数非零', miss.status !== 0, miss.stdout || miss.stderr);
    const recent = spawnSync(process.execPath, [CLI, 'ledger-query', '--recent', '2'], { encoding: 'utf8' });
    check('recent CLI 退出 0', recent.status === 0, recent.stderr || recent.stdout);
    let doc;
    try { doc = JSON.parse(recent.stdout); } catch { doc = null; }
    check('recent CLI 吐 JSON 且有 line', doc && doc.ok && typeof doc.line === 'string' && doc.count === 2, recent.stdout);
    const zero = spawnSync(process.execPath, [CLI, 'ledger-query', '--issue', '1'], { encoding: 'utf8' });
    check('查到 0 条仍退出 0（不是没查成）', zero.status === 0, zero.stderr || zero.stdout);
    let z;
    try { z = JSON.parse(zero.stdout); } catch { z = null; }
    check('0 条 kind=zero', z && z.kind === 'zero' && /查到 0 条/.test(z.line), zero.stdout);
  }

  console.log(`\n${fail === 0 ? 'OK' : 'FAIL'}  ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
