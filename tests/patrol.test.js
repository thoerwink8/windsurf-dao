// 机制巡检（commander.mjs patrol）。
//
// 这条路的风险不在「跑不跑得起来」，在三处：
//   ① 一个无人看管的会话在服务器上乱改——所以边界必须有查得出的判据，不能只写在任务书里；
//   ② 「已有报告列不出来」被当成「一条都没有」——那会让它把报过的事再报一遍；
//   ③ 有人另写一套起会话/回收，造出没人收的孤儿会话（本机那版就是这么堆了几十个）。
// 下面每一条都配了故意违规的样本：判据失效时这些样本会当场变绿，测试就红。
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const MOD = () => import('file://' + path.join(ROOT, 'scripts', 'commander.mjs').replace(/\\/g, '/'));
const SRC = fs.readFileSync(path.join(ROOT, 'scripts', 'commander.mjs'), 'utf8');
const UNIT_DIR = path.join(ROOT, 'host', 'machine', 'systemd');

describe('巡检任务书：给会话的那份全文', () => {
  it('四类要找的东西、写到哪、怎么收尾，一条都不能少', async () => {
    const M = await MOD();
    const text = M.patrolBriefText({ existing: { scanned: true, files: [] } });
    for (const must of [
      '机制上的漏洞', '装了没生效', '判据前提已不成立', '两处规矩互相打架', // 去找什么
      'docs/observations/', 'git add', 'git commit', 'git push',           // 写到哪
      '不要再报一遍',                                                        // 不许重复报
      'exit',                                                              // 收尾
    ]) assert.ok(text.includes(must), `任务书缺「${must}」`);
  });

  it('硬边界逐条在场——少一条就是给无人看管的会话开一道口子', async () => {
    const M = await MOD();
    const text = M.patrolBriefText({ existing: { scanned: true, files: [] } });
    for (const must of [
      '只许新建或修改', '不许改代码', '不许 `sudo`', '不许启停任何服务',
      '不许开 GitHub 单子或 PR', '不许合并', '不许花钱', '只描述，不动手',
    ]) assert.ok(text.includes(must), `硬边界缺「${must}」`);
  });

  it('会话寿命写的是真被执行的那个数——任务书不许自己编一个', async () => {
    const M = await MOD();
    const text = M.patrolBriefText({ existing: { scanned: true, files: [] }, maxAgeMs: 12 * 60000 });
    assert.ok(text.includes('12 分钟'), '任务书里的分钟数必须由回收上限算出来');
    assert.ok(!text.includes('30 分钟'), '写死 30 就是编——改了回收上限它会继续骗那个会话');
  });

  it('主树只许快进：任务书必须告诉它「提交了不推」会掐死整台机器的代码同步', async () => {
    const M = await MOD();
    const text = M.patrolBriefText({ existing: { scanned: true, files: [] } });
    assert.ok(/不许留着不推/.test(text) && /快进/.test(text),
      '本地留一个没推的提交，dao-sync 的 merge --ff-only 从此每轮 Aborting——这条必须写给它');
  });

  it('提交要带标记，否则回头没法把它的提交挑出来查边界', async () => {
    const M = await MOD();
    const text = M.patrolBriefText({ existing: { scanned: true, files: [] }, commitTag: '[zzz]' });
    assert.ok(text.includes('[zzz]'), '标记要真的进任务书，不是只在代码里定义');
  });
});

describe('已有报告清单：没查成 ≠ 一条都没有', () => {
  it('故意违规样本：清单读不出来时，任务书说的是「没查成」，绝不能说「一条都没有」', async () => {
    const M = await MOD();
    const text = M.patrolBriefText({ existing: { scanned: false, error: '目录读不了：EACCES' } });
    assert.ok(text.includes('没查成'), '读不出来要在任务书里显形');
    assert.ok(text.includes('EACCES'), '要把读不出来的原因带给它');
    assert.ok(!text.includes('一条都没有'),
      '把「没查成」写成「一条都没有」，巡检就会把已经报过的事再报一遍');
    assert.ok(/不要写新报告|没法判重复/.test(text), '没法判重复时要让它停手，不是照写');
  });

  it('反证：真查过且是空的，要明说这是查过的结果——判据不是恒「没查成」', async () => {
    const M = await MOD();
    const text = M.patrolBriefText({ existing: { scanned: true, files: [] } });
    assert.ok(text.includes('一条都没有') && text.includes('不是没查成'));
  });

  it('查到了就把文件名列进去（它靠这个判重复）', async () => {
    const M = await MOD();
    const text = M.patrolBriefText({ existing: { scanned: true, files: ['2026-09-05-a.md', '2026-09-05-b.md'] } });
    assert.ok(text.includes('2026-09-05-a.md') && text.includes('2026-09-05-b.md'));
  });

  it('listObservations：目录读不了 → 没查成，不是空数组', async () => {
    const M = await MOD();
    const bad = M.listObservations({ dir: path.join(os.tmpdir(), 'patrol-no-such-dir-' + Date.now()) });
    assert.equal(bad.scanned, false, '读不了必须是没查成');
    assert.ok(!Array.isArray(bad.files), '不许退化成空清单');
    const good = M.listObservations({ dir: path.join(ROOT, 'docs', 'observations') });
    assert.equal(good.scanned, true, '真目录要读得出来——读不出来说明落点判据已失效');
    assert.ok(good.files.length > 0, '扫出 0 份不算通过：收件箱目录本来就有判例档案');
  });
});

