// 关单没接线（2026-09-05 实咬）。
//
// 2026-08-21 拍板把关单的「唯一生产入口」定为 flow.mjs 合后钩——PR 一合就判这一张。
// 那个钩子 #807 已删，而**没有任何东西接替它**：全仓只剩 commander.mjs 的 merge 动作会调
// `close-issues.mjs --pr N`，凡不是指挥官合的 PR，单就一直开着，延迟是无限大。
// 服务器实测关单定时器数量 = 0；当天帅位手工关了 12 张，正好把缺口盖住，所以一直没人发现。
//
// 本闸守三件事：
//   ① 定时器存在，且跑的是**窗口补漏**（--since-hours），不是拍板明令禁止的全量 sweep；
//   ② 窗口是个卡死的数字（MAX_SINCE_HOURS），不是一句命名约定；
//   ③ 关单动作以 marshal 身份落，凭据没装就 fail-loud，不悄悄退回裸 gh 记到用户本人头上。
//
// 每条判据都先喂一个故意违规的样本，被拦住才算这条判据真在查东西。
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const UNIT_DIR = path.join(ROOT, 'host', 'machine', 'systemd');
const SERVICE = path.join(UNIT_DIR, 'dao-close-issues.service');
const TIMER = path.join(UNIT_DIR, 'dao-close-issues.timer');
const CLI = path.join(ROOT, 'scripts', 'close-issues.mjs');
const LOAD_CLI = import('file://' + CLI.replace(/\\/g, '/'));

/**
 * 无人看管的关单单元该长什么样。做成函数而不是一串 inline assert，
 * 是为了能拿假单元喂它——判据自己没被验过，就只是一段看起来像检查的代码。
 */
function auditCloseUnit(text) {
  const bad = [];
  const execs = [...String(text).matchAll(/^ExecStart=(.+)$/gm)].map((m) => m[1]);
  if (execs.length === 0) bad.push('没有 ExecStart');
  const user = (String(text).match(/^User=(.+)$/m) || [])[1];
  if (!user || user.trim() === 'root') bad.push('以 root 跑（不写 User= 就是 root）');
  for (const e of execs) {
    if (/--sweep\b/.test(e)) bad.push('跑的是全量 sweep——2026-08-21 拍板禁止 agent 自动跑，它误重开过 58 个远古单');
    if (/--i-know-what-im-doing\b/.test(e)) bad.push('带了 --i-know-what-im-doing——那个 flag 的意义就是「人当轮拍的」，写进单元等于机器替人一直拍');
    if (!/--since-hours\s+\d+/.test(e)) bad.push('没给 --since-hours：无人看管的关单必须按合并时间卡窗口');
    if (!/close-issues\.mjs/.test(e)) bad.push('ExecStart 跑的不是关单脚本');
  }
  return bad;
}

