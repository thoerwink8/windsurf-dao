// 用户级 auto 权限面 · 三层改齐（换机后重跑同样有效，幂等）。
// 权限面动作，须用户亲手跑：
//   node scripts/dao-auto-mode.mjs
//
// 为什么是用户级不是随仓：Claude Code v2.1.142+ 刻意忽略项目级 .claude/settings.json 里的
// defaultMode=auto（官方文档 permission-modes.md："so a repository cannot grant itself auto mode"）。
// 为什么要改三层：cc-switch 下发 ~/.claude/settings.json 用的是 providers 表当前行 settings_config
// 整体覆盖（config-sync/README.md 第 43 行）——只改 live 会在下次下发被覆盖，只改 common 不改
// providers 会在切 provider 时回退。三层 = live 投影 + cc-switch DB（providers 各行 +
// common_config_claude）+ config-sync git 快照（换机恢复流的载体）。
// 主仓交互会话的 manual 锁（.claude/settings.local.json，项目级收紧被尊重）不受本脚本影响。
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const lib = await import(pathToFileURL(join(REPO, 'config-sync/lib/sqlite.mjs')).href);
const { selectRows, transaction, sqlLiteral, backupDb, stableJson } = lib;

const setAuto = (obj) => {
  obj.permissions ??= {};
  obj.permissions.defaultMode = 'auto';
  return obj;
};

// ① DB 先备份
console.log('OK DB 备份: ' + backupDb());

// ② DB：common_config_claude（换机恢复流恢复的就是这个键）
const commonRows = selectRows('settings', "WHERE key='common_config_claude'");
if (commonRows.length !== 1) throw new Error('common_config_claude 行数异常: ' + commonRows.length);
const commonVal = stableJson(setAuto(JSON.parse(commonRows[0].value)));

// ③ DB：providers 各行（下发的真源）。只动已带 permissions 面的行，异常行照直报、不动。
const provStmts = [];
for (const p of selectRows('providers')) {
  let cfg;
  try { cfg = JSON.parse(p.settings_config); } catch { console.log(`SKIP provider ${p.id}: settings_config 非 JSON`); continue; }
  if (!cfg || typeof cfg !== 'object' || !cfg.permissions) { console.log(`SKIP provider ${p.id}: 无 permissions 面`); continue; }
  cfg.permissions.defaultMode = 'auto';
  provStmts.push(`UPDATE providers SET settings_config=${sqlLiteral(stableJson(cfg))} WHERE id=${sqlLiteral(p.id)};`);
}
transaction([
  `UPDATE settings SET value=${sqlLiteral(commonVal)} WHERE key='common_config_claude';`,
  ...provStmts,
]);
console.log(`OK DB 已写: common_config_claude + providers ×${provStmts.length}`);

// ④ git 快照（占位符形态，与 DB 各改各的，只动 defaultMode 一个字段）
const SNAP = join(REPO, 'config-sync/common/settings.json');
const snap = JSON.parse(readFileSync(SNAP, 'utf8').replace(/^﻿/, ''));
const snapRow = snap.rows.find((r) => r.key === 'common_config_claude');
snapRow.value = stableJson(setAuto(JSON.parse(snapRow.value)));
writeFileSync(SNAP, JSON.stringify(snap, null, 2) + '\n', 'utf8');
console.log('OK 快照已写: ' + SNAP);

// ⑤ live 投影（立即生效，不等下发）
const LIVE = join(homedir(), '.claude/settings.json');
writeFileSync(LIVE, JSON.stringify(setAuto(JSON.parse(readFileSync(LIVE, 'utf8'))), null, 2) + '\n', 'utf8');
console.log('OK live 已写: ' + LIVE);

// ⑥ 顺手清随仓死配置（项目级 auto 被宿主忽略，留着只会误导）
const DEAD = join(REPO, '.claude/settings.json');
if (existsSync(DEAD)) { unlinkSync(DEAD); console.log('OK 已删随仓死配置: ' + DEAD); }

// ⑦ 回读验证
const checks = [
  ['live', JSON.parse(readFileSync(LIVE, 'utf8')).permissions?.defaultMode === 'auto'],
  ['db.common', JSON.parse(selectRows('settings', "WHERE key='common_config_claude'")[0].value).permissions?.defaultMode === 'auto'],
  ['db.providers', selectRows('providers').every((p) => {
    try { const c = JSON.parse(p.settings_config); return !c?.permissions || c.permissions.defaultMode === 'auto'; } catch { return true; }
  })],
  ['快照', JSON.parse(JSON.parse(readFileSync(SNAP, 'utf8')).rows.find((r) => r.key === 'common_config_claude').value).permissions?.defaultMode === 'auto'],
  ['随仓死配置已除', !existsSync(DEAD)],
];
for (const [name, ok] of checks) console.log(`${ok ? '  ✓' : '  ✗'} ${name}`);
console.log('回读验证: ' + (checks.every(([, ok]) => ok) ? 'PASS' : 'FAIL'));
