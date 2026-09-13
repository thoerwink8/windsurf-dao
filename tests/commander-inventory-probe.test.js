// #1166：盘点「探针连红」那一格的判据。
//
// 病：原来读 `journalctl -u gw-remote-probe`，而跑盘点的身份是 orca——orca 不在
// systemd-journal / adm 里，journalctl 退出 1、stdout 空。闸把「没权限」误诊成
// 「可能没这个单元」，标 unknown 不开单。这台机器上这一格**从来没真查过**。
//
// 改法：真相源从「别人单元的日志」换成「探活自己落的健康表」（provider-health.json），
// 那个文件 orca 读得到。判据复用 provider-health.mjs 的 loadHealthTable，
// 不另造第二套新鲜度口径。
//
// 本测试只覆盖纯函数 judgeProbeRed：真实读盘那一头由 dao-check 与指挥官盘点每跑必验。
// 刻意不起子进程（本仓测试有 spawn 预算）。

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const LOAD = import('file://' + path.join(REPO, 'scripts', 'lib', 'commander-inventory.mjs').replace(/\\/g, '/'));

const mk = (states) => ({
  unknown: false,
  path: '/tmp/health.json',
  table: Object.fromEntries(states.map((s, i) => [`target${i}`, { state: s }])),
});

describe('#1166 探针连红判据读健康表', () => {
  it('有目标红 → red，且点名是哪几条', async () => {
    const { judgeProbeRed } = await LOAD;
    const r = judgeProbeRed(mk(['green', 'red', 'green']));
    assert.equal(r.state, 'red', JSON.stringify(r));
    assert.equal(r.key, 'probe-red', 'key 不变（快照/开单都按它）');
    assert.match(r.detail, /target1/);
    assert.deepEqual(Object.keys(r.plain || {}).sort(), ['impact', 'plan', 'what'], '红要带人话三行');
  });

  it('全绿 → ok', async () => {
    const { judgeProbeRed } = await LOAD;
    const r = judgeProbeRed(mk(['green', 'green']));
    assert.equal(r.state, 'ok', JSON.stringify(r));
  });

  // 下面四条是这道闸的关键：**「没查成」不许做成「查过没事」**，
  // 也不许做成红（没采到 ≠ 坏）。这三态分不开正是原判据的死因。
  it('健康表不在 → unknown（不是绿，也不是红）', async () => {
    const { judgeProbeRed } = await LOAD;
    const r = judgeProbeRed({ unknown: true, reason: '健康表文件不在' });
    assert.equal(r.state, 'unknown', JSON.stringify(r));
    assert.match(r.detail, /没查成|不在/);
  });

  it('健康表过期 → unknown', async () => {
    const { judgeProbeRed } = await LOAD;
    const r = judgeProbeRed({ unknown: true, reason: '健康表过期（200min > 2×30min）' });
    assert.equal(r.state, 'unknown', JSON.stringify(r));
  });

  it('表在但一个目标都没有 → unknown（没采到 ≠ 全绿）', async () => {
    const { judgeProbeRed } = await LOAD;
    const r = judgeProbeRed({ unknown: false, table: {}, path: '/tmp/health.json' });
    assert.equal(r.state, 'unknown', JSON.stringify(r));
    assert.match(r.detail, /没采到/);
  });

  it('全 unknown 状态的目标准 → ok（没采到不等于坏，不误报红）', async () => {
    const { judgeProbeRed } = await LOAD;
    const r = judgeProbeRed(mk(['unknown', 'unknown']));
    assert.equal(r.state, 'ok', JSON.stringify(r));
  });

  it('盘点不再用 journalctl 判探针（ora 读不到别人的 journal）', async () => {
    const { readFileSync } = require('node:fs');
    const src = readFileSync(path.join(REPO, 'scripts', 'lib', 'commander-inventory.mjs'), 'utf8');
    // 探针那一格不许再出现 journalctl 调用；「可能没这个单元」那句误诊也要没了
    assert.doesNotMatch(src, /journalctl['"]\s*,\s*\[['"]-u['"],\s*['"]gw-remote-probe/);
    assert.doesNotMatch(src, /可能没这个单元/);
    assert.match(src, /loadHealthTable/, '要复用 provider-health 的读表口径，不另造一套');
  });
});
