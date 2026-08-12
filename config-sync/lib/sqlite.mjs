import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ccSwitchBackupDir, ccSwitchDbPath, configSyncRoot } from './paths.mjs';

const VENDOR_DIR = path.join(configSyncRoot, 'vendor');
const VENDOR_SQLITE = path.join(VENDOR_DIR, 'sqlite', 'sqlite3.exe');

const FALLBACK_SQLITE_PATHS = [
  VENDOR_SQLITE,
  path.join(os.homedir(), 'AppData', 'Local', 'Android', 'platform-tools', 'sqlite3.exe'),
  path.join(os.homedir(), 'AppData', 'Local', 'Android', 'platform-tools', 'sqlite3'),
];

export const CORE_TABLES = [
  'settings',
  'mcp_servers',
  'skills',
  'skill_repos',
  'prompts',
  'proxy_config',
  'provider_endpoints',
  'model_pricing',
  'providers',
];

export const RUNTIME_TABLES = new Set([
  'proxy_request_logs',
  'stream_check_logs',
  'provider_health',
  'usage_daily_rollups',
  'proxy_live_backup',
  'session_log_sync',
]);

export function findSqlite3() {
  const candidates = [process.env.SQLITE3_PATH, 'sqlite3', ...FALLBACK_SQLITE_PATHS].filter(Boolean);
  for (const candidate of candidates) {
    try {
      if (candidate !== 'sqlite3' && !fs.existsSync(candidate)) continue;
      const resolved = execFileSync(process.platform === 'win32' ? 'where' : 'which', [candidate], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0] || candidate;
      execFileSync(resolved, ['-version'], { stdio: ['ignore', 'ignore', 'ignore'] });
      return resolved;
    } catch {
      try {
        execFileSync(candidate, ['-version'], { stdio: ['ignore', 'ignore', 'ignore'] });
        return candidate;
      } catch {
        // continue
      }
    }
  }
  throw new Error('找不到 sqlite3。请安装 sqlite3，或设置环境变量 SQLITE3_PATH 指向 sqlite3 可执行文件。');
}

export function ensureSqlite3() {
  // 不再自动下载：sqlite3 是随处能装的开源命令行工具，缺了报错提示手动装一行即可（
  // 2026-08-12 与 setup-sqlite.ps1 / vendor/sqlite-tools.json 同批退役下载器）。
  return findSqlite3();
}

