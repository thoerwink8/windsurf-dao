#!/usr/bin/env node
// 查成且空：先打 type=sessions 协议帧，再零行会话。scanSessions 必须认 scanned:true。
console.log(JSON.stringify({ type: 'sessions', sessions: [], count: 0 }));
