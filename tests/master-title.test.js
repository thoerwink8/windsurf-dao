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

  it('#684 帅位定界区：事件点全量重写', async (t) => {
    const T = await T_LOAD;
    const repo = 'self';
    const other = 'other';
    const masterId = `${repo}::/master`;
    function board(cards) {
      const comments = Object.fromEntries(cards.map(c => {
        const id = c.worktreeId || c.id;
        return [id, c.comment || ''];
      }));
      const worktrees = () => cards.map(c => ({ ...c, comment: comments[c.worktreeId || c.id] }));
      const runOrca = (args) => {
        if (args[0] === 'worktree' && args[1] === 'ps') {
          return { ok: true, json: { result: { worktrees: worktrees() } } };
        }
        const id = args[args.indexOf('--worktree') + 1];
        if (args[1] === 'show') {
          return { ok: true, json: { result: { worktree: { comment: comments[id] || '' } } } };
        }
        if (args[1] === 'set') {
          comments[id] = args[args.indexOf('--comment') + 1];
          return { ok: true, json: { ok: true } };
        }
        return { ok: false, error: `unexpected ${args.join(' ')}` };
      };
      return { runOrca, worktrees, comments };
    }

    const afterAdd = board([
      { worktreeId: masterId, isMainWorktree: true, path: '/master', comment: '主会话：对话/派单/终审' },
      { worktreeId: `${repo}::/684`, isMainWorktree: false, linkedIssue: 684, comment: '进度｜[#684]' },
      { worktreeId: `${repo}::/495`, isMainWorktree: false, linkedPR: { number: 495 }, linkedIssue: { number: 490 } },
    ]);
    const added = T.syncMasterTicketZone({
      worktrees: afterAdd.worktrees(),
      selfRepo: repo,
      runOrca: afterAdd.runOrca,
    });
    await t.test('造新增：派一单 → master 定界区出现该号', () => {
      assert.ok(added.ok && added.action === 'updated' && added.comment === '主会话：对话/派单/终审｜[#490 #495 #684]',
        '造新增  →  ' + JSON.stringify(added));
    });

    const afterRm = board([
      { worktreeId: masterId, isMainWorktree: true, path: '/master', comment: '主会话：对话/派单/终审｜[#490 #495 #684]' },
      { worktreeId: `${repo}::/495`, isMainWorktree: false, linkedPR: { number: 495 }, linkedIssue: { number: 490 } },
    ]);
    const removed = T.syncMasterTicketZone({
      worktrees: afterRm.worktrees(),
      selfRepo: repo,
      runOrca: afterRm.runOrca,
    });
    await t.test('造删除：清卡 → 单号从定界区消失', () => {
      assert.ok(removed.ok && removed.comment === '主会话：对话/派单/终审｜[#490 #495]',
        '造删除  →  ' + JSON.stringify(removed));
    });

    const fake = board([
      { worktreeId: masterId, isMainWorktree: true, path: '/master', comment: '主会话｜[#999 #684]' },
      { worktreeId: `${repo}::/684`, isMainWorktree: false, linkedIssue: 684, comment: '｜[#684]' },
    ]);
    const converged = T.syncMasterTicketZone({
      worktrees: fake.worktrees(),
      selfRepo: repo,
      runOrca: fake.runOrca,
    });
    await t.test('造假号：手改塞 #999 → 下一次事件收敛', () => {
      assert.ok(converged.ok && converged.comment === '主会话｜[#684]' && !/#999/.test(converged.comment),
        '造假号  →  ' + JSON.stringify(converged));
    });

    const twoMarshals = board([
      { worktreeId: masterId, isMainWorktree: true, path: '/master', comment: '帅位' },
      { worktreeId: `${repo}::/a`, isMainWorktree: false, linkedIssue: 611, comment: '甲在做｜[#611]' },
      { worktreeId: `${repo}::/b`, isMainWorktree: false, linkedIssue: 622, comment: '乙在做｜[#622]' },
    ]);
    const all = T.syncMasterTicketZone({
      worktrees: twoMarshals.worktrees(),
      selfRepo: repo,
      runOrca: twoMarshals.runOrca,
    });
    await t.test('造多帅：无归属真相源 → 定界区写全体在途单', () => {
      assert.ok(all.ok && all.comment === '帅位｜[#611 #622]' && all.tickets.join(',') === '#611,#622',
        '造多帅  →  ' + JSON.stringify(all));
    });

    await t.test('卡名里的 #N 不算判据（#589）', () => {
      const named = T.ticketsFromWorktree({
        displayName: '#999 工人·x',
        comment: '叙述里也有 #888',
        linkedIssue: 684,
      });
      assert.ok(named.join(',') === '#684', '卡名井号不算  →  ' + named.join(','));
    });

    const otherRepo = board([
      { worktreeId: masterId, isMainWorktree: true, path: '/master', comment: '帅位｜[#684]' },
      { worktreeId: `${repo}::/684`, isMainWorktree: false, linkedIssue: 684 },
      { worktreeId: `${other}::/1`, isMainWorktree: false, linkedIssue: 1, comment: '｜[#1]' },
      { worktreeId: `${other}::/master`, isMainWorktree: true, path: '/other', comment: '外仓帅' },
    ]);
    const scoped = T.syncMasterTicketZone({
      worktrees: otherRepo.worktrees(),
      selfRepo: repo,
      runOrca: otherRepo.runOrca,
    });
    await t.test('外仓卡不进本仓定界区（#492）', () => {
      assert.ok(scoped.ok && scoped.comment === '帅位｜[#684]' && !/#1/.test(scoped.comment),
        '外仓  →  ' + JSON.stringify(scoped));
    });

    const psFail = T.worktreesFromPs(() => ({ ok: false, error: 'ECONNREFUSED' }));
    await t.test('ps 失败 = 没查成，不是在途 0', () => {
      assert.ok(psFail.ok === false && psFail.unscanned === true && /没查成|失败/.test(psFail.error),
        'ps 失败  →  ' + JSON.stringify(psFail));
    });

    let setCalled = false;
    const noWrite = T.syncMasterTicketZone({
      worktrees: null,
      runOrca: (args) => {
        if (args[1] === 'set') setCalled = true;
        return { ok: true, json: {} };
      },
    });
    await t.test('worktrees 不是数组 → 不写（没查成 ≠ 空盘）', () => {
      assert.ok(noWrite.ok === false && noWrite.unscanned === true && setCalled === false,
        '没查成不写  →  ' + JSON.stringify(noWrite));
    });

    const emptyBoard = board([
      { worktreeId: masterId, isMainWorktree: true, path: '/master', comment: '帅位｜[#684]' },
    ]);
    const cleared = T.syncMasterTicketZone({
      worktrees: emptyBoard.worktrees(),
      selfRepo: repo,
      runOrca: emptyBoard.runOrca,
    });
    await t.test('扫完 0 张在途卡 → 定界区消失、前缀还在', () => {
      assert.ok(cleared.ok && cleared.comment === '帅位' && cleared.scanned === 0,
        '扫完 0  →  ' + JSON.stringify(cleared));
    });

    const archived = T.collectInFlightTickets([
      { worktreeId: `${repo}::/m`, isMainWorktree: true },
      { worktreeId: `${repo}::/old`, isMainWorktree: false, isArchived: true, linkedIssue: 100 },
      { worktreeId: `${repo}::/live`, isMainWorktree: false, linkedIssue: 684 },
    ], repo);
    await t.test('归档卡不进在途集合', () => {
      assert.ok(archived.ok && archived.tickets.join(',') === '#684' && archived.scanned === 1,
        '归档  →  ' + JSON.stringify(archived));
    });

    const missingMaster = T.syncMasterTicketZone({
      worktrees: [{ worktreeId: `${repo}::/684`, isMainWorktree: false, linkedIssue: 684 }],
      selfRepo: repo,
      runOrca: () => { throw new Error('不该写'); },
    });
    const liveStale = board([
      {
        worktreeId: masterId,
        isMainWorktree: true,
        path: '/master',
        comment: '主会话：对话/派单/终审（两位主帅共用，各自在途单号见各自终端标题）',
      },
      { worktreeId: `${repo}::/684`, isMainWorktree: false, linkedIssue: 684, comment: '进度｜[#684]' },
    ]);
    const rewritten = T.syncMasterTicketZone({
      worktrees: liveStale.worktrees(),
      selfRepo: repo,
      runOrca: liveStale.runOrca,
    });
    await t.test('过期「见终端标题」前缀改成「见定界区」，定界区同时写上', () => {
      assert.ok(rewritten.ok && rewritten.comment === '主会话：对话/派单/终审（在途单号见定界区）｜[#684]',
        '前缀替换 + 定界区  →  ' + JSON.stringify(rewritten));
    });
    await t.test('替换后不再指向终端标题', () => {
      assert.ok(!/终端标题/.test(rewritten.comment) && /在途单号见定界区/.test(rewritten.comment),
        '不再指向终端标题  →  ' + rewritten.comment);
    });

    const alreadyNew = board([
      {
        worktreeId: masterId,
        isMainWorktree: true,
        path: '/master',
        comment: '主会话：对话/派单/终审（在途单号见定界区）｜[#999]',
      },
      { worktreeId: `${repo}::/684`, isMainWorktree: false, linkedIssue: 684 },
    ]);
    const kept = T.syncMasterTicketZone({
      worktrees: alreadyNew.worktrees(),
      selfRepo: repo,
      runOrca: alreadyNew.runOrca,
    });
    await t.test('已是「见定界区」的前缀保留，假号收敛', () => {
      assert.ok(kept.ok && kept.comment === '主会话：对话/派单/终审（在途单号见定界区）｜[#684]',
        '已替换前缀保留  →  ' + JSON.stringify(kept));
    });

    await t.test('rewriteMasterPrefix：无关前缀不动', () => {
      assert.ok(T.rewriteMasterPrefix('帅位') === '帅位', '无关前缀  →  ' + T.rewriteMasterPrefix('帅位'));
    });

    await t.test('找不到 master 卡 → 报警不写', () => {
      assert.ok(missingMaster.ok === false && /master/.test(missingMaster.reason),
        '无 master  →  ' + JSON.stringify(missingMaster));
    });
  });

  it('#684 余量：多仓盘面认本仓（repoId/repoName，pathHint 失配不再瞎）', async (t) => {
    const T = await T_LOAD;
    // 仿真实盘面：worktreeId = repoId(uuid)::path，卡带 repo 字段；master 卡与主树不同盘位。
    const SELF = '11111111-aaaa-4bbb-8ccc-000000000001';
    const OTHER = '22222222-bbbb-4ccc-8ddd-000000000002';
    const masterId = `${SELF}::D:/frank/windsurf-dao`;
    const missPath = 'C:/Users/Administrator/orca/workspaces/windsurf-dao'; // 主树根，盘上没有这张卡
    function board(cards) {
      const comments = Object.fromEntries(cards.map(c => {
        const id = c.worktreeId || c.id;
        return [id, c.comment || ''];
      }));
      const worktrees = () => cards.map(c => ({ ...c, comment: comments[c.worktreeId || c.id] }));
      const runOrca = (args) => {
        if (args[0] === 'worktree' && args[1] === 'ps') {
          return { ok: true, json: { result: { worktrees: worktrees() } } };
        }
        const id = args[args.indexOf('--worktree') + 1];
        if (args[1] === 'show') {
          return { ok: true, json: { result: { worktree: { comment: comments[id] || '' } } } };
        }
        if (args[1] === 'set') {
          comments[id] = args[args.indexOf('--comment') + 1];
          return { ok: true, json: { ok: true } };
        }
        return { ok: false, error: `unexpected ${args.join(' ')}` };
      };
      return { runOrca, worktrees, comments };
    }
    const multi = board([
      { worktreeId: masterId, isMainWorktree: true, repo: 'windsurf-dao', path: 'D:/frank/windsurf-dao', comment: '主会话：对话/派单/终审（在途单号见定界区）' },
      { worktreeId: `${SELF}::C:/Users/Administrator/orca/workspaces/windsurf-dao/ISSUE-684-工人`, isMainWorktree: false, repo: 'windsurf-dao', linkedIssue: 684, comment: '｜[#684]' },
      { worktreeId: `${OTHER}::C:/Users/Administrator/orca/exam-arena`, isMainWorktree: true, repo: 'exam-arena', path: 'C:/Users/Administrator/orca/exam-arena', comment: '外仓帅' },
      { worktreeId: `${OTHER}::C:/Users/Administrator/orca/exam-arena/ISSUE-1`, isMainWorktree: false, repo: 'exam-arena', linkedIssue: 1, comment: '｜[#1]' },
    ]);
    const byRepoId = T.syncMasterTicketZone({
      worktrees: multi.worktrees(),
      repoId: SELF,
      pathHint: missPath,
      runOrca: multi.runOrca,
    });
    await t.test('pathHint 失配 + repoId 显式 → 认本仓、外仓不进（#492）', () => {
      assert.ok(byRepoId.ok && byRepoId.comment === '主会话：对话/派单/终审（在途单号见定界区）｜[#684]' && !/#1/.test(byRepoId.comment),
        'repoId 认本仓  →  ' + JSON.stringify(byRepoId));
    });
    const byRepoName = T.syncMasterTicketZone({
      worktrees: multi.worktrees(),
      repoName: 'windsurf-dao',
      pathHint: missPath,
      runOrca: multi.runOrca,
    });
    await t.test('mirror 场景：无 repoId、repoName 认本仓（git remote 兜底）', () => {
      assert.ok(byRepoName.ok && byRepoName.comment === '主会话：对话/派单/终审（在途单号见定界区）｜[#684]' && !/#1/.test(byRepoName.comment),
        'repoName 认本仓  →  ' + JSON.stringify(byRepoName));
    });
    const noHint = T.syncMasterTicketZone({
      worktrees: multi.worktrees(),
      pathHint: missPath,
      runOrca: multi.runOrca,
    });
    await t.test('三个手段都没有 + 多仓 → 仍报警不写（没查成 ≠ 空盘）', () => {
      assert.ok(noHint.ok === false && noHint.unscanned === true && /分不出本仓/.test(noHint.reason),
        '多仓无手段  →  ' + JSON.stringify(noHint));
    });
    const twin = board([
      { worktreeId: `${SELF}::D:/frank/windsurf-dao`, isMainWorktree: true, repo: 'windsurf-dao' },
      { worktreeId: `${OTHER}::C:/clone/windsurf-dao`, isMainWorktree: true, repo: 'windsurf-dao' },
    ]);
    await t.test('同名两仓（不同 repoId）→ 不猜，返回 null', () => {
      assert.ok(T.inferSelfRepo(twin.worktrees(), { repoName: 'windsurf-dao' }) === null,
        '同名歧义不猜  →  ' + T.inferSelfRepo(twin.worktrees(), { repoName: 'windsurf-dao' }));
    });
    const single = board([
      { worktreeId: masterId, isMainWorktree: true, repo: 'windsurf-dao', path: 'D:/frank/windsurf-dao', comment: '帅位' },
      { worktreeId: `${SELF}::/684`, isMainWorktree: false, repo: 'windsurf-dao', linkedIssue: 684 },
    ]);
    const singleOk = T.syncMasterTicketZone({
      worktrees: single.worktrees(),
      pathHint: missPath,
      runOrca: single.runOrca,
    });
    await t.test('单仓 + pathHint 失配 → 单仓兜底照旧（不回归）', () => {
      assert.ok(singleOk.ok && singleOk.comment === '帅位｜[#684]',
        '单仓兜底  →  ' + JSON.stringify(singleOk));
    });
    await t.test('repoId 优先于 pathHint（pathHint 若误配也不覆盖）', () => {
      const got = T.inferSelfRepo(multi.worktrees(), { repoId: SELF, pathHint: 'C:/Users/Administrator/orca/exam-arena' });
      assert.ok(got === SELF, 'repoId 优先  →  ' + got);
    });
  });
});