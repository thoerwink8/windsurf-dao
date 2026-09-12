// tests/test-executor-isolation.test.js —— #1152 测试隔离闸（allowlist）判别力
//
// 源码扫描器已退役。本套只验：判官 allowlist、接线、生产入口打旗、故意 env-lost 子进程当场拦。

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync, mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { pathToFileURL } = require('node:url');

const ROOT = join(__dirname, '..');
const HERE = __dirname;
const CHECK = pathToFileURL(join(ROOT, 'scripts', 'lib', 'test-executor-isolation-check.mjs')).href;
const RUNTIME = pathToFileURL(join(ROOT, 'scripts', 'lib', 'mirasim-runtime.mjs')).href;
const DAO = join(ROOT, 'scripts', 'dao.mjs');

async function loadCheck() {
  return import(CHECK);
}

test('allowlist：空 env / 瘦 env 拦；生产旗标放行；测试不能 opt-in', async () => {
  const { judgeTestExecutorIsolation, TEST_ISOLATION_MARK, REAL_EXECUTOR_ENV } = await import(RUNTIME);
  const empty = judgeTestExecutorIsolation({});
  assert.equal(empty.ok, false);
  assert.equal(empty.why, 'missing-DAO_REAL_EXECUTOR');
  assert.match(empty.error, new RegExp(TEST_ISOLATION_MARK));

  const stripped = judgeTestExecutorIsolation({ PATH: '/bin', HOME: '/tmp' });
  assert.equal(stripped.ok, false);
  assert.equal(stripped.why, 'missing-DAO_REAL_EXECUTOR');

  const prod = judgeTestExecutorIsolation({ [REAL_EXECUTOR_ENV]: '1' });
  assert.equal(prod.ok, true);
  assert.equal(prod.why, REAL_EXECUTOR_ENV);

  const testSignal = judgeTestExecutorIsolation({ NODE_TEST_CONTEXT: 'child-v8' });
  assert.equal(testSignal.ok, false);
  assert.equal(testSignal.why, 'test-signal');

  const cannotOptIn = judgeTestExecutorIsolation({
    NODE_TEST_CONTEXT: 'child',
    [REAL_EXECUTOR_ENV]: '1',
  });
  assert.equal(cannotOptIn.ok, false);
  assert.equal(cannotOptIn.why, 'test-signal');
});

test('夹具红/绿/空有判别力', async () => {
  const { inspectTestExecutorIsolationFixtures } = await loadCheck();
  const r = inspectTestExecutorIsolationFixtures(join(HERE, 'fixtures', 'test-executor-isolation'));
  assert.equal(r.unscanned, false, r.error || '');
  assert.equal(r.ok, true, r.error || '');
  assert.ok(r.kinds.red >= 1);
  assert.ok(r.kinds.ok >= 1);
  assert.equal(r.kinds.empty, 1);
});

