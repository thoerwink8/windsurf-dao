// 工具使用闸（用户 2026-09-05 经 admit-push 选「做成闸」）。
//
// 每条对着一个实咬：同一轮对话里两条已有 memory 被踩三次——
// heredoc-eats-backslash-escapes ×2（其中一次把 3 个真 NUL 写进测试文件，之后 Edit 匹配不上）、
// python-stub-use-py ×1（WindowsApps stub，exit 49，命令「成功」一个字没写进去）。
//
// 最要紧的一组是反证：违规必须被注中，正常必须不被注中。两头都没有判别力 = 这闸不存在。
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..');
const LIB = 'file://' + path.join(REPO, 'scripts', 'lib', 'tool-use-gate.mjs').replace(/\\/g, '/');
const HOOK = path.join(REPO, 'host', 'skills', 'tool-use-gate', 'hooks', 'tool-use-gate.mjs');
const HOOKS_JSON = path.join(REPO, 'host', 'skills', 'tool-use-gate', 'hooks', 'hooks.json');
const LOAD = import(LIB);

function payload(command, tool = 'Bash') {
  return JSON.stringify({
    hook_event_name: 'PreToolUse',
    tool_name: tool,
    tool_input: { command },
  });
}

function runHook(command, tool) {
  return spawnSync(process.execPath, [HOOK], {
    windowsHide: true,
    encoding: 'utf8',
    input: payload(command, tool),
    timeout: 8000,
  });
}

function parseOut(r) {
  const raw = String(r.stdout || '').trim();
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return { _unparsed: raw }; }
}

describe('工具使用闸：heredoc 吞转义', () => {
  it('违规样本：heredoc 写 .mjs 且含 \\n —— 必须被注中', async () => {
    const S = await LOAD;
    const cmd = "cat > tests/foo.test.js <<'EOF'\nconst re = /\\s+/;\nEOF";
    const notes = S.classifyBash(cmd);
    assert.ok(notes.some((n) => n.id === 'heredoc-escape'), JSON.stringify(notes));
    assert.match(S.renderToolUseGate(notes), /吞掉/);
  });

  it('违规样本：不引号的 <<EOF 写 .ts 且含 \\d —— 同样注', async () => {
    const S = await LOAD;
    const cmd = 'cat > src/x.ts <<EOF\nfoo = /\\d+/\nEOF';
    assert.ok(S.isHeredocEscape(cmd), cmd);
  });

  it('反证：正常 heredoc 不含转义 —— 不许注', async () => {
    const S = await LOAD;
    const cmd = "cat > scripts/hello.mjs <<'EOF'\nconsole.log('hi');\nEOF";
    assert.equal(S.isHeredocEscape(cmd), false, cmd);
    assert.equal(S.classifyBash(cmd).length, 0);
  });

  it('反证：heredoc 含转义但目标不是 js/ts（.sh / .md）—— 不许注', async () => {
    const S = await LOAD;
    assert.equal(S.isHeredocEscape("cat > run.sh <<'EOF'\necho \\n\nEOF"), false);
    assert.equal(S.isHeredocEscape("cat > note.md <<EOF\n\\\\n means newline\nEOF"), false);
  });

  it('反证：Edit/拼接写 .mjs 含 \\n 但没有 heredoc —— 不许注', async () => {
    const S = await LOAD;
    assert.equal(S.isHeredocEscape('node -e "fs.writeFileSync(\'a.mjs\', \'/\\\\s+/\')"'), false);
  });

  it('heredoc 探测：<<-EOF / <<"EOF" 都算；光 << 不算', async () => {
    const S = await LOAD;
    assert.equal(S.hasHeredoc('cat <<-EOF\nhi\nEOF'), true);
    assert.equal(S.hasHeredoc('cat <<"END"\nhi\nEND'), true);
    assert.equal(S.hasHeredoc('echo a << b'), false);
    assert.equal(S.hasHeredoc('echo a <<'), false);
    assert.equal(S.hasHeredoc(''), false);
  });
});