export function bootstrapDb() {
  if (fs.existsSync(ccSwitchDbPath)) return false;

  const sqlite = ensureSqlite3();
  fs.mkdirSync(path.dirname(ccSwitchDbPath), { recursive: true });

  const cDir = path.join(configSyncRoot, 'common');
  const specs = [
    { file: 'settings.json', tables: [{ name: 'settings', key: 'rows' }] },
    { file: 'mcp_servers.json', tables: [{ name: 'mcp_servers', key: 'rows' }] },
    { file: 'skills.json', tables: [{ name: 'skills', key: 'skills' }, { name: 'skill_repos', key: 'skill_repos' }] },
    { file: 'prompts.json', tables: [{ name: 'prompts', key: 'rows' }] },
    { file: 'proxy.json', tables: [
      { name: 'proxy_config', key: 'proxy_config' },
      { name: 'provider_endpoints', key: 'provider_endpoints' },
      { name: 'model_pricing', key: 'model_pricing' },
    ] },
  ];

  const stmts = [];
  for (const spec of specs) {
    const fp = path.join(cDir, spec.file);
    if (!fs.existsSync(fp)) continue;
    let doc;
    try { doc = JSON.parse(fs.readFileSync(fp, 'utf8').replace(/^﻿/, '')); } catch { continue; }

    for (const t of spec.tables) {
      let rows = doc[t.key];
      if (!rows && Array.isArray(doc)) rows = doc;
      if (!rows && Array.isArray(doc.rows)) rows = doc.rows;
      if (!Array.isArray(rows) || !rows.length) continue;

      const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
      const pk = bootstrapPK(t.name, cols);
      const defs = cols.map((c) => {
        const isPk = pk?.length === 1 && pk[0] === c;
        return `${quoteIdent(c)} TEXT${isPk ? ' PRIMARY KEY' : ''}`;
      });
      if (pk && pk.length > 1) {
        defs.push(`PRIMARY KEY(${pk.map(quoteIdent).join(', ')})`);
      }
      stmts.push(`CREATE TABLE IF NOT EXISTS ${quoteIdent(t.name)} (${defs.join(', ')});`);
    }
  }

  stmts.push('CREATE TABLE IF NOT EXISTS "providers" ("id" TEXT PRIMARY KEY, "name" TEXT, "settings_config" TEXT);');

  if (!stmts.length) return false;

  execFileSync(sqlite, [ccSwitchDbPath], {
    input: stmts.join('\n'),
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  return true;
}

function bootstrapPK(tableName, columns) {
  const map = { settings: ['key'], skill_repos: ['owner', 'name', 'branch'], proxy_config: ['app_type'], model_pricing: ['model_id'] };
  if (map[tableName]) return map[tableName];
  if (columns.includes('id')) return ['id'];
  return null;
}

export function assertDbExists(dbPath = ccSwitchDbPath) {
  if (!fs.existsSync(dbPath)) {
    throw new Error(`找不到 cc-switch 数据库：${dbPath}\n请先安装并启动一次 cc-switch，让它创建基础数据库。`);
  }
}

// `readonly: true` ⇒ sqlite3 以 `-readonly` 打开数据库。给纯查询型消费方用
// （如 ccswitch/lib/settings-drift.js 的 `--providers` 面）：那类调用的「只读」若只靠
// 「我们写的 SQL 里没有 UPDATE」保证，就是纪律性只读——一次手滑、一次 SQL 拼接就破。
// 这个开关把它变成结构性只读：sqlite3 自己拒绝写入，而不是我们保证不写。
// 默认 false ⇒ 既有调用方（sync / restore / doctor 要写）行为逐字节不变。
export function runSql(sql, { dbPath = ccSwitchDbPath, json = false, readonly = false } = {}) {
  assertDbExists(dbPath);
  const sqlite = findSqlite3();
  // 不把 SQL 放进 argv：providers.settings_config 可能很长，Windows 命令行会触发 ENAMETOOLONG。
  // 通过 stdin 传给同一个 sqlite3 进程，既保留事务原子性，也避免 token 写入临时 .sql 文件。
  const args = [];
  if (readonly) args.push('-readonly');
  if (json) args.push('-json');
  args.push(dbPath);
  const output = execFileSync(sqlite, args, {
    input: sql,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (!json) return output;
  const trimmed = output.trim();
  return trimmed ? JSON.parse(trimmed) : [];
}

export function tableExists(tableName) {
  const rows = runSql(
    `SELECT name FROM sqlite_master WHERE type='table' AND name=${sqlLiteral(tableName)};`,
    { json: true },
  );
  return rows.length > 0;
}

export function listColumns(tableName) {
  if (!tableExists(tableName)) return [];
  const rows = runSql(`PRAGMA table_info(${quoteIdent(tableName)});`, { json: true });
  return rows.map((row) => String(row.name));
}

export function selectRows(tableName, where = '') {
  if (!tableExists(tableName)) return [];
  const suffix = where ? ` ${where}` : '';
  return runSql(`SELECT * FROM ${quoteIdent(tableName)}${suffix};`, { json: true });
}

export function backupDb(dbPath = ccSwitchDbPath) {
  assertDbExists(dbPath);
  fs.mkdirSync(ccSwitchBackupDir, { recursive: true });
  const stamp = formatStamp(new Date());
  const backupPath = path.join(ccSwitchBackupDir, `cc-switch.db.before-config-sync-${stamp}.bak`);
  fs.copyFileSync(dbPath, backupPath);
  return backupPath;
}

export function transaction(statements, { dbPath = ccSwitchDbPath } = {}) {
  assertDbExists(dbPath);
  const sql = ['BEGIN IMMEDIATE;', ...statements, 'COMMIT;'].join('\n');
  try {
    return runSql(sql, { dbPath });
  } catch (error) {
    try { runSql('ROLLBACK;', { dbPath }); } catch {}
    throw error;
  }
}

export function upsertStatements(tableName, rows) {
  if (!rows?.length) return [];
  const columns = listColumns(tableName);
  if (!columns.length) return [];
  return rows.map((row) => {
    const presentColumns = columns.filter((column) => Object.prototype.hasOwnProperty.call(row, column));
    const names = presentColumns.map(quoteIdent).join(', ');
    const values = presentColumns.map((column) => sqlLiteral(row[column])).join(', ');
    return `INSERT OR REPLACE INTO ${quoteIdent(tableName)} (${names}) VALUES (${values});`;
  });
}

export function clearTableStatement(tableName) {
  return `DELETE FROM ${quoteIdent(tableName)};`;
}

export function quoteIdent(identifier) {
  return `"${String(identifier).replaceAll('"', '""')}"`;
}

export function sqlLiteral(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
  if (typeof value === 'boolean') return value ? '1' : '0';
  return `'${String(value).replaceAll("'", "''")}'`;
}

export function stableJson(value) {
  return JSON.stringify(sortDeep(value));
}

export function sortDeep(value) {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortDeep(value[key])]));
}

export function validateJsonFields(label, rows) {
  const errors = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowId = row.key || row.name || row.id || `[${i}]`;
    for (const [col, val] of Object.entries(row)) {
      if (typeof val !== 'string') continue;
      const trimmed = val.trimStart();
      if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) continue;
      try {
        JSON.parse(val);
      } catch (e) {
        errors.push(`${label}.${rowId}.${col}: ${e.message}`);
      }
    }
  }
  if (errors.length) {
    throw new Error(
      `JSON 验证失败，拒绝写入 DB（防止损坏数据入库）：\n  ${errors.join('\n  ')}`,
    );
  }
}

function formatStamp(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}
