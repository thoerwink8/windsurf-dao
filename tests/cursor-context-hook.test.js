// cursor-context-hook.mjs 薄适配层（#707）：把 只报不拦 子脚本的 stdout 包成
// Cursor 认识的 JSON（additional_context 注入会话上下文），永远 exit 0。
// 验的是：JSON 形状对、没查成≠查过没事、不复制判定逻辑（子脚本原样跑）。

const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const ADAPTER = path.join(REPO, 'scripts', 'lib', 'cursor-context-hook.mjs');
const FIXTURE = 'tests/fixtures/cursor-hook-echo.mjs';
const LOAD = import('file://' + ADAPTER.replace(/\\/g, '/'));

function runAdapter(args, envExtra = {}) {
  return spawnSync(process.execPath, [ADAPTER, ...args], {
    encoding: 'utf8',
    timeout: 15000,
    windowsHide: true,
    env: { ...process.env, ...envExtra },
  });
}

describe('cursor-context-hook', () => {
  it('真进程：子脚本输出包成 additional_context，exit 0', () => {
    const r = runAdapter([FIXTURE]);
    let doc = null;
    try { doc = JSON.parse(String(r.stdout || '').trim()); } catch { /* 下面断言 */ }
    assert.ok(r.status === 0, '适配层应 exit 0  →  status=' + r.status);
    assert.ok(doc && doc.continue === true, '应 continue:true  →  ' + r.stdout);
    assert.ok(doc.additional_context === '[盘] fixture 行', '子脚本输出原样进 additional_context  →  ' + JSON.stringify(doc));
  });

  it('真进程：子脚本静默（非帥位等）→ 无 additional_context 的空放行 JSON', () => {
    // 用不存在但可被 resolveChild 拒绝的参数走「没指定」路径测 JSON 形状即可；
    // 静默路径在函数层验（wrapChild 注入假 exec）。
    const r = runAdapter([]);
    let doc = null;
    try { doc = JSON.parse(String(r.stdout || '').trim()); } catch { /* 下面断言 */ }
    assert.ok(r.status === 0 && doc && doc.continue === true && typeof doc.additional_context === 'string',
      '没指定子脚本应仍 exit 0 + 可辨认没查成行  →  ' + r.stdout);
  });

  it('真进程：子脚本不存在 → 没查成行（≠ 查过没事），仍 exit 0', () => {
    const r = runAdapter(['no-such-script.mjs']);
    let doc = null;
    try { doc = JSON.parse(String(r.stdout || '').trim()); } catch { /* 下面断言 */ }
    assert.ok(r.status === 0, '子脚本不存在应 exit 0  →  status=' + r.status);
    assert.ok(doc && doc.continue === true && /没跑成|没查成/.test(doc.additional_context || ''),
      '子脚本不存在应报可辨认没跑成  →  ' + r.stdout);
  });

  it('函数层：resolveChild 只收 scripts/lib 文件名或仓库根相对路径', async () => {
    const { resolveChild } = await LOAD;
    const plain = resolveChild('board-hook.mjs');
    assert.ok(plain === path.join(REPO, 'scripts', 'lib', 'board-hook.mjs'), '文件名解析到 scripts/lib  →  ' + plain);
    const rel = resolveChild('tests/fixtures/cursor-hook-echo.mjs');
    assert.ok(rel === path.join(REPO, 'tests', 'fixtures', 'cursor-hook-echo.mjs'), '带分隔符解析到仓库根  →  ' + rel);
    assert.ok(resolveChild('') === null && resolveChild(null) === null, '空参数 → null');
  });

  it('函数层：wrapChild 注入 exec 的四种形状', async () => {
    const { wrapChild } = await LOAD;
    const ok = wrapChild({ child: 'x', exec: () => ({ status: 0, stdout: '[盘] 在途无', stderr: '' }) });
    assert.ok(JSON.parse(ok).continue === true && JSON.parse(ok).additional_context === '[盘] 在途无', '有输出 → 包 additional_context  →  ' + ok);

    const silent = wrapChild({ child: 'x', exec: () => ({ status: 0, stdout: '', stderr: '' }) });
    assert.deepStrictEqual(JSON.parse(silent), { continue: true }, '静默 → 空放行 JSON  →  ' + silent);

    const fail = wrapChild({ child: 'x', exec: () => ({ status: 1, stdout: '', stderr: 'boom' }) });
    const failDoc = JSON.parse(fail);
    assert.ok(failDoc.continue === true && /没跑成/.test(failDoc.additional_context) && /boom/.test(failDoc.additional_context),
      '子脚本非 0 → 没跑成行（≠ 查过没事）  →  ' + fail);

    const timeout = wrapChild({ child: 'x', exec: () => ({ error: { code: 'ETIMEDOUT', message: 'spawnSync ETIMEDOUT' }, status: null, stdout: '', stderr: '' }) });
    const tDoc = JSON.parse(timeout);
    assert.ok(tDoc.continue === true && /超时没查成/.test(tDoc.additional_context || ''),
      '子脚本超时 → 超时没查成行（≠ 查过没事）  →  ' + timeout);

    const none = wrapChild({ child: null });
    assert.ok(JSON.parse(none).continue === true && /没指定/.test(JSON.parse(none).additional_context), '没给子脚本 → 没指定  →  ' + none);
  });
});
