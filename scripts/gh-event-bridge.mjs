#!/usr/bin/env node
// scripts/gh-event-bridge.mjs —— GitHub 事件桥：有人动了 PR，那一刻就叫醒指挥官（#956）
//
// 在解决什么：服务器上最快的一路是 commander-act 每 20 分钟一轮。
// 「审官判定落地」「PR 合并要关单」「工人交卷要起审官」这三件都是**有人做了个动作**，
// 却要靠下一次轮询才被发现——#903 实咬「三票落了 20 分钟无人处置」。
//
// 怎么做的：跑 `gh webhook forward`，它往仓上建一个 hook（投递地址是 GitHub 自己的
// webhook-forwarder），再用一条**出站** wss 把投递拉回本机 stdout。
//   · 本机不监听任何端口，不需要域名、不需要证书、不花钱。
//   · 因此 #956 正文里「HTTP 端点 + X-Hub-Signature-256」那一层不是「省了」，是**不存在**：
//     签名防的是「谁都能往我的端点 POST」，而这里没有可以 POST 的入口。
//     谁要是改回 `--url`（起本地监听），签名校验必须一起加回来。
//
// 桥不做判断：收到事件只是 `systemctl start` 已有的那两个单元，
// 真正的判据仍在 close-issues.mjs / commander.mjs act 里。一把尺只在一处。
//
// 兜底没省：dao-close-issues.timer（每小时）、commander-act.timer（每 20 分钟）原样留着。
// webhook 会丢（网络、重启、GitHub 抽风），桥停了就退回定时器的节奏，事情还是会做，只是慢。
//
// 「它悄悄停了」和「这段时间没有事发生」怎么分开：桥每 10 分钟朝自己的 hook 打一次 ping，
// GitHub 会把这个 ping 从同一条通道送回来。那是一个**自己造的样本**——
// 通道通的时候样本一定不为 0。server-check ㉓ 判绿的前提是「最近收到过 ping」，
// 不是「没报错」。判据在 lib/gh-events.mjs 的 classifyGhEventBridge。
//
// 用法：
//   node scripts/gh-event-bridge.mjs              常驻（systemd 用这条）
//   node scripts/gh-event-bridge.mjs --once       只连一次、收到第一个 ping 就退（装机自检用）
//   node scripts/gh-event-bridge.mjs status       读状态文件报三态，退出码 0/1/2
//   node scripts/gh-event-bridge.mjs --dry-run    不真叫单元，只把会叫谁打出来
//
// 环境变量：
//   GH_EVENTS_REPO       仓（默认 thoerwink8/windsurf-dao）
//   GH_EVENTS_STATE      状态文件（默认 ~/.dao/gh-events.json）
//   GH_EVENTS_COOLDOWN_MS / GH_EVENTS_PING_MS   节流与自证 ping 节奏（测试用）
//   GH_EVENTS_FORWARD_CMD  假的 forward 命令（测试用，默认 gh）
//
// stdout：JSON Lines，每条一行，进 journal。诊断走 stderr。

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';

import { DEFAULT_REPO } from './lib/shuai-scan.mjs';
import {
  FORWARD_EVENTS, HEARTBEAT_MS, PING_INTERVAL_MS, DEFAULT_COOLDOWN_MS,
  FIRST_PING_MS, FORWARDER_HOST,
  createForwardParser, routeEvent, planTrigger, classifyGhEventBridge,
  asHookId, ownInvalidHookIds, claimLiveHook, isolateOrphanAfterSweep,
  interpretHookPingResult, planReconnectBackoff, shouldSpawnForward,
} from './lib/gh-events.mjs';

const HERE = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(HERE), '..');

const REPO = process.env.GH_EVENTS_REPO || DEFAULT_REPO;
const STATE_PATH = process.env.GH_EVENTS_STATE || join(homedir(), '.dao', 'gh-events.json');
const COOLDOWN_MS = Number(process.env.GH_EVENTS_COOLDOWN_MS) || DEFAULT_COOLDOWN_MS;
const PING_MS = Number(process.env.GH_EVENTS_PING_MS) || PING_INTERVAL_MS;
const FORWARD_CMD = process.env.GH_EVENTS_FORWARD_CMD || 'gh';

// 叫单元这一步是本桥唯一要 root 的动作，走 /etc/sudoers.d/dao-gh-events 里写死的两条。
// 写死绝对路径：sudoers 白名单是按命令行原样匹配的，这里少一个字就静默失败。
const SUDO = '/usr/bin/sudo';
const SYSTEMCTL = '/usr/bin/systemctl';

