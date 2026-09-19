#!/usr/bin/env node
// scripts/session-path-audit.mjs —— agent 会话路径体检（#1460 T29）。
//
//   node scripts/session-path-audit.mjs            # 人读（markdown 表）
//   node scripts/session-path-audit.mjs --json     # 机器读（符合 T28：JSON 主形态）
//   node scripts/session-path-audit.mjs --with-session   # 加测「起一个会话」的耗时（慢，默认不测）
//
// 为什么要有它：用户 2026-09-19 问「为什么 Devin Desktop 快、我们慢」——**没有度量就没有优化**。
// 这里把「一次 agent 会话会碰到的东西」拆成可分别计时的段：DNS / TCP+TLS / API 往返 / 进程启动 /
// 工具（MCP 配置与可执行）/ 会话启动 / 文件与树操作 / 网络链路。
// 每一段都报**三态**（ok / slow / unscanned），并给出该段的**参照量级**（人不必记数字）。
//
// 归属：MCP/凭据/代理属 ai-gateway-stack（E 类），本脚本只**测**不写装法。

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const HOME = process.env.DAO_AUDIT_HOME || homedir();
const JSON_OUT = process.argv.includes('--json');
const WITH_SESSION = process.argv.includes('--with-session');

const ms = () => Number(process.hrtime.bigint() / 1000000n);
const run = (cmd, argv, opts = {}) => {
  const t0 = ms();
  const r = spawnSync(cmd, argv, { encoding: 'utf8', windowsHide: true, timeout: 20000, ...opts });
  return { ms: ms() - t0, status: r.status, out: String(r.stdout || ''), err: String(r.stderr || r.error?.message || '') };
};

/** 三态判据：有明确阈值的按阈值判；判不了就是 unscanned（没查成 ≠ 好）。 */
const verdict = (value, { ok, slow, unit = 'ms', why = '' } = {}) =>
  !Number.isFinite(value) ? { state: 'unscanned', detail: why || '没量到' }
    : value <= ok ? { state: 'ok', detail: `${value}${unit}` }
      : value <= slow ? { state: 'warn', detail: `${value}${unit}（偏慢）` }
        : { state: 'slow', detail: `${value}${unit}（慢）` };

const results = [];
const push = (group, id, verdictObj, note = '') => results.push({ group, id, ...verdictObj, note });

// ── 1. DNS（会话要连的域名）──
const HOSTS = ['api.github.com', 'github.com', 'registry.npmjs.org'];
for (const host of HOSTS) {
  const r = run('node', ['-e', `require('node:dns').promises.lookup('${host}').then(a=>{console.log(a.address);process.exit(0)}).catch(e=>{console.error(e.code);process.exit(1)})`]);
  const ok = r.status === 0 && r.out.trim().length > 0;
  push('dns', host, ok ? verdict(r.ms, { ok: 300, slow: 2000 }) : { state: 'unscanned', detail: r.err.trim().slice(0, 60) || '解析失败' });
}

// ── 2. API 往返（无认证；认证路径由 gh-as 自己量）──
for (const url of ['https://api.github.com/rate_limit']) {
  const r = run('curl', ['-s', '-o', '/dev/null', '-w', '%{time_total}', url]);
  const secs = Number(r.out.trim());
  push('api', url.replace('https://', ''), Number.isFinite(secs) ? verdict(Math.round(secs * 1000), { ok: 400, slow: 2000 }) : { state: 'unscanned', detail: r.err.trim().slice(0, 60) || 'curl 没回数' });
}

// ── 3. 进程启动（会话每步都要付的固定成本）──
push('spawn', 'node -e 1', verdict(run('node', ['-e', '1']).ms, { ok: 300, slow: 1500 }));
push('spawn', 'gh --version', (() => {
  const r = run('gh', ['--version']);
  return r.status === 0 ? verdict(r.ms, { ok: 400, slow: 2000 }) : { state: 'unscanned', detail: 'gh 不在 PATH' };
})());

// ── 4. 工具面：MCP 配置 + 会话里能用的快路（ddgs 等）──
const MCP_CANDIDATES = [
  { agent: 'cursor', path: '.cursor/mcp.json' },
  { agent: 'codex', path: '.codex/config.toml' },
  { agent: 'claude', path: '.claude.json' },
  { agent: 'claude', path: '.claude/settings.json' },
];
let mcpFound = 0;
for (const { agent, path } of MCP_CANDIDATES) {
  const full = join(HOME, path);
  if (!existsSync(full)) continue;
  let servers = [];
  try {
    const text = readFileSync(full, 'utf8');
    servers = [...new Set([...text.matchAll(/"(mcpServers|mcp_servers)"|\[mcp_servers\.([a-zA-Z0-9_-]+)\]|"(server-[a-zA-Z0-9_-]+)"/g)].map(m => m[2] || m[3]).filter(Boolean))];
  } catch { /* 读不了就算没配 */ }
  mcpFound += 1;
  push('tools', `${agent}:${path}`, { state: servers.length ? 'ok' : 'warn', detail: servers.length ? servers.slice(0, 6).join(',') : '存在但没有可识别的 server 名' });
}
if (!mcpFound) push('tools', 'mcp 配置', { state: 'unscanned', detail: '没找到任何执行体的 MCP 配置（没查成，不等于没配）' });