describe('写入边界：查得出，不是只写在任务书里', () => {
  it('故意违规样本：碰了 docs/observations/ 之外的文件 → 抓出来', async () => {
    const M = await MOD();
    const r = M.patrolBoundaryViolations([
      'docs/observations/2026-09-05-x.md',
      'scripts/commander.mjs',
      'host/machine/systemd/dao-patrol.timer',
    ]);
    assert.equal(r.scanned, true);
    assert.deepEqual(r.violations, ['scripts/commander.mjs', 'host/machine/systemd/dao-patrol.timer']);
  });

  it('反证：只写收件箱就是干净的——判据不是恒红', async () => {
    const M = await MOD();
    const r = M.patrolBoundaryViolations(['docs/observations/a.md', 'docs/observations/b.md']);
    assert.deepEqual(r.violations, []);
    assert.equal(r.checked, 2, '查了几个要显形');
  });

  it('清单本身没查成 → 不当成「没越界」', async () => {
    const M = await MOD();
    assert.equal(M.patrolBoundaryViolations(null).scanned, false);
    assert.equal(M.patrolBoundaryViolations(undefined).scanned, false);
  });
});

describe('回头审巡检自己的提交', () => {
  // 注入 runner：不碰真 git，样本自己造。
  const runner = (map) => (argv) => {
    if (argv[1] === 'log') return map.log;
    const hash = argv[argv.length - 1];
    return map.show[hash] || { ok: false, error: 'no such commit' };
  };

  it('故意违规样本：巡检提交里动了代码 → 点名是哪个提交、哪些文件', async () => {
    const M = await MOD();
    const r = M.auditPatrolCommits({
      sinceIso: '2026-09-01T00:00:00Z',
      run: runner({
        log: { ok: true, out: 'aaaaaaaa1111\nbbbbbbbb2222\n' },
        show: {
          aaaaaaaa1111: { ok: true, out: 'docs/observations/ok.md\n' },
          bbbbbbbb2222: { ok: true, out: 'docs/observations/x.md\nscripts/land.mjs\n' },
        },
      }),
    });
    assert.equal(r.scanned, true);
    assert.equal(r.commits, 2, '查了几个提交要显形');
    assert.equal(r.offenders.length, 1);
    assert.equal(r.offenders[0].commit, 'bbbbbbbb');
    assert.deepEqual(r.offenders[0].files, ['scripts/land.mjs']);
  });

  it('反证：全都只碰收件箱 → 干净', async () => {
    const M = await MOD();
    const r = M.auditPatrolCommits({
      sinceIso: '2026-09-01T00:00:00Z',
      run: runner({ log: { ok: true, out: 'cccccccc3333\n' }, show: { cccccccc3333: { ok: true, out: 'docs/observations/y.md\n' } } }),
    });
    assert.equal(r.offenders.length, 0);
    assert.equal(r.commits, 1);
  });

  it('一个巡检提交都没有 = 查过没事，不是没查成', async () => {
    const M = await MOD();
    const r = M.auditPatrolCommits({ sinceIso: '2026-09-01T00:00:00Z', run: runner({ log: { ok: true, out: '' }, show: {} }) });
    assert.equal(r.scanned, true);
    assert.equal(r.commits, 0);
  });

  it('git 查不成 → 没查成，绝不报「干净」', async () => {
    const M = await MOD();
    const noLog = M.auditPatrolCommits({ sinceIso: 'x', run: () => ({ ok: false, error: '不是 git 仓' }) });
    assert.equal(noLog.scanned, false);
    assert.ok(!('offenders' in noLog), '没查成不许附带一个空的越界清单——那看起来就像查过了');

    const noShow = M.auditPatrolCommits({
      sinceIso: 'x',
      run: runner({ log: { ok: true, out: 'dddddddd4444\n' }, show: {} }),
    });
    assert.equal(noShow.scanned, false, '列得出提交但看不到它碰了什么，同样是没查成');
  });
});

