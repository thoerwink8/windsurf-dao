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

  it('#642 本仓对账绿，B 模板禁 EncodedCommand', async (t) => {
    const S = await LIB_LOAD;
    const live = S.checkMachinePaths({ root: REPO });
    await t.test('本仓仓外路径闸绿', () => {
      assert.ok(live.kind === 'ok' && live.green && !live.fail, '本仓仓外路径闸绿  →  ' + JSON.stringify(live));
    });

    const hookCmd = fs.readFileSync(path.join(REPO, 'host', 'machine', 'hooks', 'orca-cursor-hook.cmd'), 'utf8');
    const hookJson = fs.readFileSync(path.join(REPO, 'host', 'machine', 'hooks', 'orca-cursor.hooks.json'), 'utf8');
    await t.test('Orca hook 用 conhost --headless', () => {
      assert.ok(/conhost/i.test(hookJson) && /--headless/i.test(hookJson), 'Orca hook 用 conhost --headless');
    });
    await t.test('Orca hook 的 command 禁止 EncodedCommand', () => {
      const commands = [...hookJson.matchAll(/"command"\s*:\s*"([^"]+)"/g)].map(x => x[1]).join('\n');
      assert.ok(commands && !/EncodedCommand/i.test(commands) && !/powershell[\s\S]{0,80}EncodedCommand/i.test(hookCmd), 'Orca hook 的 command 禁止 EncodedCommand  →  ' + commands);
    });
  });
});
