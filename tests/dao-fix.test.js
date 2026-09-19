// dao-fix：机械项（行尾/尾随空白/末行换行）的判别样本。判据：该修的必须被修/被报，干净的不许动。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..');
const SCRIPT = path.join(REPO, 'scripts', 'dao-fix.mjs');

/** 在临时目录里造一个最小 git 仓 + 一个「脏」文件，跑 --check / --files。 */
function fixture(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dao-fix-'));
  fs.writeFileSync(path.join(dir, 'dirty.txt'), content);
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.copyFileSync(SCRIPT, path.join(dir, 'scripts', 'dao-fix.mjs'));
  return dir;
}

test('--check 能报出 CRLF/尾随空白/末行换行（三样都认）', () => {
  const dir = fixture('a\r\nb  \n\n');
  const r = spawnSync('node', [path.join(dir, 'scripts', 'dao-fix.mjs'), '--check', '--files', 'dirty.txt'], {
    cwd: dir,
    encoding: 'utf8',
  }).stdout;
  assert.match(r, /CRLF→LF/);
  assert.match(r, /尾随空白/);
  assert.match(r, /末行换行/);
});

test('--check 对干净文件不报，且不改盘', () => {
  const dir = fixture('a\nb\n');
  const before = fs.readFileSync(path.join(dir, 'dirty.txt'), 'utf8');
  const r = spawnSync('node', [path.join(dir, 'scripts', 'dao-fix.mjs'), '--check', '--files', 'dirty.txt'], {
    cwd: dir,
    encoding: 'utf8',
  }).stdout;
  assert.match(r, /干净 1/);
  assert.equal(fs.readFileSync(path.join(dir, 'dirty.txt'), 'utf8'), before, '--check 不许改盘');
});

test('真修：修完内容恰好是「LF + 无尾随空白 + 单个末行换行」', () => {
  const dir = fixture('a\r\nb  \n\n\n');
  execFileSync('node', [path.join(dir, 'scripts', 'dao-fix.mjs'), '--files', 'dirty.txt'], {
    cwd: dir,
    encoding: 'utf8',
  });
  assert.equal(fs.readFileSync(path.join(dir, 'dirty.txt'), 'utf8'), 'a\nb\n');
});

test('二进制/声明按字节原样的文件不碰', () => {
  const dir = fixture('x\u0000\r\ny\n');
  const r = spawnSync('node', [path.join(dir, 'scripts', 'dao-fix.mjs'), '--check', '--files', 'dirty.txt'], {
    cwd: dir,
    encoding: 'utf8',
  }).stdout;
  assert.match(r, /含 NUL/);
});
