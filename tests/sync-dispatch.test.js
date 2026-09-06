// tests/sync-dispatch.test.js —— 同步脊派工成了，别判成「没查成」
//
// 实咬（2026-09-06 一晚上，用户在 GitHub 上看到一屏）：
//   #1069 #1072 #1073 #1078 #1081 #1083 #1084 #1087 …
//   全是 `[待拍板] dispatch-unscanned` / `rework-unscanned`，而那些派工**其实都成了**。
//
// 真因：两条派工脊的出口形状不一样，回读逻辑只认得已退役的那条。
//   orca（异步）  {queued:true, async:true, resultPath:'…out.json'}
//   mirasim（同步）{ok:true, executor:'mirasim', sessionKey:'pi:uuid', card:'…'}
// mirasim 没有 resultPath ⇒ 判「拿不到 resultPath」⇒ 报帅开单。会话其实已经在跑。
//
// 语料取自 scripts/dao.mjs 里 cmdDispatchMirasim 那个 emit 的真实字段，不是编的。

const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const CMD = import('file://' + path.join(__dirname, '..', 'scripts', 'commander.mjs').replace(/\\/g, '/'));

// cmdDispatchMirasim 的真实出口（字段照抄）
const MIRASIM_OUT = JSON.stringify({
  ok: true,
  executor: 'mirasim',
  card: 'ISSUE-982 工人 grok-4.6',
  issue: 982,
  repo: '/srv/projects/windsurf-dao',
  branch: 'dao-982',
  path: '/home/orca/mirasim-worktrees/windsurf-dao/dao-982',
  sessionKey: 'pi:8f2c1a44-3b7e-4d19-9a05-6c2e8b1d7f30',
  taskId: 'task-1',
  agent: 'pi',
  daoModel: 'grok-4.6',
  mergePolicy: 'auto',
});

// orca 那条脊的真实出口
const ORCA_OUT = JSON.stringify({
  ok: true, queued: true, async: true,
  orderId: 'ord-1',
  orderPath: '/srv/projects/windsurf-dao/_flow/queue/ord-1.json',
  resultPath: '/srv/projects/windsurf-dao/_flow/queue/ord-1.out.json',
});

describe('同步脊：会话号就是成功证据', () => {
  it('mirasim 出口判成「同步成了」', async () => {
    const { judgeSyncDispatch } = await CMD;
    const got = judgeSyncDispatch(MIRASIM_OUT);
    assert.equal(got.sync, true);
    assert.equal(got.sessionKey, 'pi:8f2c1a44-3b7e-4d19-9a05-6c2e8b1d7f30');
    assert.equal(got.issue, 982);
    assert.equal(got.card, 'ISSUE-982 工人 grok-4.6');
  });

  it('前面有日志噪音也认得出（真跑时 stdout 不只有 JSON）', async () => {
    const { judgeSyncDispatch } = await CMD;
    const 脏 = `[dao] 建树 dao-982\n[dao] 起会话…\n${MIRASIM_OUT}`;
    assert.equal(judgeSyncDispatch(脏)?.sync, true);
  });

  // 异步脊必须继续走回读，不能被同步判据抢走——否则「受理了」会被当成「成了」，
  // 那是 #787 的老伤（群里收到喜报而派工其实失败）。
  it('异步脊（有 resultPath）不走同步路', async () => {
    const { judgeSyncDispatch } = await CMD;
    assert.equal(judgeSyncDispatch(ORCA_OUT), null);
  });
});

describe('判据要严：没有正面证据仍判没查成', () => {
  it('只有 ok:true、没有 sessionKey → 不算同步成了', async () => {
    const { judgeSyncDispatch } = await CMD;
    assert.equal(judgeSyncDispatch('{"ok":true,"executor":"mirasim"}'), null);
  });

  it('sessionKey 是空串 / 不是字符串 → 不算', async () => {
    const { judgeSyncDispatch } = await CMD;
    assert.equal(judgeSyncDispatch('{"ok":true,"sessionKey":"  "}'), null);
    assert.equal(judgeSyncDispatch('{"ok":true,"sessionKey":123}'), null);
  });

  it('ok:false 一律不算（拒派/租约背压都在这条路上）', async () => {
    const { judgeSyncDispatch } = await CMD;
    assert.equal(judgeSyncDispatch('{"ok":false,"sessionKey":"pi:x","error":"租约被占"}'), null);
  });

  it('不是 JSON / 空输出 → 不算，交给原来的没查成分支', async () => {
    const { judgeSyncDispatch } = await CMD;
    assert.equal(judgeSyncDispatch('执行体崩了'), null);
    assert.equal(judgeSyncDispatch(''), null);
    assert.equal(judgeSyncDispatch(null), null);
  });
});

// 判据钉在 dao.mjs 真出口的字段名上。夹具是我照抄的，抄错或将来它改名，
// 本条当场红——否则「测试全绿而线上照旧开假单」，一模一样地再来一遍。
describe('夹具与 dao.mjs 的真出口对得上', () => {
  const fs = require('node:fs');
  const DAO = path.join(__dirname, '..', 'scripts', 'dao.mjs');

  it('cmdDispatchMirasim 的 emit 里确实有 ok / sessionKey / card，且没有 resultPath', () => {
    const src = fs.readFileSync(DAO, 'utf8');
    const a = src.indexOf('async function cmdDispatchMirasim');
    const b = src.indexOf('async function cmdDispatch(args)', a);
    assert.notEqual(a, -1, 'cmdDispatchMirasim 锚点找不到了——切片没取成，不是通过');
    assert.ok(b > a, '切片区间不对');
    const fn = src.slice(a, b);
    assert.match(fn, /ok: true, executor: 'mirasim'/, '同步脊的成功出口形状变了');
    assert.match(fn, /sessionKey: sess\.sessionKey/, '同步脊不再输出 sessionKey，成功判据就没了正面证据');
    assert.equal(/resultPath/.test(fn), false, 'mirasim 脊若开始输出 resultPath，本修法要重审');
  });
});

describe('接到回读那条路上：不再开假单', () => {
  it('runActions 拿到同步成功 → 不 escalate，且照发喜报', async () => {
    const { runActions } = await CMD;
    const 发出的 = [];
    runActions(
      [{ kind: 'dispatch', issue: 982, why: '测试' }, { kind: 'notify-hub', issue: 982, moment: 'dispatched' }],
      { exec: (a) => { 发出的.push(a); return { ok: true, card: 'ISSUE-982 工人', issue: 982, sync: true }; } },
    );
    assert.equal(发出的.some((a) => a.kind === 'escalate'), false, '成了就不该报帅');
    assert.equal(发出的.some((a) => a.kind === 'notify-hub'), true, '成了就该发喜报');
  });

  // 反向钉死：真的拿不到任何证据时，仍要开单——别把这条修法变成「一律当成功」。
  it('输出里既没有 resultPath 也没有 sessionKey → 仍判没查成', async () => {
    const { judgeSyncDispatch, resultPathOf } = await CMD;
    const 空 = '{"ok":true,"executor":"mirasim","note":"没有会话号"}';
    assert.equal(judgeSyncDispatch(空), null);
    assert.equal(resultPathOf(空), null);
  });
});
