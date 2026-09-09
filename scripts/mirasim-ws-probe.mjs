#!/usr/bin/env node
/**
 * mirasim-ws-probe —— 探 mirasim-server 的 ws 起会话面（#1151）。
 *
 * 病（2026-09-08 实咬）：HTTP / 还是 200、进程还在，但 ws 发不出 state 帧。
 * 指挥官整晚「会话名单读不到」——不报警、不自愈。HTTP 探活看的是口开没开，
 * 本探针看「该发生的事有没有发生」（state 帧）。同形状判例 #940。
 *
 * 为什么是独立 timer，不塞进 6 小时 LLM 巡检（cmdPatrol）：
 *   巡检自己也要起会话。ws 面瘫了，巡检也起不来，等于自己查自己。
 *   而且巡检硬边界写死「不许启停任何服务」。自愈必须走另一条路。
 *
 * 每轮：握手 → 折 strikes → 扫在途 → 连红且无在途才 restart。
 * 有在途只报警不杀。没查成（令牌不在 / 在途扫不成）不算连红，也不杀。
 *
 * 用法：
 *   node scripts/mirasim-ws-probe.mjs            # 探一轮；红项走报警/自愈，退出码 0
 *   node scripts/mirasim-ws-probe.mjs --strict   # 本轮红就退出码 1（手动/CI）
 *   node scripts/mirasim-ws-probe.mjs --quiet    # 只探不报警、不重启（调试用）
 * 装单元：sudo bash scripts/install-mirasim-ws-probe.sh
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import os from 'node:os';
import { createRuntime } from './lib/mirasim-runtime.mjs';
import { scanSessionProcs } from './lib/dispatch/lease.mjs';
import {
  DEFAULT_STRIKES_TO_ALERT,
  DEFAULT_STRIKES_TO_HEAL,
  classifyHandshake,
  classifyInFlight,
  foldWsProbe,
  decideWsHeal,
  buildWsAlert,
  buildWsRecovered,
} from './lib/mirasim-ws-probe.mjs';

const argv = process.argv.slice(2);
if (argv.includes('--install')) {
  console.error('mirasim-ws-probe --install 已退役。装法：sudo bash scripts/install-mirasim-ws-probe.sh');
  process.exit(1);
}

const STATE_FILE = process.env.MIRASIM_WS_PROBE_STATE
  || join(os.homedir(), '.local', 'state', 'mirasim-ws-probe.json');
const HUB_SAY = process.env.HUB_SAY || '/home/orca/bin/hub-say';
const HEAL_BIN = process.env.MIRASIM_WS_HEAL_BIN || '/usr/bin/sudo';
const HEAL_ARGS = process.env.MIRASIM_WS_HEAL_ARGS
  ? String(process.env.MIRASIM_WS_HEAL_ARGS).split('\n').filter(Boolean)
  : ['-n', '/usr/bin/systemctl', 'try-restart', 'mirasim-server.service'];
const STRIKES_TO_ALERT = Number(process.env.MIRASIM_WS_STRIKES_TO_ALERT || DEFAULT_STRIKES_TO_ALERT);
const STRIKES_TO_HEAL = Number(process.env.MIRASIM_WS_STRIKES_TO_HEAL || DEFAULT_STRIKES_TO_HEAL);
const QUIET = argv.includes('--quiet');
const STRICT = argv.includes('--strict');

function readJson(f, dflt) {
  try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return dflt; }
}
function writeState(state) {
  try {
    mkdirSync(dirname(STATE_FILE), { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    console.error(`  ⚠ 状态写不进 ${STATE_FILE}（${e.message}）——下轮会重复报警`);
  }
}
function say(text) {
  if (!existsSync(HUB_SAY)) { console.error(`  ⚠ ${HUB_SAY} 不在，报不出去`); return false; }
  try {
    execFileSync(HUB_SAY, [text], { stdio: 'ignore', timeout: 30_000, windowsHide: true });
    return true;
  } catch (e) {
    console.error(`  ⚠ hub-say 失败：${String(e.message).slice(0, 120)}`);
    return false;
  }
}

function runHeal() {
  try {
    execFileSync(HEAL_BIN, HEAL_ARGS, { stdio: 'pipe', timeout: 30_000, windowsHide: true });
    return { ok: true, why: `已执行 ${HEAL_BIN} ${HEAL_ARGS.join(' ')}` };
  } catch (e) {
    const msg = String((e && e.stderr && String(e.stderr)) || e.message || e).slice(0, 160);
    return { ok: false, why: `自愈失败：${msg}` };
  }
}

async function doHandshake(handshakeFn) {
  try {
    return await handshakeFn();
  } catch (error) {
    return { error };
  }
}

/**
 * 一轮探活。deps 全可注入：测试不碰真 ws / 真 systemd。
 * 返回 {folded, inflight, decision, healed, alerted} 给 journal / 退出码用。
 */