describe('三态退出码', () => {
  it('没查成压过一切；查出越界是 1；查过没事才是 0', async () => {
    const M = await MOD();
    assert.equal(M.patrolExitCode({ unscanned: ['清单读不了'], outOfBounds: 0 }), 2);
    assert.equal(M.patrolExitCode({ unscanned: ['清单读不了'], outOfBounds: 3 }), 2, '没查成不许被越界数盖过去');
    assert.equal(M.patrolExitCode({ unscanned: [], outOfBounds: 1 }), 1);
    assert.equal(M.patrolExitCode({ unscanned: [], outOfBounds: 0 }), 0);
    assert.equal(M.patrolExitCode({}), 0);
  });
});

describe('注入只给指针', () => {
  it('注入那一句短、且指向任务书文件', async () => {
    const M = await MOD();
    const p = '/home/orca/.dao/commander/patrol/patrol-2026-09-05T00-00-00-000Z.md';
    const inject = M.patrolInjectText(p);
    assert.ok(inject.includes(p), '要告诉它全文在哪');
    assert.ok(Buffer.byteLength(inject, 'utf8') <= 500,
      `注入 ${Buffer.byteLength(inject, 'utf8')} 字节——长文塞进 TUI 会坐在输入框里当粘贴块，永远不开工`);
    const brief = M.patrolBriefText({ existing: { scanned: true, files: [] } });
    assert.ok(!inject.includes(brief.slice(0, 60)), '任务书正文不许进注入');
  });
});

