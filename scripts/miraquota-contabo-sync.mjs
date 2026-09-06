#!/usr/bin/env node
/**
 * Contabo 采样器（#881）：问本机 mirasim-server 一句 getRelay，把 usage windows
 * 收成 MiraQuota 的 schemaVersion 1 分片，force-push 到账本仓 machine/contabo。
 *
 * 格式与 remote 不在本仓发明：remote 读 ~/.miraquota/sync.json，没有就用
 * miraquota-win 的 DEFAULT_REMOTE；分片字段对照那边 exportShard + 远端实物分支。
 *
 *   node scripts/miraquota-contabo-sync.mjs --once
 *   node scripts/miraquota-contabo-sync.mjs --dry-run
 *
 * systemd oneshot 调 --once。退出码：0 推成 / 1 真失败 / 2 没查成（令牌不在、连不上）。
 */
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_PORT } from './lib/mirasim-runtime.mjs';
import {
  MACHINE_ID,
  isInstallId,
  loadSyncRemote,
  shardFromRelay,
} from './lib/miraquota-contabo.mjs';

const SHARD_FILE = 'shard.json';
// 专用 installId：不要复用 miraquota-win 给 hostname 那行的身份，
// 合并按 installId 去重，共用会把 contabo 和他机合成一台。
const INSTALL_REL = ['.miraquota', 'contabo-install.json'];
const SYNC_REL = ['.miraquota', 'sync.json'];
const REPO_REL = ['.miraquota', 'contabo-sync-repo'];

const NO_PROMPT_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: 'echo',
  GCM_INTERACTIVE: 'never',
};

const argv = process.argv.slice(2);
const flag = (n) => argv.includes('--' + n);

function tokenPath(homeDir, port) {
  return join(homeDir, '.mirasim', 'run', `local-${port}.token`);
}

function readToken(homeDir, port) {
  const p = tokenPath(homeDir, port);
  let raw;
  try { raw = readFileSync(p, 'utf8'); } catch (e) {
    const err = new Error(`读不到回环会话令牌，服务多半没在跑（${e.message || e}）`);
    err.code = 'unscanned';
    throw err;
  }
  const token = String(raw).trim();
  if (!token) {
    const err = new Error('回环会话令牌是空的');
    err.code = 'unscanned';
    throw err;
  }
  return token;
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function readInstallId(file) {
  const v = readJson(file)?.installId;
  if (isInstallId(v)) return v;
  const id = randomBytes(8).toString('hex');
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ installId: id }) + '\n');
  } catch { /* 落不了盘就用内存值，下一轮会再写 */ }
  return id;
}

const defaultGit = (cwd, args, timeout = 30_000) => new Promise((resolve, reject) => {
  execFile('git', ['-C', cwd, ...args],
    { timeout, maxBuffer: 8 << 20, windowsHide: true, env: NO_PROMPT_ENV },
    (err, stdout, stderr) => {
      if (err) reject(new Error(String(stderr || err.message || err).trim() || 'git 失败'));
      else resolve(String(stdout));
    });
});

/**
 * 开一条回环 ws，clientHello + getState 之后发 getRelay，收 type=relay。
 * 令牌只进 URL，不进返回值、不进日志。
 */
