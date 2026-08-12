#!/usr/bin/env node

// dao check —— 「这套系统现在是好的吗」的唯一答案。
//
// 改这个文件前必须知道的四条不变量（来历与推理归 docs/decisions/2026-08-12-blueprint-from-zero.md 件 5）：
//   1. 退出码只有 0 和 1。加第三个态，它就变回了它替换掉的那个东西。
//   2. 检查面靠扫描算出，不许出现手维护的清单——清单会过期，而过期的清单是静默放行。
//      每个检查面都必须自带零样本闸：扫出 0 条即判红。「数到 0」和「没看到样本」输出一样，
//      不分开就等于把「本次没查成」记成了「查过没事」。
//   3. 失败解释只有 fail(标题, 怎么修, 证据) 三个槽位，第四行物理上写不进去。这是结构约束不是风格。
//   4. 没有任何东西检查 dao check 自己。它坏了会在使用中被看见——它的输出每次都有人读。
//      想在它之上再加一层守卫之前，先读上面那份蓝图第六章第 4 条。
//
// 准入判据（想加一个检查项时用它自问）：这个检查防住的失败，是不可逆的，或者是静默的吗？
// 两个都不是 ⇒ 不加，让它在使用中被发现。

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(import.meta.dirname, '..');
const t0 = Date.now();

const failures = [];
const greens = [];

/** 失败只有三个槽位：什么坏了 / 怎么修 / 机器自己给的一行证据。 */
function fail(what, howToFix, evidence) {
  failures.push([what, howToFix, evidence].filter(Boolean).slice(0, 3));
}
function green(line) { greens.push(line); }

function firstFailLine(output) {
  const line = String(output || '').split(/\r?\n/).find(l => /FAIL|✘|Assert|Error|error/.test(l));
  return (line || '(无输出)').trim().slice(0, 160);
}

// ── ① 不可逆闸的自测 ────────────────────────────────────────────────
// 闸是静默失效型部件：挂了没人知道。所以闸的自测是全系统唯一必须存在的测试。
// 自发现：tests/ 下的每一套都跑，没有清单可以漏登记。

function checkGateSelfTests() {
  const dir = join(ROOT, 'tests');
  if (!existsSync(dir)) {
    fail('tests/ 目录不在', '闸的自测是必须存在的，恢复 tests/ 或改 dao-check.mjs 的约定', dir);
    return;
  }
  const suites = readdirSync(dir).filter(f => /\.tests\.(js|ps1)$/.test(f)).sort();
  if (suites.length === 0) {
    fail('一套闸自测都没扫到', 'tests/ 空了 ⇒ 本次等于没查；补回闸的自测', dir);
    return;
  }
  for (const f of suites) {
    const p = join(dir, f);
    const r = f.endsWith('.ps1')
      ? spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', p], { encoding: 'utf8', cwd: ROOT })
      : spawnSync(process.execPath, [p], { encoding: 'utf8', cwd: ROOT });
    const out = (r.stdout || '') + (r.stderr || '');
    if (r.status === 0) green(`闸自测 ${f}`);
    else fail(`闸自测红：${f}`, `复现：node tests/${f}`, firstFailLine(out));
  }
}

// ── ② 闸的注册面 ────────────────────────────────────────────────────
// 闸的文件还在、但注册里指着一个不存在的路径 ⇒ 宿主静默跳过，那道闸就死了而没人知道。
// 真相源是 config-sync/common/settings.json（下发到宿主的那份配置的仓内源）。

function checkHookRegistration() {
  const p = join(ROOT, 'config-sync', 'common', 'settings.json');
  if (!existsSync(p)) {
    fail('hook 注册源不在', `本次没查成，不是没问题：确认 ${'config-sync/common/settings.json'} 是否被移动`, p);
    return;
  }
  let paths = [];
  try {
    const rows = JSON.parse(readFileSync(p, 'utf8')).rows || [];
    const blob = rows.map(r => String(r.value || '')).join('\n');
    paths = [...blob.matchAll(/\$\{PROJECT_ROOT\}\/([A-Za-z0-9_./-]+)/g)].map(m => m[1]);
  } catch (e) {
    fail('hook 注册源解析不了', '修 config-sync/common/settings.json 的 JSON', String(e.message).slice(0, 160));
    return;
  }
  const uniq = [...new Set(paths)];
  if (uniq.length === 0) {
    fail('注册面解析出 0 条', '解析器与配置格式对不上 ⇒ 本次等于没查；核 settings.json 里的 ${PROJECT_ROOT} 写法', p);
    return;
  }
  const missing = uniq.filter(rel => !existsSync(join(ROOT, rel)));
  if (missing.length === 0) green(`闸注册面 ${uniq.length} 条全部指得到`);
  else fail(`注册了却不存在的闸 ${missing.length} 个`, '要么补回文件，要么从 config-sync/common/settings.json 里摘掉注册', missing.join(' '));
}

