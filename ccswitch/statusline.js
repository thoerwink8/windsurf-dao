#!/usr/bin/env node
// Claude Code 状态栏 — 两行布局（纯 Node，零外部依赖）
// 行1: 会话名 · 目录 · git 分支
// 行2: 上下文进度条+已用% · token数 · 成本 · 总时长(API注解)

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

  const C = '\x1b[36m', G = '\x1b[32m', Y = '\x1b[33m', R = '\x1b[31m', GR = '\x1b[90m', RST = '\x1b[0m';

  let branch = '';
  try {
    execSync('git rev-parse --git-dir', { stdio: 'pipe' });
    branch = execSync('git --no-optional-locks branch --show-current', { encoding: 'utf8', stdio: 'pipe' }).trim();
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

  const dirBase = dir.split(/[/\\]/).filter(Boolean).pop() || '';
  const M = '\x1b[94m';
  const line1 = `${C}${name}${RST}  \u{1F4C1} ${dirBase}${branch ? '  \u{1F33F} ' + branch : ''}${model ? '  ' + M + model + RST : ''}`;
  const line2 = `${barColor}${bar}${RST} ${pct}% ${GR}${tokK}k/${sizeK}k${RST} · ${Y}${costFmt}${RST} · ⏱ ${totalFmt} ${GR}(API ${apiS}s)${RST}`;

  process.stdout.write(line1 + '\n' + line2 + '\n');
});
