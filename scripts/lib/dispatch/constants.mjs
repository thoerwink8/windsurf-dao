// scripts/lib/dispatch/constants.mjs —— 派单共享常量（从 dao-cmd.mjs 拆出，避免循环依赖）
import { resolve, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export const ROOT = resolve(import.meta.dirname, '..', '..', '..');
export const ROUTING_FILE = join(ROOT, 'docs', 'model-routing.toml');
export const ROUTING_POLICY_FILE = join(ROOT, 'docs', 'model-routing.json');
export const ESCAPE_LOG = join(ROOT, '_flow', 'cmd-escape.jsonl');
export const HELP_FIXTURE_DIR = join(ROOT, 'tests', 'fixtures', 'orca-help');
export const DEFAULT_PROBE_WAIT_MS = 120000;
export const WORKER_START_SEND_TIMEOUT_MS = 15000;
export const DEFAULT_THINK_GRACE_MS = 20 * 60 * 1000;
export const DEFAULT_PROCESS_ALIVE_MS = 2 * 60 * 1000;
