import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { claudeSettingsPath, hasBomBuffer, readJsonIfExists, snapshotPaths, stripBom, encodePaths, homeDir, findWtSettingsPath } from './paths.mjs';
import { selectRows, stableJson, tableExists } from './sqlite.mjs';
import { commonSecretsPath, countPlaceholders, SECRET_PLACEHOLDER } from './secrets.mjs';
import { probeMcpHealth, evaluateMcpHealth } from './mcp-health.mjs';

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

  section('cc-switch 运行态密钥保护门');
  checkRuntimeSettingsGuard();

  section('Claude common env');
  checkCommonClaudeEnv();

  section('当前 ~/.claude/settings.json');
  checkClaudeSettingsFile();

  section('snapshot 一致性');
  compareSnapshot('mcp_servers', snapshotPaths.mcpServers, (doc) => asRows(doc));
  compareSkillsSnapshot();

  section('common 脱敏门（防 token 进 git）');
  checkCommonRedaction();

  section('外部工具链');
  checkExternalTools();

  section('MCP 路径占位门（防绝对路径进 git）');
  checkMcpPathLeak();

  section('客户端 MCP 同步');
  checkClientMcpSync();

  section('MCP 健康态（claude mcp list，issue #92）');
  checkMcpHealth();

  section('Windows Terminal 配色');
  checkTerminalSync();

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
  let dbRows = selectRows(tableName, tableName === 'mcp_servers' ? 'ORDER BY name, id' : '');
  // mcp_servers 快照是占位符形态，db 是真实路径；比较前把 db 也 encode，否则恒不一致。
  if (tableName === 'mcp_servers') {
    dbRows = dbRows.map((m) => (m.server_config ? { ...m, server_config: encodePaths(m.server_config) } : m));
  }

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

function checkRuntimeSettingsGuard() {
  const runtimeRows = selectRows('settings', "WHERE key = 'claude_desktop_gateway_token'");
  if (!runtimeRows.length || !String(runtimeRows[0].value || '').trim()) {
    fail('settings.claude_desktop_gateway_token 缺失。Desktop 到 cc-switch Gateway 认证会 401。');
  } else {
    pass('settings.claude_desktop_gateway_token 存在（仅检查存在，不打印值）。');
  }

  if (!fs.existsSync(snapshotPaths.settings)) {
    warn(`缺少 ${snapshotPaths.settings}，跳过 settings 快照运行态 key 检查。`);
    return;
  }
  const doc = readJsonIfExists(snapshotPaths.settings, { rows: [] });
  const rows = asRows(doc);
  const bad = rows.map((row) => String(row.key || '')).filter((key) => key && !key.startsWith('common_config_'));
  if (bad.length) {
    fail(`common/settings.json 含非 common_config_ settings key（会破坏本机运行态）：${bad.join(', ')}`);
  } else {
    pass('common/settings.json 只包含 common_config_ settings key，不会覆盖运行态密钥。');
  }
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
    fail(`common/settings.json 有 ${placeholders} 个脱敏占位符，但缺少 config-sync/common-secrets.json。换机时需手动复制该文件。`);
  }
}

