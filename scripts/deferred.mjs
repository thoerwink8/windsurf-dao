#!/usr/bin/env node

// 用户侧挂账入口（#583 修正）。查 / 补信息 / 改状态。
// 没有新建：AI 落账只有回复里写 [[挂账:]]。add/create/new/挂账 一律 exit 2。

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  LEDGER_REL,
  applyUserOp,
  findLedgerItem,
  formatList,
  formatShow,
  parseLedger,
  serializeLedger,
} from './lib/deferred.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CREATE_VERBS = new Set(['add', 'create', 'new', 'open', '挂账']);

function arg(name, argv) {
  const i = argv.indexOf(`--${name}`);
  if (i < 0 || i + 1 >= argv.length) return '';
  return argv[i + 1];
}

function loadDoc(file) {
  if (!existsSync(file)) {
    return { ok: false, error: `账本不在：${file}（没查成，不是 0 条）` };
  }
  try {
    return { ok: true, doc: parseLedger(readFileSync(file, 'utf8')), file };
  } catch (e) {
    return { ok: false, error: `账本读不了：${String(e.message || e).slice(0, 80)}` };
  }
}

export function run(argv = process.argv.slice(2), { root = ROOT } = {}) {
  const verb = argv[0] || 'list';
  if (CREATE_VERBS.has(verb)) {
    process.stderr.write('AI 不许用这个 skill 落账；AI 落账只有回复里写 [[挂账:]]\n');
    return 2;
  }
  const file = join(root, LEDGER_REL);
  const loaded = loadDoc(file);
  if (!loaded.ok) {
    process.stderr.write(`${loaded.error}\n`);
    return 1;
  }
  if (verb === 'list' || verb === 'ls') {
    process.stdout.write(`${formatList(loaded.doc)}\n`);
    return 0;
  }
  if (verb === 'show') {
    const id = arg('id', argv);
    const item = findLedgerItem(loaded.doc.items, id);
    if (!item) {
      process.stderr.write(`无此 id ${id}\n`);
      return 1;
    }
    process.stdout.write(`${formatShow(item)}\n`);
    return 0;
  }

  let op;
  if (verb === 'note' || verb === 'annotate') {
    op = { type: 'note', id: arg('id', argv), text: arg('text', argv) };
  } else if (verb === 'reject') {
    op = { type: 'reject', id: arg('id', argv), why: arg('why', argv) };
  } else if (verb === 'wontfix') {
    op = { type: 'wontfix', id: arg('id', argv), why: arg('why', argv) };
  } else if (verb === 'priority') {
    op = { type: 'priority', id: arg('id', argv), to: arg('to', argv) };
  } else {
    process.stderr.write(`未知动词 ${verb}。只认 list / show / note / reject / wontfix / priority\n`);
    return 1;
  }
  const r = applyUserOp(loaded.doc, op);
  if (!r.ok) {
    process.stderr.write(`${r.error}\n`);
    return 1;
  }
  writeFileSync(file, serializeLedger(r.doc), 'utf8');
  process.stdout.write(`${formatShow(r.item)}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(run());
}
