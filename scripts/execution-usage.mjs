#!/usr/bin/env node
import { collectUsage, reportUsage, syncCursorAccountUsage } from './lib/execution-usage.mjs';
import { pathToFileURL } from 'node:url';

export async function main(argv = process.argv.slice(2)) {
  const options = {};
  let collect = false, json = false, syncCursor = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') json = true;
    else if (arg === '--sync-cursor-account') syncCursor = true;
    else if (arg === '--collect' || arg === '--once') collect = true;
    else if (['--home','--dir','--group-by','--task','--source','--inbox'].includes(arg)) {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error('missing_usage_option_value');
      if (arg === '--group-by') options.groupBy = value.split(',').map(k => ({task:'taskId',accountPool:'accountPoolId'})[k] || k);
      else if (arg === '--task') options.taskId = value;
      else if (arg === '--inbox') (options.inboxes ||= []).push(value);
      else if (arg === '--source') {
        const split = value.indexOf('=');
        if (split < 1 || split === value.length - 1) throw new Error('invalid_usage_source');
        (options.sources ||= []).push({source: value.slice(0,split), path: value.slice(split+1)});
      }
      else options[arg.slice(2)] = value;
    } else if (arg === '--help') {
      console.log('execution-usage [--collect|--once] [--sync-cursor-account] [--inbox PATH] [--json] [--home PATH] [--dir PATH] [--task ID] [--group-by task,agent,provider,accountPool,model]\nOptional repeated --source SOURCE=PATH replaces default discovery (e.g. devin-export=/tmp/probe/export.json).\nDefault reports local data. --collect commits local observations. --sync-cursor-account reads the official Cursor Dashboard API using existing local OAuth auth; never runs a model.\nConfiguration: ~/.dao/execution/usage-config.json {"accountPools":{"devin":"shared","windsurf":"shared"},"sources":[],"inboxes":[]}.\nUnknown metrics are null; charges, estimates and account balances are separate. taskAccounting states per-task completeness.');
      return 0;
    } else throw new Error('unknown_usage_option');
  }
  if (syncCursor) await syncCursorAccountUsage(options);
  const collected = collect ? collectUsage(options) : null;
  const result = reportUsage(options);
  if (collected?.busy) { result.complete = false; result.gaps.push('collector_busy'); }
  if (json) console.log(JSON.stringify(result));
  else {
    console.log(`Execution usage: ${result.groups.length} groups, ${result.deduplicatedRecords} records; collection ${result.complete ? 'complete' : 'partial'}`);
    console.log(`Accounting: ${result.taskAccounting.filter(t => t.complete).length}/${result.taskAccounting.length} tasks have reported tokens and charges`);
    for (const g of result.groups) {
      const dims = result.groupBy.map(k => `${k}=${g[k] ?? 'unknown'}`).join(' ');
      const fmt = x => x === null ? 'unknown' : x;
      console.log(`${dims}\n  input=${fmt(g.metrics.inputTokens)} output=${fmt(g.metrics.outputTokens)} cacheRead=${fmt(g.metrics.cacheReadTokens)} charges=${g.charges.length ? JSON.stringify(g.charges) : 'unknown'} estimates=${g.estimates.length ? JSON.stringify(g.estimates) : 'unknown'} unknownCharges=${g.unknownCharges}\n  sources=${g.sources.join(',')} gaps=${g.gaps.join(',') || 'none'}`);
    }
    if (result.accountSnapshots.length) console.log(`Account snapshots (not task charges): ${JSON.stringify(result.accountSnapshots)}`);
    if (result.unallocatedSummaries.length) console.log(`Unallocated session summaries: ${JSON.stringify(result.unallocatedSummaries)}`);
    if (result.gaps.length) console.log(`Collection gaps: ${result.gaps.join(', ')}`);
  }
  return result.complete ? 0 : 2;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.exitCode = await main(); }
  catch { console.error('execution_usage_failed (no source payloads or credentials logged)'); process.exitCode = 1; }
}
