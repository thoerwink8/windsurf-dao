#!/usr/bin/env node

// dao check —— 仓库现在是不是好的，唯一的答案。
//
// 改这个文件前必须知道的四条规矩（来历与推理见 docs/decisions/2026-08-12-blueprint-from-zero.md 件 5）：
//   1. 退出码只有 0 和 1。加第三个态，它就变回了它替换掉的那个东西。
//   2. 每个检查都是扫描出来的，不许出现手写的清单——清单会过期，过期的清单等于没查。
//      每个检查都必须自带「零样本报红」：扫出 0 条就报红。「数到 0」和「没看到样本」输出一样，
//      不分开就等于把「这次没查成」记成了「查过没事」。
//   3. 报失败只有三个槽位：什么坏了 / 怎么修 / 机器自己给的一行证据。第四行物理上写不进去。
//      这是结构约束不是风格。
//   4. 没有任何东西检查 dao check 自己。它坏了会在使用中被看见——它的输出每次都有人读。
//      想在它之上再加一层检查之前，先读上面那份蓝图第六章第 4 条。
//
// 准入判据（想加一个检查时用它自问）：这个检查防住的失败，是不可逆的，或者是静默的吗？
// 两个都不是 ⇒ 不加，让它在使用中被发现。
//
// 2026-08-14 拆旧（issue #425）：hook 注册 / 命令表 / skill 部署三个检查连同一套旧体系退役，
// 检查项随之删除；之后按对抗审意见恢复了「跑 tests/ 下测试」的检查（脱敏回归网回来）。
// 当前检查：①跑 tests/ 下所有测试 ②skill 装载 ③密钥不进 git 追踪面 ④常驻文件 token 预算
// ⑤模型路由表（TOML 可解析 + 必填字段 + providers.launch）⑥ host/memory 索引双向齐
// ⑦命令库 --help 参数存活（local-only：本机必须真跑 orca --help；
//   CI 无 orca 输出 SKIP「本项需本机 orca，CI 无法验证」，不计失败。
//   不许静默跳过——SKIP 和 ok 必须能分开）。
// ⑧态注入 hook 装载面点得到且真跑得动（issue #488），全部扫描自发现。
// ⑨本机 memory 是否指向仓内 host/memory 的 Junction（local-only，issue #503）：
//   普通目录/指向别处/悬空均红；本机无该项目 memory 目录（CI/新机/未接 worktree）出 SKIP 不是绿。

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { checkModeHook } from './lib/dao-mode-hook-check.mjs';
import { checkMemoryLink } from './lib/dao-memory-link-check.mjs';

const require = createRequire(import.meta.url);
// 标准 TOML 解析器（smol-toml，BSD-3，TOML 1.0 兼容，vendored 进 scripts/lib/smol-toml.cjs）。
// 不自己写正则拼凑：自己解析自己的格式等于自己查自己，查不出格式错。
const { parse: parseToml } = require('./lib/smol-toml.cjs');

const ROOT = resolve(import.meta.dirname, '..');
const t0 = Date.now();

const failures = [];
const greens = [];
const skips = [];

/** 报失败只有三个槽位：什么坏了 / 怎么修 / 机器自己给的一行证据。 */
function fail(what, howToFix, evidence) {
  failures.push([what, howToFix, evidence].filter(Boolean).slice(0, 3));
}
function green(line) { greens.push(line); }
function skip(line) { skips.push(line); }

function firstFailLine(output) {
  const line = String(output || '').split(/\r?\n/).find(l => /FAIL|✘|Assert|Error|error/.test(l));
  return (line || '(无输出)').trim().slice(0, 160);
}

// ── ① 跑 tests/ 下所有测试 ─────────────────────────────────────────
// 测试是静默失效型部件：坏了没人知道。所以自检必须每套都跑。
// 自发现：tests/ 下的每一套都跑，没有清单可以漏登记。