function checkExternalTools() {
  const tools = [
    { cmd: 'gh', label: 'GitHub CLI (gh)', installHint: 'winget install GitHub.cli' },
    { cmd: 'uvx', label: 'uv/uvx (Python MCP)', installHint: 'powershell -c "irm https://astral.sh/uv/install.ps1 | iex"' },
  ];
  for (const { cmd, label, installHint } of tools) {
    try {
      execFileSync(process.platform === 'win32' ? 'where' : 'which', [cmd], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      });
      pass(`${label} 已安装。`);
    } catch {
      fail(`${label} 未安装。→ ${installHint}`);
      continue;
    }
    if (cmd === 'gh') {
      try {
        execFileSync('gh', ['auth', 'status'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        pass('gh 已登录 GitHub。');
      } catch {
        warn('gh 未登录。→ gh auth login');
      }
    }
  }
}

function checkMcpPathLeak() {
  if (!fs.existsSync(snapshotPaths.mcpServers)) {
    warn(`缺少 ${snapshotPaths.mcpServers}，请先运行“导出配置.bat”。`);
    return;
  }
  const raw = fs.readFileSync(snapshotPaths.mcpServers, 'utf8');

  // 一级（fail）：projectRoot / home 的真实路径残留 —— 说明 encode 漏了，这类本可泛化。
  const encodable = encodePaths(raw);
  if (encodable !== raw) {
    fail('mcp_servers.json 残留 projectRoot/home 真实路径，应已占位符化。请重新运行导出。');
    return;
  }
  pass('mcp_servers.json 无 projectRoot/home 真实路径残留（已占位符化）。');

  // 二级（warn）：其他盘符绝对路径（如 D:/Program Files 的 pencil）—— 本机特定，无法泛化。
  const others = [...raw.matchAll(/"([A-Za-z]:[\\/][^"]*)"/g)].map((m) => m[1]);
  if (others.length) {
    warn(`mcp_servers.json 含本机特定绝对路径（换机需重配）：${[...new Set(others)].join(' ; ')}`);
  }
}

function checkClientMcpSync() {
  const expectedClaude = selectRows('mcp_servers', 'WHERE enabled_claude = 1 ORDER BY name').map((row) => row.name);
  const expectedCodex = selectRows('mcp_servers', 'WHERE enabled_codex = 1 ORDER BY name').map((row) => row.name);
  const jsonTargets = [
    { label: 'Claude Code CLI', path: path.join(homeDir, '.claude.json'), expected: expectedClaude },
    { label: 'Roaming Claude Desktop', path: path.join(homeDir, 'AppData', 'Roaming', 'Claude', 'claude_desktop_config.json'), expected: expectedClaude },
  ];
  for (const target of jsonTargets) {
    checkJsonMcpTarget(target);
  }

  checkClaude3pRuntimeMcp(expectedClaude);
  checkCodexMcpTarget(path.join(homeDir, '.codex', 'config.toml'), expectedCodex);
}

function checkJsonMcpTarget({ label, path: target, expected }) {
  if (!fs.existsSync(target)) { warn(`${label} config 不存在，跳过：${target}`); return; }
  let doc;
  try { doc = JSON.parse(stripBom(fs.readFileSync(target, 'utf8'))); }
  catch (error) { fail(`${label} config 不是合法 JSON：${target} (${error.message})`); return; }
  const actual = Object.keys(doc.mcpServers || {}).sort();
  reportMcpDiff(label, target, expected, actual);
}

function checkClaude3pRuntimeMcp(expected) {
  if (process.platform !== 'win32') return;
  let commandLines = [];
  try {
    const ps = [
      'Get-CimInstance Win32_Process',
      '| Where-Object { $_.CommandLine -like "*Local\\Claude-3p\\claude-code*" -and $_.CommandLine -like "*--mcp-config*" }',
      '| Select-Object -ExpandProperty CommandLine',
      '| ConvertTo-Json -Compress',
    ].join(' ');
    const raw = execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8' }).trim();
    if (raw) commandLines = JSON.parse(raw);
    if (typeof commandLines === 'string') commandLines = [commandLines];
  } catch (error) {
    warn(`Claude-3p 运行态 MCP 检查失败：${error.message}`);
    return;
  }

  if (!commandLines.length) {
    warn('未发现运行中的 Claude-3p claude-code --mcp-config 进程；跳过 Claude-3p 运行态 MCP 检查。');
    return;
  }

  const actual = extractClaude3pRuntimeMcpNames(commandLines[0]);
  if (!actual.length) {
    warn('发现 Claude-3p claude-code 进程，但无法解析 --mcp-config 中的 mcpServers；跳过一致性判定。');
    return;
  }
  reportMcpDiff('Claude-3p runtime --mcp-config', 'process command line', expected, actual);
}

function extractClaude3pRuntimeMcpNames(commandLine) {
  const match = String(commandLine).match(/--mcp-config\s+"((?:\\.|[^"])*)"/);
  if (match) {
    try {
      const unescaped = JSON.parse(`"${match[1]}"`);
      const doc = JSON.parse(unescaped);
      return Object.keys(doc.mcpServers || {}).sort();
    } catch {
      // fallback below
    }
  }

  const known = selectRows('mcp_servers', 'ORDER BY name').map((row) => row.name);
  return known.filter((name) => String(commandLine).includes(`"${name}"`) || String(commandLine).includes(`\\"${name}\\"`)).sort();
}

