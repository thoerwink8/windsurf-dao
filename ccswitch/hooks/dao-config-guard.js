// dao-config-guard.js — SessionStart drift detector (read-only!)
// Compares settings.json against CC Switch DB common_config_claude.
// If drift detected, outputs warning to stderr (shown as hook message).
// NEVER writes settings.json — doing so triggers 401 device revoked.
// To fix drift, run: dao-config-sync.ps1 (outside Claude Code session).

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const HOME = process.env.USERPROFILE || process.env.HOME;
const DB = path.join(HOME, '.cc-switch', 'cc-switch.db');
const SETTINGS = path.join(HOME, '.claude', 'settings.json');

function findMissing(target, source, prefix = '') {
  const missing = [];
  for (const k of Object.keys(source)) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (!(k in target)) {
      missing.push(p);
    } else if (
      source[k] && typeof source[k] === 'object' && !Array.isArray(source[k]) &&
      target[k] && typeof target[k] === 'object' && !Array.isArray(target[k])
    ) {
      missing.push(...findMissing(target[k], source[k], p));
    }
  }
  return missing;
}

try {
  if (!fs.existsSync(DB)) process.exit(0);

  const raw = execSync(
    `sqlite3 "${DB}" "SELECT value FROM settings WHERE key='common_config_claude'"`,
    { encoding: 'utf8', timeout: 5000, windowsHide: true }
  ).trim();

  if (!raw || raw.length < 10) process.exit(0);

  const golden = JSON.parse(raw);
  const current = JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));

  const missing = findMissing(current, golden);

  if (missing.length > 0) {
    process.stderr.write(
      `[dao-config-guard] settings.json 缺少 ${missing.length} 个 CC Switch 托管字段: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? '...' : ''}。` +
      `退出 Claude Code 后运行: powershell D:/frank/windsurf-dao/ccswitch/scripts/dao-config-sync.ps1\n`
    );
  }
} catch (_) {
  // silent — never break session startup
}
