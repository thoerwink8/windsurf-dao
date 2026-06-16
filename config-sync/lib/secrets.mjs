import path from 'node:path';
import { configSyncRoot } from './paths.mjs';

export const commonSecretsPath = path.join(configSyncRoot, 'common-secrets.json');

// 占位符：进 git 的 common 快照里，敏感字段值会被替换成这个常量。
// 真实值按 "<settingsKey> :: <dot.path>" 存到 config-sync/common-secrets.json（不入 git）。
export const SECRET_PLACEHOLDER = '__CONFIG_SYNC_SECRET__';

// 字段名命中即视为敏感（大小写不敏感）。
const SECRET_KEY_RE = /(api[_-]?key|auth[_-]?token|access[_-]?token|secret|password|passwd|app[_-]?secret|bearer|^token$|\.token$)/i;

function isSecretKey(keyName) {
  return SECRET_KEY_RE.test(keyName);
}

// 深拷贝 + 按字段名脱敏。返回 { redacted, secrets }。
// secrets 形如 { "<settingsKey> :: a.b.c": "<realValue>" }。
export function redactValue(settingsKey, value) {
  const secrets = {};

  function walk(node, dotPath) {
    if (Array.isArray(node)) {
      return node.map((item, index) => walk(item, `${dotPath}[${index}]`));
    }
    if (node && typeof node === 'object') {
      const out = {};
      for (const key of Object.keys(node)) {
        const childPath = dotPath ? `${dotPath}.${key}` : key;
        const child = node[key];
        if ((typeof child === 'string' || typeof child === 'number') && isSecretKey(key) && String(child).length > 0) {
          secrets[`${settingsKey} :: ${childPath}`] = child;
          out[key] = SECRET_PLACEHOLDER;
        } else {
          out[key] = walk(child, childPath);
        }
      }
      return out;
    }
    return node;
  }

  const redacted = walk(value, '');
  return { redacted, secrets };
}

// 把 secrets 合并回 redacted 文档（restore 用）。返回新对象。
// strict=true（默认）：缺少真实值时抛错。strict=false：缺少时保留占位符，不抛错。
export function applySecrets(settingsKey, redacted, secretsMap, { strict = true } = {}) {
  function walk(node, dotPath) {
    if (Array.isArray(node)) {
      return node.map((item, index) => walk(item, `${dotPath}[${index}]`));
    }
    if (node && typeof node === 'object') {
      const out = {};
      for (const key of Object.keys(node)) {
        const childPath = dotPath ? `${dotPath}.${key}` : key;
        const child = node[key];
        if (child === SECRET_PLACEHOLDER) {
          const lookup = `${settingsKey} :: ${childPath}`;
          if (!Object.prototype.hasOwnProperty.call(secretsMap, lookup)) {
            if (strict) throw new Error(`common-secrets.json 缺少占位符对应的真实值：${lookup}`);
            out[key] = SECRET_PLACEHOLDER;
          } else {
            out[key] = secretsMap[lookup];
          }
        } else {
          out[key] = walk(child, childPath);
        }
      }
      return out;
    }
    return node;
  }
  return walk(redacted, '');
}

// 判断一段（已解析的）JSON 文档里是否还残留占位符。
export function countPlaceholders(value) {
  let count = 0;
  function walk(node) {
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node && typeof node === 'object') { Object.values(node).forEach(walk); return; }
    if (node === SECRET_PLACEHOLDER) count++;
  }
  walk(value);
  return count;
}