describe('关单定时器：存在、且跑的是窗口补漏不是全量 sweep', () => {
  it('单元文件在——不在就说明关单还是没人定时跑', () => {
    assert.ok(fs.existsSync(SERVICE), 'dao-close-issues.service 不在，关单延迟仍是无限大');
    assert.ok(fs.existsSync(TIMER), 'dao-close-issues.timer 不在，service 没人触发');
  });

  it('故意违规样本：sweep 版单元 / root 版单元都要被拦下', () => {
    const sweepUnit = '[Service]\nUser=orca\nExecStart=/usr/bin/node /home/orca/windsurf-dao/scripts/close-issues.mjs --sweep --i-know-what-im-doing\n';
    const swept = auditCloseUnit(sweepUnit);
    assert.ok(swept.some((b) => /sweep/.test(b)), '全量 sweep 版本必须被拦住，实际：' + JSON.stringify(swept));
    assert.ok(swept.some((b) => /i-know-what-im-doing/.test(b)), '机器替人一直拍那个 flag 必须被拦住');

    const rootUnit = '[Service]\nExecStart=/usr/bin/node /home/orca/windsurf-dao/scripts/close-issues.mjs --since-hours 6\n';
    assert.ok(auditCloseUnit(rootUnit).some((b) => /root/.test(b)), '不写 User= 就是 root，必须被拦住');

    const noWindow = '[Service]\nUser=orca\nExecStart=/usr/bin/node /home/orca/windsurf-dao/scripts/close-issues.mjs\n';
    assert.ok(auditCloseUnit(noWindow).some((b) => /since-hours/.test(b)), '不卡窗口的无人看管关单必须被拦住');
  });

  it('反证：真单元干净——判据不是恒红', () => {
    assert.deepEqual(auditCloseUnit(fs.readFileSync(SERVICE, 'utf8')), []);
  });

  it('timer 有挂钟点位——只有单调时钟会进 active(elapsed) 死态', () => {
    // timer-armed 已经全目录扫这一条；这里再钉一次是因为「关单从此不跑」和「关单从来没装」
    // 在盘面上长得一模一样，而前者更难发现。
    const t = fs.readFileSync(TIMER, 'utf8');
    assert.match(t, /^OnCalendar=/m, 'timer 缺 OnCalendar，停掉再起就永不触发且无人报警');
    assert.match(t, /^Persistent=true$/m, '缺 Persistent：停机期间漏掉的那轮不会补跑');
  });

  it('装机脚本在，且不 chmod 仓内文件（chmod 会把树弄脏，ff-only 同步当场 Aborting）', () => {
    const f = path.join(ROOT, 'scripts', 'install-dao-close-issues.sh');
    assert.ok(fs.existsSync(f), '装机脚本不在，单元只能靠人手抄进 /etc');
    const text = fs.readFileSync(f, 'utf8');
    const bad = text.split(/\r?\n/).filter((l) => /^\s*chmod\b/.test(l) && /\$(ROOT|\{ROOT\})/.test(l));
    assert.deepEqual(bad, [], '装机脚本 chmod 了仓内文件：\n' + bad.join('\n'));
    assert.match(text, /--dry-run/, '装完必须先预演一次——「装上了」不等于「跑得通」');
  });
});

describe('窗口是卡死的数字，不是命名约定', () => {
  it('故意违规样本：把窗口开到 sweep 那么大要被顶回来', async () => {
    const M = await LOAD_CLI;
    for (const h of [M.MAX_SINCE_HOURS + 1, 24 * 365, 100000]) {
      const r = M.clampSinceHours(h);
      assert.equal(r.ok, false, `--since-hours ${h} 应被拒——它读起来像补漏，跑起来是全量 sweep`);
      assert.match(r.error, /sweep/, '报错要点破「这已经是 sweep 了」，不能只说超限');
    }
    for (const h of [0, -1, 'abc', null, undefined, NaN]) {
      assert.equal(M.clampSinceHours(h).ok, false, `--since-hours ${JSON.stringify(h)} 应被拒`);
    }
  });

  it('反证：正常窗口放行', async () => {
    const M = await LOAD_CLI;
    for (const h of [1, 6, 24, 72]) {
      const r = M.clampSinceHours(h);
      assert.equal(r.ok, true, `${h} 小时该放行`);
      assert.equal(r.hours, h);
    }
  });

  it('--since-hours 不是 sweep：不被强制 dry-run，也不要 --i-know-what-im-doing', async () => {
    const M = await LOAD_CLI;
    const { args, notice } = M.enforceSweepPolicy(M.parseArgs(['--since-hours', '6']));
    assert.equal(args.dryRun, false, '窗口模式被强制 dry-run 的话，定时器就是个不干活的机制');
    assert.equal(args.sweep, false, '标成 sweep 会让人以为定时器在扫全史');
    assert.equal(args.sinceHours, 6);
    assert.equal(notice, null);
  });

  it('无参仍然是 sweep 且仍然强制 dry-run——本单没有放松那条拍板', async () => {
    const M = await LOAD_CLI;
    const { args, notice } = M.enforceSweepPolicy(M.parseArgs([]));
    assert.equal(args.dryRun, true);
    assert.equal(args.sweep, true);
    assert.match(String(notice), /i-know-what-im-doing/);
  });
});

