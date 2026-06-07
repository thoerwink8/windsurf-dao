import fs from 'node:fs';
import { readJsonIfExists, snapshotPaths, decodePaths } from './paths.mjs';
import {
  backupDb,
  clearTableStatement,
  tableExists,
  transaction,
  upsertStatements,
} from './sqlite.mjs';
import { applySecrets, commonSecretsPath, countPlaceholders } from './secrets.mjs';

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
      throw new Error(`settings "${row.key}" 仍有 ${remaining} 个未还原的占位符。请确认 providers/common-secrets.json 已从源机器复制到本机。`);
    }
    return { key: row.key, value: JSON.stringify(restored) };
  });
}

function main() {
  const snapshots = loadSnapshots();
  validateProviders(snapshots.providers);

  const backupPath = backupDb();
  const statements = [];

  appendSettingsRestore(statements, snapshots.settings);
  appendSimpleTableRestore(statements, 'mcp_servers', snapshots.mcp_servers);
  appendSimpleTableRestore(statements, 'skills', snapshots.skills);
  appendSimpleTableRestore(statements, 'skill_repos', snapshots.skill_repos);
  appendSimpleTableRestore(statements, 'prompts', snapshots.prompts);
  appendSimpleTableRestore(statements, 'proxy_config', snapshots.proxy_config);
  appendSimpleTableRestore(statements, 'model_pricing', snapshots.model_pricing);
  appendProvidersRestore(statements, snapshots.providers, snapshots.provider_endpoints);

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
  console.log(`  providers: ${snapshots.providers.length}`);
  console.log(`  provider_endpoints: ${snapshots.provider_endpoints.length}`);
  console.log('');
  console.log('请重启 cc-switch，并切换一次 provider，让 cc-switch 重新下发配置到各端。');
}

function loadSnapshots() {
  const settingsDoc = mustRead(snapshotPaths.settings, 'common/settings.json');
  const mcpDoc = readJsonIfExists(snapshotPaths.mcpServers, { rows: [] });
  const skillsDoc = readJsonIfExists(snapshotPaths.skills, { skills: [], skill_repos: [] });
  const promptsDoc = readJsonIfExists(snapshotPaths.prompts, { rows: [] });
  const proxyDoc = readJsonIfExists(snapshotPaths.proxy, {
    proxy_config: [],
    provider_endpoints: [],
    model_pricing: [],
  });
  const providersDoc = mustRead(snapshotPaths.providers, 'providers/providers.json');

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
    providers: asRows(providersDoc),
  };
}

function mustRead(filePath, label) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`缺少 ${label}。请先在源机器运行“导出配置.bat”，并确认 providers/ 已手动复制到本机。`);
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

function appendProvidersRestore(statements, providers, providerEndpoints) {
  const hasProvidersTable = tableExists('providers');
  const hasEndpointsTable = tableExists('provider_endpoints');

  if (!hasProvidersTable) {
    console.warn('跳过 providers：当前 cc-switch db 没有 providers 表，可能 schema 已变化。');
    return;
  }

  // 先删子表 provider_endpoints，再删父表 providers；恢复时先写 providers，再写 endpoints。
  if (hasEndpointsTable) statements.push(clearTableStatement('provider_endpoints'));
  statements.push(clearTableStatement('providers'));
  statements.push(...upsertStatements('providers', providers));

  if (providerEndpoints.length) {
    if (hasEndpointsTable) statements.push(...upsertStatements('provider_endpoints', providerEndpoints));
    else console.warn('跳过 provider_endpoints：当前 cc-switch db 没有该表，可能 schema 已变化。');
  }
}

function validateProviders(providers) {
  if (!providers.length) {
    throw new Error('providers/providers.json 中没有 provider。供应商配置含 token，不进 git；请从源机器手动复制 providers/ 目录。');
  }

  for (const provider of providers) {
    for (const key of ['id', 'app_type', 'name', 'settings_config']) {
      if (provider[key] === undefined || provider[key] === null || provider[key] === '') {
        throw new Error(`provider 缺少必要字段 ${key}：${provider.name || provider.id || '(unknown)'}`);
      }
    }

    if (String(provider.app_type).toLowerCase() === 'claude') {
      let parsed = null;
      try {
        parsed = JSON.parse(provider.settings_config);
      } catch (error) {
        throw new Error(`Claude provider settings_config 不是合法 JSON：${provider.name} (${error.message})`);
      }
      const token = parsed?.env?.ANTHROPIC_AUTH_TOKEN;
      if (!token) {
        console.warn(`提示：Claude provider “${provider.name}” 没有 env.ANTHROPIC_AUTH_TOKEN；如果它走官方登录或无 token 模式，可忽略。`);
      }
    } else {
      if (typeof provider.settings_config !== 'string' || !provider.settings_config.trim()) {
        throw new Error(`provider settings_config 为空：${provider.name}`);
      }
    }
  }
}

try {
  main();
} catch (error) {
  console.error(`恢复失败：${error.message}`);
  process.exit(1);
}
