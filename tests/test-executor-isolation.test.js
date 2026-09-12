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

test('--dry-run 在 stdin 不算放行（审官对抗样本）', () => {
  const src = `${CALL}(process.execPath, ["scripts/dao.mjs", "dispatch"], { env: { PATH: "/bin" }, input: "--dry-run" });`;
  const r = classifyTestDispatchSpawns(src);
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(r.scanned, 1);
  assert.equal(r.violations[0].kind, 'env-lost');
});

test('--dry-run 在 env 字段不算放行（审官对抗样本）', () => {
  const src = `${CALL}(process.execPath, ["scripts/dao.mjs", "dispatch"], { env: { PATH: "/bin", FLAG: "--dry-run" } });`;
  const r = classifyTestDispatchSpawns(src);
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(r.scanned, 1);
  assert.equal(r.violations[0].kind, 'env-lost');
});

test('argv 里真有 --dry-run 仍放行（options 再写一份不算干扰）', () => {
  const src = `${CALL}(process.execPath, ["scripts/dao.mjs", "dispatch", "--dry-run"], { env: { PATH: "/bin" }, input: "--dry-run" });`;
  const r = classifyTestDispatchSpawns(src);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.scanned, 1);
});

test('计算属性 spawn 必须红（审官对抗样本）', () => {
  const lb = '[';
  const rb = ']';
  const src = [
    'const cp = require("node:child_process");',
    `cp${lb}${JSON.stringify(CALL)}${rb}(process.execPath, ["scripts/dao.mjs", "dispatch"], { env: { PATH: "/bin" } });`,
  ].join('\n');
  const r = classifyTestDispatchSpawns(src);
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.notEqual(r.scanned, 0, JSON.stringify(r));
  assert.ok(r.violations.length > 0);
  assert.equal(r.violations[0].kind, 'env-lost');
});

test('argv 拼接动词必须红（审官对抗样本）', () => {
  const src = `${CALL}(process.execPath, ["scripts/dao.mjs", "dis" + "patch"], { env: { PATH: "/bin" } });`;
  const r = classifyTestDispatchSpawns(src);
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.notEqual(r.scanned, 0, JSON.stringify(r));
  assert.ok(r.violations.length > 0);
});

test('解析不了的 child_process 计算属性 fail-closed', () => {
  const lb = '[';
  const rb = ']';
  const src = [
    'const cp = require("node:child_process");',
    `cp${lb}fn${rb}(process.execPath, ["scripts/dao.mjs", "dispatch"], { env: { PATH: "/bin" } });`,
  ].join('\n');
  const r = classifyTestDispatchSpawns(src);
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.notEqual(r.scanned, 0, JSON.stringify(r));
  assert.ok(r.violations.length > 0);
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

test('模板动词 `dispatch` 必须红（审官对抗样本）', () => {
  const alias = 'ru' + 'n';
  const tick = '`';
  const src = [
    `const { ${CALL}: ${alias} } = require("node:child_process");`,
    `const verb = ${tick}dispatch${tick};`,
    'const argv = ["scripts/dao.mjs", verb];',
    `${alias}(process.execPath, argv, { env: { PATH: "/bin", HOME: "/tmp" } });`,
  ].join('\n');
  const r = classifyTestDispatchSpawns(src);
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.notEqual(r.scanned, 0, JSON.stringify(r));
  assert.equal(r.violations[0].kind, 'env-lost');
});

test('属性别名 const run = cp.spawnSync 必须红（审官对抗样本）', () => {
  const alias = 'ru' + 'n';
  const src = [
    `const cp = require("node:child_process");`,
    `const ${alias} = cp.${CALL};`,
    `${alias}(process.execPath, ["scripts/dao.mjs", "dispatch"], { env: { PATH: "/bin", HOME: "/tmp" } });`,
  ].join('\n');
  assert.ok(collectSpawnAliases(src).includes(alias), collectSpawnAliases(src).join(','));
  const r = classifyTestDispatchSpawns(src);
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.notEqual(r.scanned, 0, JSON.stringify(r));
  assert.equal(r.violations[0].kind, 'env-lost');
});

test('别名再赋值必须红（审官对抗样本）', () => {
  const alias = 'ru' + 'n';
  const next = 'act' + 'ual';
  const src = [
    'const cp = require("node:child_process");',
    `const ${alias} = cp.${CALL};`,
    `const ${next} = ${alias};`,
    `${next}(process.execPath, ["scripts/dao.mjs", "dispatch"], { env: { PATH: "/bin", HOME: "/tmp" } });`,
  ].join('\n');
  const aliases = collectSpawnAliases(src);
  assert.ok(aliases.includes(alias), aliases.join(','));
  assert.ok(aliases.includes(next), aliases.join(','));
  const r = classifyTestDispatchSpawns(src);
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.notEqual(r.scanned, 0, JSON.stringify(r));
  assert.equal(r.violations[0].kind, 'env-lost');
});

test('裸赋值别名链必须红', () => {
  const alias = 'ru' + 'n';
  const next = 'act' + 'ual';
  const src = [
    'const cp = require("node:child_process");',
    `const ${alias} = cp.${CALL};`,
    `let ${next};`,
    `${next} = ${alias};`,
    `${next}(process.execPath, ["scripts/dao.mjs", "dispatch"], { env: { PATH: "/bin", HOME: "/tmp" } });`,
  ].join('\n');
  const r = classifyTestDispatchSpawns(src);
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.notEqual(r.scanned, 0, JSON.stringify(r));
});

test('argv 先声明再赋值必须红（审官对抗样本）', () => {
  const src = [
    `const { ${CALL} } = require("node:child_process");`,
    'let argv;',
    'argv = ["scripts/dao.mjs", "dispatch"];',
    `${CALL}(process.execPath, argv, { env: { PATH: "/bin" } });`,
  ].join('\n');
  const r = classifyTestDispatchSpawns(src);
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.notEqual(r.scanned, 0, JSON.stringify(r));
  assert.equal(r.violations[0].kind, 'env-lost');
});

test('解析不了的 argv 变量 fail-closed（审官对抗样本）', () => {
  const src = [
    `const { ${CALL} } = require("node:child_process");`,
    `${CALL}(process.execPath, argv, { env: { PATH: "/bin" } });`,
  ].join('\n');
  const r = classifyTestDispatchSpawns(src);
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.notEqual(r.scanned, 0, JSON.stringify(r));
  assert.match(r.violations[0].why, /无法解析的 argv/);
});

test('git 的 argv 变量解析不了不当 dispatch', () => {
  const src = `${CALL}('git', args, { cwd: tmp, encoding: 'utf8' });`;
  const r = classifyTestDispatchSpawns(src);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.scanned, 0, JSON.stringify(r));
});

test('未知计算属性经别名转发必须红（审官对抗样本）', () => {
  const alias = 'ru' + 'n';
  const lb = '[';
  const rb = ']';
  const src = [
    'const cp = require("node:child_process");',
    `const ${alias} = cp${lb}unknownKey${rb};`,
    `${alias}(process.execPath, ["scripts/dao.mjs", "dispatch"], { env: { PATH: "/bin" } });`,
  ].join('\n');
  assert.ok(collectSpawnAliases(src).includes(alias), collectSpawnAliases(src).join(','));
  const r = classifyTestDispatchSpawns(src);
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.notEqual(r.scanned, 0, JSON.stringify(r));
  assert.ok(r.violations.length > 0);
});

test('调用后再赋 --dry-run 的 argv 必须红（审官对抗样本）', () => {
  const src = [
    `const { ${CALL} } = require("node:child_process");`,
    'let argv = ["scripts/dao.mjs", "dispatch"];',
    `${CALL}(process.execPath, argv, { env: { PATH: "/bin" } });`,
    'argv = ["scripts/dao.mjs", "dispatch", "--dry-run"];',
  ].join('\n');
  const r = classifyTestDispatchSpawns(src);
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.notEqual(r.scanned, 0, JSON.stringify(r));
  assert.ok(r.violations.length > 0);
});

test('调用前 argv 已有 --dry-run、调用后再改掉仍绿', () => {
  const src = [
    `const { ${CALL} } = require("node:child_process");`,
    'let argv = ["scripts/dao.mjs", "dispatch", "--dry-run"];',
    `${CALL}(process.execPath, argv, { env: { PATH: "/bin" } });`,
    'argv = ["scripts/dao.mjs", "dispatch"];',
  ].join('\n');
  const r = classifyTestDispatchSpawns(src);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.scanned, 1);
});

test('process.execPath 别名 + 解析不了的 argv 必须红（审官对抗样本）', () => {
  const src = [
    `const { ${CALL} } = require("node:child_process");`,
    'const nodePath = process.execPath;',
    'const argv = makeArgv();',
    `${CALL}(nodePath, argv, { env: { PATH: "/bin" } });`,
  ].join('\n');
  const r = classifyTestDispatchSpawns(src);
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.notEqual(r.scanned, 0, JSON.stringify(r));
  assert.match(r.violations[0].why, /无法解析的 argv/);
});

test('process.execPath 别名再赋值 + 解析不了的 argv 仍红', () => {
  const src = [
    `const { ${CALL} } = require("node:child_process");`,
    'const nodePath = process.execPath;',
    'const bin = nodePath;',
    'const argv = makeArgv();',
    `${CALL}(bin, argv, { env: { PATH: "/bin" } });`,
  ].join('\n');
  const r = classifyTestDispatchSpawns(src);
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.notEqual(r.scanned, 0, JSON.stringify(r));
});

test('argv 函数调用 fail-closed（审官对抗样本）', () => {
  const src = [
    `const { ${CALL} } = require("node:child_process");`,
    `${CALL}(process.execPath, makeArgv(), { env: { PATH: "/bin" } });`,
  ].join('\n');
  const r = classifyTestDispatchSpawns(src);
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.notEqual(r.scanned, 0, JSON.stringify(r));
  assert.match(r.violations[0].why, /无法解析的 argv/);
});

test('未知 spread argv fail-closed（审官对抗样本）', () => {
  const src = [
    `const { ${CALL} } = require("node:child_process");`,
    `${CALL}(process.execPath, [...argv], { env: { PATH: "/bin" } });`,
  ].join('\n');
  const r = classifyTestDispatchSpawns(src);
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.notEqual(r.scanned, 0, JSON.stringify(r));
  assert.match(r.violations[0].why, /无法解析的 argv/);
});

test('数组里的动态动词 fail-closed（审官对抗样本）', () => {
  const src = [
    `const { ${CALL} } = require("node:child_process");`,
    `${CALL}(process.execPath, ["scripts/dao.mjs", getVerb()], { env: { PATH: "/bin" } });`,
  ].join('\n');
  const r = classifyTestDispatchSpawns(src);
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.notEqual(r.scanned, 0, JSON.stringify(r));
  assert.match(r.violations[0].why, /无法解析的 argv/);
});

test('数组动态动词但带 --dry-run 仍绿', () => {
  const src = [
    `const { ${CALL} } = require("node:child_process");`,
    `${CALL}(process.execPath, ["scripts/dao.mjs", getVerb(), "--dry-run"], { env: { PATH: "/bin" } });`,
  ].join('\n');
  const r = classifyTestDispatchSpawns(src);
  assert.equal(r.ok, true, JSON.stringify(r));
});

test('node 绝对路径 + 解析不了的 argv 必须红（审官对抗样本）', () => {
  const src = [
    `const { ${CALL} } = require("node:child_process");`,
    `${CALL}("/usr/bin/node", argv, { env: { PATH: "/bin" } });`,
  ].join('\n');
  const r = classifyTestDispatchSpawns(src);
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.notEqual(r.scanned, 0, JSON.stringify(r));
  assert.match(r.violations[0].why, /无法解析的 argv/);
});

test('node.exe 路径别名 + 解析不了的 argv 仍红', () => {
  const src = [
    `const { ${CALL} } = require("node:child_process");`,
    'const bin = "C:\\\\Program Files\\\\nodejs\\\\node.exe";',
    `${CALL}(bin, argv, { env: { PATH: "/bin" } });`,
  ].join('\n');
  const r = classifyTestDispatchSpawns(src);
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.notEqual(r.scanned, 0, JSON.stringify(r));
});

test('git 绝对路径 + 解析不了的 argv 不当 dispatch', () => {
  const src = `${CALL}("/usr/bin/git", args, { cwd: tmp, encoding: "utf8" });`;
  const r = classifyTestDispatchSpawns(src);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.scanned, 0, JSON.stringify(r));
});

test('非 dao 脚本 + 未知 spread 不当 dispatch', () => {
  const src = [
    `const { ${CALL} } = require("node:child_process");`,
    'const HOOK = path.join(REPO, "hooks", "dao-mode.mjs");',
    `${CALL}(process.execPath, [HOOK, ...args], { env: { PATH: "/bin" } });`,
  ].join('\n');
  const r = classifyTestDispatchSpawns(src);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.scanned, 0, JSON.stringify(r));
});

test('dao 已知其它动词 + 未知 spread 不当 dispatch', () => {
  const src = [
    `const { ${CALL} } = require("node:child_process");`,
    'const DAO = path.join(ROOT, "scripts", "dao.mjs");',
    `${CALL}(process.execPath, [DAO, "worktree-create", ...extra], { env: { ...process.env } });`,
  ].join('\n');
  const r = classifyTestDispatchSpawns(src);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.scanned, 0, JSON.stringify(r));
});

test('对象属性转发 spawn 必须红（审官对抗样本）', () => {
  const alias = 'ru' + 'n';
  const src = [
    'const cp = require("node:child_process");',
    `const box = { ${alias}: cp.${CALL} };`,
    `box.${alias}(process.execPath, ["scripts/dao.mjs", "dispatch"], { env: { PATH: "/bin" } });`,
  ].join('\n');
  assert.ok(collectSpawnAliases(src).includes(alias), collectSpawnAliases(src).join(','));
  const r = classifyTestDispatchSpawns(src);
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.notEqual(r.scanned, 0, JSON.stringify(r));
  assert.equal(r.violations[0].kind, 'env-lost');
});

test('成员赋值转发 spawn 必须红', () => {
  const alias = 'ru' + 'n';
  const src = [
    'const cp = require("node:child_process");',
    'const box = {};',
    `box.${alias} = cp.${CALL};`,
    `box.${alias}(process.execPath, ["scripts/dao.mjs", "dispatch"], { env: { PATH: "/bin" } });`,
  ].join('\n');
  const r = classifyTestDispatchSpawns(src);
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.notEqual(r.scanned, 0, JSON.stringify(r));
});

