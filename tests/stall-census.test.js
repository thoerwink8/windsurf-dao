// 盘点「还卡着的东西」（2026-09-05 实咬）。每条都对着一件当天真发生的事：
//   · 服务器静默账本里躺着 minutes:972 的条目（16 小时没动），播报里一个字都没有——
//     settled 判据把 escalate 一律当「已了结」，报过一次就永久闭嘴。
//   · #829 的 grok 进程 turn_ended 之后又挂了两天。它没有终端记录，
//     所以按 orca 终端清单遍历的扫描器**一个都数不到它**——不是漏报，是压根没采样。
const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const LIB = 'file://' + path.join(__dirname, '..', 'scripts', 'lib', 'stall-census.mjs').replace(/\\/g, '/');
const LOAD = import(LIB);
const PLAIN = 'file://' + path.join(__dirname, '..', 'scripts', 'lib', 'plain-words.mjs').replace(/\\/g, '/');

const H = 3600000;
const WS = '/home/orca/orca/workspaces/windsurf-dao';

describe('升级档：报过一次不等于永远闭嘴', () => {
  it('故意违规样本：一个静默 16 小时的会话，账本说「已报过」——必须还能被报出来', async () => {
    const S = await LOAD;
    // 这就是服务器账本里那条 minutes:972。旧路径：settled=true → continue → 永远沉默。
    const items = [{ key: 'ISSUE-891-快马896', label: '某工人', ms: 972 * 60000 }];
    const r = S.planTierAlerts({ items, memory: {}, tiers: S.SILENCE_TIERS });
    assert.equal(r.state, 'red');
    assert.equal(r.alerts.length, 1, '16 小时没动必须被报出来');
    assert.equal(r.alerts[0].tierLabel, '12 小时', '16.2 小时落 12 小时那一档');
  });

  it('同一档只说一次——去重还在，加的是升级不是取消去重', async () => {
    const S = await LOAD;
    const items = [{ key: 'k1', label: 'X', ms: 4 * H }];
    const first = S.planTierAlerts({ items, memory: {}, tiers: S.SILENCE_TIERS });
    assert.equal(first.alerts.length, 1);
    const second = S.planTierAlerts({ items, memory: first.memory, tiers: S.SILENCE_TIERS });
    assert.equal(second.alerts.length, 0, '同一档第二轮不许再刷一遍');
  });

  it('跨到更高档要再说一次——这正是「静默 3 小时没人报」的解药', async () => {
    const S = await LOAD;
    const m1 = S.planTierAlerts({ items: [{ key: 'k1', label: 'X', ms: 4 * H }], memory: {}, tiers: S.SILENCE_TIERS }).memory;
    const r = S.planTierAlerts({ items: [{ key: 'k1', label: 'X', ms: 13 * H }], memory: m1, tiers: S.SILENCE_TIERS });
    assert.equal(r.alerts.length, 1);
    assert.equal(r.alerts[0].tierLabel, '12 小时');
  });

  it('档位只涨不跌：抖动回低档不许把说过的档重说一遍', async () => {
    const S = await LOAD;
    const m = S.planTierAlerts({ items: [{ key: 'k1', label: 'X', ms: 30 * H }], memory: {}, tiers: S.SILENCE_TIERS }).memory;
    const back = S.planTierAlerts({ items: [{ key: 'k1', label: 'X', ms: 4 * H }], memory: m, tiers: S.SILENCE_TIERS });
    assert.equal(back.alerts.length, 0);
    assert.equal(back.memory.k1.tier, 2, '记账保留高档，不许被低档洗掉');
  });

  it('反证：没到第一档就不该说——判据不是恒红', async () => {
    const S = await LOAD;
    const r = S.planTierAlerts({ items: [{ key: 'k1', label: 'X', ms: 50 * 60000 }], memory: {}, tiers: S.SILENCE_TIERS });
    assert.equal(r.state, 'ok');
    assert.equal(r.alerts.length, 0, '50 分钟归上游首报管，本闸不重复');
  });

  it('一张卡好几个终端只说一次，取最久的那个', async () => {
    const S = await LOAD;
    const r = S.planTierAlerts({
      items: [{ key: 'k1', label: 'A', ms: 4 * H }, { key: 'k1', label: 'B', ms: 26 * H }],
      memory: {}, tiers: S.SILENCE_TIERS,
    });
    assert.equal(r.alerts.length, 1);
    assert.equal(r.alerts[0].tierLabel, '一天');
  });

  it('一个样本都没有 = 没查成，不是「都健康」', async () => {
    const S = await LOAD;
    assert.equal(S.planTierAlerts({ items: null, memory: {} }).state, 'unscanned');
    assert.equal(S.planTierAlerts({}).state, 'unscanned');
  });
});

