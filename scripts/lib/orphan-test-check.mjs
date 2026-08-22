// dao-check ㉖：孤儿测试闸——test 文件引用的仓内目标不存在 = 机制已删而测试没同删，
// 留着它要么红着占噪音、要么绿着骗「机制还在」。退役机制必须同 PR 删测试（Q5 拍板：
// 退役靠判断不靠 CI 自动删，CI 只负责把孤儿拦在红里）。
//
// 检查器自持正则，不 import 任何被检文件的解析（自己查自己查不出错）。
// 只查解析进仓内的引用；os.tmpdir 等绝对路径、拼不出来的动态表达式不算孤儿、单列 dynamic。
// 扫完 0 个测试文件 = 没查成（unscanned），不是「没有孤儿」。

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const LITERAL_RE = /(?:import\s+[^'"]*?from\s*|import\s*|require\s*\()\s*['"](\.{1,2}\/[^'"]+)['"]/g;
const JOIN_RE = /(?:path\.)?join\(\s*__dirname\s*((?:\s*,\s*['"][^'"]*['"])+)/g;

/** 从测试文件正文抽仓内相对引用。返回 { refs: string[], dynamic: number }。 */
export function extractTestRefs(src) {
  const refs = [];
  let dynamic = 0;
  const text = String(src || '');
  for (const m of text.matchAll(new RegExp(LITERAL_RE.source, 'g'))) refs.push(m[1]);
  for (const m of text.matchAll(new RegExp(JOIN_RE.source, 'g'))) {
    const segs = [...m[1].matchAll(/['"]([^'"]*)['"]/g)].map(x => x[1]);
    if (segs.length === 0 || segs.some(s => s.includes('${'))) { dynamic++; continue; }
    refs.push(segs.join('/'));
  }
  // import('file://' + LIB) 这类动态导入：LIB 的 join(__dirname,...) 赋值已被 JOIN_RE 收到，
  // 不重复计；拼不出来的动态表达式调用方才报 dynamic，本函数不硬猜。
  return { refs, dynamic };
}

function normRef(ref) {
  return String(ref || '').replace(/\\/g, '/');
}

/**
 * 纯判官：给测试文件清单 + 读文件 + 查存在，出孤儿名单。
 * files: 相对 root 的路径列表（tests/xxx.test.js）；readFile/exists 由调用方注入。
 */
export function inspectOrphanTests({ files, readFile, exists } = {}) {
  if (!Array.isArray(files)) return { ok: false, unscanned: true, error: '没给测试文件清单（没查成）' };
  const tests = files.filter(f => /(^|\/)tests?\/[^/]+\.test\.(js|mjs|cjs)$/i.test(f));
  if (tests.length === 0) return { ok: false, unscanned: true, error: '扫到 0 个测试文件（没查成，不是没有孤儿）' };
  if (typeof readFile !== 'function' || typeof exists !== 'function') {
    return { ok: false, unscanned: true, error: '没给 readFile/exists 探头（没查成）' };
  }
  const orphans = [];
  let dynamic = 0;
  let scannedRefs = 0;
  for (const tf of tests) {
    let src;
    try { src = readFile(tf); } catch (e) {
      return { ok: false, unscanned: true, error: `读 ${tf} 失败：${e && e.message ? e.message : e}` };
    }
    const { refs, dynamic: dyn } = extractTestRefs(src);
    dynamic += dyn;
    const testDir = tf.replace(/\/[^/]+$/, '');
    for (const rawRef of refs) {
      const ref = normRef(rawRef);
      const parts = [];
      let escaped = false;
      for (const seg of [...testDir.split('/'), ...ref.split('/')]) {
        if (seg === '' || seg === '.') continue;
        if (seg === '..') {
          if (parts.length === 0) { escaped = true; break; }
          parts.pop();
          continue;
        }
        parts.push(seg);
      }
      if (escaped) continue; // 指出仓外的不归本闸
      const resolved = parts.join('/');
      if (!resolved) continue;
      scannedRefs++;
      if (!exists(resolved)) orphans.push({ test: tf, ref, resolved });
    }
  }
  return { ok: orphans.length === 0, unscanned: false, orphans, scanned: tests.length, scannedRefs, dynamic };
}

function walkFiles(dir, prefix, acc) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) walkFiles(p, rel, acc);
    else if (st.isFile()) acc.push(rel);
  }
  return acc;
}

/** 夹具判别力：red 必须抓出孤儿、ok 必须绿、empty 必须标没查成。 */
export function inspectOrphanTestFixtures(root) {
  if (!root) return { ok: false, unscanned: true, error: '没给样本根目录' };
  if (!existsSync(root)) return { ok: false, unscanned: true, error: `样本目录不在：${root}` };
  const kinds = { red: 0, ok: 0, empty: 0 };
  const problems = [];
  for (const kind of ['red', 'ok', 'empty']) {
    const dir = join(root, kind);
    if (!existsSync(dir)) { problems.push(`缺 ${kind}/`); continue; }
    const files = walkFiles(dir, '', []).filter(f => !f.split('/').pop().startsWith('.'));
    if (kind === 'empty') {
      if (files.length !== 0) { problems.push('empty/ 应该 0 个文件（0 个 = 没查成）'); continue; }
      const r = inspectOrphanTests({ files: [], readFile: () => '', exists: () => false });
      if (!r.unscanned) problems.push('empty 没标没查成');
      else kinds.empty += 1;
      continue;
    }
    if (files.length === 0) { problems.push(`${kind}: 0 个文件——没查成`); continue; }
    const r = inspectOrphanTests({
      files,
      readFile: (rel) => readFileSync(join(dir, rel), 'utf8'),
      exists: (rel) => existsSync(join(dir, rel)),
    });
    if (kind === 'red') {
      if (r.unscanned || r.ok) problems.push('red/ 自称该红但抓不到孤儿');
      else kinds.red += 1;
    }
    if (kind === 'ok') {
      if (r.unscanned) problems.push('ok/ 没查成');
      else if (!r.ok) problems.push(`ok/ 自称该绿但抓出：${r.orphans.map(o => `${o.test}→${o.ref}`).join('；')}`);
      else kinds.ok += 1;
    }
  }
  if (kinds.red === 0 || kinds.ok === 0 || kinds.empty === 0) {
    return { ok: false, unscanned: true, error: `样本种类不够 red=${kinds.red} ok=${kinds.ok} empty=${kinds.empty}`, kinds, problems };
  }
  if (problems.length) return { ok: false, unscanned: false, error: problems[0], kinds, problems };
  return { ok: true, unscanned: false, kinds };
}