test('对象上挂原名 spawnSync 必须红', () => {
  const src = [
    'const cp = require("node:child_process");',
    `const box = { ${CALL}: cp.${CALL} };`,
    `box.${CALL}(process.execPath, ["scripts/dao.mjs", "dispatch"], { env: { PATH: "/bin" } });`,
  ].join('\n');
  const r = classifyTestDispatchSpawns(src);
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.notEqual(r.scanned, 0, JSON.stringify(r));
});

test('process.execPath 别名但 argv 带 --dry-run 仍绿', () => {
  const src = [
    `const { ${CALL} } = require("node:child_process");`,
    'const nodePath = process.execPath;',
    'const argv = ["scripts/dao.mjs", "dispatch", "--dry-run"];',
    `${CALL}(nodePath, argv, { env: { PATH: "/bin" } });`,
  ].join('\n');
  const r = classifyTestDispatchSpawns(src);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.scanned, 1);
});

test('未知计算属性别名再赋值仍红', () => {
  const alias = 'ru' + 'n';
  const next = 'act' + 'ual';
  const lb = '[';
  const rb = ']';
  const src = [
    'const cp = require("node:child_process");',
    `const ${alias} = cp${lb}unknownKey${rb};`,
    `const ${next} = ${alias};`,
    `${next}(process.execPath, ["scripts/dao.mjs", "dispatch"], { env: { PATH: "/bin" } });`,
  ].join('\n');
  const aliases = collectSpawnAliases(src);
  assert.ok(aliases.includes(alias), aliases.join(','));
  assert.ok(aliases.includes(next), aliases.join(','));
  const r = classifyTestDispatchSpawns(src);
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.notEqual(r.scanned, 0, JSON.stringify(r));
});

test('exec 命令字符串必须红（审官对抗样本）', () => {
  const exe = 'ex' + 'ec';
  const src = [
    `const { ${exe} } = require("node:child_process");`,
    `${exe}("node scripts/dao.mjs dispatch --issue 565", { env: { PATH: "/bin", HOME: "/tmp" } });`,
  ].join('\n');
  const r = classifyTestDispatchSpawns(src);
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.notEqual(r.scanned, 0, JSON.stringify(r));
  assert.equal(r.violations[0].kind, 'env-lost');
});

test('可选链成员 cp?.spawnSync 必须红（审官对抗样本）', () => {
  const src = [
    'const cp = require("node:child_process");',
    `cp?.${CALL}(process.execPath, ["scripts/dao.mjs", "dispatch"], { env: { PATH: "/bin" } });`,
  ].join('\n');
  const r = classifyTestDispatchSpawns(src);
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.notEqual(r.scanned, 0, JSON.stringify(r));
  assert.equal(r.violations[0].kind, 'env-lost');
});

test('可选链调用 spawnSync?. 必须红（审官对抗样本）', () => {
  const src = [
    'const cp = require("node:child_process");',
    `const { ${CALL} } = cp;`,
    `${CALL}?.(process.execPath, argv, { env: { PATH: "/bin" } });`,
  ].join('\n');
  const r = classifyTestDispatchSpawns(src);
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.notEqual(r.scanned, 0, JSON.stringify(r));
  assert.match(r.violations[0].why, /无法解析的 argv/);
});

test('逗号间接调用 (0, spawnSync) 必须红（审官对抗样本）', () => {
  const src = [
    'const cp = require("node:child_process");',
    `const { ${CALL} } = cp;`,
    `(0, ${CALL})(process.execPath, argv, { env: { PATH: "/bin" } });`,
  ].join('\n');
  const r = classifyTestDispatchSpawns(src);
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.notEqual(r.scanned, 0, JSON.stringify(r));
  assert.match(r.violations[0].why, /无法解析的 argv/);
});

test('计算属性键对象别名必须红（审官对抗样本）', () => {
  const alias = 'ru' + 'n';
  const src = [
    'const cp = require("node:child_process");',
    `const box = { ['${alias}']: cp.${CALL} };`,
    `box.${alias}(process.execPath, argv, { env: { PATH: "/bin" } });`,
  ].join('\n');
  assert.ok(collectSpawnAliases(src).includes(alias), collectSpawnAliases(src).join(','));
  const r = classifyTestDispatchSpawns(src);
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.notEqual(r.scanned, 0, JSON.stringify(r));
  assert.match(r.violations[0].why, /无法解析的 argv/);
});

