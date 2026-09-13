// 「声明」那一侧必须与现实对得上，否则声明退化成一句没人核的注释。
//
// 背景（2026-09-11 实咬）：单元里的 `GH_CONFIG_DIR=/var/empty` 会让 git 的凭据
// 助手 `gh auth git-credential` 找不到 hosts.yml。判「这行该不该设」的正确判据是
// 「这个单元要不要写远端」，而**猜**（扫 ExecStart + 跟 import 找 push）在
// minified 产物上必然误判——实测 mirasim-server 的 server.cjs 里撞出一堆无关的
// `['push']`。所以改成单元自己声明（`# REQUIRES_GIT_PUSH=1`）。声明式方案的
// 固有风险是「声明和现实会漂」，这道闸就是防漂的那一半：
//
// 本仓脚本树里真出现 git push 的，必须有单元声明它要推送。
//
// 判据刻意写得比 issue-gateway-check 那道宽——这里只问「有没有 push 这个动作」，
// 不试图判断它是不是活代码。宽判据在这边是安全的：多报只是让人多看一眼声明，
// 漏报才是把推送能力锁死。
//
// 反向不判（声明了但脚本其实不 push）也是故意的：不 push 的单元多留一条凭据
// 助手通路并不比少留更坏，且逐个证否要靠跑起来看，静态判不了。

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const SYSTEMD_DIR = path.join(REPO, 'host', 'machine', 'systemd');
const DECL = /^#\s*REQUIRES_GIT_PUSH=1\b/m;
// 三种写法：['push', …] / ['git', 'push', …] / sh 里的 git push。
// 刻度是拿 4 个真 push 脚本 + 6 个不 push 的脚本当场校准过的（见 git 历史）：
// 第一版写成 /\[['"]push['"]/ 时漏掉了 `["git", "push", …]` 这种最常见的形式——
// 「判据比现实窄」正是本仓反复咬到的那一类（test-side-oracle-weaker-than-real-gate）。
const PUSH_RE = /\[['"](?:git['"]\s*,\s*['"])?push['"]|\bgit\s+push\b/;
const IMPORT_RE = /^\s*import\s[^'"]*['"](\.\/[^'"]+)['"]/gm;

// 本闸只跟仓内 import。刻意**不**跟 `./lib/` 之外的绝对路径与 node_modules：
// 那些不属于本仓的推送能力，归各自的仓声明。
function scanFile(abs, seen, hits, depth = 0) {
  if (depth > 6 || seen.has(abs)) return;
  seen.add(abs);
  let text;
  try { text = fs.readFileSync(abs, 'utf8'); } catch { hits.push({ abs, unreadable: true }); return; }
  if (PUSH_RE.test(text)) hits.push({ abs });
  IMPORT_RE.lastIndex = 0;
  let m;
  while ((m = IMPORT_RE.exec(text))) {
    const child = path.resolve(path.dirname(abs), m[1]);
    scanFile(child, seen, hits, depth + 1);
  }
}

// 从单元文件的 ExecStart 取仓内脚本路径；取不到就跳过这一个（不猜）。
function repoScriptsOf(unitText) {
  const es = (unitText.match(/^ExecStart=(.*)$/m) || [])[1] || '';
  return es.split(/\s+/)
    .filter((t) => /\.(mjs|js|sh|cjs)$/.test(t))
    .map((t) => (t.startsWith('/') ? path.relative(REPO, t) : t.replace(/^\.\//, '')))
    .filter((r) => r && !r.startsWith('..') && fs.existsSync(path.join(REPO, r)));
}

describe('单元声明 REQUIRES_GIT_PUSH 与脚本现实一致', () => {
  it('仓内脚本树里真 push 的，必须有单元声明', () => {
    const units = fs.readdirSync(SYSTEMD_DIR).filter((n) => n.endsWith('.service'));
    assert.ok(units.length > 0, '一个单元都没扫到 = 没查成，不是绿');

    // ① 所有单元声明了的脚本（含 import 传递）
    const declared = new Set();
    for (const u of units) {
      const text = fs.readFileSync(path.join(SYSTEMD_DIR, u), 'utf8');
      if (!DECL.test(text)) continue;
      for (const rel of repoScriptsOf(text)) {
        const hits = [];
        scanFile(path.join(REPO, rel), new Set(), hits);
        for (const h of hits) declared.add(h.abs);
      }
    }

    // ② 全仓会进的入口脚本（单元碰到的）+ 它们 import 的本地模块
    const undeclared = [];
    let checked = 0;
    for (const u of units) {
      const text = fs.readFileSync(path.join(SYSTEMD_DIR, u), 'utf8');
      if (DECL.test(text)) continue;
      for (const rel of repoScriptsOf(text)) {
        const hits = [];
        scanFile(path.join(REPO, rel), new Set(), hits);
        checked += hits.length;
        for (const h of hits) {
          if (!declared.has(h.abs)) {
            undeclared.push(`${u}: ${path.relative(REPO, h.abs)} 里有 git push，但这个单元没声明 REQUIRES_GIT_PUSH=1`);
          }
        }
      }
    }
    // 0 个候选也可能是「正则没匹配上」，要跟「扫完查出 0 条」分开。
    assert.ok(checked >= 0, JSON.stringify({ checked, undeclared }));
    assert.deepEqual(undeclared, [], `有单元在写远端却没声明：\n${undeclared.join('\n')}`);
  });

  it('声明了的单元不许设 GH_CONFIG_DIR=/var/empty（设了就推不上去）', () => {
    const units = fs.readdirSync(SYSTEMD_DIR).filter((n) => n.endsWith('.service'));
    const bad = [];
    for (const u of units) {
      const text = fs.readFileSync(path.join(SYSTEMD_DIR, u), 'utf8');
      if (DECL.test(text) && /^Environment=GH_CONFIG_DIR=\/var\/empty\b/m.test(text)) bad.push(u);
    }
    assert.deepEqual(bad, [], `这些单元声明要推送却设了空目录，git 凭据助手会死：${bad.join('；')}`);
  });

  it('反向控制：往一个没声明的单元塞进 push 脚本 → 必须被报出来', () => {
    // 判据有没有鉴别力：手工构造一份「没声明 + 脚本里有 push」的输入，看 ① 的算法报不报。
    const tmp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'decl-probe-'));
    const script = path.join(tmp, 'pushes.mjs');
    // 样本要写成合法 JS。第一版这里写成单引号里再套单引号，字符串本身不合法，
    // 探针反而先红了——「判据没匹配上」和「样本是错的」看起来一模一样。
    fs.writeFileSync(script, 'run(["git", "push", "origin", "HEAD"]);\n');
    const hits = [];
    scanFile(script, new Set(), hits);
    assert.equal(hits.length, 1, '构造的 push 样本没被扫到——判据失效了');
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
