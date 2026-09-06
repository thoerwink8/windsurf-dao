// Contabo → MiraQuota 多机页采样器（#881）。
//
// 两个判别用例是本套的存在理由：
//   ① getRelay 真机帧的 used/budget 必须原样进 limits.windows——验收「额度数与
//      服务器 getRelay 读回一致」就钉这一格；猜窗口、填默认值、改字段名都算红。
//   ② 没有 sync.json 不许编一个 remote——Contabo 上那份文件不存在（帅位 2026-09-06
//      查证），必须退回 miraquota-win 的 DEFAULT_REMOTE。
// 连线层用假 fetchRelay 注入，不碰真服务；git 同样注入，测试期禁网闸罩着。

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const LIB = 'file://' + path.join(ROOT, 'scripts', 'lib', 'miraquota-contabo.mjs').split(path.sep).join('/');
const CLI = 'file://' + path.join(ROOT, 'scripts', 'miraquota-contabo-sync.mjs').split(path.sep).join('/');
const LOAD = import(LIB);
const LOAD_CLI = import(CLI);

const INSTALL = '0e48f9fc3654bf11';
const T0 = Date.parse('2026-09-06T06:10:50.903Z') / 1000;

/** 2026-09-06 Contabo 真机 getRelay 回帧（截 windows，其余字段照抄）。 */
function liveRelay(over = {}) {
  return {
    type: 'relay',
    relay: {
      available: true,
      host: 'relay.mirasim.ai',
      agent: 'claude',
      mode: 'cloud',
      enabled: true,
      configured: true,
      usage: {
        ok: true,
        agent: 'claude',
        source: 'relay-limits',
        capturedAt: '2026-09-06T06:10:50.903Z',
        status: 'warning',
        windows: [
          {
            label: '5h', usedPercent: 2.7, remainingPercent: 97.3,
            resetAt: '2026-09-06T09:16:45.000Z', resetAfterSeconds: 11154,
            status: 'allowed', used: 4702.412875, budget: 171852,
          },
          {
            label: '7d', usedPercent: 85, remainingPercent: 15,
            resetAt: '2026-09-08T02:58:05.000Z', resetAfterSeconds: 161234,
            status: 'warning', used: 521608.829464, budget: 613756,
          },
          {
            label: '7d_fable', usedPercent: 100, remainingPercent: 0,
            resetAt: '2026-09-08T02:58:05.000Z', resetAfterSeconds: 161234,
            status: 'limit_reached', used: 322156.15205, budget: 325291,
            modelScoped: true,
          },
        ],
        error: null,
        ...over.usage,
      },
      ...over.relay,
    },
    ...over.frame,
  };
}

describe('getRelay 帧 → 分片 limits', () => {
  it('故意违规：没收到帧 / 不是 relay / usage.ok 假 → 都不许出分片', async () => {
    const S = await LOAD;
    assert.equal(S.parseRelayUsage(null).unscanned, true);
    assert.equal(S.parseRelayUsage({ type: 'state' }).ok, false);
    assert.equal(S.parseRelayUsage({ type: 'error', message: 'nope' }).ok, false);
    const bad = liveRelay({ usage: { ok: false, windows: [], error: 'quota' } });
    const r = S.parseRelayUsage(bad);
    assert.equal(r.ok, false);
    assert.equal(r.unscanned, false);
  });

  it('真机帧：5h/7d/7d_fable 的 used/budget 原样进 limits，resetAt 收成 unix 秒', async () => {
    const S = await LOAD;
    const built = S.shardFromRelay(liveRelay(), { installId: INSTALL, generatedAt: T0 });
    assert.equal(built.ok, true, built.errors && built.errors.join('；'));
    const w = built.shard.limits.windows;
    assert.equal(w.length, 3);
    assert.equal(w[0].label, '5h');
    assert.equal(w[0].used, 4702.412875);
    assert.equal(w[0].budget, 171852);
    assert.equal(w[1].label, '7d');
    assert.equal(w[1].used, 521608.829464);
    assert.equal(w[1].budget, 613756);
    assert.equal(w[2].label, '7d_fable');
    assert.equal(w[2].modelScoped, true);
    assert.equal(w[0].resetAt, Date.parse('2026-09-06T09:16:45.000Z') / 1000);
    assert.equal(built.shard.limits.capturedAt, T0);
    assert.equal(S.validateContaboShard(built.shard), null);
  });

  it('machineId 钉死 contabo，不是 os.hostname()（本机 hostname 是 vmi3551059）', async () => {
    const S = await LOAD;
    assert.equal(S.MACHINE_ID, 'contabo');
    const built = S.shardFromRelay(liveRelay(), { installId: INSTALL, generatedAt: T0 });
    assert.equal(built.shard.machineId, 'contabo');
  });

  it('账本四件套是空对象——getRelay 是账号级窗口，填总额会把整池算到 contabo 头上', async () => {
    const S = await LOAD;
    const built = S.shardFromRelay(liveRelay(), { installId: INSTALL, generatedAt: T0 });
    assert.deepEqual(built.shard.buckets, {});
    assert.deepEqual(built.shard.scoped, {});
    assert.deepEqual(built.shard.family, {});
    assert.deepEqual(built.shard.unpriced, {});
    assert.equal(built.shard.schemaVersion, 1);
  });
});

