#!/usr/bin/env node
// 腿表选择的命令入口：看推荐列表（人读）或输出 JSON（机器读）。
//
//   node scripts/leg-choice.mjs --role executor [--exclude-family xai] [--json]
//
// 判定全在 scripts/lib/leg-choice.mjs（纯函数）；本文件只做参数解析、读盘（loadLegChoiceData）与打印。
import { chooseLeg, renderLegTable, loadLegChoiceData } from './lib/leg-choice.mjs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function argsOf(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[key] = true;
      else { out[key] = next; i += 1; }
    } else out._.push(token);
  }
  return out;
}

function main() {
  const args = argsOf(process.argv.slice(2));
  const role = String(args.role || '');
  if (!['lead', 'executor', 'reviewer'].includes(role)) {
    process.stderr.write('用法：node scripts/leg-choice.mjs --role lead|executor|reviewer [--exclude-family <f>] [--json]\n');
    return 2;
  }
  const excludeFamilies = args['exclude-family']
    ? String(args['exclude-family']).split(',').map(value => value.trim()).filter(Boolean)
    : [];
  const data = loadLegChoiceData({ root: ROOT });
  const result = chooseLeg({ profiles: data.profiles, role, excludeFamilies, health: data.health, breaker: data.breaker, headroom: data.headroom, history: data.history, now: Date.now() });
  result.notes = [...data.notes, ...result.notes];
  if (args.json === true) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else process.stdout.write(`${renderLegTable(result)}\n`);
  return result.recommended ? 0 : 1;
}

process.exit(main());