test('展开 child_process 后成员调用必须红（审官对抗样本）', () => {
  const src = [
    'const cp = require("node:child_process");',
    'const box2 = { ...cp };',
    `box2.${CALL}(process.execPath, ["scripts/dao.mjs", "dispatch"], { env: { PATH: "/bin" } });`,
  ].join('\n');
  const r = classifyTestDispatchSpawns(src);
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.notEqual(r.scanned, 0, JSON.stringify(r));
  assert.equal(r.violations[0].kind, 'env-lost');
});

test('解构 process.execPath 别名 + 解析不了的 argv 必须红（审官对抗样本）', () => {
  const src = [
    `const { ${CALL} } = require("node:child_process");`,
    'const { execPath: nodePath } = process;',
    `${CALL}(nodePath, argv, { env: { PATH: "/bin" } });`,
  ].join('\n');
  const r = classifyTestDispatchSpawns(src);
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.notEqual(r.scanned, 0, JSON.stringify(r));
  assert.match(r.violations[0].why, /无法解析的 argv/);
});

test('Function.call 适配必须红（审官对抗样本）', () => {
  const src = [
    'const cp = require("node:child_process");',
    `cp.${CALL}.call(null, process.execPath, ["scripts/dao.mjs", "dispatch"], { env: { PATH: "/bin" } });`,
  ].join('\n');
  const r = classifyTestDispatchSpawns(src);
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.notEqual(r.scanned, 0, JSON.stringify(r));
  assert.equal(r.violations[0].kind, 'env-lost');
});

test('Function.apply 适配必须红（审官对抗样本）', () => {
  const src = [
    'const cp = require("node:child_process");',
    `cp.${CALL}.apply(null, [process.execPath, ["scripts/dao.mjs", "dispatch"], { env: { PATH: "/bin" } }]);`,
  ].join('\n');
  const r = classifyTestDispatchSpawns(src);
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.notEqual(r.scanned, 0, JSON.stringify(r));
  assert.equal(r.violations[0].kind, 'env-lost');
});

test('Reflect.apply 适配必须红（审官对抗样本）', () => {
  const applyOf = 'ap' + 'ply';
  const src = [
    'const cp = require("node:child_process");',
    `Reflect.${applyOf}(cp.${CALL}, null, [process.execPath, ["scripts/dao.mjs", "dispatch"], { env: { PATH: "/bin" } }]);`,
  ].join('\n');
  const r = classifyTestDispatchSpawns(src);
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.notEqual(r.scanned, 0, JSON.stringify(r));
  assert.equal(r.violations[0].kind, 'env-lost');
});

test('立刻 bind()() 适配必须红', () => {
  const src = [
    'const cp = require("node:child_process");',
    `cp.${CALL}.bind(null)(process.execPath, ["scripts/dao.mjs", "dispatch"], { env: { PATH: "/bin" } });`,
  ].join('\n');
  const r = classifyTestDispatchSpawns(src);
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.notEqual(r.scanned, 0, JSON.stringify(r));
  assert.equal(r.violations[0].kind, 'env-lost');
});

test('Function.prototype.call.call 适配必须红', () => {
  const src = [
    'const cp = require("node:child_process");',
    `Function.prototype.call.call(cp.${CALL}, null, process.execPath, ["scripts/dao.mjs", "dispatch"], { env: { PATH: "/bin" } });`,
  ].join('\n');
  const r = classifyTestDispatchSpawns(src);
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.notEqual(r.scanned, 0, JSON.stringify(r));
  assert.equal(r.violations[0].kind, 'env-lost');
});

test('动态 import() child_process 必须红（审官对抗样本）', () => {
  const src = [
    'const cp = await import("node:child_process");',
    `cp.${CALL}(process.execPath, ["scripts/dao.mjs", "dispatch"], { env: { PATH: "/bin" } });`,
  ].join('\n');
  const r = classifyTestDispatchSpawns(src);
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.notEqual(r.scanned, 0, JSON.stringify(r));
  assert.equal(r.violations[0].kind, 'env-lost');
});

test('import().then 接收器必须红', () => {
  const src = [
    'import("node:child_process").then((cp) => {',
    `  cp.${CALL}(process.execPath, ["scripts/dao.mjs", "dispatch"], { env: { PATH: "/bin" } });`,
    '});',
  ].join('\n');
  const r = classifyTestDispatchSpawns(src);
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.notEqual(r.scanned, 0, JSON.stringify(r));
  assert.equal(r.violations[0].kind, 'env-lost');
});

test('先声明再赋值 require(child_process) 必须红（审官对抗样本）', () => {
  const src = [
    'let cp;',
    'cp = require("node:child_process");',
    `cp.${CALL}(process.execPath, ["scripts/dao.mjs", "dispatch"], { env: { PATH: "/bin" } });`,
  ].join('\n');
  const r = classifyTestDispatchSpawns(src);
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.notEqual(r.scanned, 0, JSON.stringify(r));
  assert.equal(r.violations[0].kind, 'env-lost');
});

