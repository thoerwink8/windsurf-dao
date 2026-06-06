import fs from 'node:fs';
import { claudeSettingsPath, hasBomBuffer, readJsonIfExists, snapshotPaths, stripBom } from './paths.mjs';
import { selectRows, stableJson, tableExists } from './sqlite.mjs';
import { commonSecretsPath, countPlaceholders, SECRET_PLACEHOLDER } from './secrets.mjs';

const REQUIRED_CLAUDE_ENV = {
  CLAUDE_CODE_ATTRIBUTION_HEADER: '0',
  CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK: '1',
  CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING: '1',
};

let problems = 0;
let warnings = 0;

function main() {
  section('cc-switch 数据库');
  try {
    const ok = tableExists('settings');
    pass(ok ? 'cc-switch db 可访问，settings 表存在。' : 'cc-switch db 可访问。');
  } catch (error) {
    fail(error.message);
    finish();
    return;
  }

  section('Claude common env');
  checkCommonClaudeEnv();

  section('当前 ~/.claude/settings.json');
  checkClaudeSettingsFile();

  section('snapshot 一致性');
  compareSnapshot('mcp_servers', snapshotPaths.mcpServers, (doc) => asRows(doc));
  compareSkillsSnapshot();

  section('providers 本地私密快照');
  checkProvidersSnapshot();

  section('common 脱敏门（防 token 进 git）');
  checkCommonRedaction();

  finish();
}

function checkCommonClaudeEnv() {
  const rows = selectRows('settings', "WHERE key = 'common_config_claude'");
  if (!rows.length) {
    fail('settings.common_config_claude 不存在。');
    return;
  }

  let value;
  try {
    value = JSON.parse(rows[0].value);
  } catch (error) {
    fail(`common_config_claude 不是合法 JSON：${error.message}`);
    return;
  }

  const env = value.env || {};
  checkEnvMap(env, 'common_config_claude.env');
}

function checkClaudeSettingsFile() {
  if (!fs.existsSync(claudeSettingsPath)) {
    warn(`找不到 ${claudeSettingsPath}，可能当前机器尚未运行 Claude Code。`);
    return;
  }

  const buffer = fs.readFileSync(claudeSettingsPath);
  if (hasBomBuffer(buffer)) fail('settings.json 带 UTF-8 BOM，会导致严格 JSON 解析失败。');
  else pass('settings.json 无 BOM。');

  let json;
  try {
    json = JSON.parse(stripBom(buffer.toString('utf8')));
  } catch (error) {
    fail(`settings.json 不是合法 JSON：${error.message}`);
    return;
  }

  checkEnvMap(json.env || {}, 'settings.json.env');
}

function checkEnvMap(env, label) {
  for (const [key, expected] of Object.entries(REQUIRED_CLAUDE_ENV)) {
    if (String(env[key]) === expected) pass(`${label}.${key} = ${expected}`);
    else fail(`${label}.${key} 缺失或不是 ${expected}`);
  }
}

function compareSnapshot(tableName, snapshotPath, rowsOfSnapshot) {
  if (!fs.existsSync(snapshotPath)) {
    warn(`缺少 ${snapshotPath}，请先运行“导出配置.bat”。`);
    return;
  }
  if (!tableExists(tableName)) {
    warn(`当前 cc-switch db 没有 ${tableName} 表，跳过一致性检查。`);
    return;
  }

  const snapshot = readJsonIfExists(snapshotPath, null);
  const snapshotRows = rowsOfSnapshot(snapshot);
  const dbRows = selectRows(tableName, tableName === 'mcp_servers' ? 'ORDER BY name, id' : '');

  if (stableJson(snapshotRows) === stableJson(dbRows)) pass(`${tableName} 与 common 快照一致（${dbRows.length} 条）。`);
  else warn(`${tableName} 与 common 快照不一致：db=${dbRows.length}，snapshot=${snapshotRows.length}。如刚改过 cc-switch，请运行“导出配置.bat”。`);
}

