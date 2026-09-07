// tests/helpers/record-reads.mjs —— 采样时记录「这套测试读过哪些本仓文件」（预加载模块）
//
// 为什么必须有它（2026-09-06 实测）：V8 覆盖率只记**执行过的 JS**，
// 测试用 `readFileSync` 读的 JSON / MD / TOML 完全不可见——建完图一查，
// 103 套里含非 JS 依赖的是 **0 套**。于是改 `docs/model-routing.json` 这种真相源时，
// affected 会算出「0 套相关」，把真正该跑的 legs.test.js 静默跳过。
// **比慢危险得多**：慢看得见，漏跑看不见。
//
// 2026-09-06 起**每次跑测试都挂**：地图改成 `dao-check` 跑测试的副产物，没有单独的建图动作了。
// 原来只在 `test-impact-map.mjs build` 那一次挂，理由是「有 I/O 开销」——实测那个开销是
// **8%**（18 套 5049ms → 5445ms），而它换掉的是一个建一次 110 秒、每加一个测试就要重建的机制。
//
// 与覆盖率同样靠 NODE_OPTIONS 继承罩住 spawn 出去的 CLI：被测 CLI 读了哪个配置，
// 也算这套测试的依赖（dispatch 读 model-routing.json 就是这么被记下的）。

import fs from 'node:fs';
import { appendFileSync } from 'node:fs';

const OUT = process.env.DAO_READ_LOG;
const ROOT = (process.env.DAO_READ_ROOT || '').replace(/\\/g, '/').replace(/\/$/, '');

// 只记「像数据/配置」的：JS 那半覆盖率已经管了，重复记只会让图变胖。
const DATA_EXT = /\.(json|md|toml|ya?ml|txt|ndjson|service|timer|sh|ps1)$/i;

function note(p) {
  if (!OUT || !ROOT || typeof p !== 'string') return;
  const norm = p.replace(/\\/g, '/');
  if (!norm.startsWith(ROOT + '/')) return;
  const rel = norm.slice(ROOT.length + 1);
  if (rel.includes('node_modules/') || rel.startsWith('_tmp/') || rel.startsWith('.git/')) return;
  if (!DATA_EXT.test(rel)) return;
  try { appendFileSync(OUT, rel + '\n'); } catch { /* 记不上不许拖垮被采样的进程 */ }
}

for (const name of ['readFileSync', 'existsSync', 'statSync', 'readdirSync']) {
  const real = fs[name];
  if (typeof real !== 'function') continue;
  fs[name] = function patched(p, ...rest) {
    // 只记，不改行为——采样器不许影响被采样对象的结果
    try { note(typeof p === 'string' ? p : (p && p.pathname) || ''); } catch { /* 同上 */ }
    return real.call(this, p, ...rest);
  };
}