describe('sync.json 不在 Contabo 上', () => {
  it('没有配置 → 用 miraquota-win 的 DEFAULT_REMOTE，不许另造地址', async () => {
    const S = await LOAD;
    assert.equal(S.DEFAULT_REMOTE, 'https://github.com/thoerwink8/miraquota-ledger.git');
    const r = S.loadSyncRemote(null);
    assert.equal(r.remote, S.DEFAULT_REMOTE);
    assert.equal(r.from, 'default');
  });

  it('sync.json 有 remote 就用那一份', async () => {
    const S = await LOAD;
    const r = S.loadSyncRemote({ remote: 'git@github.com-miraquota:you/ledger.git', intervalSec: 600 });
    assert.equal(r.remote, 'git@github.com-miraquota:you/ledger.git');
    assert.equal(r.from, 'sync.json');
  });

  it('hub / inbox 配了但没 remote → 仍退 DEFAULT_REMOTE（本采样器只走 git 通道）', async () => {
    const S = await LOAD;
    const r = S.loadSyncRemote({ hub: 'https://example/mq', token: 'x' });
    assert.equal(r.remote, S.DEFAULT_REMOTE);
    assert.equal(r.from, 'default');
  });
});

describe('runOnce：假连线 + 假 git', () => {
  it('dry-run 采得到分片、一帧 git 都不发', async () => {
    const C = await LOAD_CLI;
    const calls = [];
    const r = await C.runOnce({
      dryRun: true,
      installId: INSTALL,
      nowSec: T0,
      homeDir: os.tmpdir(),
      configFile: path.join(os.tmpdir(), 'no-such-sync.json'),
      fetchRelay: async () => liveRelay(),
      git: async (_cwd, args) => { calls.push(args); return ''; },
    });
    assert.equal(r.ok, true);
    assert.equal(r.dryRun, true);
    assert.equal(r.branch, 'machine/contabo');
    assert.equal(r.windows[1].used, 521608.829464);
    assert.equal(r.windows[1].budget, 613756);
    assert.equal(calls.length, 0, 'dry-run 不许碰 git');
  });

  it('真跑：force-push 的是 HEAD:machine/contabo', async () => {
    const C = await LOAD_CLI;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mq-contabo-'));
    const calls = [];
    const r = await C.runOnce({
      installId: INSTALL,
      nowSec: T0,
      homeDir: dir,
      configFile: path.join(dir, 'missing-sync.json'),
      repoDir: path.join(dir, 'repo'),
      fetchRelay: async () => liveRelay(),
      git: async (_cwd, args) => {
        calls.push(args.join(' '));
        if (args[0] === 'remote' && args.length === 1) return '';
        if (args[0] === 'rev-parse') { const e = new Error('no head'); throw e; }
        return '';
      },
    });
    assert.equal(r.ok, true);
    assert.ok(calls.some((c) => c === 'push --quiet --force origin HEAD:machine/contabo'),
      '必须 force-push 到 machine/contabo，实际：' + calls.join(' | '));
    const shard = JSON.parse(fs.readFileSync(path.join(dir, 'repo', 'shard.json'), 'utf8'));
    assert.equal(shard.machineId, 'contabo');
    assert.equal(shard.limits.windows[0].used, 4702.412875);
  });

  it('getRelay 没回帧 → 抛 unscanned，不是假装推成了', async () => {
    const C = await LOAD_CLI;
    let code = null;
    try {
      await C.runOnce({
        installId: INSTALL,
        nowSec: T0,
        homeDir: os.tmpdir(),
        fetchRelay: async () => { const e = new Error('没回'); e.code = 'unscanned'; throw e; },
        git: async () => '',
      });
    } catch (e) { code = e.code; }
    assert.equal(code, 'unscanned');
  });
});

describe('systemd 单元与装机脚本', () => {
  const service = path.join(ROOT, 'host', 'machine', 'systemd', 'miraquota-contabo.service');
  const timer = path.join(ROOT, 'host', 'machine', 'systemd', 'miraquota-contabo.timer');
  const installer = path.join(ROOT, 'scripts', 'install-miraquota-contabo.sh');

  it('单元在，User=orca，timer 有 OnCalendar', () => {
    assert.ok(fs.existsSync(service), 'miraquota-contabo.service 不在');
    assert.ok(fs.existsSync(timer), 'miraquota-contabo.timer 不在');
    const s = fs.readFileSync(service, 'utf8');
    const t = fs.readFileSync(timer, 'utf8');
    assert.match(s, /^User=orca$/m);
    assert.match(s, /miraquota-contabo-sync\.mjs --once/);
    assert.match(t, /^OnCalendar=/m);
    assert.match(t, /^Persistent=true$/m);
    assert.ok(!/^OnCalendar=\*:07:00$/m.test(t)
      && !/^OnCalendar=\*:23:00$/m.test(t)
      && !/^OnCalendar=\*:1\/5$/m.test(t),
      '点位撞了别人的 timer');
  });

  it('装机脚本在，且不 chmod 仓内文件', () => {
    assert.ok(fs.existsSync(installer), '装机脚本不在，单元只能靠人手抄进 /etc');
    const text = fs.readFileSync(installer, 'utf8');
    const bad = text.split(/\r?\n/).filter((l) =>
      /^\s*chmod\b/.test(l) && /\$(ROOT|\{ROOT\})/.test(l));
    assert.deepEqual(bad, [], 'chmod 仓内文件会把树弄脏、ff-only 同步 Aborting');
    assert.match(text, /NextElapseUSecRealtime/, '装完必须验下一次触发，不能只 enable');
  });
});
