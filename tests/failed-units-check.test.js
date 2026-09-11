// #1173 的第三格：本仓单元挂进 `systemctl --failed` 时要有东西红。
//
// 这道闸要防的那个形状（2026-09-06 起实咬了五天）：
// 另一道闸守「单元文件写对没写对」，它 11/11 绿的时候 miraquota-contabo
// 正因为文件里那一行每 10 分钟红一次。**文件对了不等于单元活了。**
//
// 判据刻度：归属看 ExecStart 指不指向本仓，不看单元名（名字是手打的，早晚漏）。
// 三态里只有 red 是红；unknown 一律不当绿——「没查成」和「查完没事」必须分得开。

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const LOAD = import('file://' + path.join(REPO, 'scripts', 'lib', 'failed-units-check.mjs').replace(/\\/g, '/'));
const fs = require('node:fs');

const MINE = '[Service]\nUser=orca\nExecStart=/usr/bin/node /srv/projects/windsurf-dao/scripts/miraquota-contabo-sync.mjs --once\n';
const OTHERS = '[Service]\nExecStart=/usr/bin/node /srv/projects/ai-gateway-stack/deploy/x.mjs\n';

describe('本仓单元挂 systemctl --failed', () => {
  it('本仓单元失败 → red，且点名是哪个', async () => {
    const { classifyFailedUnits } = await LOAD;
    const out = '  UNIT LOAD ACTIVE SUB DESCRIPTION\n  miraquota-contabo.service loaded failed failed MiraQuota\n';
    const r = classifyFailedUnits({
      output: out, repoRoot: REPO,
      unitTexts: { 'miraquota-contabo.service': MINE },
    });
    assert.equal(r.state, 'red', JSON.stringify(r));
    assert.deepEqual(r.failed, ['miraquota-contabo.service']);
    assert.ok(r.plain && r.plain.what && r.plain.impact, '红要带人话三行');
  });

  it('只有别仓的单元失败 → green（不归本仓，不许把噪音算进来）', async () => {
    const { classifyFailedUnits } = await LOAD;
    const out = '  UNIT LOAD ACTIVE SUB DESCRIPTION\n  other.service loaded failed failed x\n';
    const r = classifyFailedUnits({ output: out, repoRoot: REPO, unitTexts: { 'other.service': OTHERS } });
    assert.equal(r.state, 'green', JSON.stringify(r));
  });

  it('干净 → green', async () => {
    const { classifyFailedUnits } = await LOAD;
    const r = classifyFailedUnits({
      output: '  UNIT LOAD ACTIVE SUB DESCRIPTION\n\n0 loaded units listed.\n',
      repoRoot: REPO, unitTexts: {},
    });
    assert.equal(r.state, 'green', JSON.stringify(r));
  });

  // 三条 unknown：探不到 / 输出空 / 读不到 unit 文件判不了归属。
  // 任一做成绿，就等于把「没查成」当成「查过没事」——本仓硬规矩不允许。
  it('探不到 systemctl → unknown，不是绿', async () => {
    const { classifyFailedUnits } = await LOAD;
    const r = classifyFailedUnits({ output: undefined, repoRoot: REPO, unitTexts: {} });
    assert.equal(r.state, 'unknown', JSON.stringify(r));
    assert.match(r.detail, /没查成|探不到/);
  });

  it('输出空 → unknown，不是绿', async () => {
    const { classifyFailedUnits } = await LOAD;
    const r = classifyFailedUnits({ output: '', repoRoot: REPO, unitTexts: {} });
    assert.equal(r.state, 'unknown', JSON.stringify(r));
  });

  it('失败单元读不到 unit 文件 → unknown，不是绿', async () => {
    const { classifyFailedUnits } = await LOAD;
    const out = '  UNIT LOAD ACTIVE SUB DESCRIPTION\n  mystery.service loaded failed failed x\n';
    const r = classifyFailedUnits({ output: out, repoRoot: REPO, unitTexts: {} });
    assert.equal(r.state, 'unknown', JSON.stringify(r));
    assert.deepEqual(r.unjudged, ['mystery.service']);
  });

  it('归属判据用 ExecStart 指向本仓，不用单元名', async () => {
    const { repoScriptOf } = await LOAD;
    assert.equal(repoScriptOf(MINE, REPO), '/srv/projects/windsurf-dao/scripts/miraquota-contabo-sync.mjs');
    assert.equal(repoScriptOf(OTHERS, REPO), null);
    // 单元名可以随便取，只要 ExecStart 指本仓就算本仓的活
    const renamed = '[Service]\nExecStart=/usr/bin/node /srv/projects/windsurf-dao/scripts/refiner.mjs\n';
    assert.ok(repoScriptOf(renamed, REPO));
    // 相对路径按仓根解（systemd 的 WorkingDirectory 就指仓根）
    const rel = '[Service]\nWorkingDirectory=/srv/projects/windsurf-dao\nExecStart=/usr/bin/node scripts/refiner.mjs\n';
    assert.equal(repoScriptOf(rel, REPO), '/srv/projects/windsurf-dao/scripts/refiner.mjs');
    // 往外爬的不认——宁可不认，不许把别处的活算成自己的
    const outside = '[Service]\nExecStart=/usr/bin/node ../../../etc/something.mjs\n';
    assert.equal(repoScriptOf(outside, REPO), null);
  });

  it('本仓 systemd 目录读得到单元名（0 个 = 没查成）', async () => {
    const { repoUnitNames } = await LOAD;
    const r = repoUnitNames({ root: REPO });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.ok(r.names.length > 5, '本仓单元应该有一大把');
    assert.ok(r.names.includes('dao-land.service'));
    const bad = repoUnitNames({ root: path.join(REPO, 'no-such-dir') });
    assert.equal(bad.ok, false);
  });

  // 这里**不**再拿真 `systemctl --failed` 跑一遍自检：探它要起子进程，而本仓测试有
  // spawn 预算（scripts/lib/spawn-budget.mjs，147 格），为「证明真实环境能算出结果」
  // 花一格不值——真实环境那一头由 dao-check 的 checkFailedUnitsLive 每跑必验，
  // 而且它验的是同一份 output 形态。判别力由上面 6 条夹具承担（red 1 条 / unknown 3 条）。
});
