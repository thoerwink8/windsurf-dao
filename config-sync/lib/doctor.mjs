import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { claudeSettingsPath, hasBomBuffer, readJsonIfExists, snapshotPaths, stripBom, encodePaths, homeDir, findWtSettingsPath, piSettingsPath, piThemesDir, piAuthPath } from './paths.mjs';
import { selectRows, stableJson, tableExists } from './sqlite.mjs';
import { commonSecretsPath, countPlaceholders, SECRET_PLACEHOLDER } from './secrets.mjs';
import { probeMcpHealth, evaluateMcpHealth, computeMcpUniverse } from './mcp-health.mjs';
import { sameJson, themeDrift, leakedSecretPaths, countPiSecrets, rehydratePiAuth } from './pi-sync.mjs';

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

  section('pi 配置漂移（快照 ↔ ~/.pi/agent，issue #344）');
  checkPiSync();

  finish();
}

function checkClaudeSettingsFile() {
  if (!fs.existsSync(claudeSettingsPath)) {
    warn(`找不到 ${claudeSettingsPath}，可能当前机器尚未运行 Claude Code。`);
    return;
  }

  const buffer = fs.readFileSync(claudeSettingsPath);
  if (hasBomBuffer(buffer)) fail('settings.json 带 UTF-8 BOM，会导致严格 JSON 解析失败。');
  else pass('settings.json 无 BOM。');

  try {
    JSON.parse(stripBom(buffer.toString('utf8')));
  } catch (error) {
    fail(`settings.json 不是合法 JSON：${error.message}`);
    return;
  }
  pass('settings.json 是合法 JSON。');
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
//
// 🔴 **2026-08-08 对抗复核实证：期望名单的宇宙曾经取错了**——旧版只查 cc-switch DB
// 的 `enabled_claude=1`，而 `claude mcp list` 实际会报出**所有**它认识的 server，
// 两者不是一回事：本机当天 DB 只登记 5 个，`claude mcp list` 实报 7 个，多出的
// `opendesign`/`penpot` 只注册在 Claude Code 自己那边（不在 cc-switch DB 里）。
// `opendesign` 当天恰好是死连接，且正是 issue #92 表格点名的那三个死连接之一——
// 旧版因为它不在 DB 期望集里而**静默跳过**，issue 的关闭条件在它自己点名的样本上
// 反而不成立。上面两行之外那一节（`checkClientMcpSync`）其实已经算出了这个差集
// （`extra=[opendesign,penpot]`），只是没被这一节用上。
// 修法：期望集改成「DB 期望集 ∪ 探测实见」的并集——探测实见但不在 DB 里的 server
// 照样按 dead/degraded/ok 判，只是报文里注明"不在 DB 名单里、来自实报"，让读者
// 明白它为什么会出现在这份体检里。
function checkMcpHealth() {
  const dbExpected = selectRows('mcp_servers', 'WHERE enabled_claude = 1 ORDER BY name').map((row) => row.name);
  const probe = probeMcpHealth({});
  const universe = computeMcpUniverse(dbExpected, probe);
  if (!universe.length) {
    warn(probe.state === 'ok'
      ? 'cc-switch db 里没有 enabled_claude=1 的 MCP server，claude mcp list 输出也没有任何 server，跳过健康探测。'
      : `cc-switch db 里没有 enabled_claude=1 的 MCP server，且探测本身没有跑成（${probe.why || probe.state}），跳过健康探测。`);
    return;
  }
  const dbExpectedSet = new Set(dbExpected);
  const { lines } = evaluateMcpHealth(universe, probe);
  for (const line of lines) {
    const extraSuffix = dbExpectedSet.has(line.name) ? '' :
      '（不在 cc-switch DB 的 enabled_claude 名单里，来自 claude mcp list 实报）';
    const message = line.message + extraSuffix;
    if (line.level === 'pass') pass(message);
    else if (line.level === 'fail') fail(message);
    else warn(message);
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

// pi(~/.pi/agent/) 三件：settings.json / themes/ 进 git 快照，auth.json 占位快照 + common-secrets.json。
// 漂移判定全是结构化比对（sameJson / themeDrift / 泄漏逐字段），不做文案正则。
function checkPiSync() {
  // ── settings.json ──
  if (!fs.existsSync(snapshotPaths.piSettings)) {
    warn('缺少 common/pi/settings.json 快照，请先运行 dao.bat 上行导出 pi。');
  } else if (!fs.existsSync(piSettingsPath)) {
    warn('~/.pi/agent/settings.json 不存在（本机可能尚未运行 pi），下行可落位。');
  } else if (sameJson(readJsonIfExists(snapshotPaths.piSettings, null), readJsonIfExists(piSettingsPath, null))) {
    pass('pi settings.json 与快照一致。');
  } else {
    warn('pi settings.json 与快照不一致（漂移）。如需同步，运行 dao.bat 下行或上行。');
  }

  // ── themes/（三向：缺 / 改 / 多）──
  const snapThemes = listJsonFiles(snapshotPaths.piThemes);
  const localThemes = listJsonFiles(piThemesDir);
  if (!Object.keys(snapThemes).length) {
    warn('缺少 common/pi/themes/ 快照（无主题文件），请先运行 dao.bat 上行导出 pi。');
  } else {
    const drift = themeDrift(snapThemes, localThemes);
    const bits = [];
    if (drift.missing.length) bits.push(`缺 ${drift.missing.join(',')}`);
    if (drift.changed.length) bits.push(`改 ${drift.changed.join(',')}`);
    if (drift.extra.length) bits.push(`多 ${drift.extra.join(',')}`);
    if (bits.length) warn(`pi themes/ 与快照不一致：${bits.join('；')}。`);
    else pass(`pi themes/ 与快照一致（${Object.keys(snapThemes).length} 个主题）。`);
  }

  // ── auth.json（占位快照 vs common-secrets.json + 本机真值）──
  if (!fs.existsSync(snapshotPaths.piAuth)) {
    warn('缺少 common/pi/auth.json 快照，请先运行 dao.bat 上行导出 pi。');
    return;
  }
  const snapAuth = readJsonIfExists(snapshotPaths.piAuth, null);
  const leaked = leakedSecretPaths(snapAuth);
  if (leaked.length) {
    fail(`common/pi/auth.json 泄漏敏感字段（未脱敏）：${leaked.join(', ')}。该文件进 git，请重新导出。`);
  } else {
    pass('common/pi/auth.json 无明文敏感字段（已占位化）。');
  }

  const placeholders = countPlaceholders(snapAuth);
  const secretsMap = readJsonIfExists(commonSecretsPath, null)?.secrets || {};
  const piSecrets = countPiSecrets(secretsMap);
  if (placeholders === 0) {
    pass('common/pi/auth.json 无脱敏占位符。');
  } else if (piSecrets < placeholders) {
    fail(`common/pi/auth.json 有 ${placeholders} 个脱敏占位符，但 common-secrets.json 只有 ${piSecrets} 个 pi 真实值，恢复会失败。换机时需手动复制该文件。`);
  } else if (!fs.existsSync(piAuthPath)) {
    pass(`common/pi/auth.json 有 ${placeholders} 个脱敏占位符，common-secrets.json 提供 ${piSecrets} 个真实值；本机尚无 auth.json，下行可落位。`);
  } else {
    const merged = rehydratePiAuth(snapAuth, secretsMap);
    if (merged && sameJson(merged, readJsonIfExists(piAuthPath, null))) pass(`pi auth.json 与快照一致（${placeholders} 个占位符还原比对）。`);
    else warn('pi auth.json 与快照不一致（漂移）。如需同步，运行 dao.bat 下行或上行。');
  }
}

function listJsonFiles(dir) {
  if (!fs.existsSync(dir)) return {};
  const out = {};
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.json')) out[entry.name] = path.join(dir, entry.name);
  }
  return out;
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