function checkCodexMcpTarget(target, expected) {
  if (!fs.existsSync(target)) { warn(`Codex config 不存在，跳过：${target}`); return; }
  const raw = stripBom(fs.readFileSync(target, 'utf8'));
  const actual = [...raw.matchAll(/^\[mcp_servers\.([^\].]+)\]\s*$/gm)].map((m) => unquoteTomlKey(m[1])).sort();
  reportMcpDiff('Codex config', target, expected, actual);
}

function unquoteTomlKey(key) {
  if (!key.startsWith('"')) return key;
  try { return JSON.parse(key); } catch { return key; }
}

function reportMcpDiff(label, target, expected, actual) {
  const expectedSorted = [...expected].sort();
  const missing = expectedSorted.filter((name) => !actual.includes(name));
  const extra = actual.filter((name) => !expectedSorted.includes(name));
  if (!missing.length && !extra.length) pass(`${label} MCP 与 cc-switch 一致：${target}（${actual.length} 个）`);
  else warn(`${label} MCP 与 cc-switch 不一致：${target} missing=[${missing.join(',')}] extra=[${extra.join(',')}]`);
}

// ── MCP 健康态（issue #92）──────────────────────────────────────────────────
// 上面 checkClientMcpSync 那组只答"配置里写没写这个 server"（注册态），本节答
// "它现在连不连得上"（生效态）——issue #92 记录的病正是这两者被分开却无人例行看差异。
// 判据全部在 config-sync/lib/mcp-health.mjs（parseMcpListOutput / probeMcpHealth /
// evaluateMcpHealth 三个纯函数 + 一层薄薄的 I/O 边界），本函数只做取数与打印，
// 不复述判据——那份文件头注是唯一真相源。
// 成本照直写：`claude mcp list` 本机实测 6-15 秒（issue 原文记录过一次 30s+），
// 这是它只挂在这里（显式体检）、不放进 SessionStart 同步路径的唯一理由。
function checkMcpHealth() {
  const expected = selectRows('mcp_servers', 'WHERE enabled_claude = 1 ORDER BY name').map((row) => row.name);
  if (!expected.length) {
    warn('cc-switch db 里没有 enabled_claude=1 的 MCP server，跳过健康探测。');
    return;
  }
  const probe = probeMcpHealth({});
  const { lines } = evaluateMcpHealth(expected, probe);
  for (const line of lines) {
    if (line.level === 'pass') pass(line.message);
    else if (line.level === 'fail') fail(line.message);
    else warn(line.message);
  }
}

function checkTerminalSync() {
  const wtPath = findWtSettingsPath();
  if (!wtPath) {
    warn('未找到 Windows Terminal settings.json（未安装或非商店版）。');
    return;
  }
  pass(`Windows Terminal: ${wtPath}`);

  const snap = readJsonIfExists(snapshotPaths.terminal, null);
  if (!snap) {
    warn('缺少 common/terminal.json 快照，请运行 dao.bat 上行导出 terminal。');
    return;
  }

  let wt;
  try {
    wt = JSON.parse(stripBom(fs.readFileSync(wtPath, 'utf8')));
  } catch (error) {
    fail(`Windows Terminal settings.json 解析失败：${error.message}`);
    return;
  }

  const localScheme = wt.profiles?.defaults?.colorScheme;
  const snapScheme = snap.defaults?.colorScheme;
  if (localScheme && snapScheme && localScheme === snapScheme) {
    pass(`默认配色一致：${localScheme}`);
  } else if (localScheme && snapScheme) {
    warn(`默认配色不一致：本机 "${localScheme}" ≠ 快照 "${snapScheme}"。如需同步，运行 dao.bat 上行或下行。`);
  }

  const localSchemes = (wt.schemes || []).map((s) => s.name).sort();
  const snapSchemes = (snap.schemes || []).map((s) => s.name).sort();
  if (stableJson(localSchemes) === stableJson(snapSchemes)) {
    pass(`自定义 schemes 一致（${localSchemes.length} 个）。`);
  } else {
    warn(`自定义 schemes 不一致：本机 [${localSchemes.join(',')}] ≠ 快照 [${snapSchemes.join(',')}]。`);
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
