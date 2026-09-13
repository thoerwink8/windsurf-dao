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

const CHECKOUT = path.resolve(__dirname, '..');
const REPO = '/srv/projects/windsurf-dao';
const LOAD = import('file://' + path.join(CHECKOUT, 'scripts', 'lib', 'failed-units-check.mjs').replace(/\\/g, '/'));
const fs = require('node:fs');

const MINE = '[Service]\nUser=orca\nExecStart=/usr/bin/node /srv/projects/windsurf-dao/scripts/miraquota-contabo-sync.mjs --once\n';
const OTHERS = '[Service]\nExecStart=/usr/bin/node /srv/projects/ai-gateway-stack/deploy/x.mjs\n';

describe('本仓单元挂 systemctl --failed', () => {
  it('本仓 unit 从没跑成过、挂在 --failed → red，且点名是哪个', async () => {
    const { classifyFailedUnits } = await LOAD;
    const out = '  UNIT LOAD ACTIVE SUB DESCRIPTION\n  miraquota-contabo.service loaded failed failed MiraQuota\n';
    const r = classifyFailedUnits({
      output: out, repoRoot: REPO,
      unitTexts: { 'miraquota-contabo.service': MINE },
      arming: { 'miraquota-contabo.service': false },
    });
    assert.equal(r.state, 'red', JSON.stringify(r));
    assert.deepEqual(r.failed, ['miraquota-contabo.service']);
    // 拆成最简断言（本仓 assert-style：复合断言失败时分不清哪半坏了）
    assert.deepEqual(Object.keys(r.plain || {}).sort(), ['impact', 'plan', 'what'], '红要带人话三行');
  });

  // 这一档是本仓设计使然：dao-execution-usage 按设计用 exit 2 表示「采集不完整」，
  // 而 charge 这类字段结构上报不全 ⇒ 它每 5 分钟必然重进 --failed。
  // 那种常亮红灯跟 miraquota 那五天一样，最后一定没人看——所以「跑成过、最近一次非零」
  // 不判红，但必须列进 flaky 说出来（不红不等于不说）。
  it('本仓 unit 跑成过、只是最近一次非零 → 不红，但列进 flaky 如实报', async () => {
    const { classifyFailedUnits } = await LOAD;
    const out = '  UNIT LOAD ACTIVE SUB DESCRIPTION\n  dao-execution-usage.service loaded failed failed collector\n';
    const r = classifyFailedUnits({
      output: out, repoRoot: REPO,
      unitTexts: { 'dao-execution-usage.service': MINE },
      arming: { 'dao-execution-usage.service': true },
    });
    assert.equal(r.state, 'green', JSON.stringify(r));
    assert.deepEqual(r.flaky, ['dao-execution-usage.service']);
    assert.match(r.detail, /dao-execution-usage\.service/, 'flaky 也要点名，否则等于没说');
    assert.deepEqual(r.failed, []);
  });

  it('跑成过 + 从没跑成过混在一起 → red 只算从没跑成过的那部分', async () => {
    const { classifyFailedUnits } = await LOAD;
    const out = '  UNIT LOAD ACTIVE SUB DESCRIPTION\n'
      + '  never.service loaded failed failed x\n'
      + '  flaky.service loaded failed failed y\n';
    const r = classifyFailedUnits({
      output: out, repoRoot: REPO,
      unitTexts: { 'never.service': MINE, 'flaky.service': MINE },
      arming: { 'never.service': false, 'flaky.service': true },
    });
    assert.equal(r.state, 'red', JSON.stringify(r));
    assert.deepEqual(r.failed, ['never.service']);
    assert.deepEqual(r.flaky, ['flaky.service']);
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
    const r = repoUnitNames({ root: CHECKOUT });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.ok(r.names.length > 5, '本仓单元应该有一大把');
    assert.ok(r.names.includes('dao-land.service'));
    const bad = repoUnitNames({ root: path.join(CHECKOUT, 'no-such-dir') });
    assert.equal(bad.ok, false);
  });

  // 这里**不**再拿真 `systemctl --failed` 跑一遍自检：探它要起子进程，而本仓测试有
  // spawn 预算（scripts/lib/spawn-budget.mjs，147 格），为「证明真实环境能算出结果」
  // 花一格不值——真实环境那一头由 dao-check 的 checkFailedUnitsLive 每跑必验，
  // 而且它验的是同一份 output 形态。判别力由上面 6 条夹具承担（red 1 条 / unknown 3 条）。
});

// hasEverRun 是「这一档算不算红」的判据本身，它读错字段会凭空造红灯——
// 实测本机 systemd 255 上 LastTriggerUSecRealtime 是空的，有值的是 LastTriggerUSec。
describe('hasEverRun 读对了 timer 的字段吗', () => {
  it('LastTriggerUSec 有值 → 跑成过（本机 systemd 255 的真实形态）', async () => {
    const { hasEverRun } = await LOAD;
    const real = 'LastTriggerUSec=Fri 2026-09-11 21:18:10 CST\n';
    assert.equal(hasEverRun({ serviceName: 'x.service', timerProps: real, hasTimerFile: true }), true);
  });

  it('两个字段都空值 / 0 / n/a → 从没跑过', async () => {
    const { hasEverRun } = await LOAD;
    for (const v of ['LastTriggerUSec=\n', 'LastTriggerUSec=0\n', 'LastTriggerUSec=n/a\n',
      'LastTriggerUSecRealtime=\nLastTriggerUSec=\n']) {
      assert.equal(hasEverRun({ serviceName: 'x.service', timerProps: v, hasTimerFile: true }), false, JSON.stringify(v));
    }
  });

  it('Realtime 有值也算（另一版 systemd 可能只给这一项）', async () => {
    const { hasEverRun } = await LOAD;
    assert.equal(hasEverRun({ serviceName: 'x.service', timerProps: 'LastTriggerUSecRealtime=Fri 2026-09-11 21:18:10 CST\n', hasTimerFile: true }), true);
  });

  it('没配对的 timer → 不算跑成过（oneshot 靠人拉）', async () => {
    const { hasEverRun } = await LOAD;
    assert.equal(hasEverRun({ serviceName: 'x.service', timerProps: 'LastTriggerUSec=Fri 2026-01-01 00:00:00 CST\n', hasTimerFile: false }), false);
  });

  it('两项都没打出来 → null（判不了，调用方保守当红）', async () => {
    const { hasEverRun } = await LOAD;
    assert.equal(hasEverRun({ serviceName: 'x.service', timerProps: 'Whatever=1\n', hasTimerFile: true }), null);
  });
});
