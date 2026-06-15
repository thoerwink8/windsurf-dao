// 把 cc-switch DB 的 common_config_claude 中 env 字段合并到 ~/.claude/settings.json。
// 仅补充 env，不覆盖 model/permissions/hooks 等字段——那些由 cc-switch 切 provider 时完整下发。
// 用途：cc-switch 未下发时，CLI 快速修复 doctor 报的 "settings.json.env.* 缺失"。

import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { claudeSettingsPath, readJsonIfExists, stripBom } from './paths.mjs';
import { selectRows } from './sqlite.mjs';

export function runMergeSettings({ dryRun = false } = {}) {
  const rows = selectRows('settings', "WHERE key = 'common_config_claude'");
  if (!rows.length) {
    console.error('cc-switch DB 中 common_config_claude 不存在，无法合并。');
    process.exit(1);
  }

  let commonConfig;
  try {
    commonConfig = JSON.parse(rows[0].value);
  } catch (error) {
    console.error(`common_config_claude 不是合法 JSON：${error.message}`);
    process.exit(1);
  }

  const commonEnv = commonConfig.env || {};
  if (!Object.keys(commonEnv).length) {
    console.log('common_config_claude.env 为空，无需合并。');
    return;
  }

  let settings = {};
  if (fs.existsSync(claudeSettingsPath)) {
    try {
      settings = JSON.parse(stripBom(fs.readFileSync(claudeSettingsPath, 'utf8')));
    } catch (error) {
      console.error(`settings.json 不是合法 JSON：${error.message}`);
      process.exit(1);
    }
  }

  const existingEnv = settings.env || {};
  const merged = { ...existingEnv, ...commonEnv };

  const added = Object.keys(commonEnv).filter((k) => !(k in existingEnv));
  const updated = Object.keys(commonEnv).filter((k) => k in existingEnv && String(existingEnv[k]) !== String(commonEnv[k]));

  if (!added.length && !updated.length) {
    console.log('settings.json.env 已与 common_config_claude.env 一致，无需变更。');
    return;
  }

  settings.env = merged;

  if (dryRun) {
    console.log('[DRY-RUN] 将写入以下 env 变更：');
  } else {
    fs.writeFileSync(claudeSettingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
    console.log(`已合并 env 到 ${claudeSettingsPath}`);
  }

  if (added.length) console.log(`  新增: ${added.join(', ')}`);
  if (updated.length) console.log(`  更新: ${updated.join(', ')}`);
}

function isCli() {
  return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isCli()) {
  const dryRun = process.argv.includes('--dry-run');
  runMergeSettings({ dryRun });
}