// ── ③ skill 装载面 ──────────────────────────────────────────────────
// frontmatter 坏掉的 skill 不会报错，它只是不加载——同样是静默失效。

function checkSkillFrontmatter() {
  const dir = join(ROOT, 'ccswitch', 'skills');
  if (!existsSync(dir)) {
    fail('ccswitch/skills 不在', '本次没查成：确认部署源目录是否被移动', dir);
    return;
  }
  const dirs = readdirSync(dir).filter(d => statSync(join(dir, d)).isDirectory());
  if (dirs.length === 0) {
    fail('一个 skill 都没扫到', 'ccswitch/skills 空了 ⇒ 本次等于没查', dir);
    return;
  }
  const bad = [];
  for (const d of dirs) {
    const f = join(dir, d, 'SKILL.md');
    if (!existsSync(f)) { bad.push(`${d}(缺 SKILL.md)`); continue; }
    const m = readFileSync(f, 'utf8').match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!m) { bad.push(`${d}(无 frontmatter)`); continue; }
    const name = (m[1].match(/^name:\s*(.+)$/m) || [])[1]?.trim();
    if (!name) bad.push(`${d}(无 name)`);
    else if (name !== d) bad.push(`${d}(name=${name})`);
  }
  if (bad.length === 0) green(`skill 装载面 ${dirs.length} 个 frontmatter 可解析`);
  else fail(`装载不了的 skill ${bad.length} 个`, 'SKILL.md 要有 frontmatter，且 name 必须等于目录名', bad.join(' '));
}

// ── ④ 密钥不在 git 追踪面 ───────────────────────────────────────────
// 全系统唯一真正不可逆的伤害：密钥一旦进 git，删不掉、改不回、只能换密钥。
// 自发现：扫 git 追踪面里所有「密钥形态」的文件名，不维护任何白名单。

const SECRET_SHAPED = /(?:^|[/.-])(?:secret|secrets|credential|credentials|token|password|apikey|api-key)[^/]*\.(?:json|ya?ml|txt|ini|conf|cfg|env)$|\.(?:pem|key|pfx|p12|jks|keystore)$|(?:^|\/)\.env(?:\.|$)/i;

function checkSecretsNotTracked() {
  const r = spawnSync('git', ['ls-files'], { encoding: 'utf8', cwd: ROOT });
  if (r.status !== 0) {
    fail('git 追踪面读不出来', '本次没查成，不是没问题：在 git 仓库里跑 dao check', String(r.stderr || '').trim().slice(0, 160));
    return;
  }
  const tracked = r.stdout.split(/\r?\n/).filter(Boolean);
  if (tracked.length === 0) {
    fail('追踪面扫出 0 个文件', '本次等于没查：确认 cwd 是仓库根', ROOT);
    return;
  }
  const hits = tracked.filter(f => SECRET_SHAPED.test(f));
  if (hits.length === 0) green(`密钥防线 追踪面 ${tracked.length} 个文件无密钥形态`);
  else fail(`疑似密钥进了 git ${hits.length} 个`, '立刻 git rm --cached + 补 .gitignore + 当作已泄漏换掉它', hits.join(' '));
}

// ── 跑 ──────────────────────────────────────────────────────────────

checkGateSelfTests();
checkHookRegistration();
checkSkillFrontmatter();
checkSecretsNotTracked();

const secs = ((Date.now() - t0) / 1000).toFixed(1);

if (failures.length === 0) {
  for (const g of greens) console.log(`  ok  ${g}`);
  console.log(`\ndao check: 好的（${greens.length} 项，${secs}s）`);
  process.exit(0);
}

for (const [what, how, evidence] of failures) {
  console.log(`\n  X  ${what}`);
  if (how) console.log(`     修：${how}`);
  if (evidence) console.log(`     ${evidence}`);
}
console.log(`\ndao check: 不好（${failures.length} 项红 / ${greens.length} 项绿，${secs}s）`);
process.exit(1);