test('赋值 await import() child_process 必须红', () => {
  const src = [
    'let cp;',
    'cp = await import("node:child_process");',
    `cp.${CALL}(process.execPath, ["scripts/dao.mjs", "dispatch"], { env: { PATH: "/bin" } });`,
  ].join('\n');
  const r = classifyTestDispatchSpawns(src);
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.notEqual(r.scanned, 0, JSON.stringify(r));
  assert.equal(r.violations[0].kind, 'env-lost');
});

test('apply 实参解析不了 fail-closed', () => {
  const src = [
    'const cp = require("node:child_process");',
    `cp.${CALL}.apply(null, mysteryArgs);`,
  ].join('\n');
  const r = classifyTestDispatchSpawns(src);
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.notEqual(r.scanned, 0, JSON.stringify(r));
});

test('审官六条对抗样本都不许 scanned:0 ok:true', () => {
  const samples = [
    [
      "const cp = require('node:child_process');",
      `cp?.${CALL}(process.execPath, ['scripts/dao.mjs', 'dispatch'], { env: { PATH: '/bin' } });`,
    ].join('\n'),
    [
      "const cp = require('node:child_process');",
      `const { ${CALL} } = cp;`,
      `${CALL}?.(process.execPath, argv, { env: { PATH: '/bin' } });`,
    ].join('\n'),
    [
      "const cp = require('node:child_process');",
      `const { ${CALL} } = cp;`,
      `(0, ${CALL})(process.execPath, argv, { env: { PATH: '/bin' } });`,
    ].join('\n'),
    [
      "const cp = require('node:child_process');",
      `const box = { ['run']: cp.${CALL} };`,
      'box.run(process.execPath, argv, { env: { PATH: \'/bin\' } });',
    ].join('\n'),
    [
      "const cp = require('node:child_process');",
      'const box2 = { ...cp };',
      `box2.${CALL}(process.execPath, ['scripts/dao.mjs', 'dispatch'], { env: { PATH: '/bin' } });`,
    ].join('\n'),
    [
      "const cp = require('node:child_process');",
      `const { ${CALL} } = cp;`,
      'const { execPath: nodePath } = process;',
      `${CALL}(nodePath, argv, { env: { PATH: '/bin' } });`,
    ].join('\n'),
  ];
  for (const src of samples) {
    const r = classifyTestDispatchSpawns(src);
    assert.equal(r.ok, false, JSON.stringify({ src, r }));
    assert.notEqual(r.scanned, 0, JSON.stringify({ src, r }));
  }
});

test('审官 call/apply/Reflect.apply/动态import/赋值require 都不许 scanned:0 ok:true', () => {
  const applyOf = 'ap' + 'ply';
  const samples = [
    [
      "const cp = require('node:child_process');",
      `cp.${CALL}.call(null, process.execPath, ['scripts/dao.mjs', 'dispatch'], { env: { PATH: '/bin' } });`,
    ].join('\n'),
    [
      "const cp = require('node:child_process');",
      `cp.${CALL}.apply(null, [process.execPath, ['scripts/dao.mjs', 'dispatch'], { env: { PATH: '/bin' } }]);`,
    ].join('\n'),
    [
      "const cp = require('node:child_process');",
      `Reflect.${applyOf}(cp.${CALL}, null, [process.execPath, ['scripts/dao.mjs', 'dispatch'], { env: { PATH: '/bin' } }]);`,
    ].join('\n'),
    [
      'const cp = await import("node:child_process");',
      `cp.${CALL}(process.execPath, ['scripts/dao.mjs', 'dispatch'], { env: { PATH: '/bin' } });`,
    ].join('\n'),
    [
      'let cp;',
      'cp = require("node:child_process");',
      `cp.${CALL}(process.execPath, ['scripts/dao.mjs', 'dispatch'], { env: { PATH: '/bin' } });`,
    ].join('\n'),
  ];
  for (const src of samples) {
    const r = classifyTestDispatchSpawns(src);
    assert.equal(r.ok, false, JSON.stringify({ src, r }));
    assert.notEqual(r.scanned, 0, JSON.stringify({ src, r }));
  }
});

test('可选链成员带 --dry-run 仍绿', () => {
  const src = [
    'const cp = require("node:child_process");',
    `cp?.${CALL}(process.execPath, ["scripts/dao.mjs", "dispatch", "--dry-run"], { env: { PATH: "/bin" } });`,
  ].join('\n');
  const r = classifyTestDispatchSpawns(src);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.scanned, 1);
});

test('展开 child_process 带 --dry-run 仍绿', () => {
  const src = [
    'const cp = require("node:child_process");',
    'const box2 = { ...cp };',
    `box2.${CALL}(process.execPath, ["scripts/dao.mjs", "dispatch", "--dry-run"], { env: { PATH: "/bin" } });`,
  ].join('\n');
  const r = classifyTestDispatchSpawns(src);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.scanned, 1);
});

