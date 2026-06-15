import { pathToFileURL } from 'node:url';
import { ensureSnapshotDirs, snapshotPaths, writeJson, encodePaths } from './paths.mjs';
import { selectRows, tableExists } from './sqlite.mjs';
import { commonSecretsPath, redactValue } from './secrets.mjs';
import { parseScopeArg, wants } from './scope.mjs';

// 对 settings 行脱敏并占位符化路径：value 是 JSON 的逐字段脱敏，非 JSON（如 codex TOML）原样保留但仍做路径占位。
// 返回 { redactedRows, secrets, skippedNonJson }。
export function redactSettings(rows) {
  const redactedRows = [];
  const secrets = {};
  const skippedNonJson = [];
  for (const row of rows) {
    let parsed;
    try {
      parsed = JSON.parse(row.value);
    } catch {
      // 非 JSON（codex 用 TOML 字符串）：不脱敏，但仍占位符化 home/project 路径，避免快照绑定本机。
      redactedRows.push({ key: row.key, value: encodePaths(row.value) });
      skippedNonJson.push(row.key);
      continue;
    }
    const { redacted, secrets: rowSecrets } = redactValue(row.key, parsed);
    Object.assign(secrets, rowSecrets);
    redactedRows.push({ key: row.key, value: encodePaths(JSON.stringify(redacted)) });
  }
  return { redactedRows, secrets, skippedNonJson };
}

// cc-switch DB → 仓库 snapshot。only=null 导出全部；否则只导出命中的 scope。
export function runExport({ only = null } = {}) {
  ensureSnapshotDirs();

  const settings = selectRows('settings', "WHERE key LIKE 'common_config_%' ORDER BY key");
  const mcpServers = selectRows('mcp_servers', 'ORDER BY name, id');
  const skills = selectRows('skills', 'ORDER BY name, id');
  const skillRepos = selectRows('skill_repos', 'ORDER BY owner, name, branch');
  const prompts = selectRows('prompts', 'ORDER BY app_type, name, id');
  const proxyConfig = selectRows('proxy_config', 'ORDER BY app_type');
  const providerEndpoints = selectRows('provider_endpoints', 'ORDER BY app_type, provider_id, id');
  const modelPricing = selectRows('model_pricing', 'ORDER BY model_id');
  const providers = selectRows('providers', 'ORDER BY app_type, sort_index, name, id');

  const { redactedRows, secrets, skippedNonJson } = redactSettings(settings);

  if (wants(only, 'settings')) {
    writeJson(snapshotPaths.settings, {
      source: 'cc-switch.settings',
      note: '敏感字段已脱敏为占位符，真实值在 providers/common-secrets.json（不入 git）。',
      rows: redactedRows,
    });
    writeJson(commonSecretsPath, {
      source: 'cc-switch.settings 中被脱敏的字段真实值',
      secrets,
    });
  }

  if (wants(only, 'mcp')) {
    writeJson(snapshotPaths.mcpServers, {
      source: 'cc-switch.mcp_servers',
      note: 'server_config 里的本机绝对路径已占位符化（${PROJECT_ROOT}/${HOME}），恢复时还原。',
      rows: mcpServers.map((m) => ({ ...m, server_config: encodePaths(m.server_config) })),
    });
  }

  if (wants(only, 'skills')) {
    writeJson(snapshotPaths.skills, {
      source: 'cc-switch.skills + cc-switch.skill_repos',
      skills,
      skill_repos: skillRepos,
    });
  }

  if (wants(only, 'prompts')) {
    writeJson(snapshotPaths.prompts, {
      source: 'cc-switch.prompts',
      rows: prompts,
    });
  }

  if (wants(only, 'proxy')) {
    writeJson(snapshotPaths.proxy, {
      source: 'cc-switch.proxy_config + provider_endpoints + model_pricing',
      proxy_config: proxyConfig,
      provider_endpoints: providerEndpoints,
      model_pricing: modelPricing,
    });
  }

  if (wants(only, 'providers')) {
    writeJson(snapshotPaths.providers, {
      source: 'cc-switch.providers',
      rows: providers,
    });
  }

  console.log('config-sync 导出完成');
  console.log(`  settings common keys: ${settings.length}`);
  console.log(`  common 脱敏字段: ${Object.keys(secrets).length}（真实值写入 providers/common-secrets.json）`);
  if (skippedNonJson.length) {
    console.log(`  非 JSON common（未脱敏，原样保留）: ${skippedNonJson.join(', ')}`);
  }
  console.log(`  mcp servers: ${mcpServers.length}`);
  console.log(`  skills: ${skills.length}`);
  console.log(`  skill repos: ${skillRepos.length}`);
  console.log(`  prompts: ${prompts.length}`);
  console.log(`  providers: ${providers.length}`);
  console.log('');
  console.log('安全提醒：providers/ 包含供应商 token/API key，已由 config-sync/.gitignore 忽略，请不要手动提交。');
  console.log('下一步建议：运行 git status，确认 common/ 与脚本进入版本管理，providers/ 不显示。');

  if (!tableExists('providers')) {
    console.warn('警告：cc-switch db 中没有 providers 表，可能 schema 与预期不同。');
  }
}

function isCli() {
  return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isCli()) {
  try {
    runExport({ only: parseScopeArg() });
  } catch (error) {
    console.error(`导出失败：${error.message}`);
    process.exit(1);
  }
}
