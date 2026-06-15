import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { readJsonIfExists, snapshotPaths, decodePaths } from './paths.mjs';
import {
  backupDb,
  clearTableStatement,
  tableExists,
  transaction,
  upsertStatements,
} from './sqlite.mjs';
import { applySecrets, commonSecretsPath, countPlaceholders } from './secrets.mjs';
import { parseScopeArg, wants } from './scope.mjs';

// 把脱敏的 settings 行还原成真实值，并把 ${PROJECT_ROOT}/${HOME} 路径占位符还原成本机路径。JSON 行用 common-secrets.json 合并；非 JSON（如 codex TOML）只还原路径。
function rehydrateSettings(rows) {
  const doc = readJsonIfExists(commonSecretsPath, null);
  const secretsMap = doc?.secrets || {};
  return rows.map((row) => {
    const decodedValue = decodePaths(row.value);
    let parsed;
    try {
      parsed = JSON.parse(decodedValue);
    } catch {
      return { key: row.key, value: decodedValue };
    }
    const restored = applySecrets(row.key, parsed, secretsMap);
    const remaining = countPlaceholders(restored);
    if (remaining > 0) {
      throw new Error(`settings "${row.key}" 仍有 ${remaining} 个未还原的占位符。请确认 config-sync/common-secrets.json 已从源机器复制到本机。`);
    }
    return { key: row.key, value: JSON.stringify(restored) };
  });
}

// 仓库 snapshot → cc-switch DB。only=null 恢复全部；否则只恢复命中的 scope。
export function runRestore({ only = null } = {}) {
  const snapshots = loadSnapshots(only);

  const backupPath = backupDb();
  const statements = [];

  if (wants(only, 'settings')) appendSettingsRestore(statements, snapshots.settings);
  if (wants(only, 'mcp')) appendSimpleTableRestore(statements, 'mcp_servers', snapshots.mcp_servers);
  if (wants(only, 'skills')) {
    appendSimpleTableRestore(statements, 'skills', snapshots.skills);
    appendSimpleTableRestore(statements, 'skill_repos', snapshots.skill_repos);
  }
  if (wants(only, 'prompts')) appendSimpleTableRestore(statements, 'prompts', snapshots.prompts);
  if (wants(only, 'proxy')) {
    appendSimpleTableRestore(statements, 'proxy_config', snapshots.proxy_config);
    appendSimpleTableRestore(statements, 'model_pricing', snapshots.model_pricing);
  }

  if (!statements.length) {
    console.log('没有可恢复的 snapshot 内容，未写入数据库。');
    console.log(`已创建备份：${backupPath}`);
    return;
  }

  transaction(statements);

  console.log('config-sync 恢复完成');
  console.log(`  数据库备份：${backupPath}`);
  console.log(`  settings: ${snapshots.settings.length}`);
  console.log(`  mcp_servers: ${snapshots.mcp_servers.length}`);
  console.log(`  skills: ${snapshots.skills.length}`);
  console.log(`  skill_repos: ${snapshots.skill_repos.length}`);
  console.log(`  prompts: ${snapshots.prompts.length}`);
  console.log(`  proxy_config: ${snapshots.proxy_config.length}`);
  console.log(`  model_pricing: ${snapshots.model_pricing.length}`);
  console.log('');
  console.log('请重启 cc-switch，并切换一次 provider，让 cc-switch 重新下发配置到各端。');
}

function loadSnapshots(only = null) {
  // 只在 scope 命中时强制要求对应快照存在，避免部分同步时被无关文件缺失阻断。
  const settingsDoc = wants(only, 'settings')
    ? mustRead(snapshotPaths.settings, 'common/settings.json')
    : readJsonIfExists(snapshotPaths.settings, { rows: [] });
  const mcpDoc = readJsonIfExists(snapshotPaths.mcpServers, { rows: [] });
  const skillsDoc = readJsonIfExists(snapshotPaths.skills, { skills: [], skill_repos: [] });
  const promptsDoc = readJsonIfExists(snapshotPaths.prompts, { rows: [] });
  const proxyDoc = readJsonIfExists(snapshotPaths.proxy, {
    proxy_config: [],
    provider_endpoints: [],
    model_pricing: [],
  });
  return {
    settings: rehydrateSettings(asRows(settingsDoc)),
    mcp_servers: asRows(mcpDoc).map((m) => (
      m.server_config ? { ...m, server_config: decodePaths(m.server_config) } : m
    )),
    skills: Array.isArray(skillsDoc.skills) ? skillsDoc.skills : [],
    skill_repos: Array.isArray(skillsDoc.skill_repos) ? skillsDoc.skill_repos : [],
    prompts: asRows(promptsDoc),
    proxy_config: Array.isArray(proxyDoc.proxy_config) ? proxyDoc.proxy_config : [],
    provider_endpoints: Array.isArray(proxyDoc.provider_endpoints) ? proxyDoc.provider_endpoints : [],
    model_pricing: Array.isArray(proxyDoc.model_pricing) ? proxyDoc.model_pricing : [],
  };
}

function mustRead(filePath, label) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`缺少 ${label}。请先在源机器运行 dao-sync.bat 导出。`);
  }
  return readJsonIfExists(filePath, null);
}

function asRows(doc) {
  if (!doc) return [];
  if (Array.isArray(doc)) return doc;
  if (Array.isArray(doc.rows)) return doc.rows;
  return [];
}

function appendSimpleTableRestore(statements, tableName, rows) {
  if (!rows.length) return;
  if (!tableExists(tableName)) {
    console.warn(`跳过 ${tableName}：当前 cc-switch db 没有该表，可能 schema 已变化。`);
    return;
  }
  statements.push(clearTableStatement(tableName));
  statements.push(...upsertStatements(tableName, rows));
}

function appendSettingsRestore(statements, rows) {
  if (!rows.length) return;
  if (!tableExists('settings')) {
    console.warn('跳过 settings：当前 cc-switch db 没有该表，可能 schema 已变化。');
    return;
  }

  const syncRows = rows.filter((row) => String(row.key || '').startsWith('common_config_'));
  const skipped = rows.length - syncRows.length;
  if (skipped > 0) {
    console.warn(`跳过 ${skipped} 条非 common_config_ settings，避免覆盖本机运行态密钥。`);
  }
  if (!syncRows.length) return;

  statements.push(...upsertStatements('settings', syncRows));
}


function isCli() {
  return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isCli()) {
  try {
    runRestore({ only: parseScopeArg() });
  } catch (error) {
    console.error(`恢复失败：${error.message}`);
    process.exit(1);
  }
}
