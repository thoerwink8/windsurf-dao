#!/usr/bin/env node
// 部分枚举：有条目但 complete:false。scanSessions 必须认 scanned:false，不许折成完整观测集。
// N/M 计数必须能从协议帧读出，不能靠被截断的 stderr。
console.log(JSON.stringify({
  type: 'sessions',
  sessions: [
    { key: 'codex:partial-fixture', state: 'running' },
    { key: 'codex:other', state: 'unknown' },
  ],
  count: 2,
  ok: false,
  partial: true,
  complete: false,
  errors: [{ backend: 'mirasim', recordKey: 'codex:other', error: 'managed active scan limit' }],
  counts: { total: 2, observed: 1, unknown: 1, missing: false, errors: 1, byError: { 'managed active scan limit': 1 } },
  why: '会话名单不完整：观察到 1，未知 1，错误 1——没查成，不许折成完整空名单',
}));
process.exitCode = 2;
