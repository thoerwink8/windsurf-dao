// 信箱台幂等脚本 · 纯函数回归（不碰 live orca）
//
// 验的层：①参数/选型 ②终端+中继活着判据（租约+PID，不是历史屏面）
// ③ensure 三岔（秒退/夺回/重建）
// ④收信分流（heartbeat 不落盘、业务信落盘）⑤check JSON 多形态解析
// ⑥重建命令串（run-use 由 relay 进程自己做，--command 不走 stdin）
// ⑦waitReady / finalizeEnsure 故障注入（超时与夺回失败必须 ok:false 非零）
// 判别力：READY 历史行当活、或超时仍 ok:true，必有一条变红。

const fs = require('fs');
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

  console.log('\n=== ② 终端 + 中继活着（#493 返工：身份从 coordinator_handle 取，标题只出不进）===');
  {
    const titled = { handle: 'term_a', title: '◑ 信箱台（勿关）', connected: true, preview: 'PS>' };
    check('runShort 去掉 run_ 前缀', S.runShort('run_bfd7e4e193ce') === 'bfd7e4e193ce');
    check('stationTitle 带 run 后缀（输出给人看）', S.stationTitle('run_bfd7e4e193ce') === '信箱台·bfd7e4e193ce（勿关）');
    check('defaultLogRel 按 run 隔离', S.defaultLogRel('run_bfd7e4e193ce').replace(/\\/g, '/') === '_flow/inbox-bfd7e4e193ce.log');
    check('defaultLogRel 无 run 兑底 inbox.log', S.defaultLogRel(null) === S.DEFAULT_LOG_REL);

    // 身份 = run-show 的 coordinator_handle：标题是 pwsh.exe 也认得；标题是信箱台也认得
    const reset = { handle: 'term_station', title: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', connected: true };
    const fancy = { handle: 'term_fancy', title: S.stationTitle('run_ev'), connected: true };
    check('按 handle 认出被重置标题的台', S.findCoordinatorTerminal([reset, fancy], 'term_station')?.handle === 'term_station');
    check('按 handle 认出正常标题的台', S.findCoordinatorTerminal([reset, fancy], 'term_fancy')?.handle === 'term_fancy');
    check('coordinator 空 → null', S.findCoordinatorTerminal([reset], null) === null);
    check('handle 不在列表 → null', S.findCoordinatorTerminal([reset], 'term_nope') === null);
    check('非数组 → null', S.findCoordinatorTerminal(null, 'term_a') === null);

    const now = 1_000_000;
    const liveLease = { pid: process.pid, runId: 'run_ev', ts: now, ttlMs: S.LEASE_TTL_MS };
    const deadPidLease = { pid: 2147483647, runId: 'run_ev', ts: now, ttlMs: S.LEASE_TTL_MS };
    const staleLease = { pid: process.pid, runId: 'run_ev', ts: now - S.LEASE_TTL_MS - 1, ttlMs: S.LEASE_TTL_MS };
    const wrongRunLease = { pid: process.pid, runId: 'run_other', ts: now, ttlMs: S.LEASE_TTL_MS };
    check('isStationAlive 新鲜+PID在+runId对 = 活', S.isStationAlive(liveLease, 'run_ev', { now }) === true);
    check('isStationAlive 死 PID = 死', S.isStationAlive(deadPidLease, 'run_ev', { now }) === false);
    check('isStationAlive 过期租约 = 死', S.isStationAlive(staleLease, 'run_ev', { now }) === false);
    check('isStationAlive runId 不对 = 死', S.isStationAlive(wrongRunLease, 'run_ev', { now }) === false);
    check('isStationAlive 无租约 = 死', S.isStationAlive(null, 'run_ev') === false);

    check('未连 = 死', S.isRelayAlive({ ...titled, connected: false }) === false);
    check('孤儿 = 死', S.isRelayAlive({ ...titled, connected: true, orphaned: true }) === false);
    check('只有标题没有中继痕迹 = 死', S.isRelayAlive(titled) === false);
    check('isRelayAlive 租约 runId 不对 = 死', S.isRelayAlive(reset, { lease: wrongRunLease, runId: 'run_ev', now }) === false);

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

  console.log('\n=== ③ ensure 判定（#493 返工：coordinator_handle 是身份，标题只出不进）===');
  {
    const now = 2_000_000;
    const RUN = 'run_ev';
    const freshLease = { pid: process.pid, runId: RUN, ts: now, ttlMs: S.LEASE_TTL_MS };
    const staleLease = { pid: process.pid, runId: RUN, ts: now - S.LEASE_TTL_MS - 1, ttlMs: S.LEASE_TTL_MS };
    const wrongRunLease = { pid: process.pid, runId: 'run_other', ts: now, ttlMs: S.LEASE_TTL_MS };
    // 审官红1 的现场：台的标题被重置成 pwsh.exe，但 run-show 的 coordinator_handle 仍是它
    const resetStation = { handle: 'term_station', title: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', connected: true };
    const station = { handle: 'term_station2', title: S.stationTitle(RUN), connected: true };
    const shuaiTerm = { handle: 'term_shuai', title: 'A 主帅（Branch）', connected: true };

    // ★ 判别测试：标题被重置成 pwsh.exe 仍按 coordinator_handle 认出自己的台 → ok / all-alive / handle 不变
    const resetDec = S.decideEnsureAction({
      runId: RUN, coordinatorHandle: 'term_station', terminals: [resetStation, shuaiTerm], lease: freshLease, now,
    });
    check('★ 标题被重置仍认出台 → ok', resetDec.action === 'ok' && resetDec.reason === 'all-alive');
    check('★ 标题被重置 handle 不变', resetDec.handle === 'term_station');
    check('★ 标题被重置不新建不顶替（无 rebuild/restart/reject）',
      !['rebuild', 'restart', 'reject'].includes(resetDec.action));

    // 正常标题的台同样 ok
    const okDec = S.decideEnsureAction({
      runId: RUN, coordinatorHandle: 'term_station2', terminals: [station], lease: freshLease, now,
    });
    check('正常标题 → ok', okDec.action === 'ok' && okDec.reason === 'all-alive' && okDec.handle === 'term_station2');
    // coordinator 被帅临时借走 + 中继活着 → ok（中继每轮 run-use 自夺回）
    check('coordinator 在帅的终端但中继活 → ok', S.decideEnsureAction({
      runId: RUN, coordinatorHandle: 'term_shuai', terminals: [resetStation, shuaiTerm], lease: freshLease, now,
    }).action === 'ok');
    // coordinator 还没回来（null）但中继活 → ok
    check('coordinator 暂空但中继活 → ok', S.decideEnsureAction({
      runId: RUN, coordinatorHandle: null, terminals: [resetStation], lease: freshLease, now,
    }).action === 'ok');

    // 台死了：租约过期 + coordinator 挂在死壳/帅的终端上 → restart（本 run 台死重启，不碰别人）
    const restartDec = S.decideEnsureAction({
      runId: RUN, coordinatorHandle: 'term_station', terminals: [resetStation], lease: staleLease, now,
    });
    check('台死 + coordinator 在死壳 → restart', restartDec.action === 'restart' && restartDec.reason === 'relay-dead');
    check('台死 + coordinator 空 → restart', S.decideEnsureAction({
      runId: RUN, coordinatorHandle: null, terminals: [], lease: staleLease, now,
    }).action === 'restart');

    // 从没有台：无租约 + 无 coordinator → rebuild（本 run 无台新建）
    const rebuildDec = S.decideEnsureAction({
      runId: RUN, coordinatorHandle: null, terminals: [], lease: null, now,
    });
    check('无台无租约 → rebuild', rebuildDec.action === 'rebuild' && rebuildDec.reason === 'no-terminal');
    // coordinator 在帅的终端但无本 run 租约 → rebuild（帅的终端不是台，绝不复用/顶替）
    check('coordinator 在帅的终端且无租约 → rebuild 不动它', S.decideEnsureAction({
      runId: RUN, coordinatorHandle: 'term_shuai', terminals: [shuaiTerm], lease: null, now,
    }).action === 'rebuild');
    // 租约 runId 不对（别人的）→ 当没有
    check('租约 runId 不对 → 当无台 rebuild', S.decideEnsureAction({
      runId: RUN, coordinatorHandle: null, terminals: [], lease: wrongRunLease, now,
    }).action === 'rebuild');

    // 撞上别的 run 的台：本 run 台死，coordinator 被别的 run 的活台占着 → reject + 报对方 run id
    const rejectDec = S.decideEnsureAction({
      runId: RUN, coordinatorHandle: 'term_foreign',
      terminals: [{ handle: 'term_foreign', title: S.stationTitle('run_other'), connected: true }],
      lease: staleLease, now,
      foreignStation: { runId: 'run_other', handle: 'term_foreign' },
    });
    check('撞上别的 run 的台 → reject', rejectDec.action === 'reject' && rejectDec.reason === 'foreign-station');
    check('拒绝时报出对方 run id', rejectDec.foreignRunId === 'run_other' && rejectDec.foreignHandle === 'term_foreign');
    // 回归反例：任何场景不得再返回 ok:true/rebuild/coordinator-stolen
    check('回归反例：不再出现 ok:true+rebuild+coordinator-stolen',
      ![resetDec, okDec, restartDec, rebuildDec, rejectDec].some(
        (d) => d.ok === true && d.action === 'rebuild' && d.reason === 'coordinator-stolen'));
    check('回归反例：reject 不带 ok:true', rejectDec.ok !== true);
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
    const plain = fs.readFileSync(path.join(__dirname, 'fixtures', 'orca-json', 'terminal-send-plaintext.txt'), 'utf8');
    const sent = S.parseOrcaStdout(plain);
    check('Sent N bytes to term_ 判成功（#580 真语料）', sent.ok === true && sent.sentPlaintext === true && sent.bytes === 11, JSON.stringify(sent));
    check('Sent N bytes 归一成 result.send.accepted', sent.json?.result?.send?.accepted === true);
    const jsonSend = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'orca-json', 'terminal-send.json'), 'utf8'));
    const parsedJson = S.parseOrcaStdout(JSON.stringify(jsonSend));
    check('send --json 信封过解析', parsedJson.ok === true && parsedJson.json.result.send.accepted === true);
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
