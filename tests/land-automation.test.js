// land timer 安装规格：名字只一处，未启用必须红，没探到必须没查成。
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const LIB = import('file://' + path.join(__dirname, '..', 'scripts', 'lib', 'land-automation.mjs').replace(/\\/g, '/'));

describe('land timer 安装规格', () => {
  it('没探到 systemctl → unknown，不是绿', async () => {
    const { classifyLandTimer } = await LIB;
    const r = classifyLandTimer({ probed: false, reason: 'spawn 失败：ENOENT' });
    assert.equal(r.state, 'unknown');
    assert.match(r.detail, /没探到|ENOENT/);
  });

  it('timer 未启用 → 红，并指出装法', async () => {
    const { classifyLandTimer, LAND_INSTALL, LAND_TIMER } = await LIB;
    const r = classifyLandTimer({ probed: true, isEnabled: 'disabled', timersText: '' });
    assert.equal(r.state, 'red');
    assert.match(r.detail, new RegExp(LAND_TIMER));
    assert.match(r.detail, new RegExp(LAND_INSTALL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });

  it('enabled 且 list-timers 有 NEXT → 绿', async () => {
    const { classifyLandTimer, LAND_TIMER } = await LIB;
    const r = classifyLandTimer({
      probed: true,
      isEnabled: 'enabled',
      timersText: `Wed 2026-09-07 01:17:00 CST 30min left n/a n/a ${LAND_TIMER} dao-land.service`,
    });
    assert.equal(r.state, 'ok');
  });

  it('enabled 但 NEXT 是横杠 → 红', async () => {
    const { classifyLandTimer, LAND_TIMER } = await LIB;
    const r = classifyLandTimer({
      probed: true,
      isEnabled: 'enabled',
      timersText: `- n/a n/a n/a ${LAND_TIMER} dao-land.service`,
    });
    assert.equal(r.state, 'red');
    assert.match(r.detail, /横杠/);
  });
});