describe('无卡孤儿：按卡遍历的扫描器看不见的那一格', () => {
  const term = (p) => ({ handle: 't-' + p, worktreePath: p });
  const proc = (pid, cwd, ageMs) => ({ pid, cwd, cmd: 'pi', ageMs });

  it('故意违规样本：#829 的 grok——进程活着，终端清单里没有它，必须当场报红', async () => {
    const S = await LOAD;
    const r = S.classifyNoCardProcesses({
      terminals: [term(`${WS}/PR-909-审官-gpt-5.6-luna`)],
      processes: [
        proc(180770, `${WS}/PR-909-审官-gpt-5.6-luna`, 8 * H),
        proc(999001, `${WS}/ISSUE-829-工人-grok-4.6-网关`, 48 * H), // 卡没了，进程还在
      ],
    });
    assert.equal(r.state, 'red');
    assert.equal(r.strays.length, 1);
    assert.match(r.strays[0].card, /ISSUE-829/);
    assert.equal(r.strays[0].ageMs, 48 * H);
  });

  it('卡目录已经被删掉的（cwd 带 deleted）也算——那次「卡删了进程没死」发了 21 条重复评论', async () => {
    const S = await LOAD;
    const r = S.classifyNoCardProcesses({
      terminals: [term(`${WS}/ISSUE-891-工人`)],
      processes: [proc(1, `${WS}/ISSUE-891-工人 (deleted)`, 5 * H)],
    });
    assert.equal(r.state, 'red', '目录都没了还认领得到卡，那是判据被路径串匹配骗了');
    assert.equal(r.strays[0].cardDeleted, true);
  });

  it('反证：每个进程都认得回自己的卡就该绿——判据不是恒红', async () => {
    const S = await LOAD;
    const r = S.classifyNoCardProcesses({
      terminals: [term(`${WS}/PR-909-审官-gpt-5.6-luna`), term(`${WS}/ISSUE-891-工人`)],
      processes: [
        proc(1, `${WS}/PR-909-审官-gpt-5.6-luna`, 8 * H),
        proc(2, `${WS}/ISSUE-891-工人/scripts`, 8 * H), // 子目录要收敛到卡目录
        proc(3, '/srv/projects/windsurf-dao', 8 * H),      // 主树不参与本闸
      ],
    });
    assert.equal(r.state, 'ok');
    assert.equal(r.sampled, 2, '主树进程不该进采样面，子目录该收敛到卡');
  });

  it('刚起的进程有宽限——orca 还没来得及登记就判孤儿是误报', async () => {
    const S = await LOAD;
    const r = S.classifyNoCardProcesses({
      terminals: [term(`${WS}/A`)],
      processes: [proc(1, `${WS}/A`, 8 * H), proc(2, `${WS}/新卡`, 60000)],
    });
    assert.equal(r.state, 'ok');
    assert.equal(r.sampled, 2, '宽限只挡报警，不该把它挤出采样面（否则会假装没查成）');
  });

  it('一个在卡里跑的程序都没采到 = 没查成，不是「没有孤儿」', async () => {
    const S = await LOAD;
    const r = S.classifyNoCardProcesses({ terminals: [term(`${WS}/A`)], processes: [proc(1, '/home/orca', 8 * H)] });
    assert.equal(r.state, 'unscanned');
    assert.match(r.detail, /没查成/);
  });

  it('终端清单 / 进程清单读不成 = 没查成', async () => {
    const S = await LOAD;
    assert.equal(S.classifyNoCardProcesses({ terminals: null, processes: [] }).state, 'unscanned');
    assert.equal(S.classifyNoCardProcesses({ terminals: [], processes: null }).state, 'unscanned');
  });

  it('终端一条都没有、进程一堆——这是最该报的形态，不许因为 known 为空就绿', async () => {
    const S = await LOAD;
    const r = S.classifyNoCardProcesses({ terminals: [], processes: [proc(1, `${WS}/A`, 8 * H)] });
    assert.equal(r.state, 'red');
  });
});

describe('工作目录 → 卡', () => {
  it('收敛到卡目录，认不出的返回空', async () => {
    const S = await LOAD;
    assert.equal(S.worktreeRootOf(`${WS}/PR-909-审官/a/b`).root, `${WS}/PR-909-审官`);
    assert.equal(S.worktreeRootOf(`${WS}/PR-909-审官`).card, 'PR-909-审官');
    assert.equal(S.worktreeRootOf('/srv/projects/windsurf-dao'), null);
    assert.equal(S.worktreeRootOf(WS), null, '仓这一层不是卡');
    assert.equal(S.worktreeRootOf(''), null);
  });
});

