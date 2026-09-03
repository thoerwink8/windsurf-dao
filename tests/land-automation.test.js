// land automation 安装规格（#829）：名字只一处、plan 幂等、prompt 不含业务逻辑。
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const LIB = import('file://' + path.join(__dirname, '..', 'scripts', 'lib', 'land-automation.mjs').replace(/\\/g, '/'));

describe('land automation 安装规格', () => {
  it('同名 0 条 create、1 条 edit、多于 1 条 error 不再造', async () => {
    const { planLandAutomationInstall } = await LIB;
    assert.equal(planLandAutomationInstall([]).action, 'create');
    const one = planLandAutomationInstall([{ name: 'land', id: 'abc', enabled: true }]);
    assert.equal(one.action, 'edit');
    assert.equal(one.id, 'abc');
    const many = planLandAutomationInstall([
      { name: 'land', id: 'a' },
      { name: 'land', id: 'b' },
    ]);
    assert.equal(many.action, 'error');
    assert.match(many.reason, /同名/);
  });

  it('别的名字不算这条', async () => {
    const { planLandAutomationInstall } = await LIB;
    assert.equal(planLandAutomationInstall([{ name: 'other', id: 'z' }]).action, 'create');
  });

  it('prompt 只下令跑 land，不写业务逻辑；precheck 是 --has-work', async () => {
    const { landPrompt, landPrecheckCommand, LAND_AUTOMATION_NAME, LAND_AUTOMATION_TRIGGER } = await LIB;
    const landJs = '/home/orca/windsurf-dao/scripts/land.mjs';
    const repo = '/home/orca/windsurf-dao';
    const prompt = landPrompt(landJs, repo);
    assert.match(prompt, /land\.mjs/);
    assert.match(prompt, /原样贴回/);
    assert.doesNotMatch(prompt, /decideShip|rebase|派生分支|worktree remove/);
    assert.equal(LAND_AUTOMATION_NAME, 'land');
    assert.equal(LAND_AUTOMATION_TRIGGER, 'hourly');
    assert.match(landPrecheckCommand(landJs, repo), /--has-work/);
  });
});
