// tests/spawn-budget.test.js —— spawn 预算闸的判别力
//
// 这条闸是「第二刀没做完」的报警器（见 scripts/lib/spawn-budget.mjs 头部）。
// 失效方式：扫描面坏了却报绿，或未声明的调用被实际数量自动放宽。
// #1399：公共总数账本制造无关 PR 冲突；本套还要证明按文件声明后，
// 不同模块加预算不再撞车，同一声明确有冲突时 git 仍阻断。

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  classifySpawnBudget,
  collectSpawnBudgetInputs,
  countSpawnCalls,
  declFileForTest,
  parseBudgetDeclaration,
  SECOND_CUT_TARGET,
  SPAWN_CALL_RE,
} from '../scripts/lib/spawn-budget.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const LIB = join(HERE, '..', 'scripts', 'lib', 'spawn-budget.mjs');

function tmp(files) {
  const dir = mkdtempSync(join(tmpdir(), 'spawn-budget-'));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return dir;
}

function verdict(files) {
  const dir = tmp(files);
  try {
    return classifySpawnBudget(collectSpawnBudgetInputs(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const CALL = 'spawn' + 'Sync(';
const WHY = 'CLI 边界：必须看到另一进程的退出码';

test('① 超本文件预算判红并点名，不按实际数放宽', () => {
  const r = verdict({
    'a.test.js': `${CALL});${CALL});`,
    'a.test.spawn-budget.json': JSON.stringify({ budget: 1, why: WHY }),
  });
  assert.equal(r.state, 'red');
  assert.equal(r.actualTotal, 2);
  assert.equal(r.declaredTotal, 1);
  assert.match(r.detail, /超本文件预算/);
  assert.match(r.detail, /a\.test\.js/);
  assert.match(r.detail, /第二刀/, '报警要带「该怎么办」，只报数字没用');
});

test('② 「没扫到」不许当成「没有 spawn」', () => {
  assert.equal(classifySpawnBudget([]).state, 'unknown');
  assert.match(classifySpawnBudget([]).detail, /没查成/);
  assert.equal(classifySpawnBudget(null).state, 'unknown');
  const emptyDir = mkdtempSync(join(tmpdir(), 'spawn-budget-empty-'));
  try {
    const c = collectSpawnBudgetInputs(emptyDir);
    assert.equal(c.scan, 'unknown');
    assert.equal(classifySpawnBudget(c).state, 'unknown');
  } finally {
    rmSync(emptyDir, { recursive: true, force: true });
  }
  const zero = verdict({ 'a.test.js': 'export const n = 0;\n' });
  assert.equal(zero.state, 'ok', '扫完确实 0 处调用 → 绿，与没扫到必须分得开');
});

test('③ 声明内判绿；卡在声明合计上如实说', () => {
  const under = classifySpawnBudget({
    scan: 'ok',
    counts: [{ file: 'a.test.js', count: 2 }],
    declarations: [{ declFile: 'a.test.spawn-budget.json', key: 'a.test', budget: 5, why: WHY }],
  });
  assert.equal(under.state, 'ok');
  assert.equal(under.actualTotal, 2);
  assert.equal(under.declaredTotal, 5);
  const exact = classifySpawnBudget({
    scan: 'ok',
    counts: [{ file: 'a.test.js', count: 5 }],
    declarations: [{ declFile: 'a.test.spawn-budget.json', key: 'a.test', budget: 5, why: WHY }],
  });
  assert.equal(exact.state, 'ok');
  assert.match(exact.detail, /正好卡在声明合计上/);
});

test('④ 只数调用不数「提到」（首版把 import 行和注释都算了进去）', () => {
  const S = 'spawn' + 'Sync';
  const src = [
    `import { ${S} } from "node:child_process";`,
    `// 这里说明 ${S} 的坑`,
    `const r = ${S}("git", []);`,
    `${S} ( "node", [] );`,
  ].join('\n');
  assert.equal(countSpawnCalls(src), 2, `只该数出 2 处调用，实际 ${countSpawnCalls(src)}`);
});

test('⑤ 真实扫描：本仓当前调用数不超过各文件声明（第二刀往下做要同步降声明）', () => {
  const collected = collectSpawnBudgetInputs(HERE);
  const r = classifySpawnBudget(collected);
  assert.notEqual(r.state, 'unknown', '扫描面坏了——本条等于没查');
  assert.equal(r.state, 'ok', r.detail);
  assert.equal(r.actualTotal <= r.declaredTotal, true);
});

test('⑥ 未声明 spawn 必须红——删声明、新调用都不许靠实际数混绿', () => {
  const undeclared = verdict({ 'a.test.js': `${CALL});` });
  assert.equal(undeclared.state, 'red');
  assert.match(undeclared.detail, /未声明/);
  const extra = verdict({
    'a.test.js': `${CALL});${CALL});`,
    'a.test.spawn-budget.json': JSON.stringify({ budget: 1, why: WHY }),
  });
  assert.equal(extra.state, 'red');
});

test('⑦ 坏 JSON / 坏字段 / 扫描 0 文件都不能报绿', () => {
  const badJsonDir = tmp({
    'a.test.js': 'export const x = 1;\n',
    'a.test.spawn-budget.json': '{ budget: 1, why: "nope" }',
  });
  try {
    const c = collectSpawnBudgetInputs(badJsonDir);
    const r = classifySpawnBudget(c);
    assert.notEqual(r.state, 'ok', r.detail);
    assert.equal(r.state, 'unknown', 'JSON 都读不成是没查成');
    assert.match(r.detail, /JSON/);
  } finally {
    rmSync(badJsonDir, { recursive: true, force: true });
  }
  const badField = verdict({
    'a.test.js': `${CALL});`,
    'a.test.spawn-budget.json': JSON.stringify({ budget: 'auto', why: WHY }),
  });
  assert.equal(badField.state, 'red');
  assert.match(badField.detail, /整数/);
  const missingWhy = parseBudgetDeclaration(JSON.stringify({ budget: 1 }), 'x.json');
  assert.equal(missingWhy.state, 'red');
  assert.match(missingWhy.detail, /why/);
});

test('⑧ 不把实际观测数当预算；两模块合计不是取最大值', () => {
  const auto = classifySpawnBudget({
    scan: 'ok',
    counts: [{ file: 'a.test.js', count: 9 }],
    declarations: [{ declFile: 'a.test.spawn-budget.json', key: 'a.test', budget: 1, why: WHY }],
  });
  assert.equal(auto.state, 'red', '实际 9 不能把预算顶成 9');
  const both = classifySpawnBudget({
    scan: 'ok',
    counts: [
      { file: 'a.test.js', count: 2 },
      { file: 'b.test.js', count: 2 },
    ],
    declarations: [
      { declFile: 'a.test.spawn-budget.json', key: 'a.test', budget: 2, why: WHY },
      { declFile: 'b.test.spawn-budget.json', key: 'b.test', budget: 2, why: WHY },
    ],
  });
  assert.equal(both.state, 'ok', both.detail);
  assert.equal(both.declaredTotal, 4, '两笔都要计入，不是 max(2,2)=2');
  assert.equal(both.actualTotal, 4);
});

test('⑨ 检查器不复用被检查测试自己的计数器', () => {
  const r = verdict({
    'a.test.js': `export const MY_COUNT = 99;\n${CALL});`,
    'a.test.spawn-budget.json': JSON.stringify({ budget: 1, why: WHY }),
  });
  assert.equal(r.state, 'ok', r.detail);
  assert.equal(r.actualTotal, 1);
});

test('⑩ 公共总数常量已删（那就是冲突源）', () => {
  const src = readFileSync(LIB, 'utf8');
  assert.doesNotMatch(src, /export const SPAWN_BUDGET\s*=/);
  assert.doesNotMatch(src, /export const BUDGET_NOTE\s*=/);
  assert.equal(Number.isInteger(SECOND_CUT_TARGET), true);
  assert.equal(declFileForTest('land.test.js'), 'land.test.spawn-budget.json');
});

test('⑪ 双分支 merge-tree：不同模块声明可合；公共账本与同一声明仍冲突', () => {
  const dir = mkdtempSync(join(tmpdir(), 'spawn-budget-git-'));
  const script = join(dir, 'run.sh');
  writeFileSync(script, `#!/usr/bin/env bash
set -eu
ROOT="$1"

init_repo() {
  local p="$1"
  mkdir -p "$p"
  command git init -q -b master "$p"
  command git -C "$p" config user.email t@t
  command git -C "$p" config user.name t
  command git -C "$p" config commit.gpgsign false
}

# --- 新布局：两个模块各一份声明 ---
NEW="$ROOT/new"
init_repo "$NEW"
mkdir -p "$NEW/tests"
printf '%s\\n' '{"budget":1,"why":"A CLI"}' > "$NEW/tests/a.test.spawn-budget.json"
printf '%s\\n' '{"budget":1,"why":"B CLI"}' > "$NEW/tests/b.test.spawn-budget.json"
printf '%s\\n' 'call();' > "$NEW/tests/a.test.js"
printf '%s\\n' 'call();' > "$NEW/tests/b.test.js"
command git -C "$NEW" add tests
command git -C "$NEW" commit -qm 'base'
command git -C "$NEW" checkout -qb branch-a
printf '%s\\n' '{"budget":2,"why":"A CLI +1"}' > "$NEW/tests/a.test.spawn-budget.json"
printf '%s\\n' 'call(); call();' > "$NEW/tests/a.test.js"
command git -C "$NEW" add tests
command git -C "$NEW" commit -qm 'A +1'
command git -C "$NEW" checkout -q master
command git -C "$NEW" checkout -qb branch-b
printf '%s\\n' '{"budget":2,"why":"B CLI +1"}' > "$NEW/tests/b.test.spawn-budget.json"
printf '%s\\n' 'call(); call();' > "$NEW/tests/b.test.js"
command git -C "$NEW" add tests
command git -C "$NEW" commit -qm 'B +1'

set +e
NEW_AB_OUT=$(command git -C "$NEW" merge-tree --write-tree --messages branch-a branch-b 2>&1)
NEW_AB_CODE=$?
set -e
NEW_AB_TREE=$(printf '%s\\n' "$NEW_AB_OUT" | awk '/^[0-9a-f]{40,}$/{print; exit}')
echo "NEW_AB_CODE=$NEW_AB_CODE"
echo "NEW_AB_CONFLICT=$(printf '%s\\n' "$NEW_AB_OUT" | grep -c '^CONFLICT' || true)"
if [ -n "$NEW_AB_TREE" ]; then
  echo "NEW_AB_A=$(command git -C "$NEW" cat-file -p "$NEW_AB_TREE:tests/a.test.spawn-budget.json" | tr -d '\\n')"
  echo "NEW_AB_B=$(command git -C "$NEW" cat-file -p "$NEW_AB_TREE:tests/b.test.spawn-budget.json" | tr -d '\\n')"
fi

command git -C "$NEW" checkout -q master
command git -C "$NEW" merge -q --no-edit branch-a
set +e
NEW_MB_OUT=$(command git -C "$NEW" merge-tree --write-tree --messages master branch-b 2>&1)
NEW_MB_CODE=$?
set -e
echo "NEW_MB_CODE=$NEW_MB_CODE"
echo "NEW_MB_CONFLICT=$(printf '%s\\n' "$NEW_MB_OUT" | grep -c '^CONFLICT' || true)"
NEW_MB_TREE=$(printf '%s\\n' "$NEW_MB_OUT" | awk '/^[0-9a-f]{40,}$/{print; exit}')
if [ -n "$NEW_MB_TREE" ]; then
  echo "NEW_MB_A=$(command git -C "$NEW" cat-file -p "$NEW_MB_TREE:tests/a.test.spawn-budget.json" | tr -d '\\n')"
  echo "NEW_MB_B=$(command git -C "$NEW" cat-file -p "$NEW_MB_TREE:tests/b.test.spawn-budget.json" | tr -d '\\n')"
fi

# --- 旧布局：公共数字 + 历史串 ---
OLD="$ROOT/old"
init_repo "$OLD"
mkdir -p "$OLD/scripts/lib"
printf '%s\\n' 'export const SPAWN_BUDGET = 160;' 'export const BUDGET_NOTE = "base";' > "$OLD/scripts/lib/ledger.mjs"
command git -C "$OLD" add scripts
command git -C "$OLD" commit -qm 'old base'
command git -C "$OLD" checkout -qb old-a
printf '%s\\n' 'export const SPAWN_BUDGET = 161;' 'export const BUDGET_NOTE = "base A+1";' > "$OLD/scripts/lib/ledger.mjs"
command git -C "$OLD" add scripts
command git -C "$OLD" commit -qm 'old A'
command git -C "$OLD" checkout -q master
command git -C "$OLD" checkout -qb old-b
printf '%s\\n' 'export const SPAWN_BUDGET = 161;' 'export const BUDGET_NOTE = "base B+1";' > "$OLD/scripts/lib/ledger.mjs"
command git -C "$OLD" add scripts
command git -C "$OLD" commit -qm 'old B'
set +e
OLD_OUT=$(command git -C "$OLD" merge-tree --write-tree --messages old-a old-b 2>&1)
OLD_CODE=$?
set -e
echo "OLD_CODE=$OLD_CODE"
echo "OLD_CONFLICT=$(printf '%s\\n' "$OLD_OUT" | grep -c '^CONFLICT' || true)"

# --- 同一份声明两边都改：必须仍冲突 ---
command git -C "$NEW" checkout -q master
command git -C "$NEW" checkout -qb clash-a
printf '%s\\n' '{"budget":3,"why":"A clash"}' > "$NEW/tests/a.test.spawn-budget.json"
command git -C "$NEW" add tests
command git -C "$NEW" commit -qm 'clash A'
command git -C "$NEW" checkout -q master
command git -C "$NEW" checkout -qb clash-b
printf '%s\\n' '{"budget":4,"why":"B clash"}' > "$NEW/tests/a.test.spawn-budget.json"
command git -C "$NEW" add tests
command git -C "$NEW" commit -qm 'clash B'
set +e
CLASH_OUT=$(command git -C "$NEW" merge-tree --write-tree --messages clash-a clash-b 2>&1)
CLASH_CODE=$?
set -e
echo "CLASH_CODE=$CLASH_CODE"
echo "CLASH_CONFLICT=$(printf '%s\\n' "$CLASH_OUT" | grep -c '^CONFLICT' || true)"
`);
  try {
    const r = spawnSync('bash', [script, dir], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 60000,
    });
    assert.equal(r.status, 0, `merge 实验脚本失败：${r.stderr || r.stdout}`);
    const out = String(r.stdout || '');
    const grab = (k) => {
      const m = out.match(new RegExp(`^${k}=(.*)$`, 'm'));
      assert.ok(m, `缺 ${k}：\\n${out}`);
      return m[1];
    };
    assert.equal(grab('NEW_AB_CODE'), '0', out);
    assert.equal(grab('NEW_AB_CONFLICT'), '0', out);
    assert.equal(grab('NEW_MB_CODE'), '0', out);
    assert.equal(grab('NEW_MB_CONFLICT'), '0', out);
    const a = JSON.parse(grab('NEW_AB_A'));
    const b = JSON.parse(grab('NEW_AB_B'));
    assert.equal(a.budget, 2);
    assert.equal(b.budget, 2);
    assert.equal(a.budget + b.budget, 4, '计入两笔，不是取最大值');
    const ma = JSON.parse(grab('NEW_MB_A'));
    const mb = JSON.parse(grab('NEW_MB_B'));
    assert.equal(ma.budget, 2);
    assert.equal(mb.budget, 2);
    assert.notEqual(grab('OLD_CODE'), '0', '旧公共账本必须仍冲突');
    assert.equal(Number(grab('OLD_CONFLICT')) > 0, true, out);
    assert.notEqual(grab('CLASH_CODE'), '0', '同一声明确有分歧时必须仍阻断');
    assert.equal(Number(grab('CLASH_CONFLICT')) > 0, true, out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('⑫ 迁移后声明合计覆盖本仓既有调用（不隐式按实际数改上限）', () => {
  const collected = collectSpawnBudgetInputs(HERE);
  assert.equal(collected.scan, 'ok', collected.scanDetail);
  const byFile = Object.fromEntries(collected.counts.map((c) => [c.file, c.count]));
  const decls = Object.fromEntries(
    collected.declarations.filter((d) => !d.headroom).map((d) => [d.key, d]),
  );
  for (const [file, n] of Object.entries(byFile)) {
    if (n <= 0) continue;
    const key = file.replace(/\.(js|mjs|cjs)$/i, '');
    assert.ok(decls[key], `${file} 有 ${n} 处调用却没有声明`);
    assert.equal(decls[key].parseState || 'ok', 'ok', decls[key].parseDetail);
    assert.equal(n <= decls[key].budget, true, `${file} 实际 ${n} > 声明 ${decls[key].budget}`);
  }
  const files = readdirSync(HERE).filter((f) => f.endsWith('.spawn-budget.json'));
  assert.equal(files.length > 0, true, '声明文件必须进 git，不能只靠运行时按实际数生成');
});

test('⑬ 注释和字符串里的 spawnSync( 不当调用（#1405 审官 P1）', () => {
  const src = [
    'spawnSync("real");',
    '// spawnSync("comment");',
    'const s = "spawnSync(str)";',
  ].join('\n');
  assert.equal((src.match(SPAWN_CALL_RE) || []).length, 3, '正则扫原文仍会把注释/字符串算进去');
  assert.equal(countSpawnCalls(src), 1, '词法扫描只留那一处真调用');
  assert.equal(countSpawnCalls('/* spawnSync("block"); */'), 0);
  assert.equal(countSpawnCalls("const b = 'spawnSync(str)';"), 0);
  assert.equal(countSpawnCalls('const c = `spawnSync(tmpl)`;'), 0);
  assert.equal(countSpawnCalls('spawnSync /* gap */ ("x");'), 1);
  assert.equal(countSpawnCalls('const d = `x ${spawnSync("inner")} y`;'), 1, '模板插值里的调用要数');
});
