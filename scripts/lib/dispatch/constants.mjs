// scripts/lib/dispatch/constants.mjs —— 派单共享常量/纯工具（从 dao-cmd.mjs 拆出，避免循环依赖，#768）
// ROOT 三层路径（dispatch/ → lib/ → scripts/ → 仓库根）已验证，与 repo.mjs 拆分同款。
import { resolve, join } from 'node:path';
import { ROUTING_JSON } from '../model-routing-json.mjs';

export const ROOT = resolve(import.meta.dirname, '..', '..', '..');
export const ROUTING_FILE = join(ROOT, 'docs', 'model-routing.toml');
export const ROUTING_POLICY_FILE = ROUTING_JSON;
export const ESCAPE_LOG = join(ROOT, '_flow', 'cmd-escape.jsonl');
export const HELP_FIXTURE_DIR = join(ROOT, 'tests', 'fixtures', 'orca-help');

export const DEFAULT_THINK_GRACE_MS = 20 * 60 * 1000;
export const DEFAULT_PROCESS_ALIVE_MS = 2 * 60 * 1000;
/** 探针等屏默认值。一个所有已知情况都不成立的缺省值是陷阱：
 * grok 配 45s、codex 第一项实测 84s，没有任何 TUI 能在 8s 内跑完第一项。
 * 120s 盖住目前最慢的实测；表上仍给各 provider 显式值。
 * #559：waitAndVerify 原默认 8000ms 硬编码，pi 启动加载 skills 常常超过，
 * 派工连续死在这里——默认改为本常量，调用方再按 provider 的 probe_wait_ms 显式覆盖。 */
export const DEFAULT_PROBE_WAIT_MS = 120000;
/** worker-start 调用的物理上限（2026-08-23 fire-and-forget 拍板）：这不是认账钟——
 * orca 到点报 agent_prompt_stalled 只代表「没等到 agent 认账」，字已进终端
 * （763 实证：报 stalled 的工人其实在跑）。15s 盖住注入 + orca 返回；
 * 认账确认不在派工路做，交给 watchdog / flow / inbox.log。 */
export const WORKER_START_SEND_TIMEOUT_MS = 15000;

export function probeWaitMs(routing, provider) {
  const raw = routing?.providers?.[provider]?.probe_wait_ms;
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0) return n;
  return DEFAULT_PROBE_WAIT_MS;
}

// 漏 -a never 时 codex 会停在确认条。验开工认这些屏面，不靠「看起来在干活」。
export const CONFIRM_PATTERNS = [
  /allow this command/i,
  /allow command\??/i,
  /approval required/i,
  /ask for approval/i,
  /waiting for approval/i,
  /do you want to (allow|approve|run)/i,
  /run this command\??/i,
  /always allow/i,
  /\[y\/n\]/i,
  /待确认/,
  /批准这次/,
  /允许执行/,
];
