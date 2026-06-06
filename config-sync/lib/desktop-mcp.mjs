import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { selectRows } from './sqlite.mjs';
import { stripBom } from './paths.mjs';

const home = os.homedir();
const CLAUDE_JSON_PATH = path.join(home, '.claude.json');
const CODEX_CONFIG_PATH = path.join(home, '.codex', 'config.toml');
const DESKTOP_TARGETS = [
  { label: 'Roaming Claude Desktop', path: path.join(home, 'AppData', 'Roaming', 'Claude', 'claude_desktop_config.json') },
  { label: 'Local Claude-3p Desktop', path: path.join(home, 'AppData', 'Local', 'Claude-3p', 'claude_desktop_config.json') },
];

function readJson(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const text = stripBom(fs.readFileSync(filePath, 'utf8'));
  return text.trim() ? JSON.parse(text) : {};
}

function stamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function loadEnabledMcp(columnName) {
  const rows = selectRows('mcp_servers', `WHERE ${columnName} = 1 ORDER BY name`);
  const servers = {};
  for (const row of rows) {
    try {
      servers[row.name] = JSON.parse(row.server_config);
    } catch (error) {
      throw new Error(`mcp_servers.${row.name}.server_config 不是合法 JSON: ${error.message}`);
    }
  }
  return servers;
}

function backupFile(filePath, suffix) {
  if (fs.existsSync(filePath)) {
    fs.copyFileSync(filePath, `${filePath}.before-${suffix}-${stamp()}.bak`);
  }
}

function writeJsonMcpConfig(filePath, mcpServers, suffix) {
  const current = readJson(filePath);
  const next = { ...current, mcpServers };
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  backupFile(filePath, suffix);
  fs.writeFileSync(filePath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return Object.keys(current.mcpServers || {}).length;
}

function writeCodexToml(filePath, mcpServers) {
  const current = fs.existsSync(filePath) ? stripBom(fs.readFileSync(filePath, 'utf8')) : '';
  const nextBlock = renderCodexMcpBlock(mcpServers);
  const next = replaceCodexMcpBlock(current, nextBlock);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  backupFile(filePath, 'codex-mcp');
  fs.writeFileSync(filePath, next.endsWith('\n') ? next : `${next}\n`, 'utf8');
  return countCodexMcpServers(current);
}

function renderCodexMcpBlock(mcpServers) {
  const lines = ['[mcp_servers]', ''];
  for (const [name, config] of Object.entries(mcpServers)) {
    lines.push(`[mcp_servers.${tomlBareKey(name)}]`);
    lines.push(`type = ${tomlString(config.type || 'stdio')}`);
    lines.push(`command = ${tomlString(config.command)}`);
    if (Array.isArray(config.args)) {
      lines.push(`args = [${config.args.map(tomlString).join(', ')}]`);
    }
    if (config.env && typeof config.env === 'object' && Object.keys(config.env).length) {
      lines.push(`[mcp_servers.${tomlBareKey(name)}.env]`);
      for (const [key, value] of Object.entries(config.env)) {
        lines.push(`${tomlBareKey(key)} = ${tomlString(value)}`);
      }
    }
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

function replaceCodexMcpBlock(text, block) {
  const normalized = text.trimEnd();
  if (!normalized) return `${block}\n`;

  const start = normalized.search(/^\[mcp_servers\]\s*$/m);
  if (start < 0) return `${normalized}\n\n${block}\n`;

  const afterStart = normalized.slice(start);
  const nextSection = afterStart.slice(afterStart.indexOf('\n') + 1).search(/^\[(?!mcp_servers(?:\.|\]))/m);
  if (nextSection < 0) return `${normalized.slice(0, start).trimEnd()}\n\n${block}\n`;

  const afterHeaderOffset = afterStart.indexOf('\n') + 1;
  const end = start + afterHeaderOffset + nextSection;
  return `${normalized.slice(0, start).trimEnd()}\n\n${block}\n\n${normalized.slice(end).trimStart()}\n`;
}

function countCodexMcpServers(text) {
  return [...String(text).matchAll(/^\[mcp_servers\.([^\].]+)\]\s*$/gm)].length;
}

function tomlString(value) {
  return `"${String(value ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function tomlBareKey(value) {
  const key = String(value);
  if (/^[A-Za-z0-9_-]+$/.test(key)) return key;
  return tomlString(key);
}

function syncJsonTargets(mcpServers, targets, suffix) {
  const names = Object.keys(mcpServers);
  if (!names.length) throw new Error('cc-switch 中没有 enabled_claude=1 的 MCP。');

  for (const target of targets) {
    const beforeCount = writeJsonMcpConfig(target.path, mcpServers, suffix);
    console.log(`已写入 ${target.label}: ${target.path}`);
    console.log(`  原 mcpServers: ${beforeCount} 个 -> 当前 ${names.length} 个（保留其他配置字段）`);
  }
}

function main() {
  const claudeMcpServers = loadEnabledMcp('enabled_claude');
  const claudeNames = Object.keys(claudeMcpServers);
  if (!claudeNames.length) throw new Error('cc-switch 中没有 enabled_claude=1 的 MCP。');
  console.log(`Claude MCP 来源: cc-switch enabled_claude=1 (${claudeNames.length} 个): ${claudeNames.join(', ')}`);
  syncJsonTargets(claudeMcpServers, [
    { label: 'Claude Code CLI', path: CLAUDE_JSON_PATH },
    ...DESKTOP_TARGETS,
  ], 'claude-mcp');

  const codexMcpServers = loadEnabledMcp('enabled_codex');
  const codexNames = Object.keys(codexMcpServers);
  if (!codexNames.length) throw new Error('cc-switch 中没有 enabled_codex=1 的 MCP。');
  const codexBeforeCount = writeCodexToml(CODEX_CONFIG_PATH, codexMcpServers);
  console.log(`Codex MCP 来源: cc-switch enabled_codex=1 (${codexNames.length} 个): ${codexNames.join(', ')}`);
  console.log(`已写入 Codex config: ${CODEX_CONFIG_PATH}`);
  console.log(`  原 mcp_servers: ${codexBeforeCount} 个 -> 当前 ${codexNames.length} 个（保留其他配置字段）`);
}

try {
  main();
} catch (error) {
  console.error(`MCP 下发失败: ${error.message}`);
  process.exit(1);
}
