// pi-sync.mjs — pi(~/.pi/agent/) 配置同步（issue #344）
//
// 同步面（issue #344 表格，用户 2026-08-12 拍板）：
//   settings.json / themes/    → 进 git 快照
//   auth.json                  → 快照只放脱敏占位，真实值走 common-secrets.json（不进 git）
//   sessions/ models-store.json bin/ extensions/ → 不同步
//
// 形态照 config-sync 既有做法：judgment 全在纯函数（本文件）+ 一层薄薄的 I/O 边界，
// 与 lib/mcp-health.mjs 同款；I/O 函数接受显式目录参数（缺省才落到真机 ~/.pi/agent），
// tests/pi-sync.tests.js 用 _tmp 沙箱目录跑全流程，不碰真机配置。
//
// 判据清单（漂移判定一律结构化比对 stableJson / 字节哈希，不做文案正则）：
//   settings.json 漂移  → 快照 vs 本机 JSON 结构化比对
//   themes/ 漂移        → 快照主题文件 vs 本机同名文件：缺 / 改 / 多 三向
//   auth 快照泄漏       → 敏感字段名的值不是占位符 ⇒ 泄漏（逐字段走，不是扫文案）

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { projectRoot, homeDir, readJsonIfExists, writeJson } from './paths.mjs';
import { stableJson } from './sqlite.mjs';
import { commonSecretsPath, SECRET_PLACEHOLDER, redactValue, applySecrets, countPlaceholders, isSecretKey } from './secrets.mjs';

// auth.json 在 common-secrets.json 里的命名空间前缀（secrets 键形如 "pi_auth :: deepseek.key"）。
export const PI_AUTH_KEY = 'pi_auth';

// pi auth.json 的敏感字段判据：通用词表 + 裸 key（pi 的 auth.json 结构里 "<provider>.key" 就是密钥，
// 而通用 SECRET_KEY_RE 只认 api_key 不认裸 key）。导出脱敏与泄漏判定共用这一份。
export function isPiSecretKey(keyName) {
  return isSecretKey(keyName) || keyName === 'key';
}

export function defaultPiAgentDir() {
  return path.join(homeDir, '.pi', 'agent');
}
export function defaultPiSnapshotDir() {
  return path.join(projectRoot, 'config-sync', 'common', 'pi');
}

// ── 纯函数：判据 ──────────────────────────────────────────────────────────────

// auth.json 脱敏：敏感字段值 → SECRET_PLACEHOLDER；真实值键形如 "pi_auth :: deepseek.key"。
export function redactPiAuth(authDoc) {
  return redactValue(PI_AUTH_KEY, authDoc, { isSecretKey: isPiSecretKey });
}

// 把占位快照还原成真实 auth.json。缺真实值（common-secrets.json 缺失/不全）返回 null ⇒ 恢复方跳过。
export function rehydratePiAuth(redactedAuth, secretsMap) {
  const merged = applySecrets(PI_AUTH_KEY, redactedAuth, secretsMap, { strict: false });
  return countPlaceholders(merged) > 0 ? null : merged;
}

// 两个解析后的 JSON 文档是否结构化相同（键序/缩进无关，只比语义）。
export function sameJson(a, b) {
  return stableJson(a) === stableJson(b);
}

// 两个文件是否一致：都是合法 JSON ⇒ 结构化比对；任一解析失败 ⇒ 字节哈希比对。
export function sameFile(aPath, bPath) {
  if (!fs.existsSync(aPath) || !fs.existsSync(bPath)) return false;
  let aJson = null;
  let bJson = null;
  try { aJson = JSON.parse(stripBom(fs.readFileSync(aPath, 'utf8'))); } catch { aJson = null; }
  try { bJson = JSON.parse(stripBom(fs.readFileSync(bPath, 'utf8'))); } catch { bJson = null; }
  if (aJson !== null && bJson !== null) return sameJson(aJson, bJson);
  return sha256File(aPath) === sha256File(bPath);
}

// themes/ 三向漂移：snapshotFiles/localFiles 都是 { name: 绝对路径 }。
// 返回 { missing: string[], changed: string[], extra: string[] }。
export function themeDrift(snapshotFiles, localFiles) {
  const missing = [];
  const changed = [];
  const extra = [];
  for (const [name, snapPath] of Object.entries(snapshotFiles)) {
    const localPath = localFiles[name];
    if (!localPath) missing.push(name);
    else if (!sameFile(snapPath, localPath)) changed.push(name);
  }
  for (const name of Object.keys(localFiles)) {
    if (!Object.prototype.hasOwnProperty.call(snapshotFiles, name)) extra.push(name);
  }
  return { missing, changed, extra };
}

// auth 占位快照的泄漏判定：敏感字段名（isPiSecretKey，与导出脱敏同一份判据）的值不是占位符 ⇒ 泄漏。
// 返回泄漏字段的 dot 路径数组（空 = 干净）。
export function leakedSecretPaths(doc) {
  const leaked = [];
  function walk(node, dotPath) {
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, `${dotPath}[${index}]`));
      return;
    }
    if (node && typeof node === 'object') {
      for (const key of Object.keys(node)) {
        const childPath = dotPath ? `${dotPath}.${key}` : key;
        const child = node[key];
        if (typeof child === 'string' && child.length > 0 && child !== SECRET_PLACEHOLDER && isPiSecretKey(key)) {
          leaked.push(childPath);
        } else {
          walk(child, childPath);
        }
      }
    }
  }
  walk(doc, '');
  return leaked;
}

