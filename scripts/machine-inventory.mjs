#!/usr/bin/env node
// scripts/machine-inventory.mjs —— 机器级清单：这台机器上「该有什么、实际有没有」。
//
//   node scripts/machine-inventory.mjs            # 人读报告（三态：绿 / 红 / 没查成）
//   node scripts/machine-inventory.mjs --json     # 机器读
//
// 为什么是脚本而不是一张写死的表：**版本号会过期，清单不会**。这里只声明
// 「什么必须有、怎么找、为什么、装法在哪」；实际版本当场读回来。换机时它既当安装后的终检，
// 也当「这台机器上到底装了什么」的现场答案（bootstrap-server.mjs 的最后一步就调它）。
//
// 判据三态（这个仓的老规矩）：
//   绿 = 找到了且能报出版本/路径；红 = 该有却没有；没查成 = 探测本身失败（不是绿）。
//
// 归属：Mirasim / key / Clash / ssh 接线归 ai-gateway-stack（见 host/machine/INDEX.md）；
// 本清单只管**编排面这台机器**要有的 OS / Node / 执行体 / 工具 / sudoers / 凭据落点。

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, delimiter } from 'node:path';
import { pathToFileURL } from 'node:url';

const HOME = process.env.DAO_INVENTORY_HOME || homedir();
const run = (cmd, argv) => spawnSync(cmd, argv, { encoding: 'utf8', windowsHide: true });
const firstLine = text => String(text || '').trim().split('\n')[0]?.slice(0, 60) || '';

/** 解析可执行文件：PATH + `~/.local/bin` + 几个已知的 off-PATH 落点。
 *  为什么要额外找：ACP 腿（cursor-agent/devin/claude）与 uv 工具（ddgs）**不在 PATH** 上，
 *  靠 ~/.local/bin 的 shim + versions 目录；只查 PATH 会把「装了」报成「没查成」（实咬）。 */
const KNOWN_BIN_DIRS = ['.local/bin', '.grok/bin', '.local/share/uv/tools/ddgs/bin', 'bin'];
const resolveBin = cmd => {
  // 不用 shell（`bash -lc` 在 Windows 上会返回 POSIX 路径，spawn 直接 ENOENT；登录 shell 还会重置 PATH）。
  const exts = process.platform === 'win32' ? ['.cmd', '.exe', '.bat', ''] : [''];
  const dirs = [...String(process.env.PATH || '').split(delimiter), ...KNOWN_BIN_DIRS.map(rel => join(HOME, rel))];
  for (const dir of dirs) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, cmd + ext);
      try { if (statSync(candidate).isFile()) return candidate; } catch { /* 这个落点没有，继续 */ }
    }
  }
  return null;
};

/** 探测小工具：能跑就回 { found, detail }；跑不动回 { found:false, unscanned:true }。 */
const probeCommand = (cmd, args = ['--version']) => () => {
  const bin = resolveBin(cmd);
  if (!bin) return { found: false, why: `PATH 与已知落点都没有 ${cmd}` };
  const r = run(bin, args);
  if (r.error) return { found: false, unscanned: true, why: `探测失败：${r.error.code || r.error.message}` };
  if (r.status !== 0) return { found: false, why: `退出码 ${r.status}：${firstLine(r.stderr) || firstLine(r.stdout)}` };
  const offPath = bin !== cmd;
  return { found: true, detail: `${firstLine(r.stdout || r.stderr) || '（无版本输出）'}${offPath ? `（${bin}，不在 PATH）` : ''}` };
};

/** /etc/sudoers.d 下的规则：**读不到 ≠ 没有**——非 root 身份 existsSync 会因目录 750 返回 false，
 *  那是「没查成」，报成红就是假红（本仓被「没查成当红/当绿」咬过很多次）。 */
const probeSudoers = name => () => {
  const p = `/etc/sudoers.d/${name}`;
  try {
    statSync(p); // existsSync 在 EACCES 上只回 false，分不出「没有」和「看不见」——用 statSync
    return { found: true, detail: p };
  } catch (e) {
    if (e.code === 'ENOENT') return { found: false, why: `不在 ${p}` };
    return { found: false, unscanned: true, why: `读不了 ${p}（${e.code || e.message}）——用 root 跑才能判` };
  }
};