function runTests() {
  const dir = join(ROOT, 'tests');
  if (!existsSync(dir)) {
    fail('tests/ 目录不在', '恢复 tests/，或改 dao-check.mjs 的约定', dir);
    return;
  }
  const suites = readdirSync(dir).filter(f => /\.tests\.(js|ps1)$/.test(f)).sort();
  if (suites.length === 0) {
    fail('一套测试都没扫到', 'tests/ 空了 ⇒ 本次等于没查；补回测试', dir);
    return;
  }
  for (const f of suites) {
    const p = join(dir, f);
    const r = f.endsWith('.ps1')
      ? spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', p], { encoding: 'utf8', cwd: ROOT })
      : spawnSync(process.execPath, [p], { encoding: 'utf8', cwd: ROOT });
    const out = (r.stdout || '') + (r.stderr || '');
    if (r.status === 0) green(`测试 ${f}`);
    else fail(`测试红：${f}`, `复现：node tests/${f}`, firstFailLine(out));
  }
}

// ── ② skill 装载面 ──────────────────────────────────────────────────
// frontmatter 坏掉的 skill 不会报错，它只是不加载——静默失效。
// 自发现：扫 host/skills 下所有目录，没有清单可以漏登记。

function checkSkillFrontmatter() {
  const dir = join(ROOT, 'host', 'skills');
  if (!existsSync(dir)) {
    fail('host/skills 不在', '本次没查成：确认部署源目录是否被移动', dir);
    return;
  }
  const dirs = readdirSync(dir).filter(d => statSync(join(dir, d)).isDirectory());
  if (dirs.length === 0) {
    fail('一个 skill 都没扫到', 'host/skills 空了 ⇒ 本次等于没查', dir);
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

// ── ③ 密钥不在 git 追踪面 ───────────────────────────────────────────
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

// ── ④ 常驻文件 token 预算 ───────────────────────────────────────────
// 膨胀是不可感知型失效：每次只加几行，永远不会有人报警，等看见时已经是几百次提交之后。
// 所以预算类规则不等「第二次违例再升级」，立规即配闸。
// 期望集合从宿主约定推导（不是手写清单）：文件名是 CLAUDE.md / *-CLAUDE.md 的就是常驻注入面
// （CLAUDE.md 这个名字是宿主的注入机制本身），这类文件必须声明预算，缺声明即红——
// 否则删掉一行声明就能让单个文件静默逃出保护（对抗审 PR #437 抓出的绕过路径）。
// 其他 markdown 自愿声明的同样强制。
// 口径：token 按 字符数/2 估算——这是近似字符预算不是真 tokenizer 值，对以中文为主的
// 文本会低估 token（偏宽松），对英文偏严格；预算值应据此保守设定。

const BUDGET_MARK = /总量控制在\s*(\d+)\s*token/;
const RESIDENT_NAME = /(^|-)CLAUDE\.md$/;

function checkResidentBudget() {
  const found = [];
  const missing = [];
  for (const dir of [ROOT, join(ROOT, 'docs')]) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter(x => x.endsWith('.md'))) {
      const p = join(dir, f);
      if (!statSync(p).isFile()) continue;
      const rel = dir === ROOT ? f : `docs/${f}`;
      const txt = readFileSync(p, 'utf8');
      const m = txt.match(BUDGET_MARK);
      if (m) found.push({ rel, budget: Number(m[1]), tokens: Math.round(txt.length / 2) });
      else if (RESIDENT_NAME.test(f)) missing.push(rel);
    }
  }
  if (missing.length > 0) {
    fail(`常驻注入面缺预算声明 ${missing.length} 个`, '每个 CLAUDE.md 形态的文件末尾都要有「总量控制在 N token」声明，删声明=逃出保护', missing.join(' '));
    return;
  }
  if (found.length === 0) {
    fail('一个声明了 token 预算的常驻文件都没扫到', '常驻约定文件末尾要有「总量控制在 N token」声明；0 个声明 = 本次等于没查', `${ROOT} 与 docs/`);
    return;
  }
  const over = found.filter(c => c.tokens > c.budget);
  if (over.length === 0) green(`常驻预算(字符/2 估算,中文偏宽) ${found.map(c => `${c.rel} ${c.tokens}/${c.budget}`).join(' · ')}`);
  else fail(`常驻文件超预算 ${over.length} 个`, '加行前先删行；确实要扩容需用户拍板改声明值', over.map(c => `${c.rel} ${c.tokens}>${c.budget}`).join(' '));
}