const nowIso = () => new Date().toISOString();
const out = (o) => { process.stdout.write(JSON.stringify({ at: nowIso(), ...o }) + '\n'); };
const diag = (s) => { process.stderr.write(`${s}\n`); };

// ── 状态文件：原子写（先写同目录 tmp 再 rename），读的一方永远看不到半截 JSON ──
function saveState(state) {
  const dir = dirname(STATE_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${STATE_PATH}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  renameSync(tmp, STATE_PATH);
}

export function readState(path = STATE_PATH) {
  try { return { probed: true, state: JSON.parse(readFileSync(path, 'utf8')) }; }
  catch (e) {
    // 文件不在 = 这台机器没装，不是「装了但没事发生」——两者都不判绿，但理由要说得出来。
    return { probed: false, reason: `事件桥状态文件读不到（${path}）：${e.code === 'ENOENT' ? '没有这个文件，这台机器装了吗' : e.message}` };
  }
}

// ── 叫醒单元 ──
//
// 为什么走 systemctl 而不是直接 `node scripts/commander.mjs act`：
// commander 的 state.json 没有锁，事件触发的那一次和定时器那一次撞上就会互相盖写
// （丢 wakeCounts = 多起一个大脑 = 多花一次钱）。systemd 对同一个 oneshot 单元
// 只会有一个启动 job，第二次 start 自动并进去——串行是白拿的。
function triggerUnit(unit, { dryRun }) {
  if (dryRun) return { ok: true, dryRun: true };
  const r = spawnSync(SUDO, ['-n', SYSTEMCTL, 'start', '--no-block', unit], {
    encoding: 'utf8', timeout: 20000, windowsHide: true,
  });
  if (r.error) return { ok: false, error: String(r.error.message || r.error).slice(0, 200) };
  if (r.status !== 0) {
    return { ok: false, error: `exit ${r.status}：${String(r.stderr || r.stdout || '').trim().slice(0, 200)}` };
  }
  return { ok: true };
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    diag(readFileSync(HERE, 'utf8').split('\n').filter((l) => l.startsWith('//')).join('\n'));
    process.exit(0);
  }
  if (argv[0] === 'status') return cmdStatus(argv);
  return runBridge({ dryRun: argv.includes('--dry-run'), once: argv.includes('--once') });
}

function cmdStatus(argv) {
  const got = readState();
  const v = classifyGhEventBridge({ ...got, pingIntervalMs: PING_MS });
  if (argv.includes('--json')) out({ check: 'gh-event-bridge', ...v });
  else diag(`[${v.state}] ${v.detail}`);
  process.exit(v.state === 'ok' ? 0 : v.state === 'red' ? 1 : 2);
}

// 启动/重连时只扫**自家失效** hook。两条实测（2026-09-05，别照直觉推）：
//   · 只 SIGTERM 桥、没管子进程 → **子进程活下来了**，连接还在、hook 还在仓上。
//     这是真见过的那次（手跑调试时 pkill 桥，事后 `gh api .../hooks` 里还挂着一个）。
//   · SIGKILL 桥和子进程 → hook **自己没了**。连接一断，GitHub 那边的 forwarder 自己收摊，
//     不需要 gh 来删。所以「硬杀会漏 hook」这个直觉是错的。
// 也就是说真正会漏的是**孤儿子进程留下的自家 hook**。systemd 用 KillMode=control-group
// 堵住了 cgroup 内的孤儿进程；这个扫描是给手跑调试、EOF 后父进程自己重连、以及
// 任何绕过 cgroup 的杀法兜底。
// 2026-09-14 实咬：宽扫所有 webhook-forwarder hook 会误伤别人的活 hook；
// EOF 后只 5 秒重连、不扫自家孤儿，会把通道卡死几十小时。归属判据在 ownInvalidHookIds。
export { FORWARDER_HOST, ownInvalidHookIds, claimLiveHook, isolateOrphanAfterSweep };

function isChildAlive(c) {
  return !!(c && c.exitCode === null && !c.killed);
}

function listHooks() {
  const list = spawnSync(FORWARD_CMD, ['api', `repos/${REPO}/hooks`], { encoding: 'utf8', timeout: 30000, windowsHide: true });
  if (list.status !== 0) {
    out({ type: 'hook-list-failed', why: String(list.stderr || '').trim().slice(0, 200) });
    return null;
  }
  try { return JSON.parse(list.stdout || '[]'); }
  catch { out({ type: 'hook-list-failed', why: 'hook 清单解析不了' }); return null; }
}