function compareSkillsSnapshot() {
  const snapshotPath = snapshotPaths.skills;
  if (!fs.existsSync(snapshotPath)) {
    warn(`缺少 ${snapshotPath}，请先运行“导出配置.bat”。`);
    return;
  }
  const snapshot = readJsonIfExists(snapshotPath, { skills: [], skill_repos: [] });
  const dbSkills = tableExists('skills') ? selectRows('skills', 'ORDER BY name, id') : [];
  const dbRepos = tableExists('skill_repos') ? selectRows('skill_repos', 'ORDER BY owner, name, branch') : [];

  const skillsSame = stableJson(snapshot.skills || []) === stableJson(dbSkills);
  const reposSame = stableJson(snapshot.skill_repos || []) === stableJson(dbRepos);
  if (skillsSame && reposSame) pass(`skills / skill_repos 与 common 快照一致（skills=${dbSkills.length}, repos=${dbRepos.length}）。`);
  else warn(`skills / skill_repos 与 common 快照不一致：db skills=${dbSkills.length}, snapshot skills=${(snapshot.skills || []).length}; db repos=${dbRepos.length}, snapshot repos=${(snapshot.skill_repos || []).length}。`);
}

function checkProvidersSnapshot() {
  if (!fs.existsSync(snapshotPaths.providers)) {
    fail('缺少 providers/providers.json。供应商配置含 token，不进 git；换机时需手动复制 providers/ 目录。');
    return;
  }
  const doc = readJsonIfExists(snapshotPaths.providers, { rows: [] });
  const rows = asRows(doc);
  if (!rows.length) fail('providers/providers.json 存在但为空。');
  else pass(`providers/providers.json 存在（${rows.length} 个 provider）。注意：该目录含 token，不应提交到 git。`);
}

function checkCommonRedaction() {
  if (!fs.existsSync(snapshotPaths.settings)) {
    warn(`缺少 ${snapshotPaths.settings}，请先运行“导出配置.bat”。`);
    return;
  }

  // 1) 进 git 的 common/settings.json 不得残留疑似明文密钥。
  const raw = fs.readFileSync(snapshotPaths.settings, 'utf8');
  const leakRe = /sk-[A-Za-z0-9_\-]{12,}|eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}/;
  if (leakRe.test(raw)) fail('common/settings.json 命中疑似明文密钥（sk-/JWT）。该文件会进 git，请重新运行导出脱敏。');
  else pass('common/settings.json 未命中明文密钥模式。');

  // 2) 占位符与真实值文件应配套出现。
  let placeholders = 0;
  try {
    const doc = readJsonIfExists(snapshotPaths.settings, { rows: [] });
    for (const row of asRows(doc)) {
      try { placeholders += countPlaceholders(JSON.parse(row.value)); } catch { /* 非 JSON 跳过 */ }
    }
  } catch (error) {
    warn(`解析 common/settings.json 失败：${error.message}`);
  }

  if (placeholders === 0) {
    pass(`common/settings.json 无脱敏占位符（${SECRET_PLACEHOLDER} 计 0 个）。`);
  } else if (fs.existsSync(commonSecretsPath)) {
    const secretsDoc = readJsonIfExists(commonSecretsPath, { secrets: {} });
    const have = Object.keys(secretsDoc.secrets || {}).length;
    if (have >= placeholders) pass(`脱敏占位符 ${placeholders} 个，common-secrets.json 提供 ${have} 个真实值。`);
    else fail(`脱敏占位符 ${placeholders} 个，但 common-secrets.json 只有 ${have} 个真实值，恢复会失败。`);
  } else {
    fail(`common/settings.json 有 ${placeholders} 个脱敏占位符，但缺少 providers/common-secrets.json。换机时需手动复制 providers/ 目录。`);
  }
}

function asRows(doc) {
  if (!doc) return [];
  if (Array.isArray(doc)) return doc;
  if (Array.isArray(doc.rows)) return doc.rows;
  return [];
}

function section(title) {
  console.log(`\n[${title}]`);
}

function pass(message) {
  console.log(`  ✓ ${message}`);
}

function warn(message) {
  warnings++;
  console.log(`  ! ${message}`);
}

function fail(message) {
  problems++;
  console.log(`  ✗ ${message}`);
}

function finish() {
  console.log('\n[结果]');
  if (problems === 0 && warnings === 0) {
    console.log('  全部通过。');
  } else {
    console.log(`  问题 ${problems} 项，提醒 ${warnings} 项。`);
  }
  process.exit(problems > 0 ? 1 : 0);
}

try {
  main();
} catch (error) {
  console.error(`体检失败：${error.message}`);
  process.exit(1);
}