// ── ⑤ 模型路由表 ───────────────────────────────────────────────────────
// 路由真相源是静默失效型部件：字段缺失没人报错，只会让下游按空气路由。
// 两道校验：①必填字段（why/decided/status/roles）缺失即红；②值校验——路由的
// model/fallback 必须指向 models[].id（防幽灵引用），beijing 必须是
// HH:MM-HH:MM 逗号列表（防填错的时段静默不匹配）。
// 自发现：文件在不在、条目数是不是 0，都单独报红——不把「没扫到」当「扫完 0 违规」。

const ROUTING_FILE = join(ROOT, 'docs', 'model-routing.toml');

function missingKeys(entry, keys) {
  return keys.filter(k => {
    const v = entry[k];
    return v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
  });
}

// beijing 时间窗格式：HH:MM-HH:MM 的逗号列表，小时 00-23、结束允许 24:00、分钟 00-59，
// 且结束必须晚于开始。
const BEIJING_WINDOW_RE = /^\d{2}:\d{2}-\d{2}:\d{2}(?:,\s*\d{2}:\d{2}-\d{2}:\d{2})*$/;

function validBeijingWindows(s) {
  if (typeof s !== 'string' || !BEIJING_WINDOW_RE.test(s.trim())) return false;
  return s.split(',').every(w => {
    const [a, b] = w.trim().split('-');
    const [ah, am] = a.split(':').map(Number);
    const [bh, bm] = b.split(':').map(Number);
    const hh = h => h >= 0 && h <= 23;
    if (!hh(ah) || am < 0 || am > 59) return false;
    if (!((bh === 24 && bm === 0) || hh(bh)) || bm < 0 || bm > 59) return false;
    return bh * 60 + bm > ah * 60 + am;
  });
}

function checkModelRouting() {
  if (!existsSync(ROUTING_FILE)) {
    fail('docs/model-routing.toml 不在', '路由真相源文件缺失 ⇒ 本次等于没查；恢复文件', ROUTING_FILE);
    return;
  }
  let doc;
  try {
    doc = parseToml(readFileSync(ROUTING_FILE, 'utf8'));
  } catch (e) {
    fail('docs/model-routing.toml 不是合法 TOML', '按标准 TOML 解析器报的错修文件', String(e.message || e).split(/\r?\n/)[0].slice(0, 160));
    return;
  }

  const models = Array.isArray(doc.models) ? doc.models : [];
  const routes = Array.isArray(doc.routes) ? doc.routes : [];
  const bans = Array.isArray(doc.bans) ? doc.bans : [];
  const rules = Array.isArray(doc.rules) ? doc.rules : [];

  if (models.length === 0 && routes.length === 0 && bans.length === 0 && rules.length === 0) {
    fail('路由表里一条模型/路由/禁令/规则都没扫到', '0 条 = 本次等于没查；按 schema 补条目', ROUTING_FILE);
    return;
  }

  const problems = [];
  const modelIds = new Set(models.map(m => m.id).filter(Boolean));
  if (!doc.updated) problems.push('顶层缺 updated');
  models.forEach((m, i) => {
    const miss = missingKeys(m, ['id', 'provider', 'roles', 'status', 'why', 'decided']);
    if (miss.length) problems.push(`models[${i}]缺${miss.join('/')}`);
  });
  routes.forEach((r, i) => {
    const miss = missingKeys(r, ['role', 'beijing', 'model', 'fallback', 'why', 'decided']);
    if (miss.length) problems.push(`routes[${i}]缺${miss.join('/')}`);
    if (r.model && !modelIds.has(r.model)) problems.push(`routes[${i}].model 幽灵引用 ${JSON.stringify(r.model)}`);
    if (r.fallback && !modelIds.has(r.fallback)) problems.push(`routes[${i}].fallback 幽灵引用 ${JSON.stringify(r.fallback)}`);
    if (r.beijing && !validBeijingWindows(r.beijing)) problems.push(`routes[${i}].beijing 格式不对 ${JSON.stringify(r.beijing)}`);
  });
  bans.forEach((b, i) => {
    const miss = missingKeys(b, ['scope', 'why', 'decided']);
    if (miss.length) problems.push(`bans[${i}]缺${miss.join('/')}`);
  });
  rules.forEach((r, i) => {
    const miss = missingKeys(r, ['rule', 'why', 'decided']);
    if (miss.length) problems.push(`rules[${i}]缺${miss.join('/')}`);
  });

  const usedProviders = [...new Set(models.map(m => m && m.provider).filter(Boolean))];
  if (usedProviders.length === 0) {
    problems.push('没扫到任何带 provider 的模型，providers.launch 没查成');
  } else {
    for (const name of usedProviders) {
      const p = doc.providers?.[name];
      if (!p) { problems.push(`${name} 无 providers 节`); continue; }
      if (!p.launch || String(p.launch).trim() === '') { problems.push(`${name} 缺 launch`); continue; }
      if (String(p.launch).includes('{model}') && !p.launch_model && !p.default_model) {
        problems.push(`${name} 的 launch 含 {model} 但缺 launch_model/default_model`);
      }
    }
  }

  if (problems.length === 0) {
    green(`模型路由表 ${models.length} 模型/${routes.length} 路由/${bans.length} 禁令/${rules.length} 规则，字段与引用齐，${usedProviders.length} 个 provider 有 launch`);
  } else {
    fail(`模型路由表校验不过 ${problems.length} 处`, '模型要 id/provider/roles/status/why/decided；路由要 role/beijing/model/fallback/why/decided，且 model/fallback 必须指向 models[].id、beijing 要是 HH:MM-HH:MM 逗号列表；禁令要 scope/why/decided；规则要 rule/why/decided；被模型引用的 provider 要有 launch', problems.slice(0, 10).join(' '));
  }
}

