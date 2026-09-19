// 仓内 systemd 单元必须已经上机，撞点看活日历（dao-check ㊳，issue #1408）
//
// 验 scripts/lib/unit-deploy-check.mjs：
//   仓内改字段、活单元没跟上 → 红，点名「仓内 X ≠ 活单元 Y」；
//   部署后再比 → 绿；
//   活单元读不到 → 没查成，不得与「一致」同形；
//   活 heal-root 与活 dao-sync 展开相交必须空；*:06/5 ≡ *:1/5 必须红；
//   注释差 / TimeoutStartSec 不算契约漂移（那是 ⑳ 全文比被 drop-in 钉红的病）。
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..');
const LIB = path.join(REPO, 'scripts', 'lib', 'unit-deploy-check.mjs');
const FIX = path.join(__dirname, 'fixtures', 'unit-deploy');
const LIVE_DIR = '/etc/systemd/system';
const UNIT_DIR = path.join(REPO, 'host', 'machine', 'systemd');
const LOAD = import('file://' + LIB.replace(/\\/g, '/'));

function probesFrom(root) {
  return {
    exists: (rel) => fs.existsSync(path.join(root, rel)),
    readdir: (rel) => fs.readdirSync(path.join(root, rel)),
    readFile: (rel) => fs.readFileSync(path.join(root, rel), 'utf8'),
  };
}

describe('unit-deploy-check 契约字段', () => {
  it('parseOnCalendar 取最后一次非注释行', async () => {
    const S = await LOAD;
    assert.equal(S.parseOnCalendar('# OnCalendar=*:06/5\nOnCalendar=*:00/5\n'), '*:00/5');
    assert.equal(S.parseOnCalendar('[Timer]\nPersistent=true\n'), null);
  });

  it('Environment 多行合并，后写覆盖；多赋值一行也能拆', async () => {
    const S = await LOAD;
    const c = S.parseContract([
      'Environment=HOME=/root',
      'Environment=DAO_REPO_ROOT=/srv/projects/windsurf-dao PATH=/usr/bin',
      'Environment=DAO_REPO_ROOT=/other',
    ].join('\n'));
    assert.equal(c.env.HOME, '/root');
    assert.equal(c.env.DAO_REPO_ROOT, '/other');
    assert.equal(c.env.PATH, '/usr/bin');
  });

  it('正控：仓内改 OnCalendar 不部署 → 红并写出仓内 X ≠ 活单元 Y', async () => {
    const S = await LOAD;
    const repo = '[Timer]\nOnCalendar=*:00/5\n';
    const live = '[Timer]\nOnCalendar=*:06/5\n';
    const diffs = S.contractDiff(repo, live);
    assert.equal(diffs.length, 1);
    assert.equal(diffs[0].key, 'OnCalendar');
    assert.equal(diffs[0].repo, '*:00/5');
    assert.equal(diffs[0].live, '*:06/5');
    const r = S.classifyFragmentDrift([{ name: 'dao-skills-heal-root.timer', repo, live, unreadable: false }]);
    assert.equal(r.state, 'red');
    assert.match(r.detail, /仓内 OnCalendar=\*:00\/5 ≠ 活单元 OnCalendar=\*:06\/5/);
    assert.match(r.detail, /install-dao-sync/);
  });

  it('正控：#1226 那份多出来的 DAO_SKILL_HOMES 也红', async () => {
    const S = await LOAD;
    const repo = '[Service]\nEnvironment=HOME=/root\nUser=root\n';
    const live = '[Service]\nEnvironment=HOME=/root\nEnvironment=DAO_SKILL_HOMES=/root\nUser=root\n';
    const diffs = S.contractDiff(repo, live);
    assert.equal(diffs.length, 1);
    assert.equal(diffs[0].key, 'Environment=DAO_SKILL_HOMES');
    assert.equal(diffs[0].live, '/root');
    const r = S.classifyFragmentDrift([{ name: 'dao-skills-heal-root.service', repo, live }]);
    assert.equal(r.state, 'red');
    assert.match(r.detail, /仓内 Environment=DAO_SKILL_HOMES=\(无\) ≠ 活单元 Environment=DAO_SKILL_HOMES=\/root/);
  });

  it('正控：契约一致 → 绿（注释差 / TimeoutStartSec 不算）', async () => {
    const S = await LOAD;
    const repo = '# 仓内注释\n[Timer]\nOnCalendar=*:00/5\nTimeoutStartSec=300\n';
    const live = '# 活注释不同\n[Timer]\nOnCalendar=*:00/5\nTimeoutStartSec=90\n';
    const diffs = S.contractDiff(repo, live);
    assert.deepEqual(diffs, []);
    const r = S.classifyFragmentDrift([{ name: 'a.timer', repo, live }]);
    assert.equal(r.state, 'ok');
    assert.match(r.detail, /1 个/);
  });

  it('负控：读不到 → 没查成，不得与一致同形', async () => {
    const S = await LOAD;
    const unread = S.classifyFragmentDrift([
      { name: 'a.timer', repo: '[Timer]\nOnCalendar=*:00/5\n', live: null, unreadable: true },
    ]);
    assert.equal(unread.state, 'unknown');
    assert.match(unread.detail, /没查成/);
    assert.match(unread.detail, /不是「一致」/);
    assert.equal(/契约字段仓里和机器上一致/.test(unread.detail), false);

    const none = S.classifyFragmentDrift([]);
    assert.equal(none.state, 'unknown');
    assert.match(none.detail, /没查成/);

    const notArr = S.classifyFragmentDrift(null);
    assert.equal(notArr.state, 'unknown');

    const missingAll = S.classifyFragmentDrift([
      { name: 'a.timer', repo: 'X', live: null, unreadable: false },
    ]);
    assert.equal(missingAll.state, 'unknown');
    assert.match(missingAll.detail, /没查成/);
  });

  it('部分装了、另一份没有 → 红（缺的是缺，不是没查成）', async () => {
    const S = await LOAD;
    const r = S.classifyFragmentDrift([
      { name: 'ok.timer', repo: '[Timer]\nOnCalendar=*:00/5\n', live: '[Timer]\nOnCalendar=*:00/5\n' },
      { name: 'gone.timer', repo: '[Timer]\nOnCalendar=*:03/5\n', live: null },
    ]);
    assert.equal(r.state, 'red');
    assert.match(r.detail, /gone\.timer/);
    assert.match(r.detail, /仓里有机器上没有/);
  });
});