for (const tool of ['ddgs', 'uv', 'jq']) {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', ''] : [''];
  const bin = [join(HOME, '.local/bin'), '/usr/bin'].flatMap(d => exts.map(e => join(d, tool + e))).find(p => existsSync(p));
  if (!bin) { push('tools', tool, { state: 'unscanned', detail: '不在已知落点（会话里大概也用不到）' }); continue; }
  const r = run(bin, tool === 'ddgs' ? ['--help'] : ['--version']);
  push('tools', tool, r.status === 0 ? verdict(r.ms, { ok: 800, slow: 3000 }) : { state: 'warn', detail: `装了但跑不起来（exit ${r.status}）` });
}

// ── 5. 文件与树操作（worktree/检出）──
const worktrees = ['/home/orca/mirasim-worktrees', join(HOME, 'wt')].filter(existsSync);
if (!worktrees.length) push('fs', 'worktree 目录', { state: 'unscanned', detail: '本机没有已知的 worktree 目录' });
for (const dir of worktrees) {
  let count = 0;
  try { count = readdirSync(dir).length; } catch { /* ignore */ }
  push('fs', `${dir}（${count} 棵树）`, { state: 'ok', detail: `${count} 棵` });
}

// ── 6. 会话启动（可选，慢）──
if (WITH_SESSION) {
  const t0 = ms();
  const r = run('node', ['-e', `
    const { createExecutionRuntime } = await import('${process.cwd()}/scripts/lib/execution-runtime.mjs');
    const rt = createExecutionRuntime();
    const started = await rt.startSession({ profileId: process.env.AUDIT_PROFILE || 'devin-acp-deepseek', workdir: process.env.AUDIT_WORKDIR || process.cwd(), prompt: '只回一行 OK' });
    console.log(JSON.stringify({ key: started?.sessionKey || null }));
    if (started?.sessionKey) await rt.stopSession(started.sessionKey).catch(() => {});
  `], { timeout: 240000 });
  push('session', '起一个会话（含握手）', r.status === 0 ? verdict(ms() - t0, { ok: 20000, slow: 90000 }) : { state: 'unscanned', detail: r.err.trim().slice(0, 80) || '起会话没成功' });
} else {
  push('session', '起一个会话', { state: 'unscanned', detail: '默认不测（--with-session 打开；它慢且烧额度）' });
}

// ── 7. 网络链路（本机 ↔ 远端机器）──
const sshHost = process.env.DAO_AUDIT_SSH;
if (sshHost) {
  const r = run('ssh', ['-o', 'ConnectTimeout=8', sshHost, 'echo ok']);
  push('network', `ssh ${sshHost}`, r.status === 0 ? verdict(r.ms, { ok: 500, slow: 3000 }) : { state: 'unscanned', detail: '连不上（链路问题本身也是结论）' });
} else {
  push('network', '本机↔远端', { state: 'unscanned', detail: '未声明 DAO_AUDIT_SSH' });
}

// ── 输出（JSON 主形态 + markdown 镜像，字段一一对应）──
const counts = results.reduce((a, r) => ({ ...a, [r.state]: (a[r.state] || 0) + 1 }), {});
if (JSON_OUT) {
  process.stdout.write(`${JSON.stringify({ host: HOME, platform: process.platform, counts, items: results }, null, 2)}\n`);
} else {
  let group = null;
  for (const r of results) {
    if (r.group !== group) { group = r.group; process.stdout.write(`\n${group}\n`); }
    const mark = { ok: '✓', warn: '!', slow: '✗', unscanned: '?' }[r.state];
    process.stdout.write(`  ${mark} ${r.id} — ${r.detail}${r.note ? ` ${r.note}` : ''}\n`);
  }
  process.stdout.write(`\n会话路径体检：ok ${counts.ok || 0} / 偏慢 ${counts.warn || 0} / 慢 ${counts.slow || 0} / 没查成 ${counts.unscanned || 0}\n`);
  process.stdout.write('「没查成」不是好：它只是没量到。慢的那几段才是要动手的地方。\n');
}
process.exit((counts.slow || 0) > 0 ? 1 : 0);
