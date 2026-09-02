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
      const r = S.classifyAgentScreen('读: command not found\norca@host:~$ ');
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

  it('agentIdentity：校准到 agent 终端，不许把空壳当注入目标', async (t) => {
    const S = await S_LOAD;
    const wt = 'repo::/work';
    const shell = { handle: 'term_shell', worktreeId: wt, title: 'Terminal 1', agentIdentity: null, preview: 'user@host:~$ ' };
    const coord = { handle: 'term_coord', worktreeId: wt, title: '派工协调（勿关）', agentIdentity: null };
    const pi = { handle: 'term_pi', worktreeId: wt, title: 'pi session', agentIdentity: 'pi', preview: 'pi ready' };
    const grok = { handle: 'term_grok', worktreeId: wt, title: 'Grok', agentIdentity: 'grok' };

    await t.test('字段在但空 = shell；有值 = agent；字段不在 = unknown', () => {
      assert.ok(S.classifyTerminalRole(shell).kind === 'shell', JSON.stringify(S.classifyTerminalRole(shell)));
      assert.ok(S.classifyTerminalRole(pi).kind === 'agent' && S.classifyTerminalRole(pi).agentIdentity === 'pi');
      assert.ok(S.classifyTerminalRole({ handle: 'term_old', title: 'Grok' }).kind === 'unknown');
    });
    await t.test('故意违规：claimed 是空壳、旁边有 pi → calibrate，不往壳送 launch', () => {
      const p = S.planInjectTarget({
        claimedHandle: 'term_shell',
        terminals: [shell, coord, pi],
        worktreeId: wt,
        wantAgentId: 'pi',
      });
      assert.ok(p.action === 'calibrate' && p.handle === 'term_pi' && p.fromHandle === 'term_shell', JSON.stringify(p));
    });
    await t.test('claimed 已是 agent → keep', () => {
      const p = S.planInjectTarget({
        claimedHandle: 'term_grok', terminals: [shell, grok], worktreeId: wt, wantAgentId: 'grok',
      });
      assert.ok(p.action === 'keep' && p.handle === 'term_grok', JSON.stringify(p));
    });
    await t.test('只有空壳 → fallback-command', () => {
      const p = S.planInjectTarget({
        claimedHandle: 'term_shell', terminals: [shell, coord], worktreeId: wt, wantAgentId: 'pi',
      });
      assert.ok(p.action === 'fallback-command', JSON.stringify(p));
    });
    await t.test('老回包没 agentIdentity → unscanned，不是当成 0 个 agent', () => {
      const p = S.planInjectTarget({
        claimedHandle: 'term_x',
        terminals: [{ handle: 'term_x', worktreeId: wt, title: 'Terminal 1' }],
        worktreeId: wt,
      });
      assert.ok(p.action === 'unscanned', JSON.stringify(p));
    });
    await t.test('list 不是数组 → unscanned', () => {
      const p = S.planInjectTarget({ claimedHandle: 'term_x', terminals: null });
      assert.ok(p.action === 'unscanned', JSON.stringify(p));
    });
  });

  it('requireBookForRepair / planRepairSends：缺任务书不能记 fallback-ok', async (t) => {
    const S = await S_LOAD;
    const ate = S.classifyAgentScreen('读: command not found');
    const book = '读 host/skills/dispatch/templates/soldier-book.md spec=短摘要';

    await t.test('calibrate 没 book → fail，sends 空', () => {
      const r = S.requireBookForRepair({ action: 'calibrate', book: '' });
      assert.ok(!r.ok && /没传 book/.test(r.error), JSON.stringify(r));
      const p = S.planRepairSends({ action: 'calibrate', book: '   ' });
      assert.ok(p.action === 'fail' && p.kind === 'book-missing' && p.sends.length === 0, JSON.stringify(p));
    });
    await t.test('calibrate 有 book → 只重送 book', () => {
      const p = S.planRepairSends({ action: 'calibrate', book });
      assert.ok(p.action === 'resend' && p.book === book && p.sends.join(',') === 'book', JSON.stringify(p));
    });
    await t.test('故意违规：裸 shell 回退但没 book → fail，不是 fallback-ok', () => {
      const p = S.planRepairSends({
        action: 'fallback-command', screen: ate, command: 'pi --model gw-dspool/deepseek-v4-flash', book: '',
      });
      assert.ok(p.action === 'fail' && p.kind === 'book-missing' && p.sends.length === 0, JSON.stringify(p));
    });
    await t.test('裸 shell + command + book → command、等 TUI、再送书', () => {
      const p = S.planRepairSends({
        action: 'fallback-command', screen: ate, command: 'pi --model x', book,
      });
      assert.ok(p.action === 'fallback' && p.sends.join(',') === 'command,wait-tui,book' && p.book === book,
        JSON.stringify(p));
    });
    await t.test('keep 不要求 book（worker-start 已注入）', () => {
      const r = S.requireBookForRepair({ action: 'keep', book: '' });
      assert.ok(r.ok && r.needed === false, JSON.stringify(r));
    });
    await t.test('屏面已是 TUI → keep，空 book 也不回退', () => {
      const p = S.planRepairSends({
        action: 'fallback-command',
        screen: S.classifyAgentScreen('Grok Build  1.0.1  always-approve'),
        command: 'grok -m grok-4.6',
        book: '',
      });
      assert.ok(p.action === 'keep' && p.sends.length === 0, JSON.stringify(p));
    });
    await t.test('裸 shell 但没 launch.command → fail 不是 book-missing', () => {
      const p = S.planRepairSends({ action: 'fallback-command', screen: ate, command: '', book });
      assert.ok(p.action === 'fail' && p.kind !== 'book-missing' && /launch\.command/.test(p.error), JSON.stringify(p));
    });
  });

  it('dao.mjs 接线：校准 agentIdentity 再注入；startWorkerBySlate 成功也记 attempts', () => {
    const src = fs.readFileSync(CLI, 'utf8');
    const startFn = src.match(/function startOrcaWorker[\s\S]*?\nfunction startWorkerBySlate/);
    assert.ok(startFn, '定位 startOrcaWorker');
    assert.ok(/planInjectTarget\(/.test(startFn[0]), 'startOrcaWorker 要按 agentIdentity 校准 handle');
    assert.ok(/planRepairSends\(/.test(startFn[0]), '校准/回退按 planRepairSends 决定送什么');
    assert.ok(/kind: injected\.ok \? 'resend-ok'/.test(startFn[0]), '校准后重送任务书到 agent 终端');
    assert.ok(/action === 'fallback-command'/.test(startFn[0]), '没有 agent 终端才回退 --command');
    assert.ok(/fellBackToCommand/.test(startFn[0]), '回退后跳过补粘/补回车');
    assert.ok(/repair\.kind/.test(startFn[0]) && /book-missing/.test(fs.readFileSync(LIB, 'utf8')),
      '缺任务书记 book-missing，不许 fallback-ok');
    assert.ok(!/if \(book\)/.test(startFn[0]), '回退/校准不得 if (book) 跳过重送');
    assert.ok(/repair\.book/.test(startFn[0]) && /repair\.command/.test(startFn[0]),
      '回退路径要先送 launch.command 再送 repair.book');
    const cmdSendAt = startFn[0].indexOf('text: repair.command');
    const injectBookAt = startFn[0].lastIndexOf('text: repair.book');
    const fallbackOkAt = startFn[0].indexOf("kind: 'fallback-ok'");
    assert.ok(cmdSendAt > 0 && injectBookAt > cmdSendAt && fallbackOkAt > injectBookAt,
      '回退顺序必须是 command → 重送任务书 → 才记 fallback-ok');

    const slateFn = src.match(/function startWorkerBySlate[\s\S]*?\nfunction readOnceHandle/);
    assert.ok(slateFn, '定位 startWorkerBySlate');
    assert.ok(/kind: 'deferred'/.test(slateFn[0]) && /kind: 'created'/.test(slateFn[0]),
      '成功路径也要 push launchAttempt，launchAttempts 不许再是空数组');
    assert.ok(!/waitAndVerify/.test(slateFn[0]), 'startWorkerBySlate 不把旧就绪探针请回来');
  });

  it('每个 startOrcaWorker 调用点都传 book（审官红：子工人/批派/审官入口漏传）', () => {
    const src = fs.readFileSync(CLI, 'utf8');
    const needle = 'startOrcaWorker({';
    const calls = [];
    let from = 0;
    while (true) {
      const i = src.indexOf(needle, from);
      if (i < 0) break;
      const isDef = src.slice(Math.max(0, i - 9), i) === 'function ';
      let depth = 0;
      let j = i + needle.length - 1;
      for (; j < src.length; j++) {
        if (src[j] === '{') depth++;
        else if (src[j] === '}') {
          depth--;
          if (depth === 0) {
            j++;
            break;
          }
        }
      }
      const block = src.slice(i, j);
      if (!isDef) calls.push({ index: i, block });
      from = i + needle.length;
    }
    assert.ok(calls.length >= 6, '至少 6 个调用点（主派/子工人/批派/复用审官/create/attach），实际 ' + calls.length);
    for (const c of calls) {
      assert.ok(/\bbook\s*:/.test(c.block) || /(^|[,\s])book\s*[,}]/.test(c.block),
        '调用点没传 book：' + c.block.slice(0, 280));
    }
  });
});
