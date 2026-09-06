#!/usr/bin/env node
// 跨宿主唯一 GitHub Issue 写入入口（#792）。
//
//   node scripts/issue-gateway.mjs create  --repo owner/name --title "..." --body-file f --host claude --idempotency-key k
//   node scripts/issue-gateway.mjs comment --repo owner/name --issue N --body-file f --host ... --idempotency-key k
//   node scripts/issue-gateway.mjs close   --repo owner/name --issue N [--reason completed] [--comment "..."] --host ... --idempotency-key k
//   node scripts/issue-gateway.mjs edit-labels --repo owner/name --issue N --add x --remove y --host ... --idempotency-key k
//
// 没有 --identity / --token / --role / 任意 shell。身份由网关固定 dao-marshal[bot]。

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  ACTIONS,
  applyIssueWrite,
} from './lib/issue-gateway.mjs';

const VERB = {
  create: 'issue_create',
  comment: 'issue_comment',
  close: 'issue_close',
  reopen: 'issue_reopen',
  'edit-labels': 'issue_edit_labels',
};

function usage(msg) {
  if (msg) console.error(msg);
  console.error('用法: node scripts/issue-gateway.mjs <create|comment|close|reopen|edit-labels> --repo owner/name --host <宿主> --idempotency-key <键> ...');
  console.error('  create      --title ... [--body-file f | --body ...] [--label x]');
  console.error('  comment     --issue N [--body-file f | --body ...]');
  console.error('  close       --issue N [--reason completed] [--comment ...]');
  console.error('  reopen      --issue N [--comment ...]');
  console.error('  edit-labels --issue N [--add x] [--remove y]');
  console.error('禁止旗标: --identity --token --role --cmd（身份由网关固定，不能选）');
  process.exit(2);
}

export function parseGatewayArgv(argv) {
  const a = { rest: [] };
  if (!argv.length) return { ok: false, error: '缺动作' };
  const verb = argv[0];
  if (verb.startsWith('-')) return { ok: false, error: '第一个参数必须是动作，不是旗标' };
  if (!VERB[verb]) return { ok: false, error: `未知动作「${verb}」` };
  a.action = VERB[verb];
  a.labels = [];
  a.add = [];
  a.remove = [];
  for (let i = 1; i < argv.length; i++) {
    const v = argv[i];
    const next = () => argv[++i];
    if (v === '--repo') a.repo = next();
    else if (v === '--host') a.host = next();
    else if (v === '--idempotency-key' || v === '--idempotency_key') a.idempotency_key = next();
    else if (v === '--title') a.title = next();
    else if (v === '--body') a.body = next();
    else if (v === '--body-file') {
      const p = next();
      if (!p) return { ok: false, error: '--body-file 缺路径' };
      try { a.body = readFileSync(p, 'utf8'); }
      catch (e) { return { ok: false, error: `读 --body-file 失败：${String(e.message || e).slice(0, 160)}` }; }
    }
    else if (v === '--issue') a.issue = next();
    else if (v === '--reason') a.reason = next();
    else if (v === '--comment') a.comment = next();
    else if (v === '--label') a.labels.push(next());
    else if (v === '--add') a.add.push(next());
    else if (v === '--remove') a.remove.push(next());
    else if (v === '--identity' || v === '--token' || v === '--role' || v === '--cmd' || v === '--command' || v === '--gh') {
      return { ok: false, error: `禁止旗标 ${v}：身份由网关固定 dao-marshal[bot]，不能选、不能传 token、不能交任意命令` };
    }
    else return { ok: false, error: `未知旗标 ${v}` };
  }
  if (!a.host) a.host = process.env.DAO_ISSUE_GATEWAY_HOST || '';
  return { ok: true, request: a };
}

function main(argv) {
  const parsed = parseGatewayArgv(argv);
  if (!parsed.ok) usage(parsed.error);
  const r = applyIssueWrite(parsed.request);
  if (r.ok) {
    process.stdout.write(`${JSON.stringify({
      ok: true,
      action: r.action,
      repo: r.repo,
      number: r.number,
      url: r.url,
      author: r.author || null,
      replay: !!r.replay,
    })}\n`);
    process.exit(0);
  }
  console.error(`${r.stage || 'failed'}: ${r.error}`);
  process.stdout.write(`${JSON.stringify({ ok: false, stage: r.stage, error: r.error, url: r.url || null })}\n`);
  process.exit(1);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main(process.argv.slice(2));

void ACTIONS;
