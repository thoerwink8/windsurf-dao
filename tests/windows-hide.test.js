// 本机（帅位/开发机）是 Windows：spawn 子进程不带 windowsHide 就闪一个控制台窗。
// #807 Linux 化时以「Linux 上无黑窗」为由把它删了——理由不成立：非 Windows 平台它是 no-op，
// 删了对 Linux 零收益，而 Windows 上每次 spawn 闪一次。dao-mode 的 UserPromptSubmit hook
// 每轮对话都跑，所以用户看到的是「一直在闪」（2026-09-05 用户实报）。
//
// 用户拍板（2026-09-05）：不是「少调用几次」，是**任何 spawn 都不许闪**——所以判据是全仓覆盖，
// 不是钉几个热点文件。规矩一句话：仓内每一处 spawn/execFile 都带 windowsHide: true，没有例外。
//
// 这道检查是「删了会有东西报警」的那个报警。#807 还把「不再传 windowsHide」写死进
// tests/dispatch-launch.test.js 的断言——回归被固化成契约，所以这里额外钉一条：那句断言不许回来。
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');

// 扫描面：本机与服务器都会跑的 node 脚本。加了在 Linux 是 no-op，所以不分平台。
const GLOB_DIRS = [
  ['scripts', /\.mjs$/],
  ['scripts/lib', /\.mjs$/],
  ['scripts/lib/dispatch', /\.mjs$/],
  ['host/skills/dao-mode/hooks', /\.mjs$/],
];

function listFiles() {
  const out = [];
  for (const [rel, re] of GLOB_DIRS) {
    const dir = path.join(REPO, rel);
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      if (fs.statSync(p).isFile() && re.test(name)) out.push(path.relative(REPO, p).replace(/\\/g, '/'));
    }
  }
  return out;
}

/** 一处 spawn 调用的起点列表（跳过注释行、import 行、函数定义行）。 */
function spawnSites(src) {
  const sites = [];
  const re = /\b(spawnSync|spawn|execFileSync|execFile)\s*\(/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const ls = src.lastIndexOf('\n', m.index) + 1;
    const le = src.indexOf('\n', m.index);
    const line = src.slice(ls, le < 0 ? src.length : le);
    const st = line.trim();
    if (st.startsWith('//') || st.startsWith('*')) continue;
    if (line.includes('import') && line.includes('from')) continue;
    if (/\bfunction\s+(spawnSync|spawn|execFileSync|execFile)/.test(line)) continue;
    sites.push({ index: m.index, line: st, lineNo: src.slice(0, m.index).split('\n').length });
  }
  return sites;
}

/** 调用点后 600 字符内认得出「带了 windowsHide」的三种形态。 */
function hasHide(src, site) {
  const seg = src.slice(site.index, site.index + 600);
  if (seg.includes('windowsHide')) return true;
  // options 是变量：常量名带 OPTS / 就地 opts 变量——那两处在各自文件的构造处已带，
  // 这里认它们，但要求文件里确实有一处 windowsHide（否则整文件都没带 = 判红）。
  if (/,\s*(opts|SPAWN_OPTS)\s*\)/.test(seg) && src.includes('windowsHide')) return true;
  return false;
}

describe('Windows 不闪控制台窗（全仓覆盖）', () => {
  it('仓内每一处 spawn/execFile 都带 windowsHide', () => {
    const files = listFiles();
    assert.ok(files.length >= 20, `扫描面只有 ${files.length} 个文件——判据钉的目录可能挪了，这是「没查成」不是「查过没事」`);
    let total = 0;
    const bad = [];
    for (const rel of files) {
      const src = fs.readFileSync(path.join(REPO, rel), 'utf8');
      for (const site of spawnSites(src)) {
        total += 1;
        if (!hasHide(src, site)) bad.push(`${rel}:${site.lineNo}  ${site.line.slice(0, 80)}`);
      }
    }
    assert.ok(total >= 50, `只扫到 ${total} 处 spawn——扫描逻辑可能失效了（本仓实测 60+ 处）`);
    assert.deepEqual(bad, [], `${bad.length}/${total} 处 spawn 缺 windowsHide，Windows 上每处闪一次窗：\n  ${bad.join('\n  ')}`);
  });

  it('判别力：缺 windowsHide 的样本必须被这套逻辑判红', () => {
    const fake = "const r = spawnSync('orca', args, { encoding: 'utf8', timeout: 20000 });";
    const sites = spawnSites(fake);
    assert.equal(sites.length, 1, '样本应识别出 1 处 spawn');
    assert.equal(hasHide(fake, sites[0]), false, '缺 windowsHide 的样本必须判红——否则这道检查是摆设');
    const good = "const r = spawnSync('orca', args, { encoding: 'utf8', windowsHide: true });";
    assert.equal(hasHide(good, spawnSites(good)[0]), true, '带了的不许误报');
  });

  it('#807 那条反向断言不许回来（回归被固化成契约的地方）', () => {
    const src = fs.readFileSync(path.join(REPO, 'tests/dispatch-launch.test.js'), 'utf8');
    assert.doesNotMatch(src, /windowsHide\s*!==\s*true/, '「断言不许传 windowsHide」= 把闪窗写成契约');
    assert.match(src, /windowsHide === true/, 'detached 那处要正向断言带 windowsHide');
  });
});