// ── ⑥ memory 索引双向齐 ──────────────────────────────────────────────
// MEMORY.md 是每轮注入的唯一索引面。有文件无索引 = 条目永不被 recall（静默）。
// 只读仓内 host/memory/，不碰本机 ~/.claude。链接用检查器自己的正则抽，
// 不复用任何「memory 自己的解析」。
// 零样本：目录不在 / 一个 md 都没有 / MEMORY.md 不在 / 索引 0 条但目录有条目 / 只有索引没有条目 → 没查成。

function checkMemoryIndex() {
  const dir = join(ROOT, 'host', 'memory');
  if (!existsSync(dir)) {
    fail('host/memory 不在', '本次没查成：确认 memory 真相源目录是否被移动', dir);
    return;
  }
  const files = readdirSync(dir).filter(f => f.endsWith('.md') && statSync(join(dir, f)).isFile());
  if (files.length === 0) {
    fail('host/memory 一个 md 都没扫到', '目录空了 ⇒ 本次等于没查', dir);
    return;
  }
  const indexPath = join(dir, 'MEMORY.md');
  if (!existsSync(indexPath)) {
    fail('host/memory/MEMORY.md 不在', '索引面缺失 ⇒ 条目不会被 recall；补回 MEMORY.md', indexPath);
    return;
  }
  const txt = readFileSync(indexPath, 'utf8');
  const indexed = new Set();
  const re = /\[[^\]]*\]\(([^)\s]+\.md)\)/gi;
  let m;
  while ((m = re.exec(txt))) {
    const target = m[1].replace(/\\/g, '/').split('/').pop();
    if (target && target.toLowerCase() !== 'memory.md') indexed.add(target);
  }
  const entries = files.filter(f => f !== 'MEMORY.md');
  if (entries.length === 0) {
    fail('host/memory 除 MEMORY.md 外一个条目都没扫到', '只有索引没有条目 ⇒ 本次等于没查', dir);
    return;
  }
  if (indexed.size === 0) {
    fail('MEMORY.md 一条索引都没扫到', '索引面空了但目录里有条目 ⇒ 本次等于没查', indexPath);
    return;
  }
  const missing = entries.filter(f => !indexed.has(f));
  const ghosts = [...indexed].filter(i => !entries.includes(i));
  if (missing.length === 0 && ghosts.length === 0) {
    green(`memory 索引 ${entries.length} 条与 MEMORY.md 双向齐`);
  } else {
    const bits = [];
    if (missing.length) bits.push(`有文件无索引: ${missing.join(' ')}`);
    if (ghosts.length) bits.push(`有索引无文件: ${ghosts.join(' ')}`);
    fail(`memory 索引不齐 ${missing.length + ghosts.length} 处`, 'MEMORY.md 每个条目要有 [标题](文件.md)，目录里每个 md（除 MEMORY.md）都要被点到', bits.join('；'));
  }
}

// ── ⑦ 命令库 --help 参数存活（local-only）──────────────────────────
// 库里用到的 orca 参数必须还在对应命令的真 --help 里。解析器自己写，不复用
// dao-cmd.parseHelpFlags。本机必须真跑 orca；CI 无 orca 走 SKIP，不计失败。
// 零样本：catalog 空 / help 空 / 一个 flag 都解析不到 → 没查成，不是「0 个缺失」。
// SKIP ≠ ok：输出必须能分开「扫完 0 条」和「这次没扫到」。

function parseHelpOptionsIndependent(text) {
  const flags = new Set();
  for (const line of String(text || '').split(/\r?\n/)) {
    const opt = line.match(/^\s+(--[a-z0-9][a-z0-9-]*)\b/i);
    if (opt) flags.add(opt[1]);
    const usage = line.match(/^\s*Usage:/i);
    if (usage) {
      const re = /(--[a-z0-9][a-z0-9-]*)/gi;
      let m;
      while ((m = re.exec(line))) flags.add(m[1]);
    }
  }
  return flags;
}

async function checkCommandHelp() {
  let catalogUsedFlags, fetchOrcaHelp, orcaHelpAvailable, isCiEnv, helpCheckPolicy;
  try {
    const mod = await import(new URL('./lib/dao-cmd.mjs', import.meta.url));
    catalogUsedFlags = mod.catalogUsedFlags;
    fetchOrcaHelp = mod.fetchOrcaHelp;
    orcaHelpAvailable = mod.orcaHelpAvailable;
    isCiEnv = mod.isCiEnv;
    helpCheckPolicy = mod.helpCheckPolicy;
  } catch (e) {
    fail('命令库模块加载失败', '恢复 scripts/lib/dao-cmd.mjs', String(e.message || e).slice(0, 160));
    return;
  }

  const policy = helpCheckPolicy({ ci: isCiEnv(), orca: orcaHelpAvailable() });
  if (policy.action === 'skip') {
    skip(`命令库 --help 参数存活：${policy.reason}`);
    return;
  }
  if (policy.action === 'fail') {
    fail('命令库 --help 自检没查成', '本机装 orca 并保证在 PATH。此项本机必须真跑，不能跳过', policy.reason);
    return;
  }

  const catalog = catalogUsedFlags();
  if (!catalog || catalog.length === 0) {
    fail('命令库一条 orca 命令都没扫到', 'builder 空了 ⇒ 本次等于没查', 'catalogUsedFlags()');
    return;
  }
  const missing = [];
  let scanned = 0;
  for (const item of catalog) {
    let text;
    try {
      text = fetchOrcaHelp(item.cmd);
    } catch (e) {
      fail('命令库 --help 自检没查成', '本机 orca --help 必须能跑', `${item.cmd}: ${String(e.message || e).slice(0, 120)}`);
      return;
    }
    const available = parseHelpOptionsIndependent(text);
    if (available.size === 0) {
      fail('命令库 --help 一个参数都没解析到', 'help 文本形态变了，本次等于没查', item.cmd);
      return;
    }
    scanned++;
    for (const flag of item.flags || []) {
      if (!available.has(flag)) missing.push(`${item.cmd} ${flag}`);
    }
  }
  if (missing.length === 0) {
    green(`命令库参数存活 ${scanned} 条命令 / 源=live`);
  } else {
    fail(`库参数已不在 orca --help ${missing.length} 个`, 'orca 升级删了参数，或库用了从未存在的旗标（#482 的 --submit 坑）', missing.join(' '));
  }
}