describe('工具使用闸：python 是 stub', () => {
  it('违规样本：裸 python -c —— 必须被注中', async () => {
    const S = await LOAD;
    const notes = S.classifyBash('python -c "print(1)"');
    assert.ok(notes.some((n) => n.id === 'python-stub'), JSON.stringify(notes));
    assert.match(S.renderToolUseGate(notes), /stub/);
  });

  it('违规样本：python.exe / WindowsApps 路径 —— 同样注', async () => {
    const S = await LOAD;
    assert.equal(S.isPythonStub('python.exe -c "open(r\'a.txt\',\'w\').write(\'x\')"'), true);
    assert.equal(S.isPythonStub('C:\\Users\\x\\AppData\\Local\\Microsoft\\WindowsApps\\python.exe -c pass'), true);
    assert.equal(S.isPythonStub('/usr/bin/python -c pass'), true);
  });

  it('反证：py / python3 / python3.12 —— 不许注', async () => {
    const S = await LOAD;
    assert.equal(S.isPythonStub('py -3 -c "print(1)"'), false);
    assert.equal(S.isPythonStub('python3 -c "print(1)"'), false);
    assert.equal(S.isPythonStub('python3.12 script.py'), false);
    assert.equal(S.isPythonStub('/usr/bin/python3 -c pass'), false);
    assert.equal(S.classifyBash('py -c "print(1)"').length, 0);
  });

  it('反证：python 只出现在参数里（echo python）—— 不许注', async () => {
    const S = await LOAD;
    assert.equal(S.isPythonStub('echo python is a stub'), false);
    assert.equal(S.isPythonStub('node -e "console.log(\'python\')"'), false);
  });

  it('管道/列表里第一词是 python 也注（python && echo ok）', async () => {
    const S = await LOAD;
    assert.equal(S.isPythonStub('python -c pass && echo ok'), true);
    assert.equal(S.isPythonStub('echo hi; python -c pass'), true);
  });
});

describe('工具使用闸：两条可以同时命中，空命令不注', () => {
  it('heredoc 写 .mjs 含转义，同时又调 python —— 两条都注，顺序稳定', async () => {
    const S = await LOAD;
    const cmd = "python -c pass; cat > a.mjs <<'EOF'\n/\\s+/\nEOF";
    const notes = S.classifyBash(cmd);
    assert.deepEqual(notes.map((n) => n.id), ['heredoc-escape', 'python-stub']);
  });

  it('空 / 非字符串 / 普通 ls —— 空数组，render 出空串', async () => {
    const S = await LOAD;
    assert.deepEqual(S.classifyBash(''), []);
    assert.deepEqual(S.classifyBash(null), []);
    assert.deepEqual(S.classifyBash('ls -la'), []);
    assert.equal(S.renderToolUseGate([]), '');
    assert.equal(S.renderWarning([]), '');
  });
});