test('夹具 *.js 必须红', async () => {
  const { inspectTestExecutorIsolationFixtures } = await loadCheck();
  const root = mkdtempSync(join(tmpdir(), 'iso-fix-'));
  try {
    mkdirSync(join(root, 'red'));
    mkdirSync(join(root, 'ok'));
    mkdirSync(join(root, 'empty'));
    writeFileSync(join(root, 'red', 'env-lost.test.js'), 'process.env.DAO_REAL_EXECUTOR="1";\n');
    writeFileSync(join(root, 'ok', 'production.json'), '{"DAO_REAL_EXECUTOR":"1"}\n');
    const r = inspectTestExecutorIsolationFixtures(root);
    assert.equal(r.ok, false);
    assert.match(String(r.error || ''), /\.js/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('live：本仓 tests/*.test.js 扫得到', async () => {
  const { inspectTestExecutorIsolationLive } = await loadCheck();
  const r = inspectTestExecutorIsolationLive({
    dir: HERE,
    readdir: readdirSync,
  });
  assert.equal(r.unscanned, false, r.error || '');
  assert.equal(r.ok, true, r.error || '');
  assert.ok(r.scanned > 0, '扫到 0 套 = 没查成');
});

test('live 0 个测试文件 = 没查成', async () => {
  const { inspectTestExecutorIsolationLive } = await loadCheck();
  const r = inspectTestExecutorIsolationLive({
    dir: '/tmp',
    readdir: () => [],
  });
  assert.equal(r.unscanned, true);
  assert.match(r.error, /没查成/);
});

test('接线：runtime/dao/execution/commander 都在真 IO 前过隔离闸，且是 allowlist', async () => {
  const { inspectIsolationWiring } = await loadCheck();
  const r = inspectIsolationWiring({
    runtimeSrc: readFileSync(join(ROOT, 'scripts', 'lib', 'mirasim-runtime.mjs'), 'utf8'),
    daoSrc: readFileSync(join(ROOT, 'scripts', 'dao.mjs'), 'utf8'),
    executionSrc: readFileSync(join(ROOT, 'scripts', 'lib', 'execution-runtime.mjs'), 'utf8'),
    commanderSrc: readFileSync(join(ROOT, 'scripts', 'commander.mjs'), 'utf8'),
    unitSrc: readFileSync(join(ROOT, 'scripts', 'lib', 'commander-inventory.mjs'), 'utf8'),
  });
  assert.equal(r.unscanned, false, r.error || '');
  assert.equal(r.ok, true, (r.problems || []).join('；'));
});

test('接线：缺调用必须红；denylist 空 env 放行必须红', async () => {
  const { inspectIsolationWiring } = await loadCheck();
  const missing = inspectIsolationWiring({
    runtimeSrc: 'async function ensureWorkspace(){ await open(); }\nasync function startSession(){ await open(); }\nasync function readSession(){}',
    daoSrc: 'async function cmdDispatchMirasim(){ await bind.runtime.ensureWorkspace(repo, branch); }\nasync function cmdDispatch(){}\nasync function cmdStartMirasim(){ await bind.runtime.ensureWorkspace(repo, branch); }\nasync function cmdSessionRead(){}\nasync function cmdWorktreeCreateMirasim(){ await binding.worktreeCreate({ repo, branch }); }\nfunction cmdLedgerQuery(){}',
    executionSrc: 'ensureWorkspace:async(repo,branch)=>{ const tree=await ensureGitWorkspace(); }\ninteract:async(){}\nasync function startSession(spec) {\nassertMutationAllowed();\n}\nasync function readSession(){}',
    commanderSrc: 'export function runCmd(argv, timeout = 600000, { spawn = spawnSync } = {}) {\n  const r = spawn(argv[0], argv.slice(1), { env: process.env });\n}\nexport function parseDaoResult(stdout) {}',
    unitSrc: '[Service]\nEnvironment=PATH=/usr/bin\n',
  });
  assert.equal(missing.ok, false);
  assert.ok(missing.problems.length >= 5, missing.problems.join('；'));

  const denylist = inspectIsolationWiring({
    runtimeSrc: "export function judgeTestExecutorIsolation(){ if (0) return { why: 'no-test-signal' }; }\nasync function ensureWorkspace(){ const isolation = judgeTestExecutorIsolation(); await open(); }\nasync function startSession(){ const isolation = judgeTestExecutorIsolation(); await open(); }\nasync function readSession(){}",
    daoSrc: 'async function cmdDispatchMirasim(){ const isolation = judgeTestExecutorIsolation(); await bind.runtime.ensureWorkspace(repo, branch); }\nasync function cmdDispatch(){}\nasync function cmdStartMirasim(){ const isolation = judgeTestExecutorIsolation(); await bind.runtime.ensureWorkspace(repo, branch); }\nasync function cmdSessionRead(){}\nasync function cmdWorktreeCreateMirasim(){ const isolation = judgeTestExecutorIsolation(); await binding.worktreeCreate({ repo, branch }); }\nfunction cmdLedgerQuery(){}',
    executionSrc: 'judgeTestExecutorIsolation()\nensureWorkspace:async(repo,branch)=>{ assertExecutorIsolation(); }\ninteract:async(){}\nasync function startSession(spec) {\nassertExecutorIsolation();\n}\nasync function readSession(){}',
    commanderSrc: 'export function runCmd(argv) {\n  const env = { ...process.env, DAO_REAL_EXECUTOR: "1" };\n}\nexport function parseDaoResult() {}',
    unitSrc: 'Environment=DAO_REAL_EXECUTOR=1\n',
  });
  assert.equal(denylist.ok, false);
  assert.ok(denylist.problems.some((p) => /no-test-signal|denylist/.test(p)), denylist.problems.join('；'));
});

test('故意样本：子进程 env 丢失当场拦，不建 dao-565 树', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'dao-1152-lost-'));
  try {
    const r = spawnSync(process.execPath, [
      DAO, 'worktree-create', '--executor', 'mirasim',
      '--branch', 'dao-565', '--repo', tmp,
    ], {
      encoding: 'utf8',
      cwd: ROOT,
      timeout: 30000,
      env: { PATH: process.env.PATH, HOME: tmp, TMPDIR: tmp },
    });
    let out = {};
    try { out = JSON.parse(String(r.stdout || '').trim().split(/\r?\n/).pop() || '{}'); }
    catch { out = { raw: r.stdout, err: r.stderr }; }
    assert.notEqual(r.status, 0, JSON.stringify(out).slice(0, 400));
    assert.match(
      String(out.error || r.stderr || r.stdout || ''),
      /结构性够不着真执行体|DAO_REAL_EXECUTOR/,
    );
    assert.equal(existsSync(join(tmp, 'dao-565')), false);
    assert.equal(existsSync(join(ROOT, 'dao-565')), false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
