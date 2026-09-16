#!/usr/bin/env node
// Installed as root:root under /usr/local/lib/dao-execution-usage. Never run the
// orca-writable checkout as a privileged timer. Exports counters and hashed IDs,
// not raw traffic, transcripts, config, auth files, prompts or account objects.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { collectUsage, publishUsageInbox } from './lib/execution-usage.mjs';

export function exportRootMirasim({ home = '/root', dir = '/var/lib/dao-execution-usage/private', inbox = '/var/lib/dao-execution-usage/root-inbox', readerGid, limits } = {}) {
  const collection = collectUsage({ home, dir, limits, mirasimOnly: true, readConfig: false, inboxes: [] });
  const exported = publishUsageInbox({ dir, inbox, readerGid, limits });
  return { collection, exported };
}

export function main(argv = process.argv.slice(2)) {
  if (argv.length === 1 && argv[0] === '--help') {
    console.log('Root-owned local exporter: /root/.mirasim/{insights,traffic} -> /var/lib/dao-execution-usage/root-inbox. No network or model calls.');
    return 0;
  }
  if (argv.length || process.getuid?.() !== 0) throw new Error('root_export_requires_installed_service');
  const readerGid = Number(execFileSync('/usr/bin/id', ['-g', 'orca'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' }, windowsHide: true }).trim());
  const result = exportRootMirasim({ readerGid });
  console.log(JSON.stringify(result));
  // Status-class catch-up stays visible on the manifest. Exit 2 is only a
  // fault (unreadable / bad format / stall), so the oneshot is not a
  // permanent --failed noise source (#1231).
  return result.collection?.busy || result.collection?.gaps?.length ? 2 : 0;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { process.exitCode = main(); }
  catch { console.error('execution_usage_export_failed'); process.exitCode = 1; }
}
