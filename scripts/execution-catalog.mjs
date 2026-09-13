#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { DEFAULT_CATALOG_PATH, loadExecutionCatalog, discoverExecutionCredentials, refreshExecutionCatalog, selectExecutionProfile, writeExecutionCatalog, freshness } from './lib/execution-catalog.mjs';

const HELP = `Execution catalog (no live model generation or config writes)
  node scripts/execution-catalog.mjs list [--catalog FILE] [--json]
  node scripts/execution-catalog.mjs discover [--home DIR] [--json]
  node scripts/execution-catalog.mjs refresh [--home DIR] [--catalog FILE] [--output FILE] [--source ID] [--json]
  node scripts/execution-catalog.mjs select --role companion|review-low-risk|implementation|architecture|review
       [--task '{"risk":"low","inputTokens":10000,"outputTokens":2000}']
       [--author-profile ID | --author-family FAMILY] [--allow-unknown-price] [--json]
Refresh stores only model/price/source/freshness snapshots; listings never prove execution.
Prices marked reference are public metadata, not account billing. Unknown prices are excluded
unless --allow-unknown-price is explicit. A cost ceiling still requires a known price.
Exit: 0 success (list is an inventory, not a health check), 2 blocked/partial refresh, 1 invalid input.`;

export async function main(argv = process.argv.slice(2), { stdout = console.log, stderr = console.error, refresh = refreshExecutionCatalog } = {}) {
  if (argv.includes('--help') || !argv.length) { stdout(HELP); return 0; }
  const command = argv[0], args = {};
  const flags = new Set(['--json', '--allow-unknown-price']);
  const values = new Set(['--catalog', '--home', '--output', '--source', '--role', '--task', '--author-profile', '--author-family']);
  for (let i = 1; i < argv.length; i++) {
    if (flags.has(argv[i])) args[argv[i].slice(2)] = true;
    else if (values.has(argv[i]) && argv[i + 1] && !argv[i + 1].startsWith('--')) args[argv[i].slice(2)] = argv[++i];
    else { stderr('Unknown option or missing value; use --help.'); return 1; }
  }
  const print = value => stdout(JSON.stringify(value, null, args.json ? 2 : undefined));
  try {
    if (command === 'discover') { print({ credentials: discoverExecutionCredentials({ home: args.home }) }); return 0; }
    const file = args.catalog ?? DEFAULT_CATALOG_PATH, catalog = loadExecutionCatalog(file);
    if (command === 'list') {
      print({ schemaVersion: catalog.schemaVersion, updatedAt: catalog.updatedAt, profiles: catalog.profiles.map(p => ({ ...p, freshness: freshness(p.availability.checkedAt, { maxAgeHours: catalog.freshness?.maxAgeHours ?? 24 }) })) });
      return 0;
    }
    if (command === 'refresh') {
      if (args.source && !catalog.sources.some(s => s.id === args.source && s.kind !== 'evidence' && s.enabled !== false)) { stderr('Source is missing or not refreshable.'); return 1; }
      const result = await refresh(catalog, { home: args.home, sourceIds: args.source ? [args.source] : undefined });
      writeExecutionCatalog(result.catalog, args.output ?? file);
      print({ ok: result.ok, updatedAt: result.catalog.updatedAt, reports: result.reports });
      return result.ok ? 0 : 2;
    }
    if (command === 'select') {
      const task = args.task ? JSON.parse(args.task) : {};
      if (!task || typeof task !== 'object' || Array.isArray(task)) { stderr('Task must be a JSON object.'); return 1; }
      const result = selectExecutionProfile(catalog, { role: args.role, task, authorProfileId: args['author-profile'], authorFamily: args['author-family'], allowUnknownPrice: !!args['allow-unknown-price'] });
      print(result); return result.status === 'selected' ? 0 : 2;
    }
    stderr('Unknown command; use --help.'); return 1;
  } catch { stderr('Catalog operation failed; check schema, paths and JSON arguments. No credential or upstream error body is printed.'); return 1; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main();
