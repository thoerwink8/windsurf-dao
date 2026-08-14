#!/usr/bin/env node
// Claude Code 状态栏 — 两行布局（纯 Node，零外部依赖）
// 行1左: 会话名 · 📁目录 ·🌿分支 · 模型 [effort]
// 行1右: 脏文件列表（≤5展开，>5收起为数字）
// 行2左: 上下文进度条+已用% · token数 · 成本 · 总时长(API注解)

const { execSync } = require('child_process');

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { raw += chunk; });
process.stdin.on('end', () => {
  let d;
  try { d = JSON.parse(raw); } catch { d = {}; }

  const name = d.session_name || '—';
  const dir = (d.workspace && d.workspace.current_dir) || '';
  const model = (d.model && d.model.display_name) || (d.model && d.model.id) || '';
  let pct = Math.round(Number((d.context_window && d.context_window.used_percentage) || 0));
  const inTok = Number((d.context_window && d.context_window.total_input_tokens) || 0);
  const size = Number((d.context_window && d.context_window.context_window_size) || 200000);
  const cost = Number((d.cost && d.cost.total_cost_usd) || 0);
  const durMs = Number((d.cost && d.cost.total_duration_ms) || 0);
  const apiMs = Number((d.cost && d.cost.total_api_duration_ms) || 0);
  const effort = (d.effort && d.effort.level) || '';

  const C = '\x1b[36m', G = '\x1b[32m', Y = '\x1b[33m', R = '\x1b[31m';
  const GR = '\x1b[90m', RST = '\x1b[0m', MAG = '\x1b[35m', M = '\x1b[94m';

  let branch = '';
  let dirtyFiles = [];
  try {
    execSync('git rev-parse --git-dir', { stdio: 'pipe' });
    branch = execSync('git --no-optional-locks branch --show-current', { encoding: 'utf8', stdio: 'pipe' }).trim();
    const st = execSync('git --no-optional-locks status --porcelain', { encoding: 'utf8', stdio: 'pipe' }).trim();
    if (st) {
      dirtyFiles = st.split('\n').map(line => {
        const code = line.substring(0, 2).trim() || '?';
        const file = line.substring(3).split('/').pop().split('\\').pop();
        return { code, file };
      });
    }
  } catch {}

  if (pct > 100) pct = 100;
  if (pct < 0) pct = 0;

  const barColor = pct >= 90 ? R : pct >= 70 ? Y : G;
  const filled = Math.floor(pct / 10);
  const empty = 10 - filled;
  const bar = '█'.repeat(filled) + '░'.repeat(empty);

  const tokK = Math.round(inTok / 1000);
  const sizeK = Math.round(size / 1000);
  const costFmt = '$' + cost.toFixed(2);

  const fmtDur = ms => {
    const s = Math.floor(ms / 1000);
    if (s >= 3600) return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
    if (s >= 60) return `${Math.floor(s / 60)}m${s % 60}s`;
    return `${s}s`;
  };
  const totalFmt = fmtDur(durMs);
  const apiS = (apiMs / 1000).toFixed(1);

  // --- 终端宽度 ---
  let cols = 120;
  try { cols = parseInt(execSync('tput cols 2>/dev/null || echo 120', { encoding: 'utf8', stdio: 'pipe' }), 10) || 120; } catch {}

  // --- ANSI 字符串的可见长度 ---
  const visLen = s => s.replace(/\x1b\[[0-9;]*m/g, '').replace(/[\u{1F300}-\u{1FFFF}]/gu, 'XX').length;

  // --- 行1 左侧 ---
  const dirBase = dir.split(/[/\\]/).filter(Boolean).pop() || '';
  const effortTag = effort ? ` ${MAG}[${effort}]${RST}` : '';
  const dirtyCount = dirtyFiles.length;
  const dirtyBadge = dirtyCount > 0 ? ` ${R}✎${dirtyCount}${RST}` : '';
  const left1 = `${C}${name}${RST}  \u{1F4C1} ${dirBase}${dirtyBadge}${branch ? '  \u{1F33F} ' + branch : ''}${model ? '  ' + M + model + RST : ''}${effortTag}`;

  // --- 行1 右侧：脏文件详情 ---
  const codeColor = c => c === 'M' ? Y : c === 'A' || c === '?' ? G : c === 'D' ? R : GR;
  let right1 = '';
  if (dirtyCount > 0 && dirtyCount <= 5) {
    right1 = dirtyFiles.map(f => `${codeColor(f.code)}${f.code}:${f.file}${RST}`).join(' ');
  } else if (dirtyCount > 5) {
    const shown = dirtyFiles.slice(0, 3);
    const rest = dirtyCount - 3;
    right1 = shown.map(f => `${codeColor(f.code)}${f.code}:${f.file}${RST}`).join(' ') + ` ${GR}+${rest} more${RST}`;
  }

  // --- 拼行1（左右对齐）---
  const gap1 = cols - visLen(left1) - visLen(right1);
  const pad1 = gap1 > 1 ? ' '.repeat(gap1) : '  ';
  const line1 = right1 ? left1 + pad1 + right1 : left1;

  // --- 行2 ---
  const line2 = `${barColor}${bar}${RST} ${pct}% ${GR}${tokK}k/${sizeK}k${RST} · ${Y}${costFmt}${RST} · ⏱ ${totalFmt} ${GR}(API ${apiS}s)${RST}`;

  process.stdout.write(line1 + '\n' + line2 + '\n');
});
