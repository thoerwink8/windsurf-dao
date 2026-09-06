#!/usr/bin/env node
// 故意违规：协议帧 sessions 是 null。scanSessions 必须认 scanned:false，不许折成空名单。
console.log(JSON.stringify({ type: 'sessions', sessions: null, count: 0 }));
