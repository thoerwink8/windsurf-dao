// #802：start=agent 落裸 shell 的屏面分类 / 回退计划 / launchAttempts
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const LIB = path.join(REPO, 'scripts', 'lib', 'dispatch', 'agent-ready.mjs');
const CLI = path.join(REPO, 'scripts', 'dao.mjs');
const S_LOAD = import('file://' + LIB.replace(/\\/g, '/'));

describe('dispatch-agent-ready（#802）', () => {
  it('classifyAgentScreen：裸 shell / 注入被吃 / TUI 指纹 / 空 / spinner 分开', async (t) => {
    const S = await S_LOAD;

    await t.test('故意违规：读: command not found → shell-ate-inject', () => {
      const r = S.classifyAgentScreen('读: command not found\norca@host:~/w$ ');
      assert.ok(r.kind === 'shell-ate-inject', 'command not found  →  ' + JSON.stringify(r));
    });
    await t.test('bash: 读: command not found 同样算注入被吃', () => {
      const r = S.classifyAgentScreen("bash: 读: command not found");
      assert.ok(r.kind === 'shell-ate-inject', JSON.stringify(r));
    });
    await t.test('Linux 提示符 → bare-shell', () => {
      const r = S.classifyAgentScreen('Last login: Thu Sep  3\norca@vmi123456:~$ ');
      assert.ok(r.kind === 'bare-shell', JSON.stringify(r));
    });
    await t.test('PS 提示符 → bare-shell', () => {
      const r = S.classifyAgentScreen('PS C:\\Users\\orca> ');
      assert.ok(r.kind === 'bare-shell', JSON.stringify(r));
    });
    await t.test('Grok TUI 真语料 → agent-ready，不因 $ 误判', () => {
      const grok = fs.readFileSync(path.join(REPO, 'tests', 'fixtures', 'orca-json', 'terminal-read.json'), 'utf8');
      const tail = JSON.parse(grok).result.terminal.tail.join('\n');
      const r = S.classifyAgentScreen(tail);
      assert.ok(r.kind === 'agent-ready', 'Grok TUI  →  ' + JSON.stringify(r));
    });
    await t.test('Ask Devin to build → agent-ready（不是裸 shell）', () => {
      const r = S.classifyAgentScreen('Ask Devin to build something');
      assert.ok(r.kind === 'agent-ready', JSON.stringify(r));
    });
    await t.test('空屏 → empty，不当回退', () => {
      const r = S.classifyAgentScreen('   \n');
      assert.ok(r.kind === 'empty' && S.shouldFallbackToCommand(r) === false, JSON.stringify(r));
    });
    await t.test('spinner 不当回退', () => {
      const r = S.classifyAgentScreen('⠋ Starting MCP servers (1/5)');
      assert.ok(r.kind === 'spinner' && S.shouldFallbackToCommand(r) === false, JSON.stringify(r));
    });
  });

  it('planAgentScreenFallback：只在裸 shell 实证上回退；没 command 就 fail-loud', async (t) => {
    const S = await S_LOAD;
    const ate = S.classifyAgentScreen('读: command not found');
    await t.test('注入被吃 + 有 launch.command → fallback', () => {
      const p = S.planAgentScreenFallback({ screen: ate, command: 'pi --model gw-dspool/deepseek-v4-flash' });
      assert.ok(p.action === 'fallback' && p.command.startsWith('pi --model'), JSON.stringify(p));
    });
    await t.test('故意违规：注入被吃但没 command → fail（不许假装已派）', () => {
      const p = S.planAgentScreenFallback({ screen: ate, command: '' });
      assert.ok(p.action === 'fail' && /launch\.command/.test(p.error), JSON.stringify(p));
    });
    await t.test('Grok TUI → keep', () => {
      const p = S.planAgentScreenFallback({
        screen: S.classifyAgentScreen('Grok Build  1.0.1  always-approve'),
        command: 'grok -m grok-4.6',
      });
      assert.ok(p.action === 'keep', JSON.stringify(p));
    });
    await t.test('空屏 → keep（可能还在起，不当回退）', () => {
      const p = S.planAgentScreenFallback({ screen: S.classifyAgentScreen(''), command: 'pi --model x' });
      assert.ok(p.action === 'keep', JSON.stringify(p));
    });
  });

  it('launchAttempt 记行：成功路径也有字段，不再是空对象乱入', async () => {
    const S = await S_LOAD;
    const row = S.launchAttempt({
      modelId: 'deepseek-v4-flash', pipeIndex: 0, provider: 'gw',
      mode: 'agent', kind: 'deferred', agentId: 'pi',
    });
    assert.ok(row.mode === 'agent' && row.kind === 'deferred' && row.agentId === 'pi' && row.provider === 'gw',
      JSON.stringify(row));
    const emptyErr = S.launchAttempt({ mode: 'agent', kind: 'agent-ready', error: '' });
    assert.ok(!('error' in emptyErr), '空 error 不写进行  →  ' + JSON.stringify(emptyErr));
  });

  it('dao.mjs 接线：startOrcaWorker 探屏回退；startWorkerBySlate 成功也记 attempts', () => {
    const src = fs.readFileSync(CLI, 'utf8');
    const startFn = src.match(/function startOrcaWorker[\s\S]*?\nfunction startWorkerBySlate/);
    assert.ok(startFn, '定位 startOrcaWorker');
    assert.ok(/classifyAgentScreen\(/.test(startFn[0]) && /planAgentScreenFallback\(/.test(startFn[0]),
      'startOrcaWorker 要探屏并走回退计划');
    assert.ok(/argsTerminalSend\(/.test(startFn[0]) && /argsTerminalWait\(/.test(startFn[0]),
      '回退要往已有终端送 launch 命令并 wait tui-idle');
    assert.ok(/fellBackToCommand/.test(startFn[0]), '回退后跳过补粘/补回车');

    const slateFn = src.match(/function startWorkerBySlate[\s\S]*?\nfunction readOnceHandle/);
    assert.ok(slateFn, '定位 startWorkerBySlate');
    assert.ok(/kind: 'deferred'/.test(slateFn[0]) && /kind: 'created'/.test(slateFn[0]),
      '成功路径也要 push launchAttempt，launchAttempts 不许再是空数组');
    assert.ok(!/waitAndVerify/.test(slateFn[0]), 'startWorkerBySlate 不把旧就绪探针请回来');
  });
});
