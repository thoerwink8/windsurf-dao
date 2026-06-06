import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { selectRows } from './sqlite.mjs';
import { stripBom } from './paths.mjs';

const home = os.homedir();
const TARGETS = [
  path.join(home, 'AppData', 'Roaming', 'Claude', 'claude_desktop_config.json'),
  path.join(home, 'AppData', 'Local', 'Claude-3p', 'claude_desktop_config.json'),
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

function loadEnabledClaudeMcp() {
  const rows = selectRows('mcp_servers', 'WHERE enabled_claude = 1 ORDER BY name');
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

function writeDesktopConfig(filePath, mcpServers) {
  const current = readJson(filePath);
  const next = { ...current, mcpServers };
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (fs.existsSync(filePath)) {
    fs.copyFileSync(filePath, `${filePath}.before-desktop-mcp-${stamp()}.bak`);
  }
  fs.writeFileSync(filePath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return Object.keys(current.mcpServers || {}).length;
}

function main() {
  const mcpServers = loadEnabledClaudeMcp();
  const names = Object.keys(mcpServers);
  if (!names.length) throw new Error('cc-switch 中没有 enabled_claude=1 的 MCP。');

  console.log(`Desktop MCP 来源: cc-switch enabled_claude=1 (${names.length} 个): ${names.join(', ')}`);
  for (const target of TARGETS) {
    const beforeCount = writeDesktopConfig(target, mcpServers);
    console.log(`已写入: ${target}`);
    console.log(`  原 mcpServers: ${beforeCount} 个 -> 当前 ${names.length} 个（保留其他配置字段）`);
  }
}

try {
  main();
} catch (error) {
  console.error(`Desktop MCP 下发失败: ${error.message}`);
  process.exit(1);
}
