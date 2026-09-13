#!/usr/bin/env node
// dao-patrol.service 的 OnFailure 兜底：巡检失败必须主动送达总控群。
// 只发纯文本，不依赖交互卡片渲染。

import { loadCredentials, DEFAULT_CREDS } from './feishu-triage.mjs';
import { sendTextViaLark } from './lib/broadcast-io.mjs';

let creds;
try {
  creds = loadCredentials(DEFAULT_CREDS);
} catch (e) {
  console.error(JSON.stringify({ ok: false, error: `巡检失败告警读凭据失败：${e.message || e}` }));
  process.exit(2);
}

const text = '[指挥官] 机制巡检没有跑成。请查看 dao-patrol.service 的 journal；本轮不能当作“巡检正常”。';
const result = sendTextViaLark({ chatId: creds.hubChatId, text });
console.log(JSON.stringify({ ok: result.ok === true, degraded: true, error: result.error || null }));
process.exit(result.ok === true ? 0 : 2);
