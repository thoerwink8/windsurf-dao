// dao timer 必须有「下一次」（2026-09-05 实咬）。
// 当天 dao-agent-stall.timer 从 12:37 起再没跑过，而 systemctl 说它 active + enabled，
// list-timers --all 里照样列着——server-check 的 ⑮⑯ 两条全绿，#833 的自动换人整段无声停摆。
// 真相只在「有没有未来触发点」这一格：NEXT 显示 n/a，SubState=elapsed。
const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const LIB = 'file://' + path.join(__dirname, '..', 'scripts', 'server-check.mjs').split(path.sep).join('/');
const LOAD = import(LIB);

describe('timer 有没有下一次触发', () => {
  it('故意违规样本：next 为空 → 红，且点名是哪个单元', async () => {
    const S = await LOAD;
    const r = S.classifyTimerArmed({ probed: true, units: [
      { unit: 'dao-sync.timer', next: '1788600000000000' },
      { unit: 'dao-agent-stall.timer', next: null },
    ] });
    assert.equal(r.state, 'red');
    assert.match(r.detail, /dao-agent-stall\.timer/, '要点名死掉的那个，不能只给个数字');
  });

  it('systemd 的几种「没有下一次」写法都算死', async () => {
    const S = await LOAD;
    for (const v of [null, '', '0', 'n/a', 'infinity']) {
      const r = S.classifyTimerArmed({ probed: true, units: [{ unit: 'dao-x.timer', next: v }] });
      assert.equal(r.state, 'red', `next=${JSON.stringify(v)} 应判死`);
    }
  });

  it('反证：都有下一次就该绿——判据不是恒红', async () => {
    const S = await LOAD;
    const r = S.classifyTimerArmed({ probed: true, units: [
      { unit: 'dao-sync.timer', next: '1788600000000000' },
      { unit: 'commander-act.timer', next: '1788600900000000' },
    ] });
    assert.equal(r.state, 'ok');
  });

  it('一个都没扫到 ≠ 都没问题', async () => {
    const S = await LOAD;
    assert.equal(S.classifyTimerArmed({ probed: true, units: [] }).state, 'unknown',
      '扫出 0 个要显形——多半是前缀或判据失效，不是全都健康');
    assert.equal(S.classifyTimerArmed({ probed: true, units: null }).state, 'unknown');
    assert.equal(S.classifyTimerArmed({ probed: false, reason: '本机无 systemd' }).state, 'unknown');
  });

  it('单元文件必须有 OnCalendar——只有单调时钟就会复发这个死态', async () => {
    const fs = require('node:fs');
    const dir = path.join(__dirname, '..', 'host', 'machine', 'systemd');
    const units = fs.readdirSync(dir).filter((f) => f.endsWith('.timer'));
    assert.ok(units.length > 0, '一个 .timer 都没扫到，本闸判据已失效');
    for (const u of units) {
      const s = fs.readFileSync(path.join(dir, u), 'utf8');
      assert.match(s, /^OnCalendar=/m,
        `${u} 只有单调时钟（OnBootSec/OnUnitActiveSec），停掉再起会进 active(elapsed) 死态且无人报警`);
    }
  });
});

// 2026-09-05 服务器巡检（第一次真跑）抓到的：仓里的 unit 补了 OnCalendar，
// **机器上还是两天前那份**——`dao-sync` 只拉代码不装单元。而两道静态闸只扫
// `host/machine/systemd/*.timer`，对**代码生成**的单元一无所知：
// `commander-act` / `commander-inventory` 由 `commander-inventory.mjs` 的模板写出来，
// 不在那个目录，于是「检查全绿，修没有生效」。
describe('代码生成的 systemd 单元也要过同一把尺', () => {
  const LIB = 'file://' + path.join(__dirname, '..', 'scripts', 'lib', 'commander-inventory.mjs')
    .split(path.sep).join('/');

  it('生成的每个 .timer 都必须有 OnCalendar', async () => {
    const M = await import(LIB);
    const files = M.INSTALL_FILES();
    const timers = Object.entries(files).filter(([p]) => p.endsWith('.timer'));
    assert.ok(timers.length > 0, '一个生成的 .timer 都没扫到，本闸判据已失效');
    for (const [p, text] of timers) {
      assert.match(text, /^OnCalendar=/m,
        `${p} 只有单调时钟——停掉再起会进 active(elapsed) 死态，显示 active+enabled 却永不触发`);
    }
  });

  it('生成的每个 .service 都必须显式写 User=（不写就是 root）', async () => {
    const M = await import(LIB);
    const files = M.INSTALL_FILES();
    const svcs = Object.entries(files).filter(([p]) => p.endsWith('.service'));
    assert.ok(svcs.length > 0, '一个生成的 .service 都没扫到，本闸判据已失效');
    for (const [p, text] of svcs) {
      assert.match(text, /^User=/m,
        `${p} 没写 User= —— systemd 默认 root，而它 ExecStart 的是 orca 可写的仓内脚本`);
    }
  });

  it('墙钟点位互不相同——都挂同一分钟就是自己跟自己抢', async () => {
    const M = await import(LIB);
    const cals = Object.entries(M.INSTALL_FILES())
      .filter(([p]) => p.endsWith('.timer'))
      .map(([, t]) => (t.match(/^OnCalendar=(.+)$/m) || [])[1]);
    assert.equal(new Set(cals).size, cals.length, `点位撞了：${cals.join(' / ')}`);
  });
});