function remainingHookIds(hooks, deletedIds = []) {
  const gone = new Set((deletedIds || []).map(asHookId).filter((id) => id != null));
  return hooks.map((h) => asHookId(h?.id)).filter((id) => id != null && !gone.has(id));
}

function sweepOwnInvalidHooks(ctx) {
  const hooks = listHooks();
  if (!hooks) {
    out({ type: 'hook-sweep-skipped', why: '清单没查成，不删' });
    return { listed: false, deletedIds: [], failedIds: [], remainingIds: null };
  }
  const ids = ownInvalidHookIds({ hooks, events: FORWARD_EVENTS, ...ctx });
  if (!ids.length) {
    out({ type: 'hook-sweep', deleted: [], note: '没有可安全删除的自家失效 hook' });
    return { listed: true, deletedIds: [], failedIds: [], remainingIds: remainingHookIds(hooks) };
  }
  const deletedIds = [];
  const failedIds = [];
  for (const id of ids) {
    const del = spawnSync(FORWARD_CMD, ['api', '-X', 'DELETE', `repos/${REPO}/hooks/${id}`], { encoding: 'utf8', timeout: 30000, windowsHide: true });
    const ok = del.status === 0;
    out({ type: 'hook-swept', hookId: id, ok, note: '自家失效 hook' });
    if (ok) deletedIds.push(id);
    else failedIds.push(id);
  }
  return { listed: true, deletedIds, failedIds, remainingIds: remainingHookIds(hooks, deletedIds) };
}

function previousOwnership() {
  const prev = readState();
  if (!prev.probed || !prev.state || typeof prev.state !== 'object') {
    return { ownedHookId: null };
  }
  const owned = asHookId(prev.state.hookId) || asHookId(prev.state.forward?.orphanHookId);
  return { ownedHookId: owned };
}

