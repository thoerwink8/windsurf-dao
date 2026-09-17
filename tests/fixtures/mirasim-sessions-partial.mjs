#!/usr/bin/env node
// 部分枚举：有条目但 complete:false。scanSessions 必须认 scanned:false，不许折成完整观测集。
console.log(JSON.stringify({
  type: 'sessions',
  sessions: [{ key: 'codex:partial-fixture' }],
  count: 1,
  ok: false,
  partial: true,
  complete: false,
}));
process.exitCode = 2;
