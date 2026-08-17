// 任务卡 comment 定界区：加删只动区、写完回读、缺区报警（#495）

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const LIB = path.join(REPO, 'scripts', 'lib', 'master-title.mjs');
const FIX = path.join(REPO, 'scripts', 'lib', 'orca-json-fixtures.mjs');
const DAO_CMD = path.join(REPO, 'scripts', 'lib', 'dao-cmd.mjs');
const T_LOAD = import('file://' + LIB.replace(/\\/g, '/'));
const F_LOAD = import('file://' + FIX.replace(/\\/g, '/'));

describe('master-title', () => {
  it('定界区加删：不碰叙述其余部分', async (t) => {
    const T = await T_LOAD;
    const base = 'merge-policy:manual · model:grok-4.6';
    const added = T.addTicket(base, '#499');
    await t.test('无区 comment 追加定界区', () => {
      assert.ok(added === 'merge-policy:manual · model:grok-4.6｜[#499]', '无区 comment 追加定界区  →  ' + added);
    });
    const added2 = T.addTicket(added, 495);
    await t.test('再加一个单号', () => {
      assert.ok(added2 === 'merge-policy:manual · model:grok-4.6｜[#499 #495]', '再加一个单号  →  ' + added2);
    });
    const dup = T.addTicket(added2, '#499');
    await t.test('重复加不复制', () => {
      assert.ok(dup === added2, '重复加不复制  →  ' + dup);
    });
    const removed = T.removeTicket(added2, '#499');
    await t.test('删一个，叙述完好', () => {
      assert.ok(removed === 'merge-policy:manual · model:grok-4.6｜[#495]', '删一个，叙述完好  →  ' + removed);
    });
    const cleared = T.removeTicket(removed, '#495');
    await t.test('删光后区消失、叙述还在', () => {
      assert.ok(cleared === base, '删光后区消失、叙述还在  →  ' + cleared);
    });

    const messy = '正在修#499的派工和 #495 遗留';
    await t.test('叙述里的 #N 不是单号区', () => {
      assert.ok(T.parseTicketZone(messy).hasZone === false, '叙述里的 #N 不是单号区');
    });
    await t.test('删叙述里的 #N 不动 comment', () => {
      assert.ok(T.removeTicket(messy, '#499') === messy, '删叙述里的 #N 不动 comment');
    });
    const zoned = T.addTicket(messy, '#480');
    await t.test('有叙述井号时只在末尾开新区', () => {
      assert.ok(zoned === '正在修#499的派工和 #495 遗留｜[#480]', '有叙述井号时只在末尾开新区  →  ' + zoned);
    });
    await t.test('删区里的号不影响叙述井号', () => {
      assert.ok(T.removeTicket(zoned, '#480') === messy, '删区里的号不影响叙述井号');
    });
  });

  it('派工名抽单号', async (t) => {
    const T = await T_LOAD;
    await t.test('#499+#495 名抽出两个', () => {
      assert.ok(T.ticketsFromName('#499+#495 - 修派工').join(',') === '#499,#495', '#499+#495 名抽出两个');
    });
    await t.test('没有井号就不猜数字', () => {
      assert.ok(T.ticketsFromName('499-495-派工通道').length === 0, '没有井号就不猜数字');
    });
  });

  it('派工卡 comment 必须有定界区', async (t) => {
    const T = await T_LOAD;
    const missing = T.auditDispatchComment({
      comment: 'merge-policy:manual · model:grok-4.6 · reviewer:gpt-5.6-sol',
      expectedTickets: ['#499'],
    });
    await t.test('故意无区 → 报警', () => {
      assert.ok(missing.ok === false && missing.unscanned === false && missing.reason && /缺单号定界区/.test(missing.reason), '故意无区 → 报警  →  ' + JSON.stringify(missing));
    });

    const ok = T.auditDispatchComment({
      comment: 'merge-policy:manual · model:grok-4.6｜[#499 #495]',
      expectedTickets: ['#499', '#495'],
    });
    await t.test('有区且含期望单号 → 不报', () => {
      assert.ok(ok.ok === true && ok.unscanned === false, '有区且含期望单号 → 不报  →  ' + JSON.stringify(ok));
    });

    const noSample = T.auditDispatchComment({ comment: 'x' });
    await t.test('没给 expectedTickets = 没查成', () => {
      assert.ok(noSample.unscanned === true && noSample.ok === false, '没给 expectedTickets = 没查成  →  ' + JSON.stringify(noSample));
    });

    const noneExpected = T.auditDispatchComment({ comment: '闲聊', expectedTickets: [] });
    await t.test('没有期望单号 = 扫完 0 条（不是没查成）', () => {
      assert.ok(noneExpected.ok === true && noneExpected.scanned === 0 && noneExpected.unscanned === false, '没有期望单号 = 扫完 0 条（不是没查成）  →  ' + JSON.stringify(noneExpected));
    });
  });

  it('写 comment：只动定界区 + 回读', async (t) => {
    const T = await T_LOAD;
    const calls = [];
    let comment = 'merge-policy:manual · 人写的进度';
    const runOrca = (args) => {
      calls.push(args.slice());
      if (args[1] === 'show') {
        return { ok: true, json: { result: { worktree: { comment } } } };
      }
      if (args[1] === 'set') {
        comment = args[args.indexOf('--comment') + 1];
        return { ok: true, json: { ok: true } };
      }
      return { ok: false, error: `unexpected ${args.join(' ')}` };
    };
    const r = T.afterDispatchComment({
      name: '#499+#495 - 修通道',
      worktreeId: 'wt_task',
      runOrca,
    });
    const sets = calls.filter(a => a[1] === 'set');
    await t.test('派工成功会写任务卡 comment', () => {
      assert.ok(r.ok === true && r.action === 'updated', '派工成功会写任务卡 comment  →  ' + JSON.stringify(r));
    });
    await t.test('定界区含两个单号、叙述还在', () => {
      assert.ok(r.comment === 'merge-policy:manual · 人写的进度｜[#499 #495]', '定界区含两个单号、叙述还在  →  ' + r.comment);
    });
    await t.test('set 打的是这张任务卡', () => {
      assert.ok(sets.length === 1 && sets[0].includes('wt_task'), 'set 打的是这张任务卡  →  ' + JSON.stringify(sets));
    });
    await t.test('写完回读用了 show', () => {
      assert.ok(calls.filter(a => a[1] === 'show').length >= 2, '写完回读用了 show');
    });

    const rm = T.applyRemoveTicket({
      id: '#499',
      worktreeId: 'wt_task',
      runOrca,
    });
    await t.test('删除入口去掉该号、叙述还在', () => {
      assert.ok(rm.ok && rm.comment === 'merge-policy:manual · 人写的进度｜[#495]', '删除入口去掉该号、叙述还在  →  ' + rm.comment);
    });

    const lie = T.afterDispatchComment({
      name: '#499 - 修通道',
      worktreeId: 'wt_task',
      runOrca: (args) => {
        if (args[1] === 'show') return { ok: true, json: { result: { worktree: { comment: '人写的进度' } } } };
        if (args[1] === 'set') return { ok: true, json: { ok: true } };
        return { ok: false, error: 'nope' };
      },
    });
    await t.test('set ok 但回读没变 → 投递成功≠送达', () => {
      assert.ok(lie.ok === false && lie.action === 'warn' && /投递成功≠送达/.test(lie.reason), 'set ok 但回读没变 → 投递成功≠送达  →  ' + JSON.stringify(lie));
    });
  });

  it('没单号 / 没树 不瞎写', async (t) => {
    const T = await T_LOAD;
    let setCalled = false;
    const skip = T.afterDispatchComment({
      name: '通道探针',
      worktreeId: 'wt_task',
      runOrca: (args) => {
        if (args[1] === 'set') setCalled = true;
        return { ok: true, json: {} };
      },
    });
    await t.test('名里没有 #单号 → skip', () => {
      assert.ok(skip.action === 'skip', '名里没有 #单号 → skip  →  ' + JSON.stringify(skip));
    });
    await t.test('没单号不 set', () => {
      assert.ok(setCalled === false, '没单号不 set');
    });

    // #564 顺带修：派工名里没有 #单号、但 --issue 带了单号 → 也要写定界区（#565 实测漏记）。
    let issueComment = '卡名：造 dao-project skill'
    const issueRunOrca = (args) => {
      if (args[1] === 'show') return { ok: true, json: { result: { worktree: { comment: issueComment } } } };
      if (args[1] === 'set') {
        issueComment = args[args.indexOf('--comment') + 1];
        return { ok: true, json: { ok: true } };
      }
      return { ok: false, error: 'nope' };
    };
    const withIssue = T.afterDispatchComment({
      name: '造 dao-project skill 与消歧门门控',
      issue: '565',
      worktreeId: 'wt_task',
      runOrca: issueRunOrca,
    });
    await t.test('名里没单号但 --issue 有 → 写定界区（#565 漏记回归钉）',
      () => {
        assert.ok(withIssue.ok === true && withIssue.action === 'updated' && withIssue.comment === '卡名：造 dao-project skill｜[#565]', '名里没单号但 --issue 有 → 写定界区（#565 漏记回归钉）  →  ' + JSON.stringify(withIssue));
      });
    const withIssue2 = T.afterDispatchComment({
      name: '#499 名里有号',
      issue: '565',
      worktreeId: 'wt_task',
      runOrca: issueRunOrca,
    });
    await t.test('名里和 --issue 都有号 → 定界区去重合写',
      () => {
        assert.ok(withIssue2.ok === true && withIssue2.tickets.length === 2 && /#565/.test(withIssue2.comment), '名里和 --issue 都有号 → 定界区去重合写  →  ' + JSON.stringify(withIssue2));
      });

    const noId = T.afterDispatchComment({ name: '#499 - x', runOrca: () => ({ ok: true }) });
    await t.test('没 worktreeId → 报警不写', () => {
      assert.ok(noId.ok === false && /worktreeId/.test(noId.reason), '没 worktreeId → 报警不写  →  ' + JSON.stringify(noId));
    });
  });

  it('真语料规矩：缺存档必须被拦', async (t) => {
    const F = await F_LOAD;
    const live = F.checkOrcaJsonFixtures({
      daoCmdText: fs.readFileSync(DAO_CMD, 'utf8'),
      fixtureDir: path.join(REPO, 'tests', 'fixtures', 'orca-json'),
    });
    await t.test('仓内 extract* 都有真语料', () => {
      assert.ok(live.ok === true && live.unscanned === false && live.scanned.length > 0, '仓内 extract* 都有真语料  →  ' + JSON.stringify(live));
    });

    const poisoned = F.checkOrcaJsonFixtures({
      daoCmdText: 'export function extractGhost(json) { return json; }\n',
      fixtureDir: path.join(REPO, 'tests', 'fixtures', 'orca-json'),
    });
    await t.test('故意加 extractGhost 无语料 → 拦', () => {
      assert.ok(poisoned.ok === false && poisoned.unscanned === false && poisoned.missing.some(m => /extractGhost/.test(m)), '故意加 extractGhost 无语料 → 拦  →  ' + JSON.stringify(poisoned));
    });

    const empty = F.checkOrcaJsonFixtures({ daoCmdText: 'export function foo() {}', fixtureDir: path.join(REPO, 'tests', 'fixtures', 'orca-json') });
    await t.test('一个 extract* 都没有 → 没查成', () => {
      assert.ok(empty.unscanned === true && empty.ok === false, '一个 extract* 都没有 → 没查成  →  ' + JSON.stringify(empty));
    });
  });
});