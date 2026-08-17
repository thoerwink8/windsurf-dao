// 派工闸门判别力（#546 #517）。
// 验的是：旁路 exit 2、逃生口放行、崩了也 exit 2、零样本报红。
// 不复用闸门自己的 decideGate 来断言自己——走真进程 + 检查器黑盒。

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const GATE = path.join(REPO, 'scripts', 'lib', 'dispatch-gate.mjs');
const HOOK = path.join(REPO, 'scripts', 'lib', 'dispatch-gate-hook.mjs'); // 随仓 .claude/settings.json 挂的入口（#553）
const CHECK = path.join(REPO, 'scripts', 'lib', 'dispatch-gate-check.mjs');

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? '  →  ' + detail : ''}`); }
}

function payload(command) {
  return JSON.stringify({
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command },
  });
}

function runGate(script, command, envExtra = {}) {
  return spawnSync(process.execPath, [script], {
    encoding: 'utf8',
    input: payload(command),
    timeout: 15000,
    windowsHide: true,
    env: { ...process.env, ...envExtra },
  });
}

async function main() {
  const { decideGate, isDispatchBypass, runAsHook, extractHookCommand } = await import('file://' + GATE.replace(/\\/g, '/'));
  const { checkDispatchGate } = await import('file://' + CHECK.replace(/\\/g, '/'));

  console.log('\n=== 函数层：什么算旁路 ===');
  check('worker-start 是旁路', isDispatchBypass('orca orchestration worker-start --task t') === true);
  check('task-create 是旁路', isDispatchBypass('orca orchestration task-create --spec x') === true);
  check('orchestration dispatch 是旁路', isDispatchBypass('orca orchestration dispatch --inject') === true);
  check('send/check/ask 不是旁路', isDispatchBypass('orca orchestration send --type heartbeat') === false
    && isDispatchBypass('orca orchestration check --json') === false);
  check('dao.mjs dispatch 不是旁路', isDispatchBypass('node scripts/dao.mjs dispatch --name x') === false);
  check('dao.mjs raw 逃生口不是旁路', isDispatchBypass('node scripts/dao.mjs raw -- orca orchestration worker-start --task t') === false);
  check('空命令不是旁路', isDispatchBypass('') === false && isDispatchBypass(null) === false);
  check('#575：echo "dao.mjs raw" && worker-start 仍是旁路（关键词出现在别处不算放行）',
    isDispatchBypass('echo "dao.mjs raw" && orca orchestration worker-start --task t') === true);
  check('#575：注释里写 dao.mjs raw 仍是旁路',
    isDispatchBypass('orca orchestration worker-start --task t # dao.mjs raw') === true);
  check('#575：任务书正文提到 dao.mjs raw 的 dispatch 不是旁路',
    isDispatchBypass('node scripts/dao.mjs dispatch --spec "请走 dao.mjs raw 不要裸 orca orchestration worker-start"') === false);
  check('#575：分号连接的 echo + 裸 worker-start 仍是旁路',
    isDispatchBypass('echo dao.mjs raw; orca orchestration worker-start --task t') === true);
  check('PreToolUse JSON 能抽出 command', extractHookCommand(JSON.parse(payload('orca orchestration worker-start'))) === 'orca orchestration worker-start');

  const blocked = decideGate('orca orchestration worker-start --task t');
  check('decideGate 旁路 block + 指向 dao.mjs dispatch', blocked.block === true && /dao\.mjs dispatch/.test(blocked.message), JSON.stringify(blocked));

  console.log('\n=== 故意违规：真跑 hook 进程 ===');
  for (const [label, script] of [['lib', GATE], ['settings hook', HOOK]]) {
    const bypass = runGate(script, 'orca orchestration worker-start --task t --worktree w');
    check(`${label} 故意旁路 worker-start → exit 2`, bypass.status === 2, `status=${bypass.status} ${bypass.stderr}`);
    check(`${label} 提示走 dao.mjs dispatch`, /dao\.mjs dispatch/.test(bypass.stderr || ''), bypass.stderr);
    const raw = runGate(script, 'node scripts/dao.mjs raw -- orca orchestration worker-start --task t');
    check(`${label} 逃生口 raw → 放行`, raw.status === 0, `status=${raw.status} ${raw.stderr}`);
    const decoy = runGate(script, 'echo "dao.mjs raw" && orca orchestration worker-start --task t --worktree w');
    check(`${label} 故意违规 echo "dao.mjs raw" && worker-start → exit 2`, decoy.status === 2, `status=${decoy.status} ${decoy.stderr}`);
    const send = runGate(script, 'orca orchestration send --type heartbeat --subject alive');
    check(`${label} 普通 send → 放行`, send.status === 0, `status=${send.status} ${send.stderr}`);
    const crashed = runGate(script, 'orca orchestration send --type heartbeat', { DISPATCH_GATE_CRASH: '1' });
    check(`${label} 故意崩 → exit 2 不放行`, crashed.status === 2, `status=${crashed.status} ${crashed.stderr}`);
    check(`${label} 崩了有 fail-closed 字样`, /fail-closed|崩/.test(crashed.stderr || ''), crashed.stderr);
  }

  const asHookCrash = runAsHook({ stdinText: payload('orca status'), env: { DISPATCH_GATE_CRASH: '1' } });
  check('runAsHook 崩了也是 exit 2', asHookCrash.exit === 2, JSON.stringify(asHookCrash));

  console.log('\n=== 检查器：零样本 vs 真闸 ===');
  const live = checkDispatchGate({ root: REPO });
  check('本仓闸门检查绿', !!live.green && !live.fail, JSON.stringify(live));

  const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dao-gate-empty-'));
  const empty = checkDispatchGate({ root: emptyRoot });
  check('零样本（没有随仓 .claude/settings.json）→ 报没查成', !!empty.fail && /没查成|不在/.test(empty.fail[0] + empty.fail[1]), JSON.stringify(empty));

  const noGateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dao-gate-nogate-'));
  fs.mkdirSync(path.join(noGateRoot, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(noGateRoot, '.claude', 'settings.json'), JSON.stringify({
    hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/scripts/lib/dao-mode.mjs" hook' }] }] },
  }), 'utf8');
  const noGate = checkDispatchGate({ root: noGateRoot });
  check('有 PreToolUse 但无 dispatch-gate 条目 → 报没扫到', !!noGate.fail && /没扫到/.test(noGate.fail[0]), JSON.stringify(noGate));

  const badRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dao-gate-bad-'));
  fs.mkdirSync(path.join(badRoot, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(badRoot, '.claude', 'settings.json'), '{oops', 'utf8');
  const bad = checkDispatchGate({ root: badRoot });
  check('settings.json 坏 JSON → 没查成', !!bad.fail && /解析不了/.test(bad.fail[0]), JSON.stringify(bad));

  const ghostRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dao-gate-ghost-'));
  fs.mkdirSync(path.join(ghostRoot, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(ghostRoot, '.claude', 'settings.json'), JSON.stringify({
    hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/scripts/lib/dispatch-gate-ghost.mjs"' }] }] },
  }), 'utf8');
  const ghost = checkDispatchGate({ root: ghostRoot });
  check('闸门指向的脚本不存在 → 报没跑成/指向空气', !!ghost.fail && /脚本都没跑成|指向空气/.test(ghost.fail[0]), JSON.stringify(ghost));

  console.log(`\n${fail === 0 ? 'OK' : 'FAIL'}  ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
