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

// pi(~/.pi/agent/) 配置（issue #344）：settings.json + themes/ 进 git 快照，
// auth.json 走 common-secrets.json 通道（快照只放脱敏占位）；sessions/ · models-store.json · bin/ · extensions/ 不同步。
export const piAgentDir = path.join(homeDir, '.pi', 'agent');
export const piSettingsPath = path.join(piAgentDir, 'settings.json');
export const piThemesDir = path.join(piAgentDir, 'themes');
export const piAuthPath = path.join(piAgentDir, 'auth.json');
export const commonPiDir = path.join(commonDir, 'pi');

export const snapshotPaths = {
  settings: path.join(commonDir, 'settings.json'),
  mcpServers: path.join(commonDir, 'mcp_servers.json'),
  skills: path.join(commonDir, 'skills.json'),
  prompts: path.join(commonDir, 'prompts.json'),
  proxy: path.join(commonDir, 'proxy.json'),
  terminal: path.join(commonDir, 'terminal.json'),
  piSettings: path.join(commonPiDir, 'settings.json'),
  piThemes: path.join(commonPiDir, 'themes'),
  piAuth: path.join(commonPiDir, 'auth.json'),
};

// Windows Terminal settings.json 路径（UWP 商店版 + Preview 版）。
const wtCandidates = [
  path.join(homeDir, 'AppData', 'Local', 'Packages', 'Microsoft.WindowsTerminal_8wekyb3d8bbwe', 'LocalState', 'settings.json'),
  path.join(homeDir, 'AppData', 'Local', 'Packages', 'Microsoft.WindowsTerminalPreview_8wekyb3d8bbwe', 'LocalState', 'settings.json'),
];
export function findWtSettingsPath() {
  return wtCandidates.find((p) => fs.existsSync(p)) || null;
}

export function ensureSnapshotDirs() {
  fs.mkdirSync(commonDir, { recursive: true });
}

export function readJsonIfExists(filePath, fallback = null) {
  if (!fs.existsSync(filePath)) return fallback;
  const text = fs.readFileSync(filePath, 'utf8');
  if (!text.trim()) return fallback;
  try {
    return JSON.parse(stripBom(text));
  } catch (error) {
    throw new Error(`JSON 解析失败 ${path.basename(filePath)}: ${error.message}`);
  }
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

// ── 路径占位符 ──
// cc-switch DB 里 MCP server_config 含本机绝对路径（projectRoot / home），
// 直接进 git 换机失效。导出时把真实路径 → 占位符，恢复时还原。
// 同时处理正斜杠与反斜杠两种写法（Windows JSON 里两者都可能出现）。
export const PLACEHOLDER_PROJECT = '${PROJECT_ROOT}';
export const PLACEHOLDER_HOME = '${HOME}';

function pathVariants(absPath) {
  const fwd = absPath.replace(/\\/g, '/');
  const back = absPath.replace(/\//g, '\\');
  const escapedBack = back.replace(/\\/g, '\\\\');
  const extendedBack = `\\\\?\\${back}`;
  const escapedExtendedBack = extendedBack.replace(/\\/g, '\\\\');
  // 长路径前缀先替换，避免只替掉其中的 home/projectRoot 后残留 \\?\ 前缀。
  return [...new Set([escapedExtendedBack, extendedBack, escapedBack, absPath, fwd, back])];
}

// 真实路径 → 占位符（导出）。projectRoot 先于 home，避免 home 截断 projectRoot。
export function encodePaths(text) {
  let out = String(text);
  for (const v of pathVariants(projectRoot)) out = out.split(v).join(PLACEHOLDER_PROJECT);
  for (const v of pathVariants(homeDir)) out = out.split(v).join(PLACEHOLDER_HOME);
  return out;
}

// 占位符 → 真实路径（恢复）。统一用正斜杠还原（跨工具最稳）。
export function decodePaths(text) {
  return String(text)
    .split(PLACEHOLDER_PROJECT).join(projectRoot.replace(/\\/g, '/'))
    .split(PLACEHOLDER_HOME).join(homeDir.replace(/\\/g, '/'));
}