test('解构 process.execPath 但 argv 带 --dry-run 仍绿', () => {
  const src = [
    `const { ${CALL} } = require("node:child_process");`,
    'const { execPath: nodePath } = process;',
    'const argv = ["scripts/dao.mjs", "dispatch", "--dry-run"];',
    `${CALL}(nodePath, argv, { env: { PATH: "/bin" } });`,
  ].join('\n');
  const r = classifyTestDispatchSpawns(src);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.scanned, 1);
});

test('Function.call 带 --dry-run 仍绿', () => {
  const src = [
    'const cp = require("node:child_process");',
    `cp.${CALL}.call(null, process.execPath, ["scripts/dao.mjs", "dispatch", "--dry-run"], { env: { PATH: "/bin" } });`,
  ].join('\n');
  const r = classifyTestDispatchSpawns(src);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.scanned, 1);
});

test('动态 import() 带 --dry-run 仍绿', () => {
  const src = [
    'const cp = await import("node:child_process");',
    `cp.${CALL}(process.execPath, ["scripts/dao.mjs", "dispatch", "--dry-run"], { env: { PATH: "/bin" } });`,
  ].join('\n');
  const r = classifyTestDispatchSpawns(src);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.scanned, 1);
});

test('赋值 require 带 --dry-run 仍绿', () => {
  const src = [
    'let cp;',
    'cp = require("node:child_process");',
    `cp.${CALL}(process.execPath, ["scripts/dao.mjs", "dispatch", "--dry-run"], { env: { PATH: "/bin" } });`,
  ].join('\n');
  const r = classifyTestDispatchSpawns(src);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.scanned, 1);
});

test('动态 import() 默认导出转发必须红（审官对抗样本）', () => {
  const src = [
    'const mod = await import("node:child_process");',
    'const cp = mod.default;',
    `cp.${CALL}(process.execPath, ["scripts/dao.mjs", "dispatch"], { env: { PATH: "/bin" } });`,
  ].join('\n');
  const r = classifyTestDispatchSpawns(src);
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.notEqual(r.scanned, 0, JSON.stringify(r));
  assert.equal(r.violations[0].kind, 'env-lost');
});

test('解构 import() default 必须红', () => {
  const src = [
    'const { default: cp } = await import("node:child_process");',
    `cp.${CALL}(process.execPath, ["scripts/dao.mjs", "dispatch"], { env: { PATH: "/bin" } });`,
  ].join('\n');
  const r = classifyTestDispatchSpawns(src);
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.notEqual(r.scanned, 0, JSON.stringify(r));
  assert.equal(r.violations[0].kind, 'env-lost');
});

test('计算属性 Function.call 适配必须红（审官对抗样本）', () => {
  const lb = '[';
  const rb = ']';
  const src = [
    'const cp = require("node:child_process");',
    `cp.${CALL}${lb}"call"${rb}(null, process.execPath, ["scripts/dao.mjs", "dispatch"], { env: { PATH: "/bin" } });`,
  ].join('\n');
  const r = classifyTestDispatchSpawns(src);
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.notEqual(r.scanned, 0, JSON.stringify(r));
  assert.equal(r.violations[0].kind, 'env-lost');
});

test('计算属性 Function.apply 适配必须红（审官对抗样本）', () => {
  const lb = '[';
  const rb = ']';
  const src = [
    'const cp = require("node:child_process");',
    `cp.${CALL}${lb}"apply"${rb}(null, [process.execPath, ["scripts/dao.mjs", "dispatch"], { env: { PATH: "/bin" } }]);`,
  ].join('\n');
  const r = classifyTestDispatchSpawns(src);
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.notEqual(r.scanned, 0, JSON.stringify(r));
  assert.equal(r.violations[0].kind, 'env-lost');
});

test('计算属性立刻 bind()() 适配必须红（审官对抗样本）', () => {
  const lb = '[';
  const rb = ']';
  const src = [
    'const cp = require("node:child_process");',
    `cp.${CALL}${lb}"bind"${rb}(null)(process.execPath, ["scripts/dao.mjs", "dispatch"], { env: { PATH: "/bin" } });`,
  ].join('\n');
  const r = classifyTestDispatchSpawns(src);
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.notEqual(r.scanned, 0, JSON.stringify(r));
  assert.equal(r.violations[0].kind, 'env-lost');
});

test('计算属性 Reflect.apply 适配必须红（审官对抗样本）', () => {
  const applyOf = 'ap' + 'ply';
  const lb = '[';
  const rb = ']';
  const src = [
    'const cp = require("node:child_process");',
    `Reflect${lb}"${applyOf}"${rb}(cp.${CALL}, null, [process.execPath, ["scripts/dao.mjs", "dispatch"], { env: { PATH: "/bin" } }]);`,
  ].join('\n');
  const r = classifyTestDispatchSpawns(src);
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.notEqual(r.scanned, 0, JSON.stringify(r));
  assert.equal(r.violations[0].kind, 'env-lost');
});

