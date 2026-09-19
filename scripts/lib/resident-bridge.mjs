// 常驻面「一行桥」解析与闸（#1524 附带）。
//
// 2026 最佳实践：AGENTS.md 当唯一真相源（Codex/Cursor/Copilot/Windsurf 原生读它），
// CLAUDE.md 留一行 `@AGENTS.md`——Anthropic 文档原话「Claude Code reads CLAUDE.md, not
// AGENTS.md」，并推荐用 import 而非 symlink（symlink 在 Windows 检出时退化成「内容只有
// AGENTS.md 五个字」的普通文件，Edit/Write 还写不进去）。
//
// 三个坑，闸就是为它们配的：
//   ① 写在反引号 / 代码块里的 `@AGENTS.md` **不导入**——最常见的「桥悄悄没生效」；
//   ② 父目录 CLAUDE.md 的 import，从子目录启动时不展开；
//   ③ import 最多嵌套 4 跳。
// 本模块只解析桥，不复用宿主自己的解析（检查器纪律）。
// 零样本：一个常驻面都没扫到 = 没查成，不是绿。

import { readFileSync, existsSync, lstatSync } from 'node:fs';
import { join, dirname } from 'node:path';

export const BRIDGE_MAX_HOPS = 4;
export const RESIDENT_RELS = ['CLAUDE.md', 'AGENTS.md', 'docs/global-CLAUDE.md'];

/** 去掉围栏代码块与行内代码。坑① 的判据要在剥离后看。 */
export function stripCode(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/~~~[\s\S]*?~~~/g, '')
    .replace(/`[^`\n]*`/g, '');
}

/** 抽真正的 @导入（坑①：写在代码块/行内代码里的不算）。 */
export function extractImports(text) {
  const out = [];
  for (const line of stripCode(text).split(/\r?\n/)) {
    const m = line.match(/^\s*@([^\s]+)\s*$/);
    if (m) out.push(m[1]);
  }
  return out;
}

/** 整份文件就是若干 @导入（无其他正文）⇒ 它是桥。 */
export function parseBridge(text) {
  const src = String(text || '');
  const imports = extractImports(src);
  const bare = stripCode(src).split(/\r?\n/).filter((l) => l.trim() && !/^\s*@[^\s]+\s*$/.test(l));
  return { bridge: imports.length > 0 && bare.length === 0, imports };
}

/** 沿桥走到最终承载内容的文件。返回 { rel, text } 或 { missing, error }。 */
export function resolveResident(root, rel, files) {
  const read = (r) => {
    const n = String(r).replace(/\\/g, '/');
    if (files && Object.prototype.hasOwnProperty.call(files, n)) return { text: files[n] };
    const p = join(root || '', n);
    if (!existsSync(p)) return { missing: true, path: p };
    try { return { text: readFileSync(p, 'utf8') }; } catch (e) { return { missing: true, error: String(e.message || e) }; }
  };
  let cur = rel;
  for (let hop = 0; hop <= BRIDGE_MAX_HOPS; hop += 1) {
    const got = read(cur);
    if (got.missing) return { missing: true, rel: cur, error: got.error || `不在: ${cur}` };
    const b = parseBridge(got.text);
    if (!b.bridge) return { rel: cur, text: got.text, hops: hop };
    if (b.imports.length !== 1) return { missing: true, rel: cur, error: `桥要恰好一条导入，这里是 ${b.imports.length} 条` };
    const next = join(dirname(cur), b.imports[0]).replace(/\\/g, '/');
    if (next.startsWith('..')) return { missing: true, rel: next, error: '导入跑出仓库' };
    cur = next;
  }
  return { missing: true, rel: cur, error: `导入超过 ${BRIDGE_MAX_HOPS} 跳` };
}

/**
 * 闸：常驻面不许出三个坑。
 * @returns {{kind:'ok'|'red'|'unscanned', problems:string[], bridged:string[]}}
 */
export function inspectBridges({ root, rels = RESIDENT_RELS, files } = {}) {
  if (!root && !files) return { kind: 'unscanned', problems: ['没给仓库根'], bridged: [] };
  const useFiles = !!files && typeof files === 'object';
  const has = (rel) => useFiles && Object.prototype.hasOwnProperty.call(files, rel);
  const problems = [];
  const bridged = [];
  let scanned = 0;

  for (const rel of rels) {
    let text;
    if (useFiles) {
      if (!has(rel)) continue;
      scanned += 1;
      text = String(files[rel]);
    } else {
      const p = join(root || '', rel);
      if (!existsSync(p)) continue;
      scanned += 1;
      try {
        if (lstatSync(p).isSymbolicLink()) problems.push(`${rel} 是符号链接——Windows 检出会退化成纯文本，Edit 也写不进去，改用 @ 导入`);
      } catch { /* 读不到就当没这条 */ }
      text = readFileSync(p, 'utf8');
    }

    const b = parseBridge(text);
    if (!b.bridge) {
      if (b.imports.length > 0) problems.push(`${rel} 混了正文与 @导入（${b.imports.join(' ')}）——要么整份当桥，要么别用 @`);
      // 坑①只对「短文件」报警：长文档正文里提到 @AGENTS.md 是正常叙述，不是想搭桥。
      else if (stripCode(text).split(/\r?\n/).filter((l) => l.trim()).length <= 2 && /@\s*[A-Za-z0-9._/-]+\.md/.test(text)) {
        problems.push(`${rel} 的 @导入写在代码块或行内代码里，不会展开（坑①：这是「桥悄悄没生效」最常见的样子）`);
      }
      continue;
    }
    bridged.push(rel);
    const r = resolveResident(root || '', rel, files);
    if (r.missing) problems.push(`${rel} 的桥断了：${r.error}`);
  }

  if (scanned === 0) return { kind: 'unscanned', problems: ['一个常驻面都没扫到'], bridged: [] };
  if (problems.length) return { kind: 'red', problems, bridged };
  return { kind: 'ok', problems, bridged };
}