export async function defaultFetchRelay({ homeDir, port, openTimeoutMs = 8_000, waitMs = 6_000 } = {}) {
  const token = readToken(homeDir, port);
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`);
  const inbox = [];
  const waiters = [];
  let closed = false;
  let failure = null;

  const pump = () => {
    for (let i = waiters.length - 1; i >= 0; i--) {
      const w = waiters[i];
      const hit = inbox.findIndex(w.pred);
      if (hit !== -1) {
        const [msg] = inbox.splice(hit, 1);
        waiters.splice(i, 1);
        clearTimeout(w.timer);
        w.resolve(msg);
      } else if (closed || failure) {
        waiters.splice(i, 1);
        clearTimeout(w.timer);
        w.resolve(null);
      }
    }
  };

  ws.onmessage = (ev) => {
    try { inbox.push(JSON.parse(ev.data)); } catch { /* 非 JSON 不是本层的事 */ }
    pump();
  };
  ws.onerror = (e) => { failure = e?.message || 'ws 出错'; pump(); };
  ws.onclose = () => { closed = true; pump(); };

  const waitFor = (pred, timeoutMs) => {
    const hit = inbox.findIndex(pred);
    if (hit !== -1) return Promise.resolve(inbox.splice(hit, 1)[0]);
    if (closed || failure) return Promise.resolve(null);
    return new Promise((resolve) => {
      const w = { pred, resolve };
      w.timer = setTimeout(() => {
        const at = waiters.indexOf(w);
        if (at !== -1) waiters.splice(at, 1);
        resolve(null);
      }, timeoutMs);
      waiters.push(w);
    });
  };

  const opened = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), openTimeoutMs);
    ws.onopen = () => { clearTimeout(timer); resolve(true); };
    const prev = ws.onerror;
    ws.onerror = (e) => { prev?.(e); clearTimeout(timer); resolve(false); };
  });
  if (!opened) {
    try { ws.close(); } catch { /* 已断 */ }
    const err = new Error(`连不上回环 ws（port=${port}${failure ? ' ' + failure : ''}）`);
    err.code = 'unscanned';
    throw err;
  }

  ws.send(JSON.stringify({ type: 'clientHello' }));
  ws.send(JSON.stringify({ type: 'getState' }));
  ws.send(JSON.stringify({ type: 'getRelay' }));
  const frame = await waitFor((m) => m && (m.type === 'relay' || m.type === 'error'), waitMs);
  try { ws.close(); } catch { /* 已断 */ }
  if (!frame) {
    const err = new Error('getRelay 没回 relay 帧（没查成）');
    err.code = 'unscanned';
    throw err;
  }
  return frame;
}

async function ensureRepo({ repoDir, remote, git }) {
  mkdirSync(repoDir, { recursive: true });
  if (!existsSync(join(repoDir, '.git'))) {
    await git(repoDir, ['init', '--quiet']);
  }
  await git(repoDir, ['config', 'user.name', 'miraquota']);
  await git(repoDir, ['config', 'user.email', 'miraquota@local']);
  await git(repoDir, ['config', 'commit.gpgsign', 'false']);
  const remotes = (await git(repoDir, ['remote'])).split('\n').map((s) => s.trim());
  if (!remotes.includes('origin')) {
    await git(repoDir, ['remote', 'add', 'origin', remote]);
  } else if ((await git(repoDir, ['remote', 'get-url', 'origin'])).trim() !== remote) {
    await git(repoDir, ['remote', 'set-url', 'origin', remote]);
  }
}

/**
 * 单提交覆盖不留历史：首次 commit，之后 amend + force-push。
 * 只作用于账本仓自己的 machine/<id> 分支——这就是覆盖式发布的语义。
 */
export async function publishShard({ repoDir, remote, shard, git = defaultGit } = {}) {
  await ensureRepo({ repoDir, remote, git });
  writeFileSync(join(repoDir, SHARD_FILE), JSON.stringify(shard));
  await git(repoDir, ['add', SHARD_FILE]);
  const hasHead = await git(repoDir, ['rev-parse', '--verify', '--quiet', 'HEAD'])
    .then(() => true, () => false);
  const msg = `shard ${shard.machineId} @ ${new Date(shard.generatedAt * 1000).toISOString()}`;
  await git(repoDir, hasHead
    ? ['commit', '--amend', '--allow-empty', '--quiet', '-m', msg]
    : ['commit', '--allow-empty', '--quiet', '-m', msg]);
  await git(repoDir, ['push', '--quiet', '--force', 'origin', `HEAD:machine/${shard.machineId}`]);
}

export async function runOnce(opts = {}) {
  const homeDir = opts.homeDir || homedir();
  const port = Number(opts.port || process.env.MIRASIM_PORT || DEFAULT_PORT);
  const machineId = opts.machineId || MACHINE_ID;
  const nowSec = opts.nowSec ?? Date.now() / 1000;
  const installFile = opts.installFile || join(homeDir, ...INSTALL_REL);
  const configFile = opts.configFile || join(homeDir, ...SYNC_REL);
  const repoDir = opts.repoDir || join(homeDir, ...REPO_REL);
  const fetchRelay = opts.fetchRelay || defaultFetchRelay;
  const git = opts.git || defaultGit;
  const dryRun = !!opts.dryRun;

  const { remote, from, why } = loadSyncRemote(readJson(configFile));
  const installId = opts.installId || readInstallId(installFile);
  const frame = await fetchRelay({ homeDir, port });
  const built = shardFromRelay(frame, { machineId, installId, generatedAt: nowSec });
  if (!built.ok) {
    const err = new Error(built.errors.join('；'));
    err.code = built.unscanned ? 'unscanned' : 'fail';
    throw err;
  }
  if (!dryRun) await publishShard({ repoDir, remote, shard: built.shard, git });
  return {
    ok: true,
    dryRun,
    remote,
    remoteFrom: from,
    remoteWhy: why,
    branch: `machine/${built.shard.machineId}`,
    machineId: built.shard.machineId,
    installId: built.shard.installId,
    generatedAt: built.shard.generatedAt,
    windows: built.shard.limits.windows.map((w) => ({
      label: w.label, used: w.used, budget: w.budget, resetAt: w.resetAt,
    })),
  };
}

function isMain() {
  const here = fileURLToPath(import.meta.url);
  const entry = process.argv[1] ? join(process.argv[1]) : '';
  return here === entry || here.endsWith(entry.replace(/\\/g, '/'));
}

if (isMain()) {
  if (flag('help') || flag('h')) {
    process.stdout.write(`用法 node scripts/miraquota-contabo-sync.mjs [--once|--dry-run]

  --once       采一次并推 machine/contabo（systemd oneshot 用这条）
  --dry-run    采一次打印分片，不碰 git
  --json       结果打成一行 JSON
`);
    process.exit(0);
  }
  const dryRun = flag('dry-run');
  runOnce({ dryRun }).then((r) => {
    if (flag('json') || dryRun) process.stdout.write(JSON.stringify(r, null, dryRun ? 2 : 0) + '\n');
    else {
      const w = r.windows.map((x) => `${x.label} ${Math.round(x.used)}/${Math.round(x.budget)}`).join(' · ');
      process.stdout.write(`推了 ${r.branch} · ${w} · remote ${r.remoteFrom}\n`);
    }
    process.exit(0);
  }).catch((e) => {
    process.stderr.write(`${e.message || e}\n`);
    process.exit(e.code === 'unscanned' ? 2 : 1);
  });
}
