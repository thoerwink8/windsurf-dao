// 常驻 systemd 单元必须 Restart=always（dao-check ㉜，issue #1037）
//
// 验 scripts/lib/unit-restart-check.mjs：
//   非 oneshot 且 Restart 不是 always（含缺省=no、on-failure）→ 红，点名文件；
//   oneshot 不要求 Restart；RestartPreventExitStatus= 不影响判定；
//   扫了 N 个 0 违规 vs 一个都没扫到——后者没查成，不许当绿；
//   检查器自持解析，不复用被检查对象；
//   故意违规夹具（Type=simple + Restart=on-failure）必须当场拦下。
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const LIB = path.join(REPO, 'scripts', 'lib', 'unit-restart-check.mjs');
const LIVE = path.join(REPO, 'host', 'machine', 'systemd');
const FIX = path.join(__dirname, 'fixtures', 'unit-restart');
const LOAD = import('file://' + LIB.replace(/\\/g, '/'));

function unit(name, body) {
  return { name, text: body };
}

describe('unit-restart-check', () => {
  it('检查器不复用被检查对象', () => {
    const src = fs.readFileSync(LIB, 'utf8');
    const imports = [...src.matchAll(/^import\s+[\s\S]*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);
    assert.equal(imports.length, 0, '本检查器零 import，探头全注入  →  ' + JSON.stringify(imports));
    assert.equal(/require\s*\(/.test(src), false, '也不许 require 被检查对象');
  });

  it('parseServiceKeys：取 [Service] 最后一次 Type=/Restart=', async () => {
    const S = await LOAD;
    const r = S.parseServiceKeys([
      '[Unit]',
      'Type=oneshot',
      '[Service]',
      'Type=simple',
      'Restart=on-failure',
      'Restart=always',
      '[Install]',
      'Restart=no',
    ].join('\n'));
    assert.equal(r.type, 'simple');
    assert.equal(r.restart, 'always');
  });

  it('judge：oneshot 不要求 Restart；常驻必须 always', async () => {
    const S = await LOAD;

    const oneshot = S.judgeUnitRestart(unit('a.service', '[Service]\nType=oneshot\nExecStart=/bin/true\n'));
    assert.equal(oneshot.ok, true);
    assert.equal(oneshot.oneshot, true);

    const always = S.judgeUnitRestart(unit('b.service', '[Service]\nType=simple\nRestart=always\n'));
    assert.equal(always.ok, true);
    assert.equal(always.restart, 'always');

    const onFailure = S.judgeUnitRestart(unit('c.service', '[Service]\nType=simple\nRestart=on-failure\n'));
    assert.equal(onFailure.ok, false);
    assert.equal(onFailure.restart, 'on-failure');
    assert.match(onFailure.why, /on-failure/);

    const missing = S.judgeUnitRestart(unit('d.service', '[Service]\nType=simple\nExecStart=/bin/true\n'));
    assert.equal(missing.ok, false);
    assert.match(missing.why, /缺 Restart=/);

    const noType = S.judgeUnitRestart(unit('e.service', '[Service]\nRestart=on-success\n'));
    assert.equal(noType.ok, false);
    assert.equal(noType.type, 'simple');

    const prevent = S.judgeUnitRestart(unit('f.service', [
      '[Service]',
      'Type=simple',
      'Restart=always',
      'RestartPreventExitStatus=3',
    ].join('\n')));
    assert.equal(prevent.ok, true, 'RestartPreventExitStatus 不影响判定');
  });

  it('inspectUnitRestart：0 个 = 没查成；扫了 N 个 0 违规是绿', async () => {
    const S = await LOAD;

    const zero = S.inspectUnitRestart({ units: [] });
    assert.equal(zero.unscanned, true);
    assert.equal(zero.ok, false);
    assert.equal(zero.scanned, 0);
    assert.match(zero.error, /没查成/);

    const missing = S.inspectUnitRestart();
    assert.equal(missing.unscanned, true);

    const green = S.inspectUnitRestart({
      units: [
        unit('oneshot.service', '[Service]\nType=oneshot\n'),
        unit('always.service', '[Service]\nType=simple\nRestart=always\nRestartPreventExitStatus=3\n'),
      ],
    });
    assert.equal(green.unscanned, false);
    assert.equal(green.ok, true);
    assert.equal(green.scanned, 2);
    assert.equal(green.resident, 1);
    assert.equal(green.violations.length, 0);

    const red = S.inspectUnitRestart({
      units: [
        unit('bad.service', '[Service]\nType=simple\nRestart=on-failure\n'),
        unit('ok.service', '[Service]\nType=oneshot\n'),
      ],
    });
    assert.equal(red.ok, false);
    assert.equal(red.unscanned, false);
    assert.equal(red.scanned, 2);
    assert.equal(red.violations.length, 1);
    assert.equal(red.violations[0].file, 'bad.service');
  });

  it('夹具红/绿/空有判别力；故意 on-failure 被拦住', async () => {
    const S = await LOAD;
    const exists = (rel) => fs.existsSync(path.join(REPO, rel));
    const readdir = (rel) => fs.readdirSync(path.join(REPO, rel));
    const readFile = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');
    const r = S.inspectUnitRestartFixtures({ exists, readdir, readFile });
    assert.equal(r.ok, true);
    assert.equal(r.unscanned, false);
    assert.equal(r.kinds.red, 1);
    assert.equal(r.kinds.ok, 1);
    assert.equal(r.kinds.empty, 1);

    const red = S.inspectUnitRestartDir({
      dirRel: 'tests/fixtures/unit-restart/red',
      readdir,
      readFile,
    });
    assert.equal(red.ok, false);
    assert.equal(red.unscanned, false);
    assert.equal(red.violations.length, 1);
    assert.equal(red.violations[0].restart, 'on-failure');
    assert.match(red.violations[0].file, /bad-on-failure\.service/);
  });

  it('仓内 host/machine/systemd/*.service 扫得到且 0 违规', async () => {
    const S = await LOAD;
    assert.equal(fs.existsSync(LIVE), true, 'host/machine/systemd 不在');
    const names = fs.readdirSync(LIVE).filter((f) => f.endsWith('.service'));
    assert.ok(names.length > 0, '一个 .service 都没扫到，本闸已经不在查任何东西');
    const r = S.inspectUnitRestartDir({
      dirRel: 'host/machine/systemd',
      readdir: (rel) => fs.readdirSync(path.join(REPO, rel)),
      readFile: (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8'),
    });
    assert.equal(r.unscanned, false, JSON.stringify(r));
    assert.equal(r.ok, true, (r.violations || []).map((v) => `${v.file}: ${v.why}`).join('；'));
    assert.ok(r.scanned === names.length);
    assert.ok(r.resident > 0, '现役常驻单元一个都没扫到，闸在量空气');
  });
});
