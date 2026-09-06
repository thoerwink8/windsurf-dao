#!/usr/bin/env node
// scripts/hub-ask.mjs —— 出站发一张待拍板交互卡片（#1012）
//
// 给 CLI / 指挥官调用。卡片构造只走 buildHubCard（scripts/lib/feishu-hub-card.mjs）。
// 凭据只读现有 ~/.mirasim/keys/feishu-app.json（与 hub-say / feishu-triage 同一份），key 不进代码。
// 不改仓外 /home/orca/bin/hub-say。
//
// 用法：
//   node scripts/hub-ask.mjs --repo <owner/name> --number <N> [--what ...] [--recommend ...]
// stdout：message_id（拿到才算发出去）
// 失败退非 0，stderr 带「没送进群」或「拒发」。

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  runHubAsk, sendCardViaLarkCli, validateHubAsk,
} from './lib/hub-ask.mjs';
import {
  loadCredentials, createStateStore, DEFAULT_CREDS, DEFAULT_STATE,
} from './feishu-triage.mjs';

const HERE = fileURLToPath(import.meta.url);

const FLAGS = ['repo', 'number', 'url', 'title', 'from', 'what', 'impact', 'recommend', 'why', 'deadline', 'creds', 'state'];

export function parseHubAskArgs(argv = []) {
  const out = { help: false };
  const rest = [...argv];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--help' || a === '-h') {
      out.help = true;
      continue;
    }
    if (!a.startsWith('--')) throw new Error(`不认识参数：${a}`);
    const key = a.slice(2);
    if (!FLAGS.includes(key)) throw new Error(`不认识参数：${a}`);
    const v = rest[i + 1];
    if (v === undefined || v.startsWith('--')) throw new Error(`参数 ${a} 缺值`);
    out[key] = v;
    i += 1;
  }
  return out;
}

export function printHelp() {
  console.log(`出站待拍板卡片（issue #1012）
用法：
  node scripts/hub-ask.mjs --repo <owner/name> --number <N> [字段...]
必填：
  --repo     仓库（owner/name）
  --number   issue 号（正整数）
选填字段（进卡片正文 / hubPending）：
  --url --title --from --what --impact --recommend --why --deadline
路径：
  --creds    凭据（默认 ~/.mirasim/keys/feishu-app.json）
  --state    hubPending 落盘（默认 ~/.dao/feishu-threads.json）
stdout：message_id；失败退非 0。`);
}

export function main(argv = process.argv.slice(2)) {
  let opts;
  try {
    opts = parseHubAskArgs(argv);
  } catch (e) {
    console.error(e.message);
    printHelp();
    return 1;
  }
  if (opts.help) {
    printHelp();
    return 0;
  }
  const v = validateHubAsk(opts);
  if (!v.ok) {
    console.error(v.error);
    return 1;
  }
  let creds;
  try {
    creds = loadCredentials(opts.creds || DEFAULT_CREDS);
  } catch (e) {
    console.error(`没送进群：${e.message}`);
    return 1;
  }
  if (!creds.hubChatId) {
    console.error('没送进群：凭据无 hubChatId');
    return 1;
  }
  const store = createStateStore(opts.state || DEFAULT_STATE);
  const r = runHubAsk({ ...opts, repo: v.repo, number: v.number }, {
    store,
    send: (card) => sendCardViaLarkCli({ chatId: creds.hubChatId, card }),
  });
  if (!r.ok) {
    console.error(r.error);
    return 1;
  }
  console.log(r.messageId);
  return 0;
}

const isDirectRun = process.argv[1] && resolve(process.argv[1]) === HERE;
if (isDirectRun) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (e) {
    console.error(e.message || String(e));
    process.exit(1);
  }
}
