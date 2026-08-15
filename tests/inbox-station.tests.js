// 信箱台幂等脚本 · 纯函数回归（不碰 live orca）
//
// 验的层：①参数/选型 ②终端+中继活着判据（租约+PID，不是历史屏面）
// ③ensure 三岔（秒退/夺回/重建）
// ④收信分流（heartbeat 不落盘、业务信落盘）⑤check JSON 多形态解析
// ⑥重建命令串（run-use 由 relay 进程自己做，--command 不走 stdin）
// ⑦waitReady / finalizeEnsure 故障注入（超时与夺回失败必须 ok:false 非零）
// 判别力：READY 历史行当活、或超时仍 ok:true，必有一条变红。

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
    check('标题带前缀也能认出（无 run 时走旧格式）', S.findInboxTerminal([titled])?.handle === 'term_a');
    check('没有信箱台 → null', S.findInboxTerminal([{ title: 'Grok', handle: 'term_x' }]) === null);
    check('非数组 → null', S.findInboxTerminal(null) === null);

    // #493：run id 是身份，标题带 run 后缀；按 run 归属找，撞上别的 run 的台不认
    const mine = { handle: 'term_my', title: S.stationTitle('run_bfd7e4e193ce') };
    const other = { handle: 'term_other', title: S.stationTitle('run_af8fc3144eb7') };
    const legacy = { handle: 'term_legacy', title: S.TITLE };
    check('runShort 去掉 run_ 前缀', S.runShort('run_bfd7e4e193ce') === 'bfd7e4e193ce');
    check('stationTitle 带 run 后缀', S.stationTitle('run_bfd7e4e193ce') === '信箱台·bfd7e4e193ce（勿关）');
    check('extractRunToken 抽全后缀', S.extractRunToken(S.stationTitle('run_bfd7e4e193ce')) === 'bfd7e4e193ce');
    check('extractRunToken 抽到垫片短号', S.extractRunToken('信箱台·af8fc（勿关·垫片）') === 'af8fc');
    check('extractRunToken 非信箱台 → null', S.extractRunToken('Grok') === null);
    check('按 run 找到自己的台', S.findInboxTerminal([mine, other], { runId: 'run_bfd7e4e193ce' })?.handle === 'term_my');
    check('不认别的 run 的台', S.findInboxTerminal([other], { runId: 'run_bfd7e4e193ce' }) === null);
    check('不认旧格式裸标题（归属不明）', S.findInboxTerminal([legacy], { runId: 'run_bfd7e4e193ce' }) === null);
    const foreignList = S.findForeignInboxTerminals([mine, other, legacy], { runId: 'run_bfd7e4e193ce' });
    check('外来台扫出别的 run + 裸标题两台', foreignList.length === 2
      && foreignList.some((f) => f.kind === 'other-run' && f.token === 'af8fc3144eb7')
      && foreignList.some((f) => f.kind === 'legacy-bare' && f.terminal.handle === 'term_legacy'));
    check('自己的台不算外来', S.findForeignInboxTerminals([mine], { runId: 'run_bfd7e4e193ce' }).length === 0);
    check('defaultLogRel 按 run 隔离', S.defaultLogRel('run_bfd7e4e193ce').replace(/\\/g, '/') === '_flow/inbox-bfd7e4e193ce.log');
    check('defaultLogRel 无 run 兑底 inbox.log', S.defaultLogRel(null) === S.DEFAULT_LOG_REL);

    check('未连 = 死', S.isRelayAlive({ ...titled, connected: false }) === false);
    check('孤儿 = 死', S.isRelayAlive({ ...titled, connected: true, orphaned: true }) === false);
    check('只有标题没有中继痕迹 = 死', S.isRelayAlive(titled) === false);

    // 审官红1 原样：connected + lastOutputAt:0 + 仅历史 READY preview
    const residue = {
      handle: 'term_a',
      title: S.TITLE,
      connected: true,
      lastOutputAt: 0,
      preview: `${S.READY_MARK} run=x\nnode scripts/inbox-station.mjs relay\norchestration check --wait`,
    };
    check('READY 历史行在但 relay 已退出 = 死', S.isRelayAlive(residue) === false);
    check('脚本名/check 历史残留不能当活', S.isRelayAlive({
      handle: 'term_a', title: S.TITLE, connected: true,
      preview: 'node scripts/inbox-station.mjs relay',
    }) === false);

    const now = 1_000_000;
    const liveLease = { pid: process.pid, ts: now, ttlMs: S.LEASE_TTL_MS };
    const deadPidLease = { pid: 2147483647, ts: now, ttlMs: S.LEASE_TTL_MS };
    const staleLease = { pid: process.pid, ts: now - S.LEASE_TTL_MS - 1, ttlMs: S.LEASE_TTL_MS };
    check('新鲜租约 + 本进程 PID = 活', S.isRelayAlive(residue, { lease: liveLease, now }) === true);
    check('新鲜租约但 PID 已死 = 死', S.isRelayAlive(residue, { lease: deadPidLease, now }) === false);
    check('过期租约 + 活 PID = 死', S.isRelayAlive(residue, { lease: staleLease, now }) === false);
    check('preview 已滚没但租约新鲜+PID 活 = 活', S.isRelayAlive({
      handle: 'term_a', title: S.TITLE, connected: true, preview: 'PS>',
    }, { lease: liveLease, now }) === true);

    check('parseLease 坏 JSON → null', S.parseLease('not-json') === null);
    check('parseLease 缺 pid → null', S.parseLease(JSON.stringify({ ts: now })) === null);
    const parsed = S.parseLease(S.formatLease({ pid: 12, runId: 'run_x', ts: now, ttlMs: 9000 }));
    check('format/parse 租约往返', parsed && parsed.pid === 12 && parsed.runId === 'run_x' && parsed.ttlMs === 9000);
    check('本进程 PID 活', S.isProcessAlive(process.pid) === true);
    check('非法 PID 死', S.isProcessAlive(0) === false && S.isProcessAlive(-1) === false);
    check('leasePath 落在日志同目录且按日志名区分', S.leasePath('D:/repo/_flow/inbox.log').replace(/\\/g, '/').endsWith('/_flow/inbox.lease'));
    check('默认日志的租约按 run 隔离', S.leasePath('D:/repo/_flow/inbox-72d9e54bbf7f.log').replace(/\\/g, '/').endsWith('/_flow/inbox-72d9e54bbf7f.lease'));
    check('显式日志的租约跟随日志名', S.leasePath('D:/repo/_flow/inbox-A.log').replace(/\\/g, '/').endsWith('/_flow/inbox-A.lease'));
    check('启动脚本也按日志名区分', S.launchFilePath('D:/repo/_flow/inbox-72d9e54bbf7f.log').replace(/\\/g, '/').endsWith('/_flow/inbox-72d9e54bbf7f.cmd'));
    check('两条 run 的租约不共用', S.leasePath('D:/repo/_flow/inbox-72d9e54bbf7f.log') !== S.leasePath('D:/repo/_flow/inbox-883935d71262.log'));
  }

  console.log('\n=== ③ ensure 三岔（#493 扩成四岔：rebuild / restart / reject / ok）===');
  {
    const term = { handle: 'term_box', title: S.stationTitle('run_bfd7e4e193ce'), connected: true, preview: S.READY_MARK };
    check('全活着 → ok', S.decideEnsureAction({
      terminal: term, relayAlive: true, coordinatorHandle: 'term_box', foreign: [],
    }).action === 'ok');
    check('全活着 reason=all-alive', S.decideEnsureAction({
      terminal: term, relayAlive: true, coordinatorHandle: 'term_box', foreign: [],
    }).reason === 'all-alive');
    check('被夺走 → restart（本 run 的台，不碰别人）', S.decideEnsureAction({
      terminal: term, relayAlive: true, coordinatorHandle: 'term_thief', foreign: [],
    }).action === 'restart');
    check('coordinator 空 → coordinator-stolen', S.decideEnsureAction({
      terminal: term, relayAlive: true, coordinatorHandle: null, foreign: [],
    }).reason === 'coordinator-stolen');
    check('没终端没外来 → rebuild', S.decideEnsureAction({
      terminal: null, relayAlive: false, coordinatorHandle: 'term_x', foreign: [],
    }).action === 'rebuild');
    check('没终端没外来 reason=no-terminal', S.decideEnsureAction({
      terminal: null, relayAlive: false, coordinatorHandle: 'term_x', foreign: [],
    }).reason === 'no-terminal');
    check('中继死 → restart（本 run 台死了重启，不再叫 rebuild）', S.decideEnsureAction({
      terminal: term, relayAlive: false, coordinatorHandle: 'term_box', foreign: [],
    }).action === 'restart');
    check('中继死 reason=relay-dead', S.decideEnsureAction({
      terminal: term, relayAlive: false, coordinatorHandle: 'term_box', foreign: [],
    }).reason === 'relay-dead');
    // 判别力：若有人改回「ensure 进程自己 run-use --from」（实测绑错终端），这条会红
    check('被夺走不能当 ok', S.decideEnsureAction({
      terminal: term, relayAlive: true, coordinatorHandle: 'term_thief', foreign: [],
    }).action !== 'ok');

    // #493 回归样本：A 顶掉 B 时旧代码返回 ok:true / rebuild / coordinator-stolen，
    // 修好后同样场景（本 run 无台 + 场上别的 run 的台在）必须拒绝并报出对方 run id。
    const foreign = [{
      terminal: { handle: 'term_af8fc', title: S.stationTitle('run_af8fc3144eb7') },
      token: 'af8fc3144eb7', kind: 'other-run',
    }];
    const stolen = S.decideEnsureAction({
      terminal: null, relayAlive: false, coordinatorHandle: null, foreign,
    });
    check('撞上别的 run 的台 → reject', stolen.action === 'reject' && stolen.reason === 'foreign-station');
    check('拒绝时报出对方 run id', stolen.foreignRunId === 'run_af8fc3144eb7');
    check('拒绝时带对方 handle', stolen.foreignHandle === 'term_af8fc');
    check('回归反例：不再返回 ok:true/rebuild/coordinator-stolen',
      !(stolen.ok === true && stolen.action === 'rebuild' && stolen.reason === 'coordinator-stolen'));
    check('回归反例：顶替场景不再返回 ok', stolen.ok !== true);
    // 裸标题外来台：归属不明也要拒绝（token 为 null，run id 报不出来但不顶替）
    const legacyForeign = S.decideEnsureAction({
      terminal: null, relayAlive: false, coordinatorHandle: null,
      foreign: [{ terminal: { handle: 'term_legacy', title: S.TITLE }, token: null, kind: 'legacy-bare' }],
    });
    check('旧格式裸标题外来也拒绝', legacyForeign.action === 'reject' && legacyForeign.foreignRunId === null);
    // 本 run 的台在时，外来存在不影响（restart/ok 优先，不因别人在就拒绝自己）
    check('自己的台在 + 外来在 → 按自己台判', S.decideEnsureAction({
      terminal: term, relayAlive: true, coordinatorHandle: 'term_box', foreign,
    }).action === 'ok');
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
    const stFail = S.statusPayload({
      ok: false, runId: 'run_x', handle: 'term_y', logPath: 'p',
      action: 'rebuild', reason: 'relay-not-alive', error: '中继未存活',
    });
    check('现状 JSON 失败带 ok:false', stFail.ok === false && stFail.error === '中继未存活');

    check('标题常量（旧格式裸标题保留作识别用）', S.TITLE === '信箱台（勿关）');
    check('新标题带 run 后缀', S.stationTitle('run_af8fc3144eb7') === '信箱台·af8fc3144eb7（勿关）');
    check('unwrap result.key', S.unwrapOrca({ result: { terminals: [1] } }, 'terminals')[0] === 1);
    check('extractHandle 几种形状', S.extractHandle({ result: { handle: 'term_z' } }) === 'term_z');
    check('findMainWorktree', S.findMainWorktree([
      { id: 'a', isMainWorktree: false },
      { id: 'b', isMainWorktree: true },
    ]).id === 'b');
  }

  console.log('\n=== ⑦ waitReady / finalizeEnsure 故障注入 ===');
  {
    const now = 2_000_000;
    const term = { handle: 'term_box', title: S.TITLE, connected: true, preview: S.READY_MARK };
    const liveLease = { pid: process.pid, ts: now, ttlMs: S.LEASE_TTL_MS };

    check('decideReady 全好 → ok', S.decideReady({
      terminal: term, lease: liveLease, coordinatorHandle: 'term_box', now,
    }).ok === true);
    check('decideReady 无终端 → 失败', S.decideReady({
      terminal: null, lease: liveLease, coordinatorHandle: 'term_box', now,
    }).ok === false);
    check('decideReady 历史 READY 无租约 → relay-not-alive', S.decideReady({
      terminal: term, lease: null, coordinatorHandle: 'term_box', now,
    }).error === 'relay-not-alive');
    check('decideReady coordinator 空 → coordinator-not-held', S.decideReady({
      terminal: term, lease: liveLease, coordinatorHandle: null, now,
    }).error === 'coordinator-not-held');
    check('decideReady coordinator 是别人 → coordinator-not-held', S.decideReady({
      terminal: term, lease: liveLease, coordinatorHandle: 'term_thief', now,
    }).error === 'coordinator-not-held');

    check('超时不得降级成功', S.acceptRebuildReady({ ok: false, error: 'timeout' }).ok === false);
    check('超时不得带 warning 当成功', !('warning' in S.acceptRebuildReady({ ok: false, error: 'timeout' })));
    check('acceptRebuildReady 成功带 handle', S.acceptRebuildReady({
      ok: true, terminal: term,
    }).handle === 'term_box');

    const base = {
      handle: 'term_box', runId: 'run_x', logPath: 'p', action: 'rebuild', reason: 'no-terminal',
    };
    const deadRelay = S.finalizeEnsure({ ...base, relayAlive: false, runShowOk: true, coordinatorHandle: 'term_box' });
    check('finalize 中继死 → ok:false 非零', deadRelay.exitCode === 1 && deadRelay.payload.ok === false);
    check('finalize 中继死 reason', deadRelay.payload.reason === 'relay-not-alive');

    const showFail = S.finalizeEnsure({ ...base, relayAlive: true, runShowOk: false, coordinatorHandle: null });
    check('finalize run-show 失败 → ok:false 非零', showFail.exitCode === 1 && showFail.payload.ok === false);
    check('finalize run-show 失败 reason', showFail.payload.reason === 'coordinator-unknown');

    const emptyCoord = S.finalizeEnsure({ ...base, relayAlive: true, runShowOk: true, coordinatorHandle: null });
    check('finalize coordinator 空 → ok:false 非零', emptyCoord.exitCode === 1 && emptyCoord.payload.ok === false);
    check('finalize coordinator 空 reason', emptyCoord.payload.reason === 'coordinator-not-held');

    const stolen = S.finalizeEnsure({ ...base, relayAlive: true, runShowOk: true, coordinatorHandle: 'term_thief' });
    check('finalize 未夺回 → ok:false 非零', stolen.exitCode === 1 && stolen.payload.ok === false);
    check('finalize 未夺回写出对方 handle', stolen.payload.coordinatorHandle === 'term_thief');

    const okFinal = S.finalizeEnsure({
      ...base, action: 'ok', reason: 'all-alive',
      relayAlive: true, runShowOk: true, coordinatorHandle: 'term_box',
    });
    check('finalize 全好 → ok:true 零退出', okFinal.exitCode === 0 && okFinal.payload.ok === true);
    check('finalize 成功不带 error', okFinal.payload.error === undefined);
  }

  console.log(`\n${fail === 0 ? 'OK' : 'FAIL'}  ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