const probeFile = rel => () => {
  const p = join(HOME, rel);
  return existsSync(p) ? { found: true, detail: p } : { found: false, why: `不在：${p}` };
};

const probeDirEntries = rel => () => {
  const p = join(HOME, rel);
  if (!existsSync(p)) return { found: false, why: `目录不在：${p}` };
  const entries = readdirSync(p);
  return entries.length ? { found: true, detail: entries.slice(0, 3).join(', ') } : { found: false, why: `${p} 是空的` };
};

/**
 * 清单。`how` 是装法指针（不复制步骤，步骤在 NEW-MACHINE / ai-gateway-stack）。
 * 分四组：平台 / 执行体 / 工具 / 接线与凭据。
 */
export const INVENTORY = [
  // ── 平台 ──
  { id: 'os-ubuntu-24.04', group: '平台', why: '目标发行版（systemd 单元、apt 包名都按它写）', how: 'NEW-MACHINE §2', probe: () => {
    try {
      const text = readFileSync('/etc/os-release', 'utf8');
      const pretty = /PRETTY_NAME="([^"]+)"/.exec(text)?.[1] || '';
      return /24\.04/.test(pretty) ? { found: true, detail: pretty } : { found: false, why: `不是 24.04：${pretty || '读不到 PRETTY_NAME'}` };
    } catch (e) { return { found: false, unscanned: true, why: `读不到 /etc/os-release：${e.code || e.message}` }; }
  } },
  { id: 'node-22', group: '平台', why: '所有脚本的运行时（nodesource apt 装的，不是 nvm）', how: 'NEW-MACHINE §2', probe: probeCommand('node', ['-v']) },
  { id: 'apt:git', group: '平台', why: 'worktree/提交/合并全靠它', how: 'apt', probe: probeCommand('git') },
  { id: 'apt:gh', group: '平台', why: 'PR/issue/CI 的结构化查询与写入', how: 'apt（官方源）', probe: probeCommand('gh') },
  { id: 'apt:jq', group: '平台', why: '单元与脚本里解析 JSON', how: 'apt', probe: probeCommand('jq') },
  { id: 'apt:python3', group: '平台', why: '若干巡检/一次性脚本', how: 'apt', probe: probeCommand('python3', ['--version']) },
  { id: 'apt:rsync', group: '平台', why: '跨机同步（账本/备份）', how: 'apt', probe: probeCommand('rsync', ['--version']) },
  { id: 'apt:curl', group: '平台', why: '装机脚本取外部二进制（如 Temporal CLI）', how: 'apt', probe: probeCommand('curl', ['--version']) },

  // ── 执行体（会话从这里起）──
  { id: 'cli:codex', group: '执行体', why: 'codex 腿（npm 全局 @openai/codex）', how: 'NEW-MACHINE §7e 一带', probe: probeCommand('codex', ['--version']) },
  { id: 'cli:grok', group: '执行体', why: 'grok 腿（npm 全局 @xai-official/grok）', how: 'NEW-MACHINE §7', probe: probeCommand('grok', ['--version']) },
  { id: 'cli:pi', group: '执行体', why: 'pi 腿（npm 全局 @earendil-works/pi-coding-agent）', how: 'NEW-MACHINE §6', probe: probeCommand('pi', ['--version']) },
  { id: 'cli:command-code', group: '执行体', why: 'command-code 腿（npm 全局）', how: 'NEW-MACHINE §7b', probe: probeCommand('command-code', ['--version']) },
  { id: 'shim:cursor-agent', group: '执行体', why: 'cursor 腿（ACP；不在 PATH，靠 ~/.local/bin shim + versions 目录）', how: 'NEW-MACHINE §7c', probe: probeFile('.local/bin/cursor-agent') },
  { id: 'shim:devin', group: '执行体', why: 'devin 腿（ACP，同上）', how: 'NEW-MACHINE §7d', probe: probeFile('.local/bin/devin') },
  { id: 'shim:reclaude', group: '执行体', why: 'claude 腿**必须**经 reclaude（裸 claude 会 login rejected）', how: '全局约定「模型偏好」节', probe: probeFile('.local/bin/reclaude') },
  { id: 'versions:cursor-agent', group: '执行体', why: 'cursor-agent 的实际版本目录（shim 指向它）', how: '§7c 的安装器', probe: probeDirEntries('.local/share/cursor-agent/versions') },
  { id: 'versions:claude', group: '执行体', why: 'claude 的实际版本目录（shim 指向它）', how: 'reclaude 链', probe: probeDirEntries('.local/share/claude/versions') },

  // ── 工具 ──
  { id: 'tool:uv', group: '工具', why: '跑 uv 工具（ddgs 等）', how: 'NEW-MACHINE §13a', probe: probeCommand('uv', ['--version']) },
  { id: 'tool:ddgs', group: '工具', why: '查资料的搜索 CLI（WebSearch 卡住时的本机路）', how: 'NEW-MACHINE §13a', probe: probeCommand('ddgs', ['--version']) },
  { id: 'tool:temporal', group: '工具', why: 'fleet 的 Temporal CLI（版本要钉死，装法在 install-fleet.sh）', how: 'scripts/install-fleet.sh', probe: probeCommand('temporal', ['--version']) },
  { id: 'tool:lark-cli', group: '工具', why: '飞书 CLI（问答卡/通知走它）', how: 'ai-gateway-stack', probe: probeFile('.local/share/lark-cli') },

  // ── 接线与凭据落点（内容不进 git）──
  { id: 'sudoers:dao-sync', group: '接线', why: 'dao-sync 重启飞书机器人那一条最小 sudo 规则', how: 'scripts/install-dao-sync.sh', probe: probeSudoers('dao-sync') },
  { id: 'sudoers:mirasim-ws-probe', group: '接线', why: '健康探针的最小 sudo 规则', how: 'scripts/install-mirasim-ws-probe.sh', probe: probeSudoers('mirasim-ws-probe') },
  { id: 'creds:dao-apps', group: '凭据', why: 'GitHub App 凭据（C 类，手动带）', how: 'NEW-MACHINE §4b', probe: probeDirEntries('.dao/apps') },
  { id: 'creds:mirasim-keys', group: '凭据', why: 'Mirasim 账户 key（C 类）', how: 'ai-gateway-stack', probe: probeDirEntries('.mirasim/keys') },
  { id: 'env:ai-gateway', group: '凭据', why: 'claude 链的凭据/代理环境文件', how: 'ai-gateway-stack', probe: probeFile('.config/ai-gateway/claude.env') },
];

function main() {
  const json = process.argv.includes('--json');
  const rows = INVENTORY.map(item => {
    let verdict;
    try { verdict = item.probe(); }
    catch (e) { verdict = { found: false, unscanned: true, why: `探测抛了：${String(e?.message || e).slice(0, 80)}` }; }
    const state = verdict.unscanned ? 'unscanned' : verdict.found ? 'green' : 'red';
    return { id: item.id, group: item.group, state, detail: verdict.detail || null, why: verdict.why || null, how: item.how, why_needed: item.why };
  });
  const counts = { green: 0, red: 0, unscanned: 0 };
  for (const r of rows) counts[r.state] += 1;
  if (json) {
    process.stdout.write(`${JSON.stringify({ home: HOME, counts, items: rows }, null, 2)}\n`);
    return counts.red || counts.unscanned ? 1 : 0;
  }
  let group = null;
  for (const r of rows) {
    if (r.group !== group) { group = r.group; process.stdout.write(`\n${group}\n`); }
    const mark = r.state === 'green' ? '✓' : r.state === 'red' ? '✗' : '?';
    process.stdout.write(`  ${mark} ${r.id}${r.detail ? ` — ${r.detail}` : ''}${r.why ? ` — ${r.why}` : ''}\n`);
  }
  process.stdout.write(`\n机器级清单：绿 ${counts.green} / 红 ${counts.red} / 没查成 ${counts.unscanned}（home=${HOME}）\n`);
  if (counts.unscanned) process.stdout.write('「没查成」不是绿：探测本身失败了，先看为什么再判。\n');
  return counts.red || counts.unscanned ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}

export { main };
