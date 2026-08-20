// #673 看门狗报帅写 GitHub：假 gh。正样本发出；没 PR / 没凭据 / gh 失败分得开；
// 扫完 0 条 ≠ 没扫成。列表没扫成不得发评论。snapshot / dispose-actions off 不写。

const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const LIB = path.join(__dirname, '..', 'scripts', 'lib', 'watchdog-report.mjs');
const LIB_LOAD = import('file://' + LIB.replace(/\\/g, '/'));

function bao({ name = '#452 - 看门狗正式版', detail = '指纹「no serving account」连败（连续命中 5 轮）', ...rest } = {}) {
  return { name, type: '报帅', detail, ...rest };
}

describe('watchdog-report', () => {
  it('评论格式 / 事故键 / 目标', async (t) => {
    const G = await LIB_LOAD;
    const ev = bao({
      worktreeId: 'wt-1',
      fingerprint: 'no serving account',
      prNumber: 674,
    });
    const key = G.accidentKey(ev);
    await t.test('事故键 = 树|指纹', () => {
      assert.ok(key === 'wt-1|no serving account', '事故键 = 树|指纹  →  ' + key);
    });
    const body = G.formatWatchdogComment({
      name: ev.name, detail: ev.detail, at: 1_700_000_000_000, key, worktreeId: ev.worktreeId,
    });
    await t.test('正文以【看门狗】打头', () => {
      assert.ok(body.startsWith('【看门狗】'), '正文以【看门狗】打头  →  ' + body.slice(0, 40));
    });
    await t.test('带卡名、指纹/原因、时间、事故键', () => {
      assert.ok(/卡名：/.test(body) && /指纹\/原因：/.test(body) && /时间：/.test(body) && /事故键：wt-1\|no serving account/.test(body),
        '带卡名、指纹/原因、时间、事故键  →  ' + body);
    });
    await t.test('有 PR 号写 PR', () => {
      const r = G.resolveCommentTarget({ prNumber: 674, issueNumber: 673 });
      assert.ok(r.ok && r.kind === 'pr' && r.number === 674, '有 PR 号写 PR  →  ' + JSON.stringify(r));
    });
    await t.test('没 PR 写关联 issue', () => {
      const r = G.resolveCommentTarget({ issueNumber: 452 });
      assert.ok(r.ok && r.kind === 'issue' && r.number === 452, '没 PR 写关联 issue  →  ' + JSON.stringify(r));
    });
    await t.test('没 PR 也没 issue → 没目标', () => {
      const r = G.resolveCommentTarget({});
      assert.ok(!r.ok && /没有 PR/.test(r.error), '没 PR 也没 issue  →  ' + JSON.stringify(r));
    });
  });

  it('扫完 0 条 vs 没扫成', async (t) => {
    const G = await LIB_LOAD;
    const zero = G.parseAccidentKeysFromComments([]);
    await t.test('空数组是扫完 0 条', () => {
      assert.ok(zero.scanned === true && zero.count === 0 && zero.keys.length === 0, '空数组是扫完 0 条  →  ' + JSON.stringify(zero));
    });
    const missing = G.parseAccidentKeysFromComments(null);
    await t.test('null 是没扫成，不是 0', () => {
      assert.ok(missing.scanned === false && /没扫成/.test(missing.error), 'null 是没扫成  →  ' + JSON.stringify(missing));
    });
    const bad = G.parseAccidentKeysFromComments({ comments: [] });
    await t.test('对象不是数组 = 没扫成', () => {
      assert.ok(bad.scanned === false && /不是数组/.test(bad.error), '对象不是数组 = 没扫成  →  ' + JSON.stringify(bad));
    });
    const hit = G.parseAccidentKeysFromComments([
      { body: '【看门狗】\n事故键：wt-1|no serving account' },
    ]);
    await t.test('扫到已有事故键', () => {
      assert.ok(hit.scanned && hit.keys.includes('wt-1|no serving account') && hit.count === 1, '扫到已有事故键  →  ' + JSON.stringify(hit));
    });
    await t.test('runGh ok:false = 没扫成', () => {
      const s = G.scanCommentsOut({ ok: false, error: 'timeout' });
      assert.ok(s.scanned === false && /没扫成/.test(s.error), 'ok:false 没扫成  →  ' + JSON.stringify(s));
    });
    await t.test('输出空字符串 = 没扫成，不是 0', () => {
      const s = G.scanCommentsOut({ ok: true, out: '' });
      assert.ok(s.scanned === false && /输出空/.test(s.error), '空输出没扫成  →  ' + JSON.stringify(s));
    });
    await t.test('[] 是扫完 0', () => {
      const s = G.scanCommentsOut({ ok: true, out: '[]' });
      assert.ok(s.scanned === true && s.count === 0, '[] 扫完 0  →  ' + JSON.stringify(s));
    });
  });

  it('闸：snapshot / dispose-actions off 不写', async (t) => {
    const G = await LIB_LOAD;
    await t.test('snapshot 默认不写', () => {
      assert.ok(G.shouldWriteGithub({ snapshotDir: '/tmp/x', disposeActions: true }) === false, 'snapshot 默认不写');
    });
    await t.test('dispose-actions off 不写', () => {
      assert.ok(G.shouldWriteGithub({ disposeActions: false }) === false, 'dispose-actions off 不写');
    });
    await t.test('live + dispose on 写', () => {
      assert.ok(G.shouldWriteGithub({ disposeActions: true }) === true, 'live + dispose on 写');
    });
    const events = [bao({ prNumber: 1 })];
    const calls = [];
    G.reportWatchdogGithub({
      events,
      args: { snapshotDir: '/tmp/snap', disposeActions: true },
      state: {},
      loadCreds: () => ({ ok: true }),
      runGh: (a) => { calls.push(a); return { ok: true, out: '[]' }; },
    });
    await t.test('snapshot 路径 runGh 一次都不调', () => {
      assert.ok(calls.length === 0, 'snapshot 路径 runGh 一次都不调  →  ' + calls.length);
    });
  });

  it('正样本：有 PR 则 pr comment 发出', async (t) => {
    const G = await LIB_LOAD;
    const calls = [];
    const events = [bao({ worktreeId: 'wt-1', fingerprint: 'no serving account', prNumber: 674 })];
    const state = {};
    G.reportWatchdogGithub({
      events,
      args: { disposeActions: true },
      state,
      now: 1_700_000_000_000,
      loadCreds: () => ({ ok: true }),
      runGh: (a) => {
        calls.push(a);
        if (a[0] === 'api') return { ok: true, out: '[]' };
        return { ok: true, out: '{"id":1}' };
      },
    });
    const comment = calls.find(a => a[0] === 'pr' && a[1] === 'comment');
    await t.test('调用 pr comment 674', () => {
      assert.ok(comment && comment[2] === '674', '调用 pr comment 674  →  ' + JSON.stringify(calls));
    });
    await t.test('--body 含【看门狗】和事故键', () => {
      const body = comment[comment.indexOf('--body') + 1];
      assert.ok(body.startsWith('【看门狗】') && /事故键：wt-1\|no serving account/.test(body), '--body 形态  →  ' + body);
    });
    await t.test('事件记已写 GitHub 评论：PR #674', () => {
      assert.ok(events.some(e => e.type === '动作' && /已写 GitHub 评论：PR #674/.test(e.detail)),
        '已写  →  ' + JSON.stringify(events));
    });
  });

  it('没 PR 写关联 issue', async (t) => {
    const G = await LIB_LOAD;
    const calls = [];
    const events = [bao({ worktreeId: 'wt-2', fingerprint: 'capacity', issueNumber: 452 })];
    G.reportWatchdogGithub({
      events,
      args: { disposeActions: true },
      state: {},
      loadCreds: () => ({ ok: true }),
      runGh: (a) => {
        calls.push(a);
        if (a[0] === 'api') return { ok: true, out: '[]' };
        return { ok: true, out: '{}' };
      },
    });
    await t.test('调用 issue comment 452', () => {
      assert.ok(calls.some(a => a[0] === 'issue' && a[1] === 'comment' && a[2] === '452'),
        'issue comment 452  →  ' + JSON.stringify(calls));
    });
    await t.test('不调 pr comment', () => {
      assert.ok(!calls.some(a => a[0] === 'pr'), '不调 pr comment  →  ' + JSON.stringify(calls));
    });
  });

  it('负样本：没目标 / 没凭据 / gh 失败分得开', async (t) => {
    const G = await LIB_LOAD;

    const noTarget = [bao({})];
    const gh1 = [];
    G.reportWatchdogGithub({
      events: noTarget,
      args: { disposeActions: true },
      state: {},
      loadCreds: () => ({ ok: true }),
      runGh: (a) => { gh1.push(a); return { ok: true, out: '[]' }; },
    });
    await t.test('没 PR 没 issue → GitHub 没写成：没有 PR', () => {
      assert.ok(noTarget.some(e => /GitHub 没写成：没有 PR/.test(e.detail)),
        '没目标  →  ' + JSON.stringify(noTarget));
    });
    await t.test('没目标不调 gh', () => {
      assert.ok(gh1.length === 0, '没目标不调 gh  →  ' + gh1.length);
    });

    const noCred = [bao({ prNumber: 1 })];
    const gh2 = [];
    G.reportWatchdogGithub({
      events: noCred,
      args: { disposeActions: true },
      state: {},
      loadCreds: () => ({ ok: false, code: 'not_installed', error: '缺凭据: watchdog.pem（不是没配好，是这台机器没装——见 NEW-MACHINE）' }),
      runGh: (a) => { gh2.push(a); return { ok: true, out: '[]' }; },
    });
    await t.test('没凭据 → GitHub 没写成且含这台机器没装', () => {
      assert.ok(noCred.some(e => /GitHub 没写成：/.test(e.detail) && /这台机器没装/.test(e.detail)),
        '没凭据  →  ' + JSON.stringify(noCred));
    });
    await t.test('没凭据不调 gh', () => {
      assert.ok(gh2.length === 0, '没凭据不调 gh  →  ' + gh2.length);
    });
    await t.test('没凭据不说没有 PR', () => {
      assert.ok(!noCred.some(e => /没有 PR/.test(e.detail)), '没凭据不说没有 PR');
    });

    const ghFail = [bao({ prNumber: 9 })];
    G.reportWatchdogGithub({
      events: ghFail,
      args: { disposeActions: true },
      state: {},
      loadCreds: () => ({ ok: true }),
      runGh: (a) => {
        if (a[0] === 'api') return { ok: true, out: '[]' };
        return { ok: false, error: 'HTTP 502 from fake' };
      },
    });
    await t.test('gh 失败 → GitHub 没写成且带 gh 错误', () => {
      assert.ok(ghFail.some(e => /GitHub 没写成：HTTP 502/.test(e.detail)),
        'gh 失败  →  ' + JSON.stringify(ghFail));
    });
    await t.test('gh 失败不说没装、不说没有 PR', () => {
      assert.ok(!ghFail.some(e => /这台机器没装|没有 PR/.test(e.detail)),
        'gh 失败口径  →  ' + JSON.stringify(ghFail));
    });
  });

  it('去重：同一树+同一指纹已报过不再刷', async (t) => {
    const G = await LIB_LOAD;
    const calls = [];
    const events = [bao({ worktreeId: 'wt-1', fingerprint: 'no serving account', prNumber: 3 })];
    const state = {};
    const run = () => G.reportWatchdogGithub({
      events,
      args: { disposeActions: true },
      state,
      loadCreds: () => ({ ok: true }),
      runGh: (a) => {
        calls.push(a);
        if (a[0] === 'api') return { ok: true, out: '[]' };
        return { ok: true, out: '{}' };
      },
    });
    run();
    const firstComments = calls.filter(a => a[1] === 'comment').length;
    events.push(bao({ worktreeId: 'wt-1', fingerprint: 'no serving account', prNumber: 3 }));
    run();
    const secondComments = calls.filter(a => a[1] === 'comment').length;
    await t.test('第二次不再 pr comment', () => {
      assert.ok(firstComments === 1 && secondComments === 1, `comment 次数 ${firstComments}→${secondComments}`);
    });

    const listed = [];
    const ev2 = [bao({ worktreeId: 'wt-9', fingerprint: 'at capacity', prNumber: 8 })];
    G.reportWatchdogGithub({
      events: ev2,
      args: { disposeActions: true },
      state: {},
      loadCreds: () => ({ ok: true }),
      runGh: (a) => {
        listed.push(a);
        if (a[0] === 'api') {
          return { ok: true, out: JSON.stringify([{ body: '【看门狗】\n事故键：wt-9|at capacity' }]) };
        }
        return { ok: true, out: '{}' };
      },
    });
    await t.test('GitHub 上已有事故键 → 不写评论', () => {
      assert.ok(!listed.some(a => a[1] === 'comment'), '已有事故键不写  →  ' + JSON.stringify(listed));
    });
    await t.test('去重观察行含不再刷', () => {
      assert.ok(ev2.some(e => e.type === '观察' && /不再刷/.test(e.detail)), '不再刷  →  ' + JSON.stringify(ev2));
    });
  });

  it('列表没扫成：GitHub 没写成，不发评论', async (t) => {
    const G = await LIB_LOAD;

    function runCase(listReply) {
      const calls = [];
      const events = [bao({ worktreeId: 'wt-x', fingerprint: 'x', prNumber: 11 })];
      G.reportWatchdogGithub({
        events,
        args: { disposeActions: true },
        state: {},
        loadCreds: () => ({ ok: true }),
        runGh: (a) => {
          calls.push(a);
          if (a[0] === 'api') return listReply;
          return { ok: true, out: '{}' };
        },
      });
      return { calls, events };
    }

    const timeout = runCase({ ok: false, error: 'timeout' });
    await t.test('列表 ok:false 不发 pr comment', () => {
      assert.ok(!timeout.calls.some(a => a[1] === 'comment'), '列表失败不写  →  ' + JSON.stringify(timeout.calls));
    });
    await t.test('列表失败 → GitHub 没写成且含没扫成/没查成', () => {
      assert.ok(timeout.events.some(e => /GitHub 没写成：/.test(e.detail) && /没扫成|没查成/.test(e.detail)),
        '没扫成显形  →  ' + JSON.stringify(timeout.events));
    });
    await t.test('列表失败不说没装、不说没有 PR', () => {
      assert.ok(!timeout.events.some(e => /这台机器没装|没有 PR/.test(e.detail)),
        '口径  →  ' + JSON.stringify(timeout.events));
    });
    await t.test('读评论带 --paginate --slurp', () => {
      const api = timeout.calls.find(a => a[0] === 'api');
      assert.ok(api && api.includes('--paginate') && api.includes('--slurp'), '要 slurp  →  ' + JSON.stringify(api));
    });

    const obj = runCase({ ok: true, out: '{}' });
    await t.test('非数组 JSON 不发评论', () => {
      assert.ok(!obj.calls.some(a => a[1] === 'comment'), '非数组不写  →  ' + JSON.stringify(obj.calls));
    });
    await t.test('非数组 → GitHub 没写成：不是数组', () => {
      assert.ok(obj.events.some(e => /GitHub 没写成：/.test(e.detail) && /不是数组/.test(e.detail)),
        '非数组显形  →  ' + JSON.stringify(obj.events));
    });

    const concat = runCase({ ok: true, out: '[]\n[]' });
    await t.test('分页未 slurp 的 []\\n[] 是没扫成，不发评论', () => {
      assert.ok(!concat.calls.some(a => a[1] === 'comment'), 'concat 不写  →  ' + JSON.stringify(concat.calls));
    });
    await t.test('[]\\n[] → GitHub 没写成：不是 JSON', () => {
      assert.ok(concat.events.some(e => /GitHub 没写成：/.test(e.detail) && /不是 JSON/.test(e.detail)),
        'concat 显形  →  ' + JSON.stringify(concat.events));
    });
  });

  it('分页 slurp：展平后认事故键；空页是扫完 0', async (t) => {
    const G = await LIB_LOAD;

    const pages = G.flattenCommentPages([
      [],
      [{ body: '【看门狗】\n事故键：wt-9|at capacity' }],
    ]);
    await t.test('两页展平后 1 条', () => {
      assert.ok(pages.ok && pages.comments.length === 1, '展平  →  ' + JSON.stringify(pages));
    });
    const emptyPages = G.scanCommentsOut({ ok: true, out: '[[],[]]' });
    await t.test('slurp 空页是扫完 0，不是没扫成', () => {
      assert.ok(emptyPages.scanned === true && emptyPages.count === 0, '空页扫完 0  →  ' + JSON.stringify(emptyPages));
    });

    const listed = [];
    const evHit = [bao({ worktreeId: 'wt-9', fingerprint: 'at capacity', prNumber: 8 })];
    G.reportWatchdogGithub({
      events: evHit,
      args: { disposeActions: true },
      state: {},
      loadCreds: () => ({ ok: true }),
      runGh: (a) => {
        listed.push(a);
        if (a[0] === 'api') {
          return {
            ok: true,
            out: JSON.stringify([[], [{ body: '【看门狗】\n事故键：wt-9|at capacity' }]]),
          };
        }
        return { ok: true, out: '{}' };
      },
    });
    await t.test('事故键在第 2 页 → 不写评论', () => {
      assert.ok(!listed.some(a => a[1] === 'comment'), '第 2 页去重  →  ' + JSON.stringify(listed));
    });
    await t.test('第 2 页命中 → 观察不再刷', () => {
      assert.ok(evHit.some(e => e.type === '观察' && /不再刷/.test(e.detail)), '不再刷  →  ' + JSON.stringify(evHit));
    });

    const wrote = [];
    const evZero = [bao({ worktreeId: 'wt-z', fingerprint: 'z', prNumber: 12 })];
    G.reportWatchdogGithub({
      events: evZero,
      args: { disposeActions: true },
      state: {},
      loadCreds: () => ({ ok: true }),
      runGh: (a) => {
        wrote.push(a);
        if (a[0] === 'api') return { ok: true, out: '[[],[]]' };
        return { ok: true, out: '{}' };
      },
    });
    await t.test('slurp 空页（扫完 0）仍写评论', () => {
      assert.ok(wrote.some(a => a[0] === 'pr' && a[1] === 'comment'), '空页仍写  →  ' + JSON.stringify(wrote));
    });
  });
});
