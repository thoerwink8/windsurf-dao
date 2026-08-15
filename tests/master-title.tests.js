// 主帅终端标题：定界区加删 + 身份判据 + 缺失 handle 策略（#495）

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

  console.log('\n=== 定界区加删：不碰标题其余部分 ===');
  {
    const base = '创建专注模式skill功能';
    const added = T.addTicket(base, '#499');
    check('无区标题追加定界区', added === '创建专注模式skill功能｜[#499]', added);
    const added2 = T.addTicket(added, 495);
    check('再加一个单号', added2 === '创建专注模式skill功能｜[#499 #495]', added2);
    const dup = T.addTicket(added2, '#499');
    check('重复加不复制', dup === added2, dup);
    const removed = T.removeTicket(added2, '#499');
    check('删一个，前缀完好', removed === '创建专注模式skill功能｜[#495]', removed);
    const cleared = T.removeTicket(removed, '#495');
    check('删光后区消失、前缀还在', cleared === base, cleared);

    const messy = '修#499的派工和 #495 遗留';
    check('前缀里的 #N 不是单号区', T.parseTicketZone(messy).hasZone === false);
    check('删前缀里的 #N 不动标题', T.removeTicket(messy, '#499') === messy);
    const zoned = T.addTicket(messy, '#480');
    check('有前缀井号时只在末尾开新区', zoned === '修#499的派工和 #495 遗留｜[#480]', zoned);
    check('删区里的号不影响前缀井号', T.removeTicket(zoned, '#480') === messy);
  }

  console.log('\n=== 派工名抽单号 ===');
  {
    check('#499+#495 名抽出两个', T.ticketsFromName('#499+#495 - 修派工').join(',') === '#499,#495');
    check('没有井号就不猜数字', T.ticketsFromName('499-495-派工通道').length === 0);
  }

  console.log('\n=== 兜底核对：过期报警 / 一致不报 / 没查成分开 ===');
  {
    const stale = T.auditTitleTickets({ title: '帅·B｜[#999 #495]', openIds: ['#495'] });
    check('标题有已关 #999 → 报警', stale.ok === false && stale.stale.includes('#999') && stale.unscanned === false, JSON.stringify(stale));
    const match = T.auditTitleTickets({ title: '帅·A｜[#499 #495]', openIds: ['#499', '#495'] });
    check('一致 → 不报警', match.ok === true && match.stale.length === 0 && match.unscanned === false, JSON.stringify(match));
    const emptyZone = T.auditTitleTickets({ title: '随便一句闲聊', openIds: ['#499'] });
    check('无单号区 = 扫完 0 条（不是没查成）', emptyZone.ok === true && emptyZone.scanned === 0 && emptyZone.unscanned === false, JSON.stringify(emptyZone));
    const noOpen = T.auditTitleTickets({ title: '帅·A｜[#499]' });
    check('没给 openIds = 没查成', noOpen.unscanned === true && noOpen.ok === false, JSON.stringify(noOpen));
  }

  console.log('\n=== 身份：正识别主工作树，不把不认识当主帅 ===');
  {
    const master = T.titleUpdatePolicy({
      env: { ORCA_TERMINAL_HANDLE: 'term_A' },
      worktree: { isMainWorktree: true },
    });
    check('主工作树+handle → 更新自己', master.action === 'update' && master.handle === 'term_A', JSON.stringify(master));

    const worker = T.titleUpdatePolicy({
      env: { ORCA_TERMINAL_HANDLE: 'term_worker' },
      worktree: { isMainWorktree: false },
    });
    check('工人树不改标题', worker.action === 'skip', JSON.stringify(worker));

    const reviewer = T.titleUpdatePolicy({
      env: { ORCA_TERMINAL_HANDLE: 'term_rev', CI: 'true' },
      worktree: { isMainWorktree: false },
    });
    check('审官树也不改', reviewer.action === 'skip', JSON.stringify(reviewer));

    const unknown = T.titleUpdatePolicy({
      env: { ORCA_TERMINAL_HANDLE: 'term_A' },
      worktree: null,
    });
    check('认不出是不是主树 → 报警不改（不是当成主帅）', unknown.action === 'warn', JSON.stringify(unknown));
  }

  console.log('\n=== ORCA_TERMINAL_HANDLE 缺失：CI 跳过 / 本机报警 ===');
  {
    const ci = T.titleUpdatePolicy({ env: { CI: 'true' }, worktree: { isMainWorktree: true } });
    check('CI 无 handle → skip', ci.action === 'skip', JSON.stringify(ci));
    const local = T.titleUpdatePolicy({ env: {}, worktree: { isMainWorktree: true } });
    check('本机无 handle → warn', local.action === 'warn', JSON.stringify(local));
  }

  console.log('\n=== 两位主帅：A 派单只改 A 的 handle ===');
  {
    const calls = [];
    const titles = { term_A: '帅·A', term_B: '帅·B' };
    const runOrca = (args) => {
      calls.push(args);
      if (args[0] === 'worktree' && args[1] === 'show') {
        return { ok: true, json: { result: { worktree: { isMainWorktree: true } } } };
      }
      if (args[0] === 'terminal' && args[1] === 'list') {
        return {
          ok: true,
          json: {
            result: {
              terminals: Object.entries(titles).map(([handle, title]) => ({ handle, title })),
            },
          },
        };
      }
      if (args[0] === 'terminal' && args[1] === 'rename') {
        const h = args[args.indexOf('--terminal') + 1];
        const title = args[args.indexOf('--title') + 1];
        titles[h] = title;
        return { ok: true, json: { ok: true } };
      }
      return { ok: false, error: `unexpected ${args.join(' ')}` };
    };
    const r = T.afterDispatchSuccess({
      name: '#499 - 修通道',
      env: { ORCA_TERMINAL_HANDLE: 'term_A', ORCA_WORKTREE_ID: 'wt_master' },
      runOrca,
    });
    const renames = calls.filter(a => a[1] === 'rename');
    check('派工成功会改标题（回读对得上才算）', r.ok === true && r.action === 'updated' && r.title === '帅·A｜[#499]', JSON.stringify(r));
    check('rename 只打 A 的 handle', renames.length === 1 && renames[0].includes('term_A'), JSON.stringify(renames));
    check('没有 rename 打到 B', renames.every(a => !a.includes('term_B')));

    const titles2 = { term_A: '帅·A｜[#499 #495]' };
    const rm = T.applyRemoveTicket({
      id: '#499',
      env: { ORCA_TERMINAL_HANDLE: 'term_A', ORCA_WORKTREE_ID: 'wt_master' },
      runOrca: (args) => {
        if (args[0] === 'worktree') return { ok: true, json: { result: { worktree: { isMainWorktree: true } } } };
        if (args[1] === 'list') {
          return { ok: true, json: { result: { terminals: [{ handle: 'term_A', title: titles2.term_A }] } } };
        }
        if (args[1] === 'rename') {
          titles2.term_A = args[args.indexOf('--title') + 1];
          return { ok: true, json: { ok: true } };
        }
        return { ok: false, error: 'nope' };
      },
    });
    check('删除入口去掉该号、其余还在', rm.ok && rm.title === '帅·A｜[#495]', JSON.stringify(rm));

    const lie = T.afterDispatchSuccess({
      name: '#499 - 修通道',
      env: { ORCA_TERMINAL_HANDLE: 'term_A', ORCA_WORKTREE_ID: 'wt_master' },
      runOrca: (args) => {
        if (args[1] === 'show') return { ok: true, json: { result: { worktree: { isMainWorktree: true } } } };
        if (args[1] === 'list') return { ok: true, json: { result: { terminals: [{ handle: 'term_A', title: '⠋ Grok' }] } } };
        if (args[1] === 'rename') return { ok: true, json: { result: { rename: { title: '帅·A｜[#499]' } } } };
        return { ok: false, error: 'nope' };
      },
    });
    check('rename ok 但回读仍是 agent 标题 → 投递成功≠送达', lie.ok === false && lie.action === 'warn' && /投递成功≠送达/.test(lie.reason), JSON.stringify(lie));
  }

  console.log('\n=== 工人树上 afterDispatch 不 rename ===');
  {
    let renamed = false;
    const r = T.afterDispatchSuccess({
      name: '#499 - 探针',
      env: { ORCA_TERMINAL_HANDLE: 'term_worker', ORCA_WORKTREE_ID: 'wt_child' },
      runOrca: (args) => {
        if (args[1] === 'show') return { ok: true, json: { result: { worktree: { isMainWorktree: false } } } };
        if (args[1] === 'rename') { renamed = true; return { ok: true, json: { ok: true } }; }
        return { ok: false, error: 'should not reach' };
      },
    });
    check('工人树 skip', r.action === 'skip', JSON.stringify(r));
    check('工人树没有 rename', renamed === false);
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
