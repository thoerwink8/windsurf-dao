import { ensureSnapshotDirs, snapshotPaths, writeJson } from './paths.mjs';
import { selectRows, tableExists } from './sqlite.mjs';
import { commonSecretsPath, redactValue } from './secrets.mjs';

// 对 settings 行脱敏：value 是 JSON 的逐字段脱敏，非 JSON（如 codex TOML）原样保留。
// 返回 { redactedRows, secrets, skippedNonJson }。
function redactSettings(rows) {
  const redactedRows = [];
  const secrets = {};
  const skippedNonJson = [];
  for (const row of rows) {
    let parsed;
    try {
      parsed = JSON.parse(row.value);
    } catch {
      // 非 JSON（codex 用 TOML 字符串）：不脱敏，原样保留。这类 common 不含 token。
      redactedRows.push({ key: row.key, value: row.value });
      skippedNonJson.push(row.key);
      continue;
    }
    const { redacted, secrets: rowSecrets } = redactValue(row.key, parsed);
    Object.assign(secrets, rowSecrets);
    redactedRows.push({ key: row.key, value: JSON.stringify(redacted) });
  }
  return { redactedRows, secrets, skippedNonJson };
}

function main() {
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

  writeJson(snapshotPaths.settings, {
    exportedAt: new Date().toISOString(),
    source: 'cc-switch.settings',
    note: '敏感字段已脱敏为占位符，真实值在 providers/common-secrets.json（不入 git）。',
    rows: redactedRows,
  });

  writeJson(commonSecretsPath, {
    exportedAt: new Date().toISOString(),
    source: 'cc-switch.settings 中被脱敏的字段真实值',
    secrets,
  });

  writeJson(snapshotPaths.mcpServers, {
    exportedAt: new Date().toISOString(),
    source: 'cc-switch.mcp_servers',
    rows: mcpServers,
  });

  writeJson(snapshotPaths.skills, {
    exportedAt: new Date().toISOString(),
    source: 'cc-switch.skills + cc-switch.skill_repos',
    skills,
    skill_repos: skillRepos,
  });

  writeJson(snapshotPaths.prompts, {
    exportedAt: new Date().toISOString(),
    source: 'cc-switch.prompts',
    rows: prompts,
  });

  writeJson(snapshotPaths.proxy, {
    exportedAt: new Date().toISOString(),
    source: 'cc-switch.proxy_config + provider_endpoints + model_pricing',
    proxy_config: proxyConfig,
    provider_endpoints: providerEndpoints,
    model_pricing: modelPricing,
  });

  writeJson(snapshotPaths.providers, {
    exportedAt: new Date().toISOString(),
    source: 'cc-switch.providers',
    rows: providers,
  });

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

try {
  main();
} catch (error) {
  console.error(`导出失败：${error.message}`);
  process.exit(1);
}