test('可选链计算属性 call 适配必须红', () => {
  const lb = '[';
  const rb = ']';
  const src = [
    'const cp = require("node:child_process");',
    `cp.${CALL}?.${lb}"call"${rb}(null, process.execPath, ["scripts/dao.mjs", "dispatch"], { env: { PATH: "/bin" } });`,
  ].join('\n');
  const r = classifyTestDispatchSpawns(src);
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.notEqual(r.scanned, 0, JSON.stringify(r));
});

test('exec 动态模板命令必须红（审官对抗样本）', () => {
  const EX = 'ex' + 'ec';
  const tick = '`';
  const src = [
    `const { ${EX} } = require("node:child_process");`,
    `${EX}(${tick}node scripts/dao.mjs \${getVerb()}${tick}, { env: { PATH: "/bin", HOME: "/tmp" } });`,
  ].join('\n');
  const r = classifyTestDispatchSpawns(src);
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.notEqual(r.scanned, 0, JSON.stringify(r));
});

test('exec 动态模板带 --dry-run 仍绿', () => {
  const EX = 'ex' + 'ec';
  const tick = '`';
  const src = [
    `const { ${EX} } = require("node:child_process");`,
    `${EX}(${tick}node scripts/dao.mjs \${getVerb()} --dry-run${tick}, { env: { PATH: "/bin", HOME: "/tmp" } });`,
  ].join('\n');
  const r = classifyTestDispatchSpawns(src);
  assert.equal(r.ok, true, JSON.stringify(r));
});

test('静态 exec 非 dispatch 动词仍绿', () => {
  const EX = 'ex' + 'ec';
  const src = [
    `const { ${EX} } = require("node:child_process");`,
    `${EX}("node scripts/dao.mjs worker-done", { env: { PATH: "/bin" } });`,
  ].join('\n');
  const r = classifyTestDispatchSpawns(src);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.scanned, 0, JSON.stringify(r));
});

test('动态 import 默认导出带 --dry-run 仍绿', () => {
  const src = [
    'const mod = await import("node:child_process");',
    'const cp = mod.default;',
    `cp.${CALL}(process.execPath, ["scripts/dao.mjs", "dispatch", "--dry-run"], { env: { PATH: "/bin" } });`,
  ].join('\n');
  const r = classifyTestDispatchSpawns(src);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.scanned, 1);
});

test('计算属性 call 带 --dry-run 仍绿', () => {
  const lb = '[';
  const rb = ']';
  const src = [
    'const cp = require("node:child_process");',
    `cp.${CALL}${lb}"call"${rb}(null, process.execPath, ["scripts/dao.mjs", "dispatch", "--dry-run"], { env: { PATH: "/bin" } });`,
  ].join('\n');
  const r = classifyTestDispatchSpawns(src);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.scanned, 1);
});

test('审官 default 转发 / 计算属性适配 / exec 动态模板都不许 scanned:0 ok:true', () => {
  const applyOf = 'ap' + 'ply';
  const EX = 'ex' + 'ec';
  const lb = '[';
  const rb = ']';
  const tick = '`';
  const samples = [
    [
      'const mod = await import("node:child_process");',
      'const cp = mod.default;',
      `cp.${CALL}(process.execPath, ["scripts/dao.mjs", "dispatch"], { env: { PATH: "/bin" } });`,
    ].join('\n'),
    [
      'const cp = require("node:child_process");',
      `cp.${CALL}${lb}"call"${rb}(null, process.execPath, ["scripts/dao.mjs", "dispatch"], { env: { PATH: "/bin" } });`,
    ].join('\n'),
    [
      'const cp = require("node:child_process");',
      `cp.${CALL}${lb}"apply"${rb}(null, [process.execPath, ["scripts/dao.mjs", "dispatch"], { env: { PATH: "/bin" } }]);`,
    ].join('\n'),
    [
      'const cp = require("node:child_process");',
      `cp.${CALL}${lb}"bind"${rb}(null)(process.execPath, ["scripts/dao.mjs", "dispatch"], { env: { PATH: "/bin" } });`,
    ].join('\n'),
    [
      'const cp = require("node:child_process");',
      `Reflect${lb}"${applyOf}"${rb}(cp.${CALL}, null, [process.execPath, ["scripts/dao.mjs", "dispatch"], { env: { PATH: "/bin" } }]);`,
    ].join('\n'),
    [
      `const { ${EX} } = require("node:child_process");`,
      `${EX}(${tick}node scripts/dao.mjs \${getVerb()}${tick}, { env: { PATH: "/bin", HOME: "/tmp" } });`,
    ].join('\n'),
  ];
  for (const src of samples) {
    const r = classifyTestDispatchSpawns(src);
    assert.equal(r.ok, false, JSON.stringify({ src, r }));
    assert.notEqual(r.scanned, 0, JSON.stringify({ src, r }));
  }
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
