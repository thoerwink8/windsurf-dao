// 任务卡 comment 定界区：加删只动区、写完回读、缺区报警（#495）

const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const LIB = path.join(REPO, 'scripts', 'lib', 'master-title.mjs');
const FIX = path.join(REPO, 'scripts', 'lib', 'orca-json-fixtures.mjs');
const DAO_CMD = path.join(REPO, 'scripts', 'lib', 'dao-cmd.mjs');

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? '  →  ' + detail : ''}`); }
}

async function main() {
  const T = await import('file://' + LIB.replace(/\\/g, '/'));
  const F = await import('file://' + FIX.replace(/\\/g, '/'));

  console.log('\n=== 定界区加删：不碰叙述其余部分 ===');
  {
    const base = 'merge-policy:manual · model:grok-4.6';
    const added = T.addTicket(base, '#499');
    check('无区 comment 追加定界区', added === 'merge-policy:manual · model:grok-4.6｜[#499]', added);
    const added2 = T.addTicket(added, 495);
    check('再加一个单号', added2 === 'merge-policy:manual · model:grok-4.6｜[#499 #495]', added2);
    const dup = T.addTicket(added2, '#499');
    check('重复加不复制', dup === added2, dup);
    const removed = T.removeTicket(added2, '#499');
    check('删一个，叙述完好', removed === 'merge-policy:manual · model:grok-4.6｜[#495]', removed);
    const cleared = T.removeTicket(removed, '#495');
    check('删光后区消失、叙述还在', cleared === base, cleared);

    const messy = '正在修#499的派工和 #495 遗留';
    check('叙述里的 #N 不是单号区', T.parseTicketZone(messy).hasZone === false);
    check('删叙述里的 #N 不动 comment', T.removeTicket(messy, '#499') === messy);
    const zoned = T.addTicket(messy, '#480');
    check('有叙述井号时只在末尾开新区', zoned === '正在修#499的派工和 #495 遗留｜[#480]', zoned);
    check('删区里的号不影响叙述井号', T.removeTicket(zoned, '#480') === messy);
  }

  console.log('\n=== 派工名抽单号 ===');
  {
    check('#499+#495 名抽出两个', T.ticketsFromName('#499+#495 - 修派工').join(',') === '#499,#495');
    check('没有井号就不猜数字', T.ticketsFromName('499-495-派工通道').length === 0);
  }

  console.log('\n=== 派工卡 comment 必须有定界区 ===');
  {
    const missing = T.auditDispatchComment({
      comment: 'merge-policy:manual · model:grok-4.6 · reviewer:gpt-5.6-sol',
      expectedTickets: ['#499'],
    });
    check('故意无区 → 报警', missing.ok === false && missing.unscanned === false && missing.reason && /缺单号定界区/.test(missing.reason), JSON.stringify(missing));

    const ok = T.auditDispatchComment({
      comment: 'merge-policy:manual · model:grok-4.6｜[#499 #495]',
      expectedTickets: ['#499', '#495'],
    });
    check('有区且含期望单号 → 不报', ok.ok === true && ok.unscanned === false, JSON.stringify(ok));

    const noSample = T.auditDispatchComment({ comment: 'x' });
    check('没给 expectedTickets = 没查成', noSample.unscanned === true && noSample.ok === false, JSON.stringify(noSample));

    const noneExpected = T.auditDispatchComment({ comment: '闲聊', expectedTickets: [] });
    check('没有期望单号 = 扫完 0 条（不是没查成）', noneExpected.ok === true && noneExpected.scanned === 0 && noneExpected.unscanned === false, JSON.stringify(noneExpected));
  }

  console.log('\n=== 写 comment：只动定界区 + 回读 ===');
  {
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
    check('派工成功会写任务卡 comment', r.ok === true && r.action === 'updated', JSON.stringify(r));
    check('定界区含两个单号、叙述还在', r.comment === 'merge-policy:manual · 人写的进度｜[#499 #495]', r.comment);
    check('set 打的是这张任务卡', sets.length === 1 && sets[0].includes('wt_task'), JSON.stringify(sets));
    check('写完回读用了 show', calls.filter(a => a[1] === 'show').length >= 2);

    const rm = T.applyRemoveTicket({
      id: '#499',
      worktreeId: 'wt_task',
      runOrca,
    });
    check('删除入口去掉该号、叙述还在', rm.ok && rm.comment === 'merge-policy:manual · 人写的进度｜[#495]', rm.comment);

    const lie = T.afterDispatchComment({
      name: '#499 - 修通道',
      worktreeId: 'wt_task',
      runOrca: (args) => {
        if (args[1] === 'show') return { ok: true, json: { result: { worktree: { comment: '人写的进度' } } } };
        if (args[1] === 'set') return { ok: true, json: { ok: true } };
        return { ok: false, error: 'nope' };
      },
    });
    check('set ok 但回读没变 → 投递成功≠送达', lie.ok === false && lie.action === 'warn' && /投递成功≠送达/.test(lie.reason), JSON.stringify(lie));
  }

  console.log('\n=== 没单号 / 没树 不瞎写 ===');
  {
    let setCalled = false;
    const skip = T.afterDispatchComment({
      name: '通道探针',
      worktreeId: 'wt_task',
      runOrca: (args) => {
        if (args[1] === 'set') setCalled = true;
        return { ok: true, json: {} };
      },
    });
    check('名里没有 #单号 → skip', skip.action === 'skip', JSON.stringify(skip));
    check('没单号不 set', setCalled === false);

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
    check('名里没单号但 --issue 有 → 写定界区（#565 漏记回归钉）',
      withIssue.ok === true && withIssue.action === 'updated' && withIssue.comment === '卡名：造 dao-project skill｜[#565]', JSON.stringify(withIssue));
    const withIssue2 = T.afterDispatchComment({
      name: '#499 名里有号',
      issue: '565',
      worktreeId: 'wt_task',
      runOrca: issueRunOrca,
    });
    check('名里和 --issue 都有号 → 定界区去重合写',
      withIssue2.ok === true && withIssue2.tickets.length === 2 && /#565/.test(withIssue2.comment), JSON.stringify(withIssue2));

    const noId = T.afterDispatchComment({ name: '#499 - x', runOrca: () => ({ ok: true }) });
    check('没 worktreeId → 报警不写', noId.ok === false && /worktreeId/.test(noId.reason), JSON.stringify(noId));
  }

  console.log('\n=== 真语料规矩：缺存档必须被拦 ===');
  {
    const live = F.checkOrcaJsonFixtures({
      daoCmdText: fs.readFileSync(DAO_CMD, 'utf8'),
      fixtureDir: path.join(REPO, 'tests', 'fixtures', 'orca-json'),
    });
    check('仓内 extract* 都有真语料', live.ok === true && live.unscanned === false && live.scanned.length > 0, JSON.stringify(live));

    const poisoned = F.checkOrcaJsonFixtures({
      daoCmdText: 'export function extractGhost(json) { return json; }\n',
      fixtureDir: path.join(REPO, 'tests', 'fixtures', 'orca-json'),
    });
    check('故意加 extractGhost 无语料 → 拦', poisoned.ok === false && poisoned.unscanned === false && poisoned.missing.some(m => /extractGhost/.test(m)), JSON.stringify(poisoned));

    const empty = F.checkOrcaJsonFixtures({ daoCmdText: 'export function foo() {}', fixtureDir: path.join(REPO, 'tests', 'fixtures', 'orca-json') });
    check('一个 extract* 都没有 → 没查成', empty.unscanned === true && empty.ok === false, JSON.stringify(empty));
  }

  console.log(`\n${fail === 0 ? 'OK' : 'FAIL'}  ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