describe('工具使用闸：hook 入口（真进程）不拦、只注', () => {
  it('故意违规 heredoc 被当场注中（上线证据形态，不是「已安装」）', () => {
    const cmd = "cat > tests/x.test.js <<'EOF'\nconst re = /\\n/;\nEOF";
    const r = runHook(cmd);
    assert.equal(r.status, 0, `exit 必须 0，拦了就错：${r.stderr}`);
    assert.equal(String(r.stderr || '').trim(), '', '不许写 stderr（别的 hook 语义里 stderr+非零=拦截）');
    const out = parseOut(r);
    assert.ok(out && out.hookSpecificOutput, JSON.stringify(out));
    assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.match(out.hookSpecificOutput.additionalContext, /吞掉/);
    assert.match(out.systemMessage, /heredoc-escape/);
  });

  it('故意违规 python 被当场注中', () => {
    const r = runHook('python -c "open(\'a.txt\',\'w\').write(\'x\')"');
    assert.equal(r.status, 0, r.stderr);
    const out = parseOut(r);
    assert.match(out.hookSpecificOutput.additionalContext, /stub/);
    assert.match(out.systemMessage, /python-stub/);
  });

  it('反证：不含转义的 heredoc —— 不吐字、exit 0', () => {
    const r = runHook("cat > scripts/hello.mjs <<'EOF'\nconsole.log('hi');\nEOF");
    assert.equal(r.status, 0, r.stderr);
    assert.equal(String(r.stdout || '').trim(), '');
    assert.equal(String(r.stderr || '').trim(), '');
  });

  it('反证：py 命令 —— 不吐字', () => {
    const r = runHook('py -3 -c "print(1)"');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(String(r.stdout || '').trim(), '');
  });

  it('反证：不是 Bash 工具（Edit）—— 闭嘴', () => {
    const r = runHook('python -c pass', 'Edit');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(String(r.stdout || '').trim(), '');
  });

  it('坏 stdin 不许非零退出', () => {
    const r = spawnSync(process.execPath, [HOOK], {
      windowsHide: true,
      encoding: 'utf8',
      input: '{这不是合法 JSON',
      timeout: 8000,
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(String(r.stdout || '').trim(), '');
  });
});

describe('工具使用闸：装载声明与随仓挂载面对得上', () => {
  it('hooks.json 声明 PreToolUse，matcher 只网 Bash', () => {
    const raw = fs.readFileSync(HOOKS_JSON, 'utf8');
    assert.ok(!raw.startsWith('\uFEFF'), 'hooks.json 带 BOM——宿主解析不了');
    const doc = JSON.parse(raw);
    const entries = doc?.hooks?.PreToolUse;
    assert.ok(Array.isArray(entries) && entries.length, 'hooks.json 里没有 PreToolUse');
    const matchers = entries.map((e) => e.matcher).filter(Boolean);
    assert.ok(matchers.some((m) => new RegExp(m).test('Bash')), 'matcher 匹配不到 Bash');
    for (const other of ['AskUserQuestion', 'Read', 'Edit', 'mcp__mirasim__im_ask_user']) {
      assert.ok(!matchers.some((m) => new RegExp(m).test(other)), `matcher 把 ${other} 也网进来了`);
    }
  });

  it('声明里点到的脚本真的在（注册指向空气是常见死法）', () => {
    const doc = JSON.parse(fs.readFileSync(HOOKS_JSON, 'utf8'));
    const cmds = doc.hooks.PreToolUse.flatMap((e) => (e.hooks || []).map((h) => h.command));
    assert.ok(cmds.length, '一条 command 都没有');
    for (const c of cmds) {
      const m = c.match(/hooks\/([\w.-]+\.mjs)/);
      assert.ok(m, `command 里看不出脚本名：${c}`);
      assert.ok(fs.existsSync(path.join(REPO, 'host', 'skills', 'tool-use-gate', 'hooks', m[1])), `声明点到的 ${m[1]} 不在`);
    }
  });

  it('随仓 .claude/settings.json 真挂了本闸（插件 hooks.json 不响，ask-gate 2026-09-05 实证）', async () => {
    const S = await LOAD;
    const settings = JSON.parse(fs.readFileSync(path.join(REPO, '.claude', 'settings.json'), 'utf8'));
    const entries = settings.hooks?.PreToolUse || [];
    const cmds = entries.flatMap((e) => (e.hooks || []).map((h) => h.command));
    assert.ok(cmds.some((c) => c.includes('tool-use-gate')), `随仓 settings 没挂 tool-use-gate：${JSON.stringify(cmds)}`);
    const ours = entries.filter((e) => (e.hooks || []).some((h) => String(h.command || '').includes('tool-use-gate')));
    assert.ok(ours.length, '找不到本闸那条 PreToolUse');
    for (const e of ours) {
      assert.ok(e.matcher, '随仓这条必须有 matcher，否则对每个工具都跑');
      assert.ok(new RegExp(e.matcher).test('Bash'), `matcher 匹配不到 Bash：${e.matcher}`);
      for (const other of ['AskUserQuestion', 'Read', 'Edit']) {
        assert.ok(!new RegExp(e.matcher).test(other), `matcher 把 ${other} 也网进来了`);
      }
    }
    for (const tool of S.BASH_TOOLS) {
      assert.ok(ours.some((e) => new RegExp(e.matcher).test(tool)), `matcher 覆盖不到 ${tool}`);
    }
  });

  it('hook 脚本本身不 spawn（要 spawn 必须带 windowsHide；本闸没有理由 spawn）', () => {
    const src = fs.readFileSync(HOOK, 'utf8');
    assert.ok(!/spawn(?:Sync)?\(/.test(src), '本闸 hook 不该 spawn；每轮 Bash 闪窗见 platform-adapter-deleted-while-still-used');
  });

  it('本测试文件自己的 spawnSync 带了 windowsHide（检查器也在这条例上）', () => {
    const src = fs.readFileSync(__filename, 'utf8');
    const spawns = [...src.matchAll(/spawnSync\(/g)];
    assert.ok(spawns.length >= 1, '本文件至少有一次真跑 hook');
    assert.ok(/windowsHide:\s*true/.test(src), 'spawnSync 必须 windowsHide: true');
  });
});
