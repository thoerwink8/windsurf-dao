// 解析外部工具输出必须有该工具真实输出存档（#499）。
// 检查器自己读信封，不调用 extract*——自己查自己查不出形状漂了。

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export function scanExtractParsers(daoCmdText) {
  const names = [];
  const re = /export function (extract[A-Z]\w*)\s*\(/g;
  let m;
  while ((m = re.exec(String(daoCmdText || '')))) names.push(m[1]);
  return names;
}

export function checkOrcaJsonFixtures({ daoCmdText, fixtureDir, index } = {}) {
  const parsers = scanExtractParsers(daoCmdText);
  if (parsers.length === 0) {
    return { ok: false, unscanned: true, error: '没扫到任何 extract* 解析函数', missing: [], scanned: [] };
  }
  if (!fixtureDir || !existsSync(fixtureDir)) {
    return { ok: false, unscanned: true, error: 'orca-json 语料目录不在', missing: [], scanned: [] };
  }
  let doc = index;
  if (!doc) {
    const indexPath = join(fixtureDir, 'index.json');
    if (!existsSync(indexPath)) {
      return { ok: false, unscanned: true, error: 'orca-json/index.json 不在', missing: [], scanned: [] };
    }
    try {
      doc = JSON.parse(readFileSync(indexPath, 'utf8'));
    } catch (e) {
      return { ok: false, unscanned: true, error: `index.json 不是 JSON: ${e.message}`, missing: [], scanned: [] };
    }
  }
  if (!doc || typeof doc !== 'object') {
    return { ok: false, unscanned: true, error: 'index.json 不是对象', missing: [], scanned: [] };
  }

  const missing = [];
  const scanned = [];
  for (const name of parsers) {
    const entry = doc[name];
    if (!entry || typeof entry !== 'object') {
      missing.push(`${name} 未登记语料`);
      continue;
    }
    if (!entry.file || !entry.command || !entry.capturedAt) {
      missing.push(`${name} 缺 file/command/capturedAt`);
      continue;
    }
    const filePath = join(fixtureDir, entry.file);
    if (!existsSync(filePath)) {
      missing.push(`${name} 语料文件不在: ${entry.file}`);
      continue;
    }
    let payload;
    try {
      payload = JSON.parse(readFileSync(filePath, 'utf8'));
    } catch (e) {
      missing.push(`${name} 语料不是 JSON: ${e.message}`);
      continue;
    }
    if (!payload || typeof payload !== 'object' || payload.ok !== true || !payload.result || typeof payload.result !== 'object') {
      missing.push(`${name} 语料不是 orca 成功信封（要 ok:true + result）`);
      continue;
    }
    scanned.push(name);
  }

  return {
    ok: missing.length === 0,
    unscanned: false,
    missing,
    scanned,
    parserCount: parsers.length,
  };
}