// ── ⑧ 态注入 hook 活着（issue #488）────────────────────────────────────
// 专注/值守三态的承重墙是 UserPromptSubmit hook：它每轮把当前态注入上下文。
// 它是静默失效型部件的极端例子——被覆盖/断链/坏掉之后，态标还挂在那儿，
// AI 却什么都收不到，用户以为自己锁着，实际没锁。假状态比没状态更糟。
//
// 装载面没有单一 owner：插件面（~/.claude/skills/<名>/）会随仓库搬家、worktree 删除而断链，
// settings.json 更是 cc-switch DB 下发 / Orca 写 hooks / CC 本体重置三方互相覆盖
// （见 memory claude-settings-self-heal）。所以「装过一次」不等于「现在还在」，必须每次重验。
//
// 两层验，缺一不可（静态门控拦不住运行时失效）：
//   静态：仓内每个自带 hook 的 skill（host/skills/<名>/hooks/hooks.json）声明的脚本，
//         都要能在本机某个装载面上被点到。
//   运行时：把点到的那条命令真跑四次，四种状态文件各一次——读到且常态 / 读到且非常态 /
//         文件不在 / 文件坏了——断言四种输出两两不同形，且只有非常态那次带得出哨兵焦点。
//         这是「读到了且是常态」「读到了且非常态」「压根没读到」三形不得同形那条硬规矩的常驻闸
//         （第四形「读到了但坏了」一并单列：没读到和读坏了是两件事，处置不一样）。
// 自发现：期望集合从 host/skills/ 扫出来，没有手写清单可以漏登记。
// 零样本：skills 目录不在 / 没有任何 hook 声明 / 声明了但脚本没了 / 一个装载面都点不到，全部单独报红。

// 实现在 scripts/lib/dao-mode-hook-check.mjs（那里能被 tests/dao-mode.tests.js 拿假 HOME 造违规
// 样本单独验，不必跑整个 dao-check——dao-check 会跑 tests/，tests 再跑 dao-check 就递归了）。

function checkModeHookAlive() {
  const r = checkModeHook({ root: ROOT, home: process.env.USERPROFILE || process.env.HOME || '' });
  if (r.green) green(r.green);
  else fail(...r.fail);
}

// ── ⑨ 本机 memory 断链检查（local-only，issue #503）───────────────────
// 正确状态（NEW-MACHINE §10）：本机 `~/.claude/projects/<编码>/memory` 是指向本仓
// `host/memory/` 的 Junction，Claude 每写一条 memory 主仓 git status 就多一条未提交变更。
// #503 的病：本机是普通目录，与仓内完全漂移，今天写的每条教训换机就丢，而 dao-check 全绿——
// 它只查仓内副本（CI 没有本机 ~/.claude）。所以本项只验本机文件系统，CI/新机/未接 worktree
// 无该项目目录时出 SKIP 不是绿（SKIP 与绿分不开 ⇒ CI 永远绿、本机永远没人查）。
// 实现放 scripts/lib/dao-memory-link-check.mjs，让 tests/memory-link.tests.js 拿假 HOME 造
// 违规样本（普通目录/指向别处/悬空=红，正确 Junction=绿，无目录=SKIP）单独验判别力。

function checkMemoryLinkAlive() {
  const r = checkMemoryLink({ root: ROOT, home: process.env.USERPROFILE || process.env.HOME || '' });
  if (r.green) green(r.green);
  else if (r.skip) skip(r.skip);
  else fail(...r.fail);
}

// ── 跑 ──────────────────────────────────────────────────────────────

runTests();
checkSkillFrontmatter();
checkSecretsNotTracked();
checkResidentBudget();
checkModelRouting();
checkMemoryIndex();
await checkCommandHelp();
checkModeHookAlive();
checkMemoryLinkAlive();

const secs = ((Date.now() - t0) / 1000).toFixed(1);

if (failures.length === 0) {
  for (const g of greens) console.log(`  ok  ${g}`);
  for (const s of skips) console.log(`  SKIP  ${s}`);
  const skipBit = skips.length ? `，${skips.length} 项跳过` : '';
  console.log(`\ndao check: 好的（${greens.length} 项${skipBit}，${secs}s）`);
  process.exit(0);
}

for (const [what, how, evidence] of failures) {
  console.log(`\n  X  ${what}`);
  if (how) console.log(`     修：${how}`);
  if (evidence) console.log(`     ${evidence}`);
}
for (const s of skips) console.log(`  SKIP  ${s}`);
console.log(`\ndao check: 不好（${failures.length} 项红 / ${greens.length} 项绿 / ${skips.length} 项跳过，${secs}s）`);
process.exit(1);
