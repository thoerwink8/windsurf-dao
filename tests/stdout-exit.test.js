// #1297：`dao now --json` 必须等 stdout 排空再退出。
// 旧实现 console.log + process.exit 会在管道里截断 JSON 却仍 exit 0。
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const DAO = path.join(REPO, 'scripts', 'dao.mjs');
const HELPER = path.join(REPO, 'scripts', 'lib', 'stdout-exit.mjs');
const load = p => import('file://' + p.replace(/\\/g, '/'));

function extractFn(src, name) {
  const start = String(src).indexOf(`async function ${name}(`);
  assert.ok(start >= 0, `找不到 ${name}`);
  const next = String(src).indexOf('\nasync function ', start + 1);
  const fallback = String(src).indexOf('\nfunction ', start + 1);
  let end = String(src).length;
  if (next >= 0) end = Math.min(end, next);
  if (fallback >= 0) end = Math.min(end, fallback);
  return String(src).slice(start, end);
}

/** 旧病：pretty JSON 打完立刻 process.exit，不等排空。 */
function jsonExitWithoutDrain(src) {
  return /console\.log\s*\(\s*JSON\.stringify[\s\S]*?process\.exit\s*\(/.test(src);
}

const OLD_CMDNOW_JSON = [
  'async function cmdNow(args) {',
  '  const board = renderNow(raw);',
  '  if (args.json === true) {',
  '    console.log(JSON.stringify({ ok: true, elapsedMs: raw.elapsedMs, progressStateDir: progressDir, board }, null, 2));',
  '    process.exit(0);',
  '  }',
  '  process.stdout.write(`推进记录源：${progressDir}\\n${formatNow(board)}\\n`);',
  '  process.exit(0);',
  '}',
].join('\n');

describe('writeStdoutAndExit', () => {
  it('write 返回 true：callback 之后才 exit', async () => {
    const { writeStdoutAndExit } = await load(HELPER);
    let code;
    let cb;
    const stdout = {
      write(_data, onFlush) { cb = onFlush; return true; },
      once() {},
    };
    writeStdoutAndExit('{"ok":true}\n', { stdout, exit: (c) => { code = c; }, code: 0 });
    assert.equal(code, undefined, '还没 flush 不许 exit');
    cb();
    assert.equal(code, 0);
  });

  it('write 返回 false：drain 之前不许 exit', async () => {
    const { writeStdoutAndExit } = await load(HELPER);
    let code;
    let drain;
    const stdout = {
      write() { return false; },
      once(ev, fn) { if (ev === 'drain') drain = fn; },
    };
    writeStdoutAndExit('x'.repeat(64), { stdout, exit: (c) => { code = c; }, code: 0 });
    assert.equal(code, undefined, '还没 drain 不许 exit');
    drain();
    assert.equal(code, 0);
  });

  it('大 pretty JSON 一次 write 完整交给 stdout', async () => {
    const { writeStdoutAndExit } = await load(HELPER);
    const payload = `${JSON.stringify({ ok: true, pad: 'x'.repeat(200000) }, null, 2)}\n`;
    let got = '';
    let code;
    const stdout = {
      write(data, cb) { got += String(data); if (cb) cb(); return true; },
      once() {},
    };
    writeStdoutAndExit(payload, { stdout, exit: (c) => { code = c; }, code: 0 });
    assert.equal(got.length, payload.length);
    assert.equal(got, payload);
    assert.equal(code, 0);
  });

  it('callback 与 drain 都到也只 exit 一次', async () => {
    const { writeStdoutAndExit } = await load(HELPER);
    let n = 0;
    let cb;
    let drain;
    const stdout = {
      write(_data, onFlush) { cb = onFlush; return false; },
      once(ev, fn) { if (ev === 'drain') drain = fn; },
    };
    writeStdoutAndExit('x', { stdout, exit: () => { n += 1; } });
    cb();
    drain();
    assert.equal(n, 1);
  });
});

describe('dao now/board JSON 出口：旧实现违规样本必须拦下', () => {
  it('构造旧实现（console.log + process.exit）必须被判违规', () => {
    assert.equal(jsonExitWithoutDrain(OLD_CMDNOW_JSON), true);
  });

  it('现役 cmdNow / cmdBoard 不再立刻 process.exit，走 writeStdoutAndExit', () => {
    const src = fs.readFileSync(DAO, 'utf8');
    const now = extractFn(src, 'cmdNow');
    const board = extractFn(src, 'cmdBoard');
    assert.equal(jsonExitWithoutDrain(now), false, now);
    assert.equal(jsonExitWithoutDrain(board), false, board);
    assert.match(now, /writeStdoutAndExit/);
    assert.match(board, /writeStdoutAndExit/);
    assert.match(now, /null,\s*2/, 'pretty JSON 结构保留');
    assert.match(now, /ok:\s*true/);
    assert.match(now, /elapsedMs:\s*raw\.elapsedMs/);
    assert.match(now, /progressStateDir:\s*progressDir/);
    assert.match(now, /推进记录源/);
    assert.match(now, /formatNow\(board/);
    assert.match(now, /DEFAULT_MAX_LINES/);
  });
});
