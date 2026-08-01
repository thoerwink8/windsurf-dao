import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { ccSwitchBackupDir, ccSwitchDbPath, configSyncRoot } from './paths.mjs';

const VENDOR_DIR = path.join(configSyncRoot, 'vendor');
const VENDOR_SQLITE = path.join(VENDOR_DIR, 'sqlite', 'sqlite3.exe');

// ── sqlite-tools 的 url / 文件名 / SHA256 唯一真相源 ──────────────────────────
// 6.4 MB 的 zip 不再进 git，改为首次用时下载 + SHA256 校验（代价：新机器首次需联网）。
// 清单与 `../setup-sqlite.ps1` 共用；**下载+校验的实现也只有一份**，就在那个 ps1 里
// （`-EnsureZipOnly`：只取包、不解压、不写环境变量），这里 shell out 过去调它，
// 免得两个消费方各写一套下载逻辑然后各自漂移。换 sqlite 版本只改 vendor/sqlite-tools.json。
const SQLITE_MANIFEST = path.join(VENDOR_DIR, 'sqlite-tools.json');
const SETUP_SQLITE_PS1 = path.join(configSyncRoot, 'setup-sqlite.ps1');

function readSqliteManifest() {
  const manifest = JSON.parse(fs.readFileSync(SQLITE_MANIFEST, 'utf8').replace(/^﻿/, ''));
  for (const field of ['file', 'url', 'sha256']) {
    if (!manifest[field]) throw new Error(`下载清单缺字段 '${field}'：${SQLITE_MANIFEST}`);
  }
  return manifest;
}

function sha256Upper(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex').toUpperCase();
}

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
  try {
    return findSqlite3();
  } catch (originalError) {
    if (process.platform !== 'win32') throw originalError;

    let manifest;
    try {
      manifest = readSqliteManifest();
    } catch { throw originalError; }

    const zipPath = path.join(VENDOR_DIR, manifest.file);
    const expected = manifest.sha256.toUpperCase();
    const destDir = path.dirname(VENDOR_SQLITE);

    // 1) 确保 vendor/ 下有安装包。本地没有、或有但哈希对不上（下载中断的半截文件）→ 让 ps1 去取。
    if (!fs.existsSync(zipPath) || sha256Upper(zipPath) !== expected) {
      console.log(`  sqlite3 未找到，首次使用需下载 ${manifest.file}（约 6.4 MB，需联网）……`);
      try {
        execFileSync(
          'powershell.exe',
          ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SETUP_SQLITE_PS1, '-EnsureZipOnly'],
          { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 300000 },
        );
      } catch (downloadError) {
        const detail = String(downloadError.stderr || downloadError.stdout || downloadError.message).trim();
        throw new Error(
          `sqlite3 安装包获取失败：${detail}\n`
          + `可离线自救：手动下载 ${manifest.url} 放进 ${VENDOR_DIR}（SHA256 须为 ${expected}），`
          + '或设置环境变量 SQLITE3_PATH 指向已装好的 sqlite3。',
        );
      }
    }

    // 2) 到手也不白信：这一侧独立复核一次 SHA256。
    //    绕开 ps1 直接把文件塞进 vendor/ 的路径同样被这道拦下——校验不该只长在下载那条路上。
    if (!fs.existsSync(zipPath)) {
      throw new Error(`获取安装包后仍未找到 ${zipPath}`);
    }
    const actual = sha256Upper(zipPath);
    if (actual !== expected) {
      fs.rmSync(zipPath, { force: true });
      throw new Error(
        `${manifest.file} SHA256 校验失败，已删除并拒绝使用（供应链防线）。\n`
        + `  期望: ${expected}\n  实际: ${actual}\n`
        + `若 sqlite.org 确实发布了新版本，请更新 ${SQLITE_MANIFEST} 的 version / file / url / sha256 四个字段。`,
      );
    }

    console.log(`  从 vendor/${manifest.file} 解压……`);
    fs.mkdirSync(destDir, { recursive: true });

    try {
      const ps = [
        'Add-Type -Assembly System.IO.Compression.FileSystem;',
        `$z=[System.IO.Compression.ZipFile]::OpenRead('${zipPath.replace(/'/g, "''")}');`,
        'foreach($e in $z.Entries){',
        "if($e.Name -match '\\.exe$'){",
        `$out=Join-Path '${destDir.replace(/'/g, "''")}' $e.Name;`,
        '[System.IO.Compression.ZipFileExtensions]::ExtractToFile($e,$out,$true)',
        '}}',
        '$z.Dispose()',
      ].join(' ');
      execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 30000,
      });
    } catch (extractError) {
      throw new Error(`sqlite3 解压失败：${extractError.message}。请手动解压 ${zipPath} 到 ${destDir}`);
    }

    return findSqlite3();
  }
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