describe('unit-deploy-check 活日历撞点', () => {
  it('故意样本：活 *:06/5 与 *:1/5 相交为满 → 红', async () => {
    const S = await LOAD;
    const r = S.classifyHealSyncOverlap({ healCal: '*:06/5', syncCal: '*:1/5' });
    assert.equal(r.state, 'red');
    assert.equal(r.hits.length, 288);
    assert.match(r.detail, /dao-skills-heal-root\.timer/);
    assert.match(r.detail, /dao-sync\.timer/);
    assert.match(r.detail, /活单元/);
  });

  it('活 *:00/5 与 *:1/5 不相交 → 绿', async () => {
    const S = await LOAD;
    const r = S.classifyHealSyncOverlap({ healCal: '*:00/5', syncCal: '*:1/5' });
    assert.equal(r.state, 'ok');
    assert.deepEqual(r.hits, []);
  });

  it('负控：活日历读不到 / 认不出 → 没查成，不是不撞', async () => {
    const S = await LOAD;
    const missing = S.classifyHealSyncOverlap({ healCal: null, syncCal: '*:1/5' });
    assert.equal(missing.state, 'unknown');
    assert.match(missing.detail, /没查成/);
    assert.equal(/不撞/.test(missing.detail) && missing.state === 'ok', false);

    const bad = S.classifyHealSyncOverlap({ healCal: 'never-in-a-million-years', syncCal: '*:1/5' });
    assert.equal(bad.state, 'unknown');
    assert.match(bad.detail, /没查成/);
  });
});