export async function runProbe(deps = {}) {
  const nowIso = deps.nowIso || new Date().toISOString();
  const handshakeFn = deps.handshake || (() => createRuntime().handshake());
  const scanFn = deps.scan || scanSessionProcs;
  const prev = deps.prev || readJson(STATE_FILE, { folded: null, alerted: false });
  const sayFn = deps.say || say;
  const healFn = deps.heal || runHeal;
  const quiet = deps.quiet === true;
  const plan = {
    strikesToAlert: deps.strikesToAlert ?? STRIKES_TO_ALERT,
    strikesToHeal: deps.strikesToHeal ?? STRIKES_TO_HEAL,
  };

  const handshake = await doHandshake(handshakeFn);
  const folded = foldWsProbe(prev.folded, handshake, nowIso);
  const inflight = classifyInFlight(scanFn());
  const decision = decideWsHeal({
    folded,
    inflight,
    strikesToAlert: plan.strikesToAlert,
    strikesToHeal: plan.strikesToHeal,
  });

  let healed = false;
  let healWhy = null;
  if (!quiet && decision.heal) {
    const r = healFn();
    healed = r.ok === true;
    healWhy = r.why;
    console.log(`  ${healed ? '↻' : '✗'} ${healWhy}`);
  }

  const wasAlerted = prev.alerted === true;
  const shouldAlert = decision.alert === true;
  if (!quiet) {
    if (shouldAlert && !wasAlerted) {
      sayFn(buildWsAlert({ folded, decision, plan }));
    } else if (!shouldAlert && wasAlerted && folded.state === 'green') {
      sayFn(buildWsRecovered({ lastWhy: prev.folded && prev.folded.why }));
    }
  }

  // --quiet 是「只探不惊动」：不推进 alerted，否则一次调试跑会把「已报过」钉上，
  // 把之后真正该报的那一声吞掉（gw-remote-probe 同一条）。
  const next = {
    folded,
    alerted: quiet ? (prev.alerted === true) : shouldAlert,
    at: nowIso,
    healed: quiet ? false : healed,
    healWhy: quiet ? null : healWhy,
    inflight: { count: inflight.count, why: inflight.why, unscanned: inflight.unscanned === true },
    decision: decision.reason,
  };
  if (typeof deps.writeState === 'function') deps.writeState(next);
  else if (!deps.skipWrite) writeState(next);

  const icon = folded.state === 'green' ? '✓' : folded.state === 'unscanned' ? '·' : '⚠';
  console.log(`  ${icon} ws ${folded.state.padEnd(9)} strikes=${folded.strikes} ${folded.why}`);
  console.log(`  · inflight ${inflight.unscanned ? 'unscanned' : inflight.count}  ${inflight.why}`);
  console.log(`  · ${decision.reason}`);

  return { folded, inflight, decision, healed, alerted: next.alerted, handshake: classifyHandshake(handshake) };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const r = await runProbe({ quiet: QUIET });
  const red = r.folded.state === 'red';
  process.exit(STRICT && red ? 1 : 0);
}
