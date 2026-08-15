// 信箱台幂等脚本 · 纯函数回归（不碰 live orca）
//
// 验的层：①参数/选型 ②终端+中继活着判据 ③ensure 三岔（秒退/夺回/重建）
// ④收信分流（heartbeat 不落盘、业务信落盘）⑤check JSON 多形态解析
// ⑥重建命令串（run-use 由 relay 进程自己做，--command 不走 stdin）
// 判别力：任何把 heartbeat 写进日志、或 all-alive 误判成 rebuild 的改动，必有一条变红。

const path = require('path');

const SCRIPT = path.resolve(__dirname, '..', 'scripts', 'inbox-station.mjs');

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? "  →  " + detail : ""}`); }
}

async function main() {
  const S = await import('file://' + SCRIPT.replace(/\\/g, '/'));

  console.log('\n=== ① 参数 / 选型 ===');
  {
    const a = S.parseArgs(['node', 'inbox-station.mjs']);
    check('默认命令 ensure', a.cmd === 'ensure');
    check('默认 timeout 15s', a.timeoutMs === 15000);
    const b = S.parseArgs(['node', 'x', 'relay', '--run', 'run_abc', '--log', 'x.log', '--timeout-ms', '5000']);
    check('relay + run/log', b.cmd === 'relay' && b.run === 'run_abc' && b.log === 'x.log' && b.timeoutMs === 5000);
    let threw = false;
    try { S.parseArgs(['node', 'x', 'explode']); } catch { threw = true; }
    check('未知命令抛错', threw);
    let threw2 = false;
    try { S.parseArgs(['node', 'x', 'ensure', '--nope']); } catch { threw2 = true; }
    check('未知参数抛错', threw2);
  }

  {
    const runs = [
      { id: 'run_legacy_local', legacy: 1, updated_at: '2026-08-20T00:00:00Z' },
      { id: 'run_old', legacy: 0, updated_at: '2026-08-14T00:00:00Z' },
      { id: 'run_new', legacy: 0, updated_at: '2026-08-15T06:00:00Z' },
    ];
    check('pickRun 跳过 legacy 取最新', S.pickRun(runs).id === 'run_new');
    check('pickRun --run 优先', S.pickRun(runs, { preferredId: 'run_old' }).id === 'run_old');
    check('pickRun current 次之', S.pickRun(runs, { currentId: 'run_old' }).id === 'run_old');
    check('pickRun 空列表空', S.pickRun([]) === null);
  }

  console.log('\n=== ② 终端 + 中继活着 ===');
  {
    const titled = { handle: 'term_a', title: '◑ 信箱台（勿关）', connected: true, preview: 'PS>' };
    check('标题带前缀也能认出', S.findInboxTerminal([titled])?.handle === 'term_a');
    check('没有信箱台 → null', S.findInboxTerminal([{ title: 'Grok', handle: 'term_x' }]) === null);
    check('非数组 → null', S.findInboxTerminal(null) === null);

    check('未连 = 死', S.isRelayAlive({ ...titled, connected: false }) === false);
    check('孤儿 = 死', S.isRelayAlive({ ...titled, connected: true, orphaned: true }) === false);
    check('有 READY 标记 = 活', S.isRelayAlive({
      handle: 'term_a', title: S.TITLE, connected: true, preview: `${S.READY_MARK} run=x`,
    }) === true);
    check('preview 含脚本名 = 活', S.isRelayAlive({
      handle: 'term_a', title: S.TITLE, connected: true, preview: 'node scripts/inbox-station.mjs relay',
    }) === true);
    check('只有标题没有中继痕迹 = 死', S.isRelayAlive(titled) === false);
  }

  console.log('\n=== ③ ensure 三岔 ===');
  {
    const term = { handle: 'term_box', title: S.TITLE, connected: true, preview: S.READY_MARK };
    check('全活着 → ok', S.decideEnsureAction({
      terminal: term, relayAlive: true, coordinatorHandle: 'term_box',
    }).action === 'ok');
    check('全活着 reason=all-alive', S.decideEnsureAction({
      terminal: term, relayAlive: true, coordinatorHandle: 'term_box',
    }).reason === 'all-alive');
    check('被夺走 → rebuild（必须在信箱台 PTY 里 run-use）', S.decideEnsureAction({
      terminal: term, relayAlive: true, coordinatorHandle: 'term_thief',
    }).action === 'rebuild');
    check('coordinator 空 → coordinator-stolen', S.decideEnsureAction({
      terminal: term, relayAlive: true, coordinatorHandle: null,
    }).reason === 'coordinator-stolen');
    check('没终端 → rebuild', S.decideEnsureAction({
      terminal: null, relayAlive: false, coordinatorHandle: 'term_x',
    }).reason === 'no-terminal');
    check('中继死 → rebuild', S.decideEnsureAction({
      terminal: term, relayAlive: false, coordinatorHandle: 'term_box',
    }).reason === 'relay-dead');
    // 判别力：若有人改回「ensure 进程自己 run-use --from」（实测绑错终端），这条会红
    check('被夺走不能当 ok', S.decideEnsureAction({
      terminal: term, relayAlive: true, coordinatorHandle: 'term_thief',
    }).action !== 'ok');
  }

  console.log('\n=== ④ 收信分流（heartbeat 不落盘）===');
  {
    const batch = [
      { id: 'm1', type: 'heartbeat', subject: 'alive', body: '' },
      { id: 'm2', type: 'worker_done', subject: '完工', body: 'PR #466' },
      { id: 'm3', type: 'HEARTBEAT', subject: 'alive', body: '' },
      { id: 'm4', type: 'question', subject: '问', body: 'x' },
    ];
    const { loggable, heartbeats } = S.splitMessages(batch);
    check('两条业务信落盘', loggable.map((m) => m.id).join(',') === 'm2,m4');
    check('两条心跳不落盘', heartbeats.length === 2);
    check('heartbeat 判定大小写不敏感', S.shouldLogMessage({ type: 'HeartBeat' }) === false);
    check('worker_done 要落盘', S.shouldLogMessage({ type: 'worker_done' }) === true);
    check('空 type 当业务信', S.shouldLogMessage({ subject: 'x' }) === true);

    const line = S.formatLogLine({
      id: 'm2', type: 'worker_done', from_handle: 'term_w', subject: '完工', body: 'PR #466',
    }, new Date('2026-08-15T07:00:00.000Z'));
    const obj = JSON.parse(line);
    check('日志是一行 JSON', obj.id === 'm2' && obj.type === 'worker_done' && obj.body === 'PR #466');
    check('日志带 ts', obj.ts === '2026-08-15T07:00:00.000Z');
    check('心跳若被 format 也不会当业务（分流在前）', !loggable.some((m) => m.type && m.type.toLowerCase() === 'heartbeat'));
  }

  console.log('\n=== ⑤ check JSON 多形态 ===');
  {
    const a = S.parseCheckResult({
      ok: true,
      result: { delivery_id: 'del_1', messages: [{ id: 'm1', type: 'question' }] },
    });
    check('result.delivery_id + messages', a.deliveryId === 'del_1' && a.messages[0].id === 'm1');

    const b = S.parseCheckResult({
      result: { delivery: { id: 'del_2', messages: [{ id: 'm2' }] } },
    });
    check('result.delivery.id 嵌套', b.deliveryId === 'del_2' && b.messages[0].id === 'm2');

    const c = S.parseCheckResult({ messages: [], deliveryId: 'del_3' });
    check('顶层 deliveryId 空消息', c.deliveryId === 'del_3' && c.messages.length === 0);

    const d = S.parseCheckResult({ ok: true, result: {} });
    check('空 result 不炸', d.messages.length === 0 && d.deliveryId === null);

    const e = S.parseOrcaStdout('noise\n{"ok":true,"result":{"x":1}}\n');
    check('stdout 夹杂时取 JSON', e.ok === true && e.json.result.x === 1);
    check('空 stdout 失败', S.parseOrcaStdout('').ok === false);
  }

  console.log('\n=== ⑥ 重建命令串 / 现状 JSON ===');
  {
    const script = S.buildLaunchScript({
      nodePath: 'C:\\Program Files\\nodejs\\node.exe',
      scriptPath: 'C:\\repo\\scripts\\inbox-station.mjs',
      runId: 'run_af8',
      logPath: 'D:\\frank\\windsurf-dao\\_flow\\inbox.log',
    });
    check('启动串先 run-use', /^\s*orca orchestration run-use --id run_af8/m.test(script));
    check('启动串再进 relay', /inbox-station\.mjs" relay --run run_af8/.test(script));
    check('启动串含 --log', script.includes('--log') && script.includes('inbox.log'));
    const cmd = S.buildRelayCommand({ launchPath: 'D:\\frank\\windsurf-dao\\_flow\\inbox-station.cmd' });
    check('create --command 走 cmd 文件', cmd.includes('cmd.exe /c') && cmd.includes('inbox-station.cmd'));
    check('命令不走 stdin/send', !/terminal send/.test(cmd) && !cmd.includes('--enter'));

    const st = S.statusPayload({
      runId: 'run_x', handle: 'term_y', logPath: 'p', action: 'ok', reason: 'all-alive',
    });
    check('现状 JSON 三件套', st.runId === 'run_x' && st.handle === 'term_y' && st.logPath === 'p');
    check('现状 JSON ok', st.ok === true && st.action === 'ok');

    check('标题常量', S.TITLE === '信箱台（勿关）');
    check('unwrap result.key', S.unwrapOrca({ result: { terminals: [1] } }, 'terminals')[0] === 1);
    check('extractHandle 几种形状', S.extractHandle({ result: { handle: 'term_z' } }) === 'term_z');
    check('findMainWorktree', S.findMainWorktree([
      { id: 'a', isMainWorktree: false },
      { id: 'b', isMainWorktree: true },
    ]).id === 'b');
  }

  console.log(`\n${fail === 0 ? 'OK' : 'FAIL'}  ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
