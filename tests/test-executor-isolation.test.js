// tests/test-executor-isolation.test.js —— #1152 测试隔离闸的判别力
//
// 本文件自己也在 live 扫描面内：违规样本必须拼出来，不能直接写调用字面量，
// 否则检查器的产出污染自己的判据（spawn-budget 同一条坑）。

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  classifyTestDispatchSpawns,
  collectSpawnAliases,
  inspectTestExecutorIsolationFixtures,
  inspectTestExecutorIsolationLive,
  inspectIsolationWiring,
} from '../scripts/lib/test-executor-isolation-check.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const CALL = 'spawn' + 'Sync';
const EXEC_FILE = 'execFile' + 'Sync';

test('没给正文 = 没查成，空字符串 = 查成 0 条', () => {
  const none = classifyTestDispatchSpawns(null);
  assert.equal(none.unscanned, true);
  assert.equal(none.ok, false);
  const empty = classifyTestDispatchSpawns('');
  assert.equal(empty.unscanned, false);
  assert.equal(empty.ok, true);
  assert.equal(empty.scanned, 0);
});

test('故意违规：执行体 env 丢失必须红', () => {
  const src = `${CALL}(process.execPath, ['dao.mjs', 'dispatch', '--issue', '565'], { env: { PATH: '/bin', HOME: '/tmp' } });`;
  const r = classifyTestDispatchSpawns(src);
  assert.equal(r.unscanned, false);
  assert.equal(r.ok, false);
  assert.equal(r.violations.length, 1);
  assert.equal(r.violations[0].kind, 'env-lost');
  assert.match(r.violations[0].why, /env 丢失/);
});

test('继承 process.env 但无 --dry-run 也是真 spawn dispatch', () => {
  const src = `${CALL}(process.execPath, ['dao.mjs', 'dispatch', '--issue', '1'], { env: { ...process.env } });`;
  const r = classifyTestDispatchSpawns(src);
  assert.equal(r.ok, false);
  assert.equal(r.violations[0].kind, 'live-dispatch');
});

test('--dry-run 放行，哪怕 env 很瘦', () => {
  const src = `${CALL}(process.execPath, ['dao.mjs', 'dispatch', '--dry-run', '--issue', '1'], { env: { PATH: '/bin' } });`;
  const r = classifyTestDispatchSpawns(src);
  assert.equal(r.ok, true);
  assert.equal(r.scanned, 1);
});

test('...base 展开后能看见 dispatch', () => {
  const src = [
    "const base = ['dao.mjs', 'dispatch', '--issue', '565'];",
    `${CALL}(process.execPath, [...base], { encoding: 'utf8' });`,
  ].join('\n');
  const r = classifyTestDispatchSpawns(src);
  assert.equal(r.ok, false);
  assert.equal(r.violations[0].kind, 'live-dispatch');
});

test('...base 展开后带 --dry-run 则绿', () => {
  const src = [
    "const base = ['dao.mjs', 'dispatch', '--issue', '565'];",
    `${CALL}(process.execPath, [...base, '--dry-run'], { encoding: 'utf8' });`,
  ].join('\n');
  const r = classifyTestDispatchSpawns(src);
  assert.equal(r.ok, true);
});

test('别名 spawnSync:run 必须红（审官对抗样本）', () => {
  const alias = 'ru' + 'n';
  const src = [
    `const { ${CALL}: ${alias} } = require('node:child_process');`,
    `${alias}(process.execPath, [CLI, 'dispatch'], { env: { PATH: '/usr/bin', HOME: '/tmp' } });`,
  ].join('\n');
  assert.ok(collectSpawnAliases(src).includes(alias));
  const r = classifyTestDispatchSpawns(src);
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(r.scanned, 1);
  assert.equal(r.violations[0].kind, 'env-lost');
});

test('import as 别名必须红', () => {
  const alias = 'go';
  const src = [
    `import { ${CALL} as ${alias} } from 'node:child_process';`,
    `${alias}(process.execPath, ['dao.mjs', 'dispatch'], { env: { PATH: '/bin', HOME: '/tmp' } });`,
  ].join('\n');
  const r = classifyTestDispatchSpawns(src);
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(r.violations[0].kind, 'env-lost');
});

