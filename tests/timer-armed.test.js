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

// 2026-09-05 巡检（服务器上的 LLM）自己抓到的：本闸原本只认 `dao*` / `commander*` 前缀。
// `gw-remote-probe.timer` 写 `~/.dao/provider-health.json`——**我们读它判派工可用性**——
// 却因为名字不带那两个前缀，从来不在扫描面里，至今还是单调时钟。
// **按名字前缀圈定扫描面，等于只查自己认识的东西。**
describe('扫描面不许按名字前缀圈定', () => {
  it('故意违规样本：不带 dao/commander 前缀的 timer 死了，也必须报出来', async () => {
    const S = await LOAD;
    const r = S.classifyTimerArmed({ probed: true, units: [
      { unit: 'dao-sync.timer', next: '1788600000000000' },
      { unit: 'gw-remote-probe.timer', next: null },
    ] });
    assert.equal(r.state, 'red', '写健康表的探针死了，比 dao 自己的 timer 死了还危险——派工会拿过期表当 unknown');
    assert.match(r.detail, /gw-remote-probe\.timer/, '要点名，不能只给个数字');
  });

  it('取数层：list-timers 的输出里，非 dao 前缀的 dao 生态 timer 要被采到', async () => {
    const fs = require('node:fs');
    const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'server-check.mjs'), 'utf8');
    const m = src.match(/const names = \[\.\.\.String\(list\.stdout \|\| ''\)\.matchAll\((\/[^\n]*?\/g)\)/);
    assert.ok(m, '采集正则的形状变了，本闸判据已失效——请同步更新');
    assert.ok(!/dao\|commander/.test(m[1]),
      `采集正则又退回按前缀圈定了：${m[1]}——前缀外的 timer 会重新变成盲区`);
    // 真拿它跑一遍 systemd 的真实输出行，证明确实采得到
    const re = new RegExp(m[1].slice(1, -2), 'g');
    const line = 'Sat 2026-09-05 18:26:00 CST 5min Sat 2026-09-05 17:56:00 CST 25min ago gw-remote-probe.timer gw-remote-probe.service';
    assert.ok([...line.matchAll(re)].some((x) => x[1] === 'gw-remote-probe.timer'),
      '正则采不到 gw-remote-probe.timer');
  });

  // 扫描面圈定经过两轮翻车，两轮都是**按名字**圈：
  //  一轮白名单（只认 `dao*`/`commander*`）→ 漏掉 gw-remote-probe.timer；
  //  一轮黑名单（排掉想得到的发行版前缀）→ 把 apport-autoreport / ua-timer 判成红。
  // 名字白名单和名字黑名单是同一个毛病：都只覆盖「有人想得到的那些」。
  // 现在按**单元文件落在哪**判，这条界线是 systemd 自己定的，不靠任何人维护名单。
  it('发行版自带的不归本仓判死，我们装的一个都不能漏——按落点判，不按名字', async () => {
    const S = await LOAD;
    for (const p of [
      '/usr/lib/systemd/system/apport-autoreport.timer',
      '/usr/lib/systemd/system/ua-timer.timer',
      '/lib/systemd/system/logrotate.timer',
    ]) {
      assert.equal(S.isOurUnit(p), false, `${p} 是发行版的，点位由 apt/systemd 管`);
    }
    for (const p of [
      '/etc/systemd/system/dao-sync.timer',
      '/etc/systemd/system/gw-remote-probe.timer', // 别的仓装的，名字不带 dao 前缀
      '/etc/systemd/system/commander-act.timer',
    ]) {
      assert.equal(S.isOurUnit(p), true, `${p} 是我们装的，漏了就是当初 gw-remote-probe 那种漏法`);
    }
  });

  it('归属判不出时回 null（没查成），绝不回 false——那就是漏报', async () => {
    const S = await LOAD;
    assert.equal(S.isOurUnit(''), null, '读不到路径 = 没查成');
    assert.equal(S.isOurUnit(null), null);
    assert.equal(S.isOurUnit('/opt/weird/place/x.timer'), null, '没见过的落点不许猜成「不归我管」');
  });
});
