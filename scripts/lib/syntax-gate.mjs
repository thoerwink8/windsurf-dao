// scripts/lib/syntax-gate.mjs —— T41：零依赖语法闸。纯函数：挑改动文件 + 判结果，不读盘不跑进程。
//
// 起因（2026-09-19 实咬）：提示词里多一对反引号截断模板串 → `packages/fleet/src/cli.mjs` 语法坏，
// 而 **fleet 测试 67/67 全绿**（测试不加载 cli.mjs）——worker 一起来就炸；抓到它的是 prettier 的解析报错。
// ⇒ 这类必须**零依赖**也能拦（prettier 没装时也要拦）：`node --check` 是 node 自带的。
//
// 三态：绿 / 红 / 没查成。**「改动里没有可查文件」与「没查成」必须分得开**。

export const SYNTAX_EXT = Object.freeze(['.js', '.mjs', '.cjs']);

const norm = (p) => String(p || '').replace(/\\/g, '/');

/** 挑出该查的文件：只认 .js/.mjs/.cjs，跳过 node_modules。 */
export function syntaxTargets(paths) {
  if (!Array.isArray(paths)) return null;
  return paths
    .map(norm)
    .filter((p) => p && !p.startsWith('node_modules/') && !p.includes('/node_modules/'))
    .filter((p) => SYNTAX_EXT.some((e) => p.endsWith(e)));
}

/**
 * @param {{ file:string, ok:boolean, error?:string }[]} results
 * @returns {{ state:'green'|'red', why:string, failures?:object[] }}
 */
export function judgeSyntaxResults(results) {
  if (!Array.isArray(results)) return { state: 'red', why: '结果形态不对（要数组）' };
  const bad = results.filter((r) => !r || r.ok !== true);
  if (bad.length) {
    return {
      state: 'red',
      failures: bad,
      why: `${bad.length} 个改动文件语法不过：${bad.map((b) => b && b.file).filter(Boolean).join(' ')}`,
    };
  }
  if (!results.length) {
    return { state: 'green', why: '改动里没有 .js/.mjs/.cjs——没东西要查（不是没查成）' };
  }
  return { state: 'green', why: `${results.length} 个改动文件语法都过` };
}