describe('unit-deploy-check 夹具与接线', () => {
  it('夹具红/绿/空有判别力', async () => {
    const S = await LOAD;
    const r = S.inspectUnitDeployFixtures(probesFrom(REPO));
    assert.equal(r.ok, true, r.error || JSON.stringify(r.problems));
    assert.equal(r.unscanned, false);
    assert.equal(r.kinds.red, 1);
    assert.equal(r.kinds.ok, 1);
    assert.equal(r.kinds.empty, 1);

    const red = S.inspectFragmentDirs({
      repoDir: path.join(FIX, 'red', 'repo'),
      liveDir: path.join(FIX, 'red', 'live'),
      readdir: (d) => fs.readdirSync(d),
      readFile: (p) => fs.readFileSync(p, 'utf8'),
    });
    assert.equal(red.state, 'red');
    assert.match(red.detail, /仓内 OnCalendar=\*:00\/5 ≠ 活单元 OnCalendar=\*:06\/5/);
    assert.match(red.detail, /Environment=DAO_SKILL_HOMES/);

    const ok = S.inspectFragmentDirs({
      repoDir: path.join(FIX, 'ok', 'repo'),
      liveDir: path.join(FIX, 'ok', 'live'),
      readdir: (d) => fs.readdirSync(d),
      readFile: (p) => fs.readFileSync(p, 'utf8'),
    });
    assert.equal(ok.state, 'ok', ok.detail);
  });

  it('负控：live 读抛 EACCES → 没查成', async () => {
    const S = await LOAD;
    const err = new Error('EACCES');
    err.code = 'EACCES';
    const r = S.inspectFragmentDirs({
      repoDir: path.join(FIX, 'ok', 'repo'),
      liveDir: '/nope',
      readdir: (d) => fs.readdirSync(d === '/nope' ? path.join(FIX, 'ok', 'repo') : d),
      readFile: (p) => {
        if (String(p).startsWith('/nope')) throw err;
        return fs.readFileSync(p, 'utf8');
      },
    });
    assert.equal(r.state, 'unknown');
    assert.match(r.detail, /没查成/);
  });

  it('dao-check 接了样本和 live，漏接等于闸不在会跑的那条路上', () => {
    const src = fs.readFileSync(path.join(REPO, 'scripts', 'dao-check.mjs'), 'utf8');
    assert.match(src, /checkUnitDeploySamples\(\)/);
    assert.match(src, /checkUnitDeployLive\(\)/);
    assert.match(src, /classifyHealSyncOverlap/);
  });

  it('上机钩子不解释仓内脚本；sudoers / dao-sync 接的是 /usr/local 那份', () => {
    const helper = fs.readFileSync(path.join(REPO, 'scripts', 'dao-install-units.sh'), 'utf8');
    assert.match(helper, /REPO=\/srv\/projects\/windsurf-dao/);
    assert.match(helper, /install -m 644/);
    assert.match(helper, /systemctl daemon-reload/);
    assert.match(helper, /<<'MANIFEST'/);
    assert.match(helper, /拒绝特权行漂移/);
    assert.equal(/node\s+["']?\$\{?REPO/.test(helper), false, '钩子不许 node 仓内脚本');
    assert.equal(/bash\s+["']?\$\{?REPO/.test(helper), false, '钩子不许 bash 仓内脚本');
    assert.equal(/source\s+["']?\$\{?REPO/.test(helper), false, '钩子不许 source 仓内文件');

    const sudoers = fs.readFileSync(path.join(REPO, 'host', 'machine', 'sudoers.d', 'dao-sync'), 'utf8');
    const rules = sudoers.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith('#'));
    assert.equal(rules.some((r) => r === 'orca ALL=(root) NOPASSWD: /usr/local/sbin/dao-install-units'), true);
    assert.equal(rules.some((r) => r === 'orca ALL=(root) NOPASSWD: /usr/bin/systemctl try-restart feishu-triage'), true);
    assert.equal(rules.some((r) => /SETENV/.test(r)), false, 'sudoers 不许 SETENV，否则测试用 SRC/DEST 能进生产钩子');

    const sync = fs.readFileSync(path.join(REPO, 'scripts', 'server-sync.sh'), 'utf8');
    assert.match(sync, /sudo -n \/usr\/local\/sbin\/dao-install-units/);
    const failBlock = sync.split('if ! g merge')[1].split('after=')[0];
    assert.equal(/^\s*install_units\b/m.test(failBlock), false, 'merge --ff-only 失败不得当 root 部署源');

    const install = fs.readFileSync(path.join(REPO, 'scripts', 'install-dao-sync.sh'), 'utf8');
    assert.match(install, /\/usr\/local\/sbin\/dao-install-units/);
    assert.match(install, /dao-install-units\.sh/);
  });

  it('本机若装着这两只钟，活日历必须不相交（不是这台机器则跳过）', async () => {
    const S = await LOAD;
    const healPath = path.join(LIVE_DIR, 'dao-skills-heal-root.timer');
    const syncPath = path.join(LIVE_DIR, 'dao-sync.timer');
    if (!fs.existsSync(healPath) || !fs.existsSync(syncPath)) return;
    const healCal = S.parseOnCalendar(fs.readFileSync(healPath, 'utf8'));
    const syncCal = S.parseOnCalendar(fs.readFileSync(syncPath, 'utf8'));
    const r = S.classifyHealSyncOverlap({ healCal, syncCal });
    assert.equal(r.state, 'ok', r.detail);
  });
});

function runInstallUnits(src, dest) {
  return spawnSync('bash', [path.join(REPO, 'scripts', 'dao-install-units.sh')], {
    encoding: 'utf8',
    env: {
      ...process.env,
      DAO_INSTALL_UNITS_TEST: '1',
      DAO_INSTALL_UNITS_SRC: src,
      DAO_INSTALL_UNITS_DEST: dest,
    },
  });
}

describe('上机钩子的不可变 manifest', () => {
  it('manifest 登记的单元名与仓内 *.service/*.timer 一一对应', () => {
    const helper = fs.readFileSync(path.join(REPO, 'scripts', 'dao-install-units.sh'), 'utf8');
    const names = [...helper.matchAll(/^### (\S+)/mg)].map((m) => m[1]).sort();
    const files = fs.readdirSync(UNIT_DIR).filter((f) => /\.(service|timer)$/.test(f)).sort();
    assert.ok(files.length > 0, '一个单元都没扫到 = 没查成');
    assert.deepEqual(names, files);
  });

  it('仓内现行单元全部能装（特权行与 manifest 对得上）', () => {
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'dao-units-ok-'));
    try {
      const r = runInstallUnits(UNIT_DIR, dest);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(/拒绝/.test(r.stderr), false, r.stderr);
      const got = fs.readdirSync(dest).filter((f) => /\.(service|timer)$/.test(f)).sort();
      const files = fs.readdirSync(UNIT_DIR).filter((f) => /\.(service|timer)$/.test(f)).sort();
      assert.deepEqual(got, files);
    } finally {
      fs.rmSync(dest, { recursive: true, force: true });
    }
  });

  it('OnCalendar 变了、特权行没变 → 仍装', () => {
    const src = fs.mkdtempSync(path.join(os.tmpdir(), 'dao-units-cal-'));
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'dao-units-cal-dest-'));
    try {
      const timer = 'dao-skills-heal-root.timer';
      const text = fs.readFileSync(path.join(UNIT_DIR, timer), 'utf8')
        .replace(/^OnCalendar=.*$/m, 'OnCalendar=*:03/5');
      fs.writeFileSync(path.join(src, timer), text);
      const r = runInstallUnits(src, dest);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /上机 1 个单元/);
      assert.match(fs.readFileSync(path.join(dest, timer), 'utf8'), /OnCalendar=\*:03\/5/);
    } finally {
      fs.rmSync(src, { recursive: true, force: true });
      fs.rmSync(dest, { recursive: true, force: true });
    }
  });

  it('恶意 service/timer 样本不能把 root 命令装进 DEST', () => {
    const src = path.join(FIX, 'malicious');
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'dao-units-evil-'));
    try {
      fs.copyFileSync(path.join(UNIT_DIR, 'dao-skills-heal-root.service'), path.join(dest, 'dao-skills-heal-root.service'));
      fs.copyFileSync(path.join(UNIT_DIR, 'dao-skills-heal-root.timer'), path.join(dest, 'dao-skills-heal-root.timer'));
      const r = runInstallUnits(src, dest);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stderr, /拒绝特权行漂移：dao-skills-heal-root\.service/);
      assert.match(r.stderr, /拒绝特权行漂移：dao-skills-heal-root\.timer/);
      assert.match(r.stderr, /拒绝未登记单元：evil-root\.service/);
      const service = fs.readFileSync(path.join(dest, 'dao-skills-heal-root.service'), 'utf8');
      assert.match(service, /ExecStart=\/usr\/bin\/node \/usr\/local\/lib\/dao-skills-heal\/skills-heal\.mjs/);
      assert.equal(/\/bin\/sh/.test(service), false);
      const timer = fs.readFileSync(path.join(dest, 'dao-skills-heal-root.timer'), 'utf8');
      assert.equal(/^Unit=/m.test(timer), false);
      assert.equal(/^ExecStart=/m.test(timer), false);
      assert.equal(fs.existsSync(path.join(dest, 'evil-root.service')), false);
    } finally {
      fs.rmSync(dest, { recursive: true, force: true });
    }
  });
});
