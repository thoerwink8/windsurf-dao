#!/usr/bin/env node
// scripts/mirasim-sessions.mjs —— 列 mirasim 会话（只读），给活性观测器当 mirasim 驱动的数据源。
//
// 为什么在仓里：此前这个能力只存在于服务器家目录里一个写着「用完即删」的临时诊断脚本。
// 观测器指过去就是指向空气的指针（CLAUDE.md：留指针要配报警，配不了就别留）。收进仓，随部署走。
//
// 用法：
//   node scripts/mirasim-sessions.mjs            每行一个会话 JSON
//   node scripts/mirasim-sessions.mjs --count    只打条数
//
// 退出码：0 查成（0 条也算查成）/ 2 没查成（连不上 / 拿不到 token / 超时）。
// 「0 条」与「没查成」必须分得开——前者 exit 0 且打印 0，后者 exit 2 并说清为什么。
//
// 端口与 token：mirasim 本地 API 把 token 写在 ~/.mirasim/run/local-<port>.token。
// 端口默认 4316，可用 MIRASIM_PORT 覆盖。

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const PORT = Number(process.env.MIRASIM_PORT || 4316);
const RUN_DIR = process.env.MIRASIM_RUN_DIR || join(homedir(), '.mirasim', 'run');
const TIMEOUT_MS = Number(process.env.MIRASIM_LS_TIMEOUT_MS || 8000);

function bail(why) {
  console.error(`mirasim 会话没查成：${why}`);
  process.exit(2);
}

function readToken() {
  if (!existsSync(RUN_DIR)) return { ok: false, why: `运行目录不在（${RUN_DIR}）——本机可能没装 mirasim` };
  let names;
  try { names = readdirSync(RUN_DIR); } catch (e) { return { ok: false, why: `运行目录读不了：${e.message || e}` }; }
  const want = `local-${PORT}.token`;
  if (!names.includes(want)) {
    return { ok: false, why: `没有端口 ${PORT} 的 token（目录里有：${names.join(',') || '空'}）` };
  }
  try {
    return { ok: true, token: readFileSync(join(RUN_DIR, want), 'utf8').trim() };
  } catch (e) {
    return { ok: false, why: `token 读不了：${e.message || e}` };
  }
}

async function main() {
  const countOnly = process.argv.slice(2).includes('--count');
  const t = readToken();
  if (!t.ok) bail(t.why);
  if (typeof WebSocket !== 'function') bail('本 node 没有内置 WebSocket（需要 Node 22+）');

  const url = `ws://127.0.0.1:${PORT}/ws?token=${encodeURIComponent(t.token)}`;
  const sessions = await new Promise((resolve) => {
    let ws;
    try { ws = new WebSocket(url); } catch (e) { resolve({ ok: false, why: `连不上：${e.message || e}` }); return; }
    const timer = setTimeout(() => {
      try { ws.close(); } catch { /* 关不掉也要出结果 */ }
      resolve({ ok: false, why: `${TIMEOUT_MS}ms 内没等到 sessions 帧` });
    }, TIMEOUT_MS);
    ws.onerror = (e) => {
      clearTimeout(timer);
      resolve({ ok: false, why: `WebSocket 出错：${e?.message || 'unknown'}` });
    };
    ws.onmessage = (ev) => {
      let f;
      try { f = JSON.parse(ev.data); } catch { return; }
      if (f && f.type === 'sessions') {
        clearTimeout(timer);
        try { ws.close(); } catch { /* 已经拿到数据，关不掉不影响 */ }
        resolve({ ok: true, list: Array.isArray(f.sessions) ? f.sessions : [] });
      }
    };
    ws.onopen = () => ws.send(JSON.stringify({ type: 'listSessions' }));
  });

  if (!sessions.ok) bail(sessions.why);
  if (countOnly) { console.log(sessions.list.length); return; }
  for (const s of sessions.list) {
    // 只输出观测器要的字段：key / title / state / cwd（+ 有就带上活动时间）。
    console.log(JSON.stringify({
      // 字段名以 mirasim 实际返回为准（2026-09-05 实测：sessionKey / runState / updatedAt / workdir）。
      // 早先按猜的名字取（key/state/cwd）全是 null，整条腿静默采不到——猜字段名的代价就是这个。
      key: s.sessionKey ?? s.key ?? s.id ?? null,
      title: s.title ?? null,
      state: s.runState ?? s.state ?? null,
      cwd: s.workdir ?? s.cwd ?? null,
      lastActivityAt: s.seatAt ?? s.updatedAt ?? s.lastActivityAt ?? null,
    }));
  }
}

main().catch((e) => bail(String(e?.message || e)));