test('argv 整段变量 + 动词变量必须红', () => {
  const src = [
    "const verb = 'dispatch';",
    "const argv = ['dao.mjs', verb, '--issue', '565'];",
    `${CALL}(process.execPath, argv, { env: { PATH: '/usr/bin', HOME: '/tmp' } });`,
  ].join('\n');
  const r = classifyTestDispatchSpawns(src);
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(r.scanned, 1);
  assert.equal(r.violations[0].kind, 'env-lost');
});

test('dispatch-exec 必须红', () => {
  const src = `${CALL}(process.execPath, ['dao.mjs', 'dispatch-exec', '--order', 'x.json'], { env: { PATH: '/bin', HOME: '/tmp' } });`;
  const r = classifyTestDispatchSpawns(src);
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(r.violations[0].kind, 'env-lost');
  assert.match(r.violations[0].why, /env 丢失/);
});

test('execFileSync 调 dispatch 必须红', () => {
  const src = `${EXEC_FILE}(process.execPath, ['dao.mjs', 'dispatch'], { env: { PATH: '/bin', HOME: '/tmp' } });`;
  const r = classifyTestDispatchSpawns(src);
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(r.violations[0].kind, 'env-lost');
});

test('夹具红/绿/空有判别力', () => {
  const r = inspectTestExecutorIsolationFixtures(join(HERE, 'fixtures', 'test-executor-isolation'));
  assert.equal(r.unscanned, false, r.error || '');
  assert.equal(r.ok, true, r.error || '');
  assert.equal(r.kinds.red, 1);
  assert.equal(r.kinds.ok, 1);
  assert.equal(r.kinds.empty, 1);
});

test('夹具 *.js 必须红（node --test 显式路径会当模块执行）', () => {
  const root = mkdtempSync(join(tmpdir(), 'iso-fix-'));
  try {
    mkdirSync(join(root, 'red'));
    mkdirSync(join(root, 'ok'));
    mkdirSync(join(root, 'empty'));
    writeFileSync(
      join(root, 'red', 'env-lost.test.js'),
      `${CALL}(process.execPath, ['dao.mjs', 'dispatch'], { env: { PATH: '/bin' } });\n`,
    );
    writeFileSync(
      join(root, 'ok', 'dry-run.txt'),
      `${CALL}(process.execPath, ['dao.mjs', 'dispatch', '--dry-run'], { env: { ...process.env } });\n`,
    );
    const r = inspectTestExecutorIsolationFixtures(root);
    assert.equal(r.ok, false);
    assert.match(String(r.error || ''), /test\.js/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('live：本仓 tests/*.test.js 0 处真 spawn dispatch', () => {
  const r = inspectTestExecutorIsolationLive({
    dir: HERE,
    readdir: readdirSync,
    readFile: (p) => readFileSync(p, 'utf8'),
    join,
  });
  assert.equal(r.unscanned, false, r.error || '');
  assert.equal(r.ok, true, (r.violations || []).map((v) => `${v.file}: ${v.why}`).join('；'));
  assert.ok(r.scanned > 0, '扫到 0 套 = 没查成');
});

test('live 0 个测试文件 = 没查成，不是没有真派工', () => {
  const r = inspectTestExecutorIsolationLive({
    dir: '/tmp',
    readdir: () => [],
    readFile: () => '',
  });
  assert.equal(r.unscanned, true);
  assert.match(r.error, /没查成/);
});

test('接线：runtime + dao 都在真 IO 前过隔离闸', () => {
  const r = inspectIsolationWiring({
    runtimeSrc: readFileSync(join(ROOT, 'scripts', 'lib', 'mirasim-runtime.mjs'), 'utf8'),
    daoSrc: readFileSync(join(ROOT, 'scripts', 'dao.mjs'), 'utf8'),
  });
  assert.equal(r.unscanned, false, r.error || '');
  assert.equal(r.ok, true, (r.problems || []).join('；'));
});

test('接线：缺调用必须红', () => {
  const r = inspectIsolationWiring({
    runtimeSrc: 'async function ensureWorkspace(){ await open(); }\nasync function startSession(){ await open(); }\nasync function readSession(){}',
    daoSrc: 'async function cmdDispatchMirasim(){ await bind.runtime.ensureWorkspace(repo, branch); }\nasync function cmdDispatch(){}',
  });
  assert.equal(r.ok, false);
  assert.ok(r.problems.length >= 3, r.problems.join('；'));
});
