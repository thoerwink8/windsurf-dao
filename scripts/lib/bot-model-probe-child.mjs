#!/usr/bin/env node
// 机器人模型探针的**子进程**（server-check ⑰ 用）。单独成文件，不内联进 spawnSync 的 -e：
// 内联要过两层转义，2026-09-04 实咬——写岔了整段发不出去，探针只会说「超时」，根因看不见。
//
//   node scripts/lib/bot-model-probe-child.mjs <网关地址> <模型名>
//   key 从环境变量 __PROBE_KEY__ 读——**不走 argv**：argv 是 /proc/<pid>/cmdline，全局可读、
//   ps aux 一眼看见；/proc/<pid>/environ 只有属主读得到，与「能读 key 文件本身」同一道信任边界。
//
// stdout 契约（父进程解析）：SSE 原文 + 末行 `__HTTP__<状态码>`；发不出去则 `__ERR__<原因>`。

const [base, model] = process.argv.slice(2);
const key = process.env.__PROBE_KEY__ || '';
const TIMEOUT_MS = Number(process.env.__PROBE_TIMEOUT_MS__ || 90000);

const ac = new AbortController();
const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
try {
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    signal: ac.signal,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, stream: true, max_tokens: 64, messages: [{ role: 'user', content: 'ok' }] }),
  });
  let text = '';
  if (res.body) {
    for await (const c of res.body) {
      text += Buffer.from(c).toString('utf8');
      if (text.length > 20000) break;          // 探针不需要全文，够判「有没有真内容」就收手
    }
  }
  process.stdout.write(`${text}\n__HTTP__${res.status}`);
} catch (e) {
  process.stdout.write(`__ERR__${e.name === 'AbortError' ? `超时 ${TIMEOUT_MS / 1000}s` : (e.message || e)}`);
} finally {
  clearTimeout(timer);
}