describe('进程表探头', () => {
  it('不是 Linux = 「不适用」，三个字都要分开：不是绿，也不冒充没查成', async () => {
    const S = await LOAD;
    const r = S.readProcessCensus({ platform: 'win32' });
    assert.equal(r.ok, false, '绝不许是绿');
    assert.equal(r.notApplicable, true, '这台机器没这一格，跟「该查却没查成」不是一回事');
    assert.equal(r.processes, null);
    assert.match(r.error, /不适用/);
  });

  it('该读却读不开 = 没查成，且必须与「不适用」分得开', async () => {
    const S = await LOAD;
    const r = S.readProcessCensus({ platform: 'linux', procRoot: '/definitely/not/here' });
    assert.equal(r.ok, false);
    assert.equal(r.notApplicable, false, '读不开是真出事，不许被当成「这台机器没这一格」');
    assert.match(r.error, /没查成/);
  });

  it('本机是 Linux 就必须真读到进程——不许 ok 却空手而归', async () => {
    const S = await LOAD;
    if (process.platform !== 'linux') return; // 非 Linux 由上一条覆盖
    const r = S.readProcessCensus();
    assert.equal(r.ok, true);
    assert.ok(r.processes.length > 0, '读得开 /proc 却一个进程都没有，判据已失效');
  });
});

describe('播报说人话（黑话拦在合并前，不是拦在群里）', () => {
  it('不到一小时不许写成「0 小时」——那看着像它根本没跑', async () => {
    const S = await LOAD;
    assert.equal(S.humanAge(30000), '不到 1 小时');
    assert.equal(S.humanAge(5 * H), '5 小时');
    assert.equal(S.humanAge(50 * H), '2 天');
    assert.match(S.noCardLine({ card: 'A', count: 1, ageMs: 0 }), /不到 1 小时/);
  });

  it('档位词前要有空格——「已经3 小时」是贴着的，服务器实跑里就是这么出来的', async () => {
    const S = await LOAD;
    assert.match(S.standingLine({ label: 'X', tierLabel: '3 小时' }), /卡了 3 小时以上/);
  });

  it('两类播报文案都不许出现路径 / 进程号 / 内部英文代号', async () => {
    const S = await LOAD;
    const P = await import(PLAIN);
    const texts = [
      S.noCardLine({ card: 'ISSUE-829-工人-grok-4.6-网关', count: 3, ageMs: 48 * H, cardDeleted: false }),
      S.noCardLine({ card: 'ISSUE-891-工人', count: 1, ageMs: 5 * H, cardDeleted: true }),
      S.standingLine({ label: '某工人会话', tierLabel: '一天' }),
    ];
    for (const t of texts) {
      assert.deepEqual(P.plainViolations(t), [], `这句话有黑话：${t}`);
    }
  });
});

// 2026-09-05 当天引入、当天咬：无卡孤儿那一格读的是**真 /proc**，于是同为 Linux，
// 自己的服务器上绿（进程都对得上卡）、GitHub runner 上红（对不上）——**机器状态漏进了单元夹具**。
// 修法是给一个显式关闭口。而一个**能被静默关掉的检查等于没有检查**，所以关掉这件事必须留痕。
describe('普查的关闭口不许静默', () => {
  const { readFileSync } = require('node:fs');
  const path2 = require('node:path');
  const CLI = readFileSync(path2.join(__dirname, '..', 'scripts', 'agent-stall-watch.mjs'), 'utf8');

  it('关掉时走的是 notApplicable，不是「查过没事」', () => {
    const m = CLI.match(/const censusOff = [\s\S]{0,400}?readProcessCensus\(\);/);
    assert.ok(m, '关闭口的形状变了，本闸判据已失效——请同步更新');
    assert.match(m[0], /notApplicable: true/, '关掉必须落 notApplicable（skipped），绝不能落 ok');
    assert.ok(!/ok: true/.test(m[0]), '关掉了还报 ok:true，就是把「没查」说成「没事」');
  });

  it('关闭原因要写进 detail，让人在输出里看得见是被关掉的', () => {
    const m = CLI.match(/const censusOff = [\s\S]{0,400}?readProcessCensus\(\);/);
    assert.match(m[0], /DAO_NOCARD_CENSUS/, 'detail 里要点名是哪个开关关的');
    assert.match(m[0], /不是「查过没事」|不是「没问题」/, '要明说它不等于绿');
  });

  it('只有夹具关它——正式路径上不许出现默认关闭', () => {
    assert.ok(!/DAO_NOCARD_CENSUS\s*\|\|\s*['"]off/.test(CLI),
      '默认值成了 off，等于这一格永远不跑');
  });
});
