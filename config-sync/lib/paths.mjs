import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const currentFile = fileURLToPath(import.meta.url);
export const libDir = path.dirname(currentFile);
export const configSyncRoot = path.resolve(libDir, '..');
export const projectRoot = path.resolve(configSyncRoot, '..');
export const homeDir = os.homedir();
export const ccSwitchDir = path.join(homeDir, '.cc-switch');
export const ccSwitchDbPath = path.join(ccSwitchDir, 'cc-switch.db');
export const ccSwitchBackupDir = path.join(ccSwitchDir, 'backups');
export const claudeSettingsPath = path.join(homeDir, '.claude', 'settings.json');
export const commonDir = path.join(configSyncRoot, 'common');
export const providersDir = path.join(configSyncRoot, 'providers');

export const snapshotPaths = {
  settings: path.join(commonDir, 'settings.json'),
  mcpServers: path.join(commonDir, 'mcp_servers.json'),
  skills: path.join(commonDir, 'skills.json'),
  prompts: path.join(commonDir, 'prompts.json'),
  proxy: path.join(commonDir, 'proxy.json'),
  providers: path.join(providersDir, 'providers.json'),
};

export function ensureSnapshotDirs() {
  fs.mkdirSync(commonDir, { recursive: true });
  fs.mkdirSync(providersDir, { recursive: true });
}

export function readJsonIfExists(filePath, fallback = null) {
  if (!fs.existsSync(filePath)) return fallback;
  const text = fs.readFileSync(filePath, 'utf8');
  if (!text.trim()) return fallback;
  return JSON.parse(stripBom(text));
}

export function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export function hasBomBuffer(buffer) {
  return buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf;
}