describe('窗口裁剪与「扫完是 0」vs「没查成」', () => {
  it('只留窗口内的；mergedAt 读不出来的不算在窗内，但要显形', async () => {
    const M = await LOAD_CLI;
    const now = Date.parse('2026-09-05T12:00:00Z');
    const r = M.selectMergedSince([
      { number: 3, mergedAt: '2026-09-05T11:00:00Z' },   // 1 小时前，在窗内
      { number: 1, mergedAt: '2026-09-05T05:00:00Z' },   // 7 小时前，出窗
      { number: 9, mergedAt: null },                      // 判不了
      { number: 5, mergedAt: '2026-09-05T09:30:00Z' },   // 2.5 小时前，在窗内
    ], { hours: 6, now });
    assert.deepEqual(r.numbers, [3, 5], '出窗的和判不了的都不许混进来');
    assert.deepEqual(r.undated, [9], '读不到 mergedAt 的要报出来，不能静默吞掉');
  });

  it('故意违规样本：查询坏了返回 0 个，不许当成「这小时没人合并」', async () => {
    const M = await LOAD_CLI;
    // 窗口 0 个 + 不带窗口也 0 个 = 这个仓「一张已合并 PR 都没有」，不可能，是查询坏了。
    assert.equal(M.classifyWindowScan({ windowed: [], probeCount: 0 }).state, 'unscanned');
    // 探针自己没查成 → 分不清，同样不许判绿。
    assert.equal(M.classifyWindowScan({ windowed: [], probeCount: null }).state, 'unscanned');
    assert.equal(M.classifyWindowScan({ windowed: null, probeCount: 5 }).state, 'unscanned');
  });

  it('反证：探针查得到而窗口是 0 → 就是这小时没人合并，正常', async () => {
    const M = await LOAD_CLI;
    const r = M.classifyWindowScan({ windowed: [], probeCount: 1 });
    assert.equal(r.state, 'zero');
    assert.match(r.detail, /扫完是 0/);
    assert.equal(M.classifyWindowScan({ windowed: [{ number: 1 }], probeCount: 1 }).state, 'found');
  });

  it('搜索串按天取下界，量砍下来再交给客户端精确裁窗', async () => {
    const M = await LOAD_CLI;
    assert.equal(M.mergedSinceQuery(6, Date.parse('2026-09-05T12:00:00Z')), 'merged:>=2026-09-05');
    assert.equal(M.mergedSinceQuery(24, Date.parse('2026-09-05T12:00:00Z')), 'merged:>=2026-09-04');
  });
});

describe('关单以 marshal 身份落，不记在用户本人头上', () => {
  it('源码里不许再有裸 gh 调用', () => {
    const src = fs.readFileSync(CLI, 'utf8');
    const bare = src.split(/\r?\n/).filter((l) => /spawnSync\(\s*['"]gh/.test(l));
    assert.deepEqual(bare, [],
      '裸 gh 走的是用户个人 token，GitHub 历史里「谁关的这张单」会全记成用户本人：\n' + bare.join('\n'));
    assert.match(src, /ghAs\(\s*['"]marshal['"]/, '要显式走 marshal 角色');
  });

  // 只查源码文本挡不住「import 了但没真用」。这条在**运行时**验：
  // 把凭据目录指到一个空目录，marshal 路径必然 fail-loud 报「缺凭据」。
  // 要是哪天有人改回裸 gh，这里拿到的就是别的错（或者干脆成功），当场红。
  it('故意违规样本：凭据目录是空的 → 必须 fail-loud 报缺凭据，不许退回裸 gh', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'dao-close-noapps-'));
    const r = spawnSync(process.execPath, [CLI, '--since-hours', '6', '--dry-run'], {
      cwd: ROOT, encoding: 'utf8', timeout: 60000,
      env: { ...process.env, DAO_APPS_DIR: empty },
    });
    const out = String(r.stdout || '') + String(r.stderr || '');
    assert.notEqual(r.status, 0, '凭据没装还退 0，等于「没查成」被当成「查过没事」');
    assert.match(out, /缺凭据/, '要报「这台机器没装」而不是含糊的 gh 报错：\n' + out.slice(0, 600));
    assert.match(out, /marshal/, '要点名缺的是 marshal 的凭据：\n' + out.slice(0, 600));
  });
});
