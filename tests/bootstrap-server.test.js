// bootstrap-server：清单与仓库必须对得上——清单漂了比没有清单更糟（会装出一个残缺的编排面）。
// 判据都是确定性的（文件在不在、集合交不交），不碰机器状态。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const MOD = import('file://' + path.join(REPO, 'scripts', 'bootstrap-server.mjs').replace(/\\/g, '/'));

test('编排面清单里的每个装机脚本都在仓库里', async () => {
  const { ORCHESTRATION } = await MOD;
  assert.ok(ORCHESTRATION.length > 0, '编排面清单为空 = 没查成');
  for (const { name, why } of ORCHESTRATION) {
    assert.equal(fs.existsSync(path.join(REPO, 'scripts', `install-${name}.sh`)), true, `install-${name}.sh 不在（${why}）`);
  }
});

test('读回清单里的每只单元都在 host/machine/systemd 里（防清单漂移）', async () => {
  const { READBACK } = await MOD;
  const dir = path.join(REPO, 'host', 'machine', 'systemd');
  assert.ok(READBACK.length > 0, '读回清单为空 = 没查成');
  for (const { unit } of READBACK) {
    assert.equal(fs.existsSync(path.join(dir, unit)), true, `${unit} 不在仓内单元目录里`);
  }
});

test('旧链路与编排面不重叠（同一只单元不许既装又拆）', async () => {
  const { ORCHESTRATION, LEGACY_UNITS, READBACK } = await MOD;
  const orchestrationUnits = new Set(READBACK.map(r => r.unit));
  for (const unit of LEGACY_UNITS) {
    assert.equal(orchestrationUnits.has(unit), false, `${unit} 同时出现在编排面与旧链路清单里`);
  }
  assert.ok(LEGACY_UNITS.length > 0, '旧链路清单为空 = 没查成（要么已拆干净，要么清单漏了）');
  assert.ok(ORCHESTRATION.length + LEGACY_UNITS.length > 0);
});

test('前提检查在非 Linux 上会拒绝（fail-closed，不猜着装）', async () => {
  const { preconditions } = await MOD;
  const problems = preconditions();
  if (process.platform !== 'linux') {
    assert.ok(problems.some(p => /Linux/.test(p)), '非 Linux 必须报出来');
  }
});