// common-secrets.json 里 pi_auth 命名空间下的真实值条目数。
export function countPiSecrets(secretsMap) {
  return Object.keys(secretsMap).filter((k) => k.startsWith(`${PI_AUTH_KEY} :: `)).length;
}

// ── I/O 边界（显式目录参数，缺省落真机）───────────────────────────────────────

// 导出：~/.pi/agent → common/pi 快照（settings.json / themes/ 原样；auth.json 占位化，
// 真实值合并进 common-secrets.json）。返回 { settings, themes, auth, secrets }。
export function exportPi({ agentDir = defaultPiAgentDir(), snapshotDir = defaultPiSnapshotDir(), secretsPath = commonSecretsPath } = {}) {
  const result = { settings: false, themes: [], auth: false, secrets: {} };

  const settingsPath = path.join(agentDir, 'settings.json');
  if (!fs.existsSync(settingsPath)) {
    console.warn(`  pi: 未找到 ${settingsPath}，跳过导出。`);
    return result;
  }
  writeJson(path.join(snapshotDir, 'settings.json'), readJsonIfExists(settingsPath, null));
  result.settings = true;

  const srcThemes = path.join(agentDir, 'themes');
  if (fs.existsSync(srcThemes)) {
    for (const entry of fs.readdirSync(srcThemes, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      fs.mkdirSync(path.join(snapshotDir, 'themes'), { recursive: true });
      fs.copyFileSync(path.join(srcThemes, entry.name), path.join(snapshotDir, 'themes', entry.name));
      result.themes.push(entry.name);
    }
  }

  const authPath = path.join(agentDir, 'auth.json');
  if (fs.existsSync(authPath)) {
    const { redacted, secrets } = redactPiAuth(readJsonIfExists(authPath, null));
    writeJson(path.join(snapshotDir, 'auth.json'), redacted);
    Object.assign(result.secrets, secrets);
    if (Object.keys(secrets).length > 0) {
      const existing = readJsonIfExists(secretsPath, null);
      const mergedSecrets = { ...(existing?.secrets || {}), ...secrets };
      writeJson(secretsPath, {
        source: 'cc-switch.settings 与 pi auth 中被脱敏的字段真实值（不进 git，换机手动复制）',
        secrets: mergedSecrets,
      });
    }
    result.auth = true;
  }
  return result;
}

// 恢复：common/pi 快照 → ~/.pi/agent（settings.json + themes/ 原样落位；auth.json
// 先脱敏还原——占位符缺真实值（缺 common-secrets.json）时跳过 auth，不写坏文件）。
export function restorePi({ agentDir = defaultPiAgentDir(), snapshotDir = defaultPiSnapshotDir(), secretsPath = commonSecretsPath, dryRun = false } = {}) {
  const changes = [];

  const settingsPath = path.join(snapshotDir, 'settings.json');
  if (!fs.existsSync(settingsPath)) {
    console.warn('  pi: 缺少 common/pi/settings.json 快照，跳过。请先在源机器导出。');
    return { changes };
  }
  changes.push('settings.json');

  const themesDir = path.join(snapshotDir, 'themes');
  const themeFiles = fs.existsSync(themesDir)
    ? fs.readdirSync(themesDir).filter((f) => f.endsWith('.json')).sort()
    : [];
  changes.push(...themeFiles.map((f) => `themes/${f}`));

  let authDoc = null;
  const authPath = path.join(snapshotDir, 'auth.json');
  if (fs.existsSync(authPath)) {
    const secretsMap = readJsonIfExists(secretsPath, null)?.secrets || {};
    authDoc = rehydratePiAuth(readJsonIfExists(authPath, null), secretsMap);
    if (authDoc) changes.push('auth.json');
    else console.warn('  pi: auth.json 含未还原占位符（缺 common-secrets.json 真实值），跳过 auth 恢复。请从源机器复制该文件。');
  }

  if (dryRun) {
    console.log(`  pi (dry-run): ${changes.length} 项变更`);
    for (const c of changes) console.log(`    ${c}`);
    return { changes, dryRun: true };
  }

  fs.mkdirSync(path.join(agentDir, 'themes'), { recursive: true });
  fs.copyFileSync(settingsPath, path.join(agentDir, 'settings.json'));
  for (const f of themeFiles) {
    fs.copyFileSync(path.join(themesDir, f), path.join(agentDir, 'themes', f));
  }
  if (authDoc) writeJson(path.join(agentDir, 'auth.json'), authDoc);

  console.log(`  pi: 已写入 settings.json + ${themeFiles.length} 个主题${authDoc ? ' + auth.json' : '（auth 跳过）'} → ${agentDir}（重启 pi 生效）`);
  return { changes };
}

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function sha256File(filePath) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}