function runBridge({ dryRun, once }) {
  const prevOwn = previousOwnership();
  const state = {
    schema: 1,
    pid: process.pid,
    repo: REPO,
    events: FORWARD_EVENTS,
    startedAt: nowIso(),
    heartbeatAt: nowIso(),
    hookId: null,
    ping: { intervalMs: PING_MS, sentAt: null, recvAt: null },
    lastEvent: null,
    counts: { received: 0, routed: 0, ignored: 0, malformed: 0, pings: 0 },
    triggers: {},
    // recentExits 存的是断开时刻，不是累计次数：跑了三个月自然会断过几次，
    // 「在抽风」要看的是**近一小时断了几次**。留最近 20 条够算，不留成日志。
    forward: {
      restarts: 0, lastExitAt: null, lastExitCode: null, recentExits: [],
      spawnAt: null, attempt: 0, backoffMs: 0, atCap: false,
      orphanHookId: prevOwn.ownedHookId,
    },
  };
  saveState(state);

  const lastFiredAt = new Map();   // unit -> ms
  const scheduled = new Map();     // unit -> timeout handle
  let child = null;
  let stopping = false;
  let reconnectTimer = null;
  let firstPingTimer = null;
  let reconnectAttempt = 0;
  let pingRetryCount = 0;
  let spawnAt = null;
  let isolatedHookIds = [];

  const fire = (unit, why) => {
    const r = triggerUnit(unit, { dryRun });
    lastFiredAt.set(unit, Date.now());
    const t = state.triggers[unit] || { lastAt: null, fails: 0, lastError: null, count: 0 };
    t.lastAt = nowIso();
    t.count += 1;
    if (r.ok) { t.fails = 0; t.lastError = null; } else { t.fails += 1; t.lastError = r.error; }
    state.triggers[unit] = t;
    saveState(state);
    out({ type: 'trigger', unit, why, ok: r.ok, ...(r.ok ? {} : { error: r.error }), ...(dryRun ? { dryRun: true } : {}) });
  };

  const wake = (unit, why) => {
    const plan = planTrigger({ lastFiredAt: lastFiredAt.get(unit) || null, now: Date.now(), cooldownMs: COOLDOWN_MS });
    if (plan.fire) return fire(unit, why);
    // 冷却中：攒到期末补一发，事件不丢。已经排了就不再排第二个。
    if (scheduled.has(unit)) return;
    const delay = Math.max(0, plan.scheduleAt - Date.now());
    const h = setTimeout(() => { scheduled.delete(unit); fire(unit, `${why}（冷却期补发）`); }, delay);
    if (h.unref) h.unref();
    scheduled.set(unit, h);
    out({ type: 'deferred', unit, why, inMs: delay });
  };

  const markChannelLive = () => {
    reconnectAttempt = 0;
    pingRetryCount = 0;
    state.forward.attempt = 0;
    state.forward.backoffMs = 0;
    state.forward.atCap = false;
    state.forward.orphanHookId = null;
  };

  const applySweep = (ctx) => {
    const sweep = sweepOwnInvalidHooks(ctx);
    const was = asHookId(state.forward.orphanHookId);
    const iso = isolateOrphanAfterSweep({
      orphanHookId: was,
      listed: sweep.listed,
      deletedIds: sweep.deletedIds,
      failedIds: sweep.failedIds,
      remainingIds: sweep.remainingIds,
    });
    if (iso.isolated && was != null) {
      if (!isolatedHookIds.includes(was)) isolatedHookIds.push(was);
      out({ type: 'hook-orphan-isolated', hookId: was, why: iso.why });
    }
    state.forward.orphanHookId = iso.orphanHookId;
    saveState(state);
    return sweep;
  };

  const armPingRetry = () => {
    if (stopping || state.ping.recvAt || firstPingTimer || pingRetryCount >= 5) return;
    pingRetryCount += 1;
    firstPingTimer = setTimeout(() => { firstPingTimer = null; sendPing(); }, FIRST_PING_MS);
    if (firstPingTimer.unref) firstPingTimer.unref();
  };

  // 自证 ping：朝自己的 hook 打一针，等它从同一条通道回来。
  // hookId 优先从收到的 ping 学；初始 ping 丢失时只认已保存的 ownedHookId，
  // 清退失败后的旧 orphan 已被隔离。404 则作废不沿用。
  const sendPing = () => {
    if (stopping) return;
    let hookId = asHookId(state.hookId);
    if (hookId == null) {
      const hooks = listHooks();
      hookId = claimLiveHook({
        hooks,
        ownedHookId: asHookId(state.forward.orphanHookId),
        skipHookIds: isolatedHookIds,
        events: FORWARD_EVENTS,
      });
      if (hookId == null) {
        out({ type: 'ping-unresolved', why: 'hookId 还没认下，稍后自愈' });
        armPingRetry();
        return;
      }
      state.hookId = hookId;
      out({ type: 'hook', hookId, note: '清单认下（初始 ping 丢失自愈）' });
      saveState(state);
    }
    const r = spawnSync(FORWARD_CMD, ['api', '-X', 'POST', `repos/${REPO}/hooks/${hookId}/pings`], {
      encoding: 'utf8', timeout: 30000, windowsHide: true,
    });
    state.ping.sentAt = nowIso();
    const parsed = interpretHookPingResult({ status: r.status, stderr: r.stderr, stdout: r.stdout });
    if (!parsed.ok) {
      out({ type: 'ping-send-failed', hookId, gone: parsed.gone, error: parsed.why });
      if (parsed.gone) {
        out({ type: 'hook-invalidated', hookId, why: 'ping 404，旧 hookId 不沿用' });
        state.hookId = null;
        armPingRetry();
      }
    }
    saveState(state);
  };

  const onEvent = (ev) => {
    state.counts.received += 1;
    const route = routeEvent(ev);
    if (route.kind === 'ping') {
      state.counts.pings += 1;
      state.ping.recvAt = nowIso();
      markChannelLive();
      if (route.hookId != null && state.hookId !== route.hookId) {
        state.hookId = route.hookId;
        out({ type: 'hook', hookId: route.hookId, note: '自证 ping 的落点已认下' });
      }
      saveState(state);
      out({ type: 'ping-received', hookId: state.hookId });
      if (once) { stop(0); }
      return;
    }
    if (route.kind === 'malformed') { state.counts.malformed += 1; saveState(state); out({ type: 'malformed', why: route.why }); return; }
    state.lastEvent = { at: nowIso(), type: ev.type, action: ev.payload?.action || null, kind: route.kind };
    if (!route.units.length) { state.counts.ignored += 1; saveState(state); out({ type: 'ignored', why: route.why }); return; }
    state.counts.routed += 1;
    saveState(state);
    out({ type: 'event', event: ev.type, kind: route.kind, why: route.why, units: route.units });
    for (const u of route.units) wake(u, route.why);
  };

  const scheduleReconnect = ({ why, ownedHookId }) => {
    if (stopping) return;
    if (reconnectTimer) return;
    const owned = asHookId(ownedHookId);
    if (owned) state.forward.orphanHookId = owned;
    const plan = planReconnectBackoff({ attempt: reconnectAttempt });
    reconnectAttempt += 1;
    state.forward.attempt = reconnectAttempt;
    state.forward.backoffMs = plan.delayMs;
    state.forward.atCap = plan.atCap;
    saveState(state);
    out({
      type: 'forward-reconnect', why, attempt: reconnectAttempt,
      delayMs: plan.delayMs, atCap: plan.atCap, orphanHookId: owned,
    });
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (stopping) return;
      const decision = shouldSpawnForward({ childAlive: isChildAlive(child), stopping });
      if (!decision.spawn) {
        out({ type: 'forward-spawn-skipped', why: decision.why });
        return;
      }
      applySweep({
        ownedHookId: asHookId(state.forward.orphanHookId),
        liveHookId: null,
      });
      startForward();
    }, plan.delayMs);
    if (reconnectTimer.unref) reconnectTimer.unref();
  };

  const startForward = () => {
    const decision = shouldSpawnForward({ childAlive: isChildAlive(child), stopping });
    if (!decision.spawn) {
      out({ type: 'forward-spawn-skipped', why: decision.why });
      return;
    }
    spawnAt = nowIso();
    state.forward.spawnAt = spawnAt;
    pingRetryCount = 0;
    saveState(state);
    const args = ['webhook', 'forward', `--repo=${REPO}`, `--events=${FORWARD_EVENTS.join(',')}`];
    child = spawn(FORWARD_CMD, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const parser = createForwardParser();
    createInterface({ input: child.stdout }).on('line', (line) => {
      const ev = parser.push(line);
      if (ev) { try { onEvent(ev); } catch (e) { diag(`处理事件出错：${e.stack || e}`); } }
    });
    createInterface({ input: child.stderr }).on('line', (l) => diag(`[forward] ${l}`));
    child.on('exit', (code) => {
      const owned = asHookId(state.hookId) || asHookId(state.forward.orphanHookId);
      state.hookId = null;
      state.forward.lastExitAt = nowIso();
      state.forward.lastExitCode = code;
      state.forward.recentExits = [...(state.forward.recentExits || []), nowIso()].slice(-20);
      if (owned) state.forward.orphanHookId = owned;
      saveState(state);
      if (stopping) return;
      // forward 掉了就重连。**心跳照旧在跳**，所以光看心跳看不出通道断——
      // 断的证据只有「ping 不回来了」，那一条在 classifyGhEventBridge 里判。
      // 重连前先按归属扫自家孤儿，退避有上界；不再 5 秒一次空转。
      state.forward.restarts += 1;
      out({ type: 'forward-exit', code, note: `第 ${state.forward.restarts} 次重连` });
      scheduleReconnect({ why: `forward exit ${code}`, ownedHookId: owned });
    });
    if (firstPingTimer) { clearTimeout(firstPingTimer); firstPingTimer = null; }
    firstPingTimer = setTimeout(() => { firstPingTimer = null; sendPing(); }, FIRST_PING_MS);
    if (firstPingTimer.unref) firstPingTimer.unref();
    out({ type: 'forward-start', repo: REPO, events: FORWARD_EVENTS, dryRun: !!dryRun, spawnAt });
  };

  const beat = setInterval(() => { state.heartbeatAt = nowIso(); saveState(state); }, HEARTBEAT_MS);
  const ping = setInterval(sendPing, PING_MS);

  function stop(code) {
    if (stopping) return;
    stopping = true;
    clearInterval(beat); clearInterval(ping);
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (firstPingTimer) { clearTimeout(firstPingTimer); firstPingTimer = null; }
    for (const h of scheduled.values()) clearTimeout(h);
    out({ type: 'stopping', code });
    if (!child || child.exitCode !== null || child.killed) return process.exit(code);
    // 等子进程真的退掉再走：它要用这段时间把自己建的 hook 从仓上删掉。
    // 干等固定毫秒数是不够的（那是一次网络往返），所以听 exit；实在不退再硬走。
    const bail = setTimeout(() => { out({ type: 'stop-timeout', note: 'forward 没按时退，hook 可能留在仓上，下次启动会扫掉' }); process.exit(code); }, 20000);
    if (bail.unref) bail.unref();
    child.on('exit', () => { clearTimeout(bail); process.exit(code); });
    child.kill('SIGTERM');
  }
  process.on('SIGTERM', () => stop(0));
  process.on('SIGINT', () => stop(0));

  applySweep({
    ownedHookId: prevOwn.ownedHookId,
    liveHookId: null,
  });
  startForward();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();

export { ROOT, REPO, STATE_PATH };
