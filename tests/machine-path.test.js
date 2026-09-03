// #642 仓外路径闸：漏写新家目录必须红；扫到 0 条 = 没查成；齐则绿。
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const LIB = path.join(REPO, 'scripts', 'lib', 'machine-path-check.mjs');
const LIB_LOAD = import('file://' + LIB.replace(/\\/g, '/'));
const FIX = path.join(__dirname, 'fixtures', 'machine-paths');

describe('machine-path', () => {
  it('#642 夹具：漏写 / 齐 / 0 条', async (t) => {
    const S = await LIB_LOAD;

    const red = S.checkMachinePaths({ root: path.join(FIX, 'red') });
    await t.test('夹具写 ~/.brand-new-cli/ 且不进 INDEX → 红', () => {
      assert.ok(red.kind === 'red' && red.fail, '夹具写 ~/.brand-new-cli/ 且不进 INDEX → 红  →  ' + JSON.stringify(red));
      assert.ok(/brand-new-cli/.test(red.fail.join(' ')), '红证据点得出新品类  →  ' + red.fail.join(' | '));
    });

    const ok = S.checkMachinePaths({ root: path.join(FIX, 'ok') });
    await t.test('同一品类写进 INDEX → 绿', () => {
      assert.ok(ok.kind === 'ok' && ok.green && !ok.fail, '同一品类写进 INDEX → 绿  →  ' + JSON.stringify(ok));
    });

    const empty = S.checkMachinePaths({ root: path.join(FIX, 'empty') });
    await t.test('扫到 0 条路径 → 没查成，不是绿', () => {
      assert.ok(empty.kind === 'unscanned' && empty.fail && /没查/.test(empty.fail.join(' ')), '扫到 0 条路径 → 没查成  →  ' + JSON.stringify(empty));
    });
  });

  it('#642 扫描器不读 INDEX 解析器', async (t) => {
    const S = await LIB_LOAD;
    const text = '装到 ~/.brand-new-cli/ 和 %USERPROFILE%\\.pi\\agent\\auth.json';
    const keys = [...S.scanText(text)].sort();
    await t.test('抽得出新品类和 pi', () => {
      assert.ok(keys.includes('~/.brand-new-cli') && keys.includes('~/.pi/agent'), '抽得出新品类和 pi  →  ' + keys.join(','));
    });

    const catalog = S.parseIndex('| 类 | 路径 | 看 |\n|---|---|---|\n| B | ~/.local/bin | shim |\n');
    await t.test('INDEX 解析是另一条路', () => {
      assert.ok(catalog.keys.has('~/.local/bin') && !catalog.keys.has('~/.brand-new-cli'), 'INDEX 解析是另一条路  →  ' + [...catalog.keys].join(','));
    });
  });

  // E 类（他仓真相源）：登记「这个落点归哪个仓」，本仓不写装法，所以仓里扫不到它。
  // 它必须免掉 stale 反查，但**不能因此变成万能豁免**——下面四小项分别验这两面。
  it('E 类：免 stale 反查，但不给非法类和漏登记开口子', async (t) => {
    const S = await LIB_LOAD;
    const NL = String.fromCharCode(10);
    const head = ['| 类 | 路径 | 看 |', '|---|---|---|', ''].join(NL);
    const cat = S.parseIndex(head + ['| E | ~/.mirasim | 归 ai-gateway-stack |', '| B | ~/.local/bin | shim |', ''].join(NL));

    await t.test('E 行进 keys 也进 softKeys，B 行不进 softKeys', () => {
      assert.ok(cat.problems.length === 0, 'E 类应合法  →  ' + JSON.stringify(cat.problems));
      assert.ok(cat.keys.has('~/.mirasim') && cat.softKeys.has('~/.mirasim'), 'E 行两边都要有  →  ' + [...cat.softKeys].join(','));
      assert.ok(!cat.softKeys.has('~/.local/bin'), 'B 行不该进 softKeys  →  ' + [...cat.softKeys].join(','));
    });

    await t.test('绿：E 路径仓里没出现，不判 stale', () => {
      const r = S.inspectMachinePaths({
        found: new Set(['~/.local/bin']),
        indexKeys: cat.keys, softKeys: cat.softKeys, ignoreKeys: new Set(), catalogProblems: [],
      });
      assert.ok(r.kind !== 'red', '仓里没出现的 E 路径不该判红  →  ' + JSON.stringify(r.problems || []));
    });

    // 违规样本①：E 类不得把「仓里有、目录没有」也一起豁免掉
    await t.test('红：仓里冒出没登记的路径，照样 leak', () => {
      const r = S.inspectMachinePaths({
        found: new Set(['~/.local/bin', '~/.brand-new-cli']),
        indexKeys: cat.keys, softKeys: cat.softKeys, ignoreKeys: new Set(), catalogProblems: [],
      });
      assert.equal(r.kind, 'red', '漏登记必须红  →  ' + JSON.stringify(r));
      assert.ok((r.leaks || []).includes('~/.brand-new-cli'), 'leak 要点名  →  ' + JSON.stringify(r.leaks));
    });

    // 违规样本②：放宽到 E 之后，越界字母仍必须判非法
    await t.test('红：类字母越界（F）仍判非法', () => {
      const bad = S.parseIndex(head + ['| F | ~/.whatever | 乱写 |', ''].join(NL));
      assert.ok(bad.problems.some(x => /类不合法/.test(x)), 'F 必须红  →  ' + JSON.stringify(bad.problems));
    });
  });

  it('#642 ignore 缺 why 必须红', async () => {
    const S = await LIB_LOAD;
    const bad = S.parseIgnore('| 路径 | why |\n|---|---|\n| ~/.secret |  |\n');
    assert.ok(bad.problems.some(p => /why/.test(p)), 'ignore 缺 why 必须红  →  ' + JSON.stringify(bad));
  });

  it('#642 live 不把实现里的正则/示例当路径', async (t) => {
    const S = await LIB_LOAD;
    const live = S.scanRepoPaths({ root: REPO });
    const ghosts = ['~/i', '~/.secret', '~/AppData/Local/i', '~/AppData/Roaming/i'];
    await t.test('实现文件已跳过', () => {
      assert.ok(S.SKIP_RELS.has('scripts/lib/machine-path-check.mjs') && S.SKIP_RELS.has('tests/machine-path.test.js'), '实现文件已跳过');
    });
    await t.test('live 不含扫描器自伤钥匙', () => {
      const hit = ghosts.filter(k => live.keys.has(k));
      assert.ok(hit.length === 0, 'live 不含扫描器自伤钥匙  →  ' + hit.join(' ') + ' / ' + [...live.keys].sort().join(','));
    });
    const stillSees = S.scanText('装到 ~/.brand-new-cli/ 以及 ~/.secret');
    await t.test('扫描器本身仍能抽出真实路径', () => {
      assert.ok(stillSees.has('~/.brand-new-cli') && stillSees.has('~/.secret'), '扫描器本身仍能抽出真实路径  →  ' + [...stillSees].join(','));
    });
  });

  it('#642 本仓对账绿（#807：不再验 Windows conhost / EncodedCommand）', async (t) => {
    const S = await LIB_LOAD;
    const live = S.checkMachinePaths({ root: REPO });
    await t.test('本仓仓外路径闸绿', () => {
      assert.ok(live.kind === 'ok' && live.green && !live.fail, '本仓仓外路径闸绿  →  ' + JSON.stringify(live));
    });
    await t.test('POSIX B 模板还在', () => {
      assert.ok(fs.existsSync(path.join(REPO, 'host', 'machine', 'shims', 'grok')), 'host/machine/shims/grok 在');
      assert.ok(fs.existsSync(path.join(REPO, 'host', 'machine', 'shims', 'agent')), 'host/machine/shims/agent 在');
    });
  });
});