describe('复用大脑那条路，不另造一套', () => {
  it('巡检用的是 wakeBrain / reapBrains', () => {
    const i = SRC.indexOf('function cmdPatrol');
    assert.ok(i > -1, '找不到 cmdPatrol——本闸判据已失效，不是通过');
    const body = SRC.slice(i, SRC.indexOf('\n// ── 代拍', i));
    assert.ok(body.length > 200, 'cmdPatrol 段没截出来，判据失效');
    assert.match(body, /wakeBrain\(/, '起会话必须走 wakeBrain（登记进 brainSessions 才有人回收）');
    assert.match(body, /reapBrains\(/, '每轮先回收：act 停摆时巡检不能自己堆孤儿会话');
  });

  it('巡检段里不许自己去碰终端——起会话和关会话都只有 wakeBrain/reapBrains 那一处', () => {
    const i = SRC.indexOf('function cmdPatrol');
    const body = SRC.slice(i, SRC.indexOf('\n// ── 代拍', i));
    // 起/送/关会话该用到的东西全在 wakeBrain、reapBrains 里。cmdPatrol 里一出现它们，
    // 就说明有人在旁边又拼了一条路——那条路上起的会话不会进 brainSessions，也就没人回收。
    for (const forbidden of ['dao.mjs', 'runOrca(', 'runCmd(', 'terminal']) {
      assert.ok(!body.includes(forbidden),
        `巡检里出现 ${forbidden}——另写一套起会话/回收就等于造一批没人收的孤儿会话`);
    }
  });

  it('回收上限只有一个来源：任务书里的分钟数和 reapBrains 的默认值同出一处', () => {
    assert.match(SRC, /const BRAIN_MAX_AGE_MS = /, '寿命上限要有名字，不许两处各写一个字面量');
    assert.match(SRC, /maxAgeMs = BRAIN_MAX_AGE_MS/, 'reapBrains 的默认值要用这个常量');
    assert.match(SRC, /maxAgeMs = BRAIN_MAX_AGE_MS/, '任务书的分钟数也从同一个常量算');
  });

  it('patrol 真的挂进了子命令表和用法说明', () => {
    assert.match(SRC, /patrol: cmdPatrol/, '没挂进 CMDS 等于命令不存在');
    assert.match(SRC, /scan\|act\|patrol\|/, '用法里要列出来，否则没人知道有它');
  });
});

describe('systemd 单元', () => {
  it('service：以 orca 跑、真跑的是 patrol、给足起会话的时间', () => {
    const f = path.join(UNIT_DIR, 'dao-patrol.service');
    assert.ok(fs.existsSync(f), '单元文件不在——装法指向空气');
    const s = fs.readFileSync(f, 'utf8');
    assert.match(s, /^User=orca$/m,
        '不写 User= 就是 root，而 ExecStart 指的是人人可写的仓——那是一条提权通道');
    assert.match(s, /^ExecStart=.*commander\.mjs patrol$/m, 'ExecStart 要真的跑 patrol');
    assert.match(s, /^TimeoutStartSec=(\d+)$/m, '起一次性会话要等，默认 90 秒会把正常的一轮掐死');
    assert.ok(Number((s.match(/^TimeoutStartSec=(\d+)$/m) || [])[1]) >= 300, '至少要盖住起会话的时间预算');
    assert.match(s, /^SuccessExitStatus=0 1$/m, '1 = 查出越界已报帅，是正常输出');
    assert.ok(!/SuccessExitStatus=.*\b2\b/.test(s),
      '2 = 没查成，不许当成功——没查成必须在 systemctl --failed 里看得见');
  });

  it('timer：有墙钟触发点，且不是分钟级——巡检找的是攒出来的问题', () => {
    const f = path.join(UNIT_DIR, 'dao-patrol.timer');
    assert.ok(fs.existsSync(f), 'timer 文件不在');
    const s = fs.readFileSync(f, 'utf8');
    const cal = (s.match(/^OnCalendar=(.+)$/m) || [])[1];
    assert.ok(cal, '只有单调时钟的 timer 停掉再起会进 active(elapsed) 死态，显示 active 却永不触发');
    // 每一轮是一整个模型会话，不是一条 grep：本机那版 10 分钟一轮，半天堆了几十个没人收的会话。
    // 所以这里把「至少 6 小时一轮」写成判据——想改档就得连同 timer 里那三条理由一起重写。
    const [hourF, minF] = cal.trim().split(/\s+/).pop().split(':');
    assert.match(minF || '', /^\d+$/, `OnCalendar=${cal} 的分钟位不是写死的数——那就是分钟级触发`);
    assert.notEqual(hourF, '*', `OnCalendar=${cal} 每小时都触发，太密`);
    const step = Number((String(hourF).match(/^\d+\/(\d+)$/) || [])[1]);
    const listed = String(hourF).split(',').length;
    assert.ok(step >= 6 || (listed > 1 && listed <= 4),
      `OnCalendar=${cal} 比 6 小时一轮更密——一天最多 4 轮，产出速度不能超过帅位消化速度`);
    assert.match(s, /^Persistent=true$/m, '机器睡过头要补跑');
  });

  it('单元里不许抄业务判据——判据只在 commander.mjs', () => {
    for (const f of ['dao-patrol.service', 'dao-patrol.timer']) {
      const s = fs.readFileSync(path.join(UNIT_DIR, f), 'utf8');
      const code = s.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith('#'));
      assert.ok(!code.some((l) => /docs\/observations|git (add|commit|push)/.test(l)),
        `${f} 里出现了任务书的内容——两处各一份，改一处就对不上`);
    }
  });
});

describe('装法', () => {
  const f = path.join(ROOT, 'scripts', 'install-dao-patrol.sh');

  it('装机脚本在，且装的是这两个单元', () => {
    assert.ok(fs.existsSync(f), '装机脚本不在——单元躺在仓里没人装');
    const s = fs.readFileSync(f, 'utf8');
    assert.match(s, /dao-patrol\.service/);
    assert.match(s, /dao-patrol\.timer/);
    assert.match(s, /systemctl enable --now dao-patrol\.timer/);
  });

  it('不许 chmod 仓内文件——装完树就脏，只许快进的同步会从此 Aborting', () => {
    const s = fs.readFileSync(f, 'utf8');
    const bad = s.split(/\r?\n/).filter((l) => /^\s*chmod\b/.test(l) && /\$(ROOT|\{ROOT\})/.test(l));
    assert.deepEqual(bad, [], `装机脚本里 chmod 了仓内文件：\n${bad.join('\n')}`);
  });

  it('装完要验「有没有下一次触发」，不是验「在不在册」', () => {
    const s = fs.readFileSync(f, 'utf8');
    assert.match(s, /NextElapseUSecRealtime/,
      'active+enabled 也可能是 elapsed 死态；装完必须验下一次触发点，验不到就报错退出');
    assert.match(s, /exit 1/, '验不到要真的失败，不是打一行字继续');
  });
});

describe('干跑：跑得出计划，且不真起会话', () => {
  it('node scripts/commander.mjs patrol --dry-run → exit 0、有计划、没起会话', () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'patrol-state-'));
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'commander.mjs'), 'patrol', '--dry-run'], {
      cwd: ROOT, encoding: 'utf8', timeout: 120000,
      env: { ...process.env, COMMANDER_STATE_DIR: stateDir },
    });
    assert.equal(r.status, 0, `干跑该是 0，实际 ${r.status}\n${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.dryRun, true);
    assert.ok(String(out.woken).includes('没真起会话'), '干跑不许真起会话');
    assert.ok(out.briefBytes > 500, '计划里要能看见任务书有多大');
    assert.ok(String(r.stderr).includes('机制巡检'), '干跑要把任务书全文打出来给人看');
    assert.deepEqual(fs.readdirSync(stateDir), [], '干跑不许留下任何文件（任务书和 state 都不落盘）');
  });
});
