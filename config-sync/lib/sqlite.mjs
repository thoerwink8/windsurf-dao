import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ccSwitchBackupDir, ccSwitchDbPath } from './paths.mjs';

const FALLBACK_SQLITE_PATHS = [
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

export function assertDbExists(dbPath = ccSwitchDbPath) {
  if (!fs.existsSync(dbPath)) {
    throw new Error(`找不到 cc-switch 数据库：${dbPath}\n请先安装并启动一次 cc-switch，让它创建基础数据库。`);
  }
}

export function runSql(sql, { dbPath = ccSwitchDbPath, json = false } = {}) {
  assertDbExists(dbPath);
  const sqlite = findSqlite3();
  // 不把 SQL 放进 argv：providers.settings_config 可能很长，Windows 命令行会触发 ENAMETOOLONG。
  // 通过 stdin 传给同一个 sqlite3 进程，既保留事务原子性，也避免 token 写入临时 .sql 文件。
  const args = json ? ['-json', dbPath] : [dbPath];
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

function formatStamp(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}
