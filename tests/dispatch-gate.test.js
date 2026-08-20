// 派工闸门判别力（#546 #517）。
// 验的是：旁路 exit 2、逃生口放行、崩了也 exit 2、零样本报红。
// 不复用闸门自己的 decideGate 来断言自己——走真进程 + 检查器黑盒。

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const GATE = path.join(REPO, 'scripts', 'lib', 'dispatch-gate.mjs');
const HOOK = path.join(REPO, 'scripts', 'lib', 'dispatch-gate-hook.mjs'); // 随仓 .claude/settings.json 挂的入口（#553）
const CHECK = path.join(REPO, 'scripts', 'lib', 'dispatch-gate-check.mjs');
const GATE_LOAD = import('file://' + GATE.replace(/\\/g, '/'));
const CHECK_LOAD = import('file://' + CHECK.replace(/\\/g, '/'));

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

describe('dispatch-gate', () => {
  it('函数层：什么算旁路', async (t) => {
    const { decideGate, isDispatchBypass, runAsHook, extractHookCommand } = await GATE_LOAD;
    await t.test('worker-start 是旁路', () => {
      assert.ok(isDispatchBypass('orca orchestration worker-start --task t') === true, 'worker-start 是旁路');
    });
    await t.test('task-create 是旁路', () => {
      assert.ok(isDispatchBypass('orca orchestration task-create --spec x') === true, 'task-create 是旁路');
    });
    await t.test('orchestration dispatch 是旁路', () => {
      assert.ok(isDispatchBypass('orca orchestration dispatch --inject') === true, 'orchestration dispatch 是旁路');
    });
    await t.test('send/check/ask 不是派工旁路（心跳另拦）', () => {
      assert.ok(isDispatchBypass('orca orchestration send --type heartbeat') === false
        && isDispatchBypass('orca orchestration check --json') === false, 'send/check 不是派工旁路');
    });
    const hb = decideGate('orca orchestration send --type heartbeat --subject alive');
    await t.test('#667 decideGate 拦心跳', () => {
      assert.ok(hb.block === true && /心跳不准发/.test(hb.message), '#667 decideGate 拦心跳  →  ' + JSON.stringify(hb));
    });
    const steal = decideGate('orca orchestration run-use --id run_x');
    await t.test('#667 decideGate 拦帅窗 run-use', () => {
      assert.ok(steal.block === true && /coordinator/.test(steal.message), '#667 decideGate 拦帅窗 run-use  →  ' + JSON.stringify(steal));
    });
    const create = decideGate('orca orchestration run-create --objective x');
    await t.test('#667 decideGate 拦帅窗 run-create', () => {
      assert.ok(create.block === true && /coordinator/.test(create.message), '#667 decideGate 拦帅窗 run-create  →  ' + JSON.stringify(create));
    });
    await t.test('dao.mjs dispatch 不是旁路', () => {
      assert.ok(isDispatchBypass('node scripts/dao.mjs dispatch --name x') === false, 'dao.mjs dispatch 不是旁路');
    });
    await t.test('dao.mjs raw 逃生口不是旁路', () => {
      assert.ok(isDispatchBypass('node scripts/dao.mjs raw -- orca orchestration worker-start --task t') === false, 'dao.mjs raw 逃生口不是旁路');
    });
    await t.test('空命令不是旁路', () => {
      assert.ok(isDispatchBypass('') === false && isDispatchBypass(null) === false, '空命令不是旁路');
    });
    await t.test('#575：echo "dao.mjs raw" && worker-start 仍是旁路（关键词出现在别处不算放行）',
      () => {
        assert.ok(isDispatchBypass('echo "dao.mjs raw" && orca orchestration worker-start --task t') === true, '#575：echo "dao.mjs raw" && worker-start 仍是旁路（关键词出现在别处不算放行）');
      });
    await t.test('#575：注释里写 dao.mjs raw 仍是旁路',
      () => {
        assert.ok(isDispatchBypass('orca orchestration worker-start --task t # dao.mjs raw') === true, '#575：注释里写 dao.mjs raw 仍是旁路');
      });
    await t.test('#575：任务书正文提到 dao.mjs raw 的 dispatch 不是旁路',
      () => {
        assert.ok(isDispatchBypass('node scripts/dao.mjs dispatch --spec "请走 dao.mjs raw 不要裸 orca orchestration worker-start"') === false, '#575：任务书正文提到 dao.mjs raw 的 dispatch 不是旁路');
      });
    await t.test('#575：分号连接的 echo + 裸 worker-start 仍是旁路',
      () => {
        assert.ok(isDispatchBypass('echo dao.mjs raw; orca orchestration worker-start --task t') === true, '#575：分号连接的 echo + 裸 worker-start 仍是旁路');
      });
    await t.test('PreToolUse JSON 能抽出 command',
      () => {
        assert.ok(extractHookCommand(JSON.parse(payload('orca orchestration worker-start'))) === 'orca orchestration worker-start', 'PreToolUse JSON 能抽出 command');
      });

    const blocked = decideGate('orca orchestration worker-start --task t');
    await t.test('decideGate 旁路 block + 指向 dao.mjs dispatch',
      () => {
        assert.ok(blocked.block === true && /dao\.mjs dispatch/.test(blocked.message), 'decideGate 旁路 block + 指向 dao.mjs dispatch  →  ' + JSON.stringify(blocked));
      });
  });

  it('故意违规：真跑 hook 进程', async (t) => {
    const { runAsHook } = await GATE_LOAD;
    for (const [label, script] of [['lib', GATE], ['settings hook', HOOK]]) {
      const bypass = runGate(script, 'orca orchestration worker-start --task t --worktree w');
      await t.test(`${label} 故意旁路 worker-start → exit 2`, () => {
        assert.ok(bypass.status === 2, `${label} 故意旁路 worker-start → exit 2  →  status=${bypass.status} ${bypass.stderr}`);
      });
      await t.test(`${label} 提示走 dao.mjs dispatch`, () => {
        assert.ok(/dao\.mjs dispatch/.test(bypass.stderr || ''), `${label} 提示走 dao.mjs dispatch  →  ` + bypass.stderr);
      });
      const raw = runGate(script, 'node scripts/dao.mjs raw -- orca orchestration worker-start --task t');
      await t.test(`${label} 逃生口 raw → 放行`, () => {
        assert.ok(raw.status === 0, `${label} 逃生口 raw → 放行  →  status=${raw.status} ${raw.stderr}`);
      });
      const decoy = runGate(script, 'echo "dao.mjs raw" && orca orchestration worker-start --task t --worktree w');
      await t.test(`${label} 故意违规 echo "dao.mjs raw" && worker-start → exit 2`, () => {
        assert.ok(decoy.status === 2, `${label} 故意违规 echo "dao.mjs raw" && worker-start → exit 2  →  status=${decoy.status} ${decoy.stderr}`);
      });
      const inbox = runGate(script, 'orca orchestration inbox --json');
      await t.test(`${label} 普通 inbox → 放行`, () => {
        assert.ok(inbox.status === 0, `${label} 普通 inbox → 放行  →  status=${inbox.status} ${inbox.stderr}`);
      });
      const send = runGate(script, 'orca orchestration send --type heartbeat --subject alive');
      await t.test(`${label} #667 心跳 → exit 2`, () => {
        assert.ok(send.status === 2 && /心跳不准发/.test(send.stderr || ''), `${label} #667 心跳 → exit 2  →  status=${send.status} ${send.stderr}`);
      });
      const runUse = runGate(script, 'orca orchestration run-use --id run_x');
      await t.test(`${label} #667 裸 run-use → exit 2`, () => {
        assert.ok(runUse.status === 2, `${label} #667 裸 run-use → exit 2  →  status=${runUse.status} ${runUse.stderr}`);
      });
      const crashed = runGate(script, 'orca orchestration send --type heartbeat', { DISPATCH_GATE_CRASH: '1' });
      await t.test(`${label} 故意崩 → exit 2 不放行`, () => {
        assert.ok(crashed.status === 2, `${label} 故意崩 → exit 2 不放行  →  status=${crashed.status} ${crashed.stderr}`);
      });
      await t.test(`${label} 崩了有 fail-closed 字样`, () => {
        assert.ok(/fail-closed|崩/.test(crashed.stderr || ''), `${label} 崩了有 fail-closed 字样  →  ` + crashed.stderr);
      });
    }

    const asHookCrash = runAsHook({ stdinText: payload('orca status'), env: { DISPATCH_GATE_CRASH: '1' } });
    await t.test('runAsHook 崩了也是 exit 2', () => {
      assert.ok(asHookCrash.exit === 2, 'runAsHook 崩了也是 exit 2  →  ' + JSON.stringify(asHookCrash));
    });
  });

  it('检查器：零样本 vs 真闸', async (t) => {
    const { checkDispatchGate } = await CHECK_LOAD;
    const live = checkDispatchGate({ root: REPO });
    await t.test('本仓闸门检查绿', () => {
      assert.ok(!!live.green && !live.fail, '本仓闸门检查绿  →  ' + JSON.stringify(live));
    });

    const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dao-gate-empty-'));
    const empty = checkDispatchGate({ root: emptyRoot });
    await t.test('零样本（没有随仓 .claude/settings.json）→ 报没查成', () => {
      assert.ok(!!empty.fail && /没查成|不在/.test(empty.fail[0] + empty.fail[1]), '零样本（没有随仓 .claude/settings.json）→ 报没查成  →  ' + JSON.stringify(empty));
    });

    const noGateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dao-gate-nogate-'));
    fs.mkdirSync(path.join(noGateRoot, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(noGateRoot, '.claude', 'settings.json'), JSON.stringify({
      hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/scripts/lib/dao-mode.mjs" hook' }] }] },
    }), 'utf8');
    const noGate = checkDispatchGate({ root: noGateRoot });
    await t.test('有 PreToolUse 但无 dispatch-gate 条目 → 报没扫到', () => {
      assert.ok(!!noGate.fail && /没扫到/.test(noGate.fail[0]), '有 PreToolUse 但无 dispatch-gate 条目 → 报没扫到  →  ' + JSON.stringify(noGate));
    });

    const badRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dao-gate-bad-'));
    fs.mkdirSync(path.join(badRoot, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(badRoot, '.claude', 'settings.json'), '{oops', 'utf8');
    const bad = checkDispatchGate({ root: badRoot });
    await t.test('settings.json 坏 JSON → 没查成', () => {
      assert.ok(!!bad.fail && /解析不了/.test(bad.fail[0]), 'settings.json 坏 JSON → 没查成  →  ' + JSON.stringify(bad));
    });

    const ghostRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dao-gate-ghost-'));
    fs.mkdirSync(path.join(ghostRoot, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(ghostRoot, '.claude', 'settings.json'), JSON.stringify({
      hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/scripts/lib/dispatch-gate-ghost.mjs"' }] }] },
    }), 'utf8');
    const ghost = checkDispatchGate({ root: ghostRoot });
    await t.test('闸门指向的脚本不存在 → 报没跑成/指向空气', () => {
      assert.ok(!!ghost.fail && /脚本都没跑成|指向空气/.test(ghost.fail[0]), '闸门指向的脚本不存在 → 报没跑成/指向空气  →  ' + JSON.stringify(ghost));
    });
  });
});