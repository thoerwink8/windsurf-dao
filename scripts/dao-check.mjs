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
// ⑩ extract* 解析外部 JSON 必须有真语料存档（#499）
// ⑪ 主帅标题核对样本（一致 / 过期 各至少一份）
// ⑫ 派工卡 comment 必须有单号定界区（#495：有区 / 缺区 各至少一份）

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { checkOrcaJsonFixtures } from './lib/orca-json-fixtures.mjs';
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
  const lines = String(output || '').split(/\r?\n/);
  // 优先抓失败断言本身（测试输出里「  FAIL  断言名」行首标记；PASS 行 detail 里可能含 error 字样，
  // 不能整行搜 error——#497 第五轮帅实证：报红时证据贴的是 PASS 行，等于指不出红在哪）。
  const failLine = lines.find(l => /^\s*(FAIL|✘|✗)\s/.test(l));
  if (failLine) return failLine.trim().slice(0, 200);
  const xLine = lines.find(l => /^\s*X\s+/.test(l)); // dao-check 自己的 fail 形（runTests 外的兜底）
  if (xLine) return xLine.trim().slice(0, 200);
  // 抓不到失败标记：退回输出末尾几行 + 注明（不是静默贴末尾）
  const tail = lines.slice(-8).join(' | ').trim().slice(0, 300);
  return `(未找到失败标记，以下为输出末尾) ${tail || '(无输出)'}`;
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

// ── ⑧ 流转器存活心跳（#480 收口：合并 ≠ 生效——flow 已合并但从未在跑且不报警）────
// _flow/heartbeat.json 由 scripts/flow.mjs 每轮原子写（字段契约见 flow.mjs 文件头）。
// 看门狗（#471）读它判「该发生而没发生」；这里只做最外层「有没有在跑」的闸：
// 缺失或 ts 超时即红——把「flow 没在跑」从「今天恰好没事」里分出来。
// 仓规两条：①解析用 dao-check 自己的 Date.parse，不 import flow.mjs 的解析逻辑；
// ②缺失（没扫到样本）与超时分别报，缺失 ≠ 查过没事。
// CI 不是 flow 宿主（CI 每次全新检出，flow 只跑在主仓运行机）——GITHUB_ACTIONS 下跳过并显式声明。

const HEARTBEAT_FILE = join(ROOT, '_flow', 'heartbeat.json');
const HEARTBEAT_STALE_MS = 15 * 60 * 1000; // 轮询间隔 300s × 3 余量

// 主工作树判定（#497 第七轮：宿主判据从可变状态换成拓扑事实——帅住主工作树，NEW-MACHINE §9b 帅手起 flow）。
// 仓规：检查逻辑不得复用被检查对象自己的解析逻辑——自己跑 git 问拓扑，不 import flow/watchdog 的判定。
// git rev-parse --git-dir 与 --git-common-dir 相同 = 主工作树；linked worktree 的 --git-dir 指向 .git/worktrees/<name>。
// 判不出来（非 git 仓 / git 不可用）→ 显形跳过并说明原因，不默认当宿主也不默认跳过掉无声。
function mainWorktreeTopo() {
  const r = spawnSync('git', ['rev-parse', '--git-dir', '--git-common-dir'], { encoding: 'utf8', cwd: ROOT, windowsHide: true });
  if (r.error || r.status !== 0) {
    return { ok: false, error: String(r.error?.message || r.stderr || `exit ${r.status}`).trim().slice(0, 120) };
  }
  const lines = String(r.stdout || '').trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return { ok: false, error: 'git rev-parse 输出不可识别' };
  const norm = p => resolve(p).replace(/[\\/]+$/, '').toLowerCase();
  return { ok: true, isMain: norm(lines[0]) === norm(lines[1]) };
}

function checkFlowHeartbeat() {
  if (process.env.GITHUB_ACTIONS === 'true') {
    green(`流转器心跳 CI 环境跳过（CI 不是 flow 宿主；存活闸只在主仓运行机生效）`);
    return;
  }
  // #497 第七轮：宿主判据用拓扑事实（主工作树 = 帅住的树 = flow 唯一常驻地），不用可变状态。
  // 第六轮的「无 _flow/state.json = 非宿主」会自我循环：flow 从未启动 → 任何树都没有 state.json →
  // 每棵树都跳过 → 「流转器压根没启动」谁都不报（watchdog.mjs:795-798 正是把缺失托付给 dao-check ⑧，
  // 上一版让那行注释变成指向空气的指针）。主工作树该跑而没跑 → 真红；非主工作树 → 显形跳过。
  const topo = mainWorktreeTopo();
  if (!topo.ok) {
    skip(`流转器心跳：判不出本树是不是主工作树（${topo.error}）——本项无法验证，显形跳过`);
    return;
  }
  if (!topo.isMain) {
    skip('流转器心跳：本树不是 flow 宿主（非主工作树），本项无法验证——心跳存活闸只在主工作树生效；帅住主树、flow 由帅手起（NEW-MACHINE §9b）');
    return;
  }
  if (!existsSync(HEARTBEAT_FILE)) {
    fail('流转器心跳缺失——flow 没在跑', 'node scripts/flow.mjs --run <runId> 值守（NEW-MACHINE §9b）；心跳文件每轮原子写，缺失 = 合并≠生效的老病', HEARTBEAT_FILE);
    return;
  }
  let ts = null;
  let round = null;
  try {
    const raw = JSON.parse(readFileSync(HEARTBEAT_FILE, 'utf8'));
    ts = Date.parse(raw && raw.ts);
    round = raw && raw.round;
  } catch (e) {
    fail('流转器心跳文件读不出 ts', '心跳文件损坏/半截（flow 在写时被删？）；重启流转器', `${HEARTBEAT_FILE}：${String(e.message || e).split(/\r?\n/)[0].slice(0, 120)}`);
    return;
  }
  if (!Number.isFinite(ts)) {
    fail('流转器心跳 ts 不是时间', 'ts 字段非法——flow 版本不对或文件被手改；重启流转器', `${HEARTBEAT_FILE}（ts=${String(ts)}）`);
    return;
  }
  const age = Date.now() - ts;
  if (age > HEARTBEAT_STALE_MS) {
    fail(`流转器心跳超时（${Math.round(age / 60000)} 分钟前，阈值 ${HEARTBEAT_STALE_MS / 60000} 分钟）`, 'flow 可能停了——该发生而没发生；查终端与 _flow/state.json，重启 flow', `${HEARTBEAT_FILE}（round=${round ?? '?'}，ts=${new Date(ts).toISOString()}）`);
    return;
  }
  green(`流转器心跳存活（${Math.max(0, Math.round(age / 1000))}s 前，round=${round ?? '?'}）`);
}

// ── ⑨ 流转器直拼 orca vs 命令库覆盖（#497 第三轮：写了指针就要配报警器）────
// 扫 scripts/flow.mjs 里直接拼 orca 命令的调用点，与 dao-cmd 导出的 DISPATCH_VERBS 对照：
// 命中「派工闸门动词」（dispatch/worker-start——#478 合并权约束 merge-policy/reviewer 的载体）
// 且不在已登记豁免表 → 红。通用透传动词（task-create/worktree-create 等）无闸门值，
// 不构成 merge-policy 旁路，不在报警范围。解析器自己写（正则扫 runOrca([...]) 的字符串
// 字面量），不复用 flow/dao-cmd 的任何解析逻辑。零样本：flow.mjs 读不到 → 没查成报红；
// 读得到但 0 个直拼调用 → 扫完 0 条（绿）——两者必须能分开。

const FLOW_FILE = join(ROOT, 'scripts', 'flow.mjs');
// 已登记豁免：动词 → 理由。#498 补上「续活/审官」场景后删掉本条，本检查立即报红，逼流转器改走库。
const FLOW_DAO_BYPASS_EXEMPT = {
  'worker-start': '库 worker-start 强制 --merge-policy+--reviewer+--worktree 且不用 --agent；flow 起审官/续活三类调用填不出真值（审官不产 PR；续活 merge-policy 派单时已定）——硬填=造假数据喂闸门',
};

async function checkFlowVsDaoLibrary() {
  if (!existsSync(FLOW_FILE)) {
    fail('scripts/flow.mjs 读不到', '本次没查成：确认文件在', FLOW_FILE);
    return;
  }
  let gateVerbs;
  try {
    const mod = await import(new URL('./lib/dao-cmd.mjs', import.meta.url));
    gateVerbs = mod.DISPATCH_VERBS || ['dispatch', 'worker-start'];
  } catch (e) {
    fail('命令库模块加载失败（⑨ 对照参考读不到）', '恢复 scripts/lib/dao-cmd.mjs', String(e.message || e).slice(0, 160));
    return;
  }
  const src = readFileSync(FLOW_FILE, 'utf8');
  const calls = [];
  const re = /runOrca\(\s*\[([\s\S]*?)\]\s*\)/g;
  let m;
  while ((m = re.exec(src))) {
    const lits = [...m[1].matchAll(/'([^']+)'|"([^"]+)"/g)].map(x => x[1] || x[2]);
    calls.push(lits.slice(0, 2).join(' '));
  }
  if (calls.length === 0) {
    green(`流转器 orca 直拼 0 条（全走库或无需 orca）——扫完 0 条`);
    return;
  }
  const hits = calls.filter(p => gateVerbs.includes(p.split(' ')[1]));
  if (hits.length === 0) {
    green(`流转器直拼 orca ${calls.length} 处，均非派工闸门动词（${gateVerbs.join('/')}）——扫完 0 条违规`);
    return;
  }
  const unexempted = hits.filter(p => !FLOW_DAO_BYPASS_EXEMPT[p.split(' ')[1]]);
  if (unexempted.length === 0) {
    green(`流转器直拼派工闸门动词 ${hits.length} 处，全在登记豁免内（${Object.keys(FLOW_DAO_BYPASS_EXEMPT).join('/')}）——扫完 0 条违规`);
    return;
  }
  fail(`流转器直拼命令库已覆盖的派工闸门动词 ${unexempted.length} 处`, 'flow 该走 scripts/dao.mjs 封装（#498 补上续活/审官后豁免已删）；改调用为走库', [...new Set(unexempted)].join(' '));
}

// ── 跑 ──────────────────────────────────────────────────────────────
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

// ── ⑩ extract* 必须有 orca 真语料 ──────────────────────────────────
// 自发现：扫 dao-cmd.mjs 的 export function extract*，不手写函数名单。
// 检查器只验信封（ok+result），不调用 extract*。
// 零样本：一个 extract* 都扫不到 / 语料目录不在 / index 不在 → 没查成。

function checkExtractFixtures() {
  const daoCmdPath = join(ROOT, 'scripts', 'lib', 'dao-cmd.mjs');
  if (!existsSync(daoCmdPath)) {
    fail('dao-cmd.mjs 不在', '本次没查成：恢复 scripts/lib/dao-cmd.mjs', daoCmdPath);
    return;
  }
  const report = checkOrcaJsonFixtures({
    daoCmdText: readFileSync(daoCmdPath, 'utf8'),
    fixtureDir: join(ROOT, 'tests', 'fixtures', 'orca-json'),
  });
  if (report.unscanned) {
    fail('orca 真语料检查没查成', 'tests/fixtures/orca-json/ 要有 index.json，且 dao-cmd 要有 extract* 导出', report.error);
    return;
  }
  if (!report.ok) {
    fail(`extract* 缺真语料 ${report.missing.length} 处`, '每个 extract* 在 orca-json/index.json 登记一份真实 --json 存档（含采集命令和日期）', report.missing.join(' '));
    return;
  }
  green(`orca 真语料 ${report.scanned.length}/${report.parserCount} 个 extract* 有存档`);
}

// ── ⑪ 主帅标题核对样本 ─────────────────────────────────────────────
// 检查器自己抽 ｜[#N] 定界区，不调用 master-title.mjs。
// 零样本：目录不在 / 一个样本都没有 / 只有一致没有过期（或反过来）→ 没查成。

function zoneTicketsIndependent(title) {
  const m = String(title || '').match(/｜\[([^\]]*)\]$/);
  if (!m) return { hasZone: false, tickets: [] };
  return { hasZone: true, tickets: m[1].match(/#\d+/g) || [] };
}

function checkMasterTitleSamples() {
  const dir = join(ROOT, 'tests', 'fixtures', 'master-title');
  if (!existsSync(dir)) {
    fail('主帅标题样本目录不在', '本次没查成：恢复 tests/fixtures/master-title/', dir);
    return;
  }
  const files = readdirSync(dir).filter(f => f.endsWith('.json')).sort();
  if (files.length === 0) {
    fail('主帅标题一套样本都没扫到', '目录空了 ⇒ 本次等于没查', dir);
    return;
  }
  const kinds = { ok: 0, stale: 0 };
  const problems = [];
  for (const f of files) {
    let doc;
    try { doc = JSON.parse(readFileSync(join(dir, f), 'utf8')); }
    catch (e) { problems.push(`${f} 不是 JSON`); continue; }
    if (!doc || !('title' in doc) || !('openIds' in doc) || !doc.expect) {
      problems.push(`${f} 缺 title/openIds/expect`);
      continue;
    }
    const parsed = zoneTicketsIndependent(doc.title);
    const open = new Set((doc.openIds || []).map(x => `#${String(x).replace(/^#/, '')}`));
    const stale = parsed.hasZone ? parsed.tickets.filter(t => !open.has(t)) : [];
    if (doc.expect === 'ok') {
      kinds.ok++;
      if (stale.length) problems.push(`${f} 自称一致但定界区有过期 ${stale.join(' ')}`);
    } else if (doc.expect === 'stale') {
      kinds.stale++;
      if (stale.length === 0) problems.push(`${f} 自称过期但定界区与 openIds 一致（样本没判别力）`);
    } else {
      problems.push(`${f} expect 只能是 ok|stale`);
    }
  }
  if (kinds.ok === 0 || kinds.stale === 0) {
    fail('主帅标题样本种类不够', '至少各要一份一致（expect:ok）和一份过期（expect:stale），缺一种 = 没查成', `ok=${kinds.ok} stale=${kinds.stale}`);
    return;
  }
  if (problems.length) {
    fail(`主帅标题样本对不上 ${problems.length} 处`, '样本的 expect 必须和定界区 vs openIds 的独立核对一致', problems.join(' '));
    return;
  }
  green(`主帅标题样本 ${files.length} 份（一致 ${kinds.ok} / 过期 ${kinds.stale}）`);
}

// ── ⑫ 派工卡 comment 必须有定界区 ──────────────────────────────────
// 检查器自己抽 ｜[#N]，不调用 master-title.mjs。
// 零样本：目录不在 / 一个样本都没有 / 只有 ok 没有 missing（或反过来）→ 没查成。

function checkCardCommentSamples() {
  const dir = join(ROOT, 'tests', 'fixtures', 'card-comment');
  if (!existsSync(dir)) {
    fail('派工卡 comment 样本目录不在', '本次没查成：恢复 tests/fixtures/card-comment/', dir);
    return;
  }
  const files = readdirSync(dir).filter(f => f.endsWith('.json')).sort();
  if (files.length === 0) {
    fail('派工卡 comment 一套样本都没扫到', '目录空了 ⇒ 本次等于没查', dir);
    return;
  }
  const kinds = { ok: 0, missing: 0 };
  const problems = [];
  for (const f of files) {
    let doc;
    try { doc = JSON.parse(readFileSync(join(dir, f), 'utf8')); }
    catch (e) { problems.push(`${f} 不是 JSON`); continue; }
    if (!doc || !('comment' in doc) || !('expectedTickets' in doc) || !doc.expect) {
      problems.push(`${f} 缺 comment/expectedTickets/expect`);
      continue;
    }
    const parsed = zoneTicketsIndependent(doc.comment);
    const expected = (doc.expectedTickets || []).map(x => `#${String(x).replace(/^#/, '')}`);
    const missing = expected.filter(t => !parsed.tickets.includes(t));
    if (doc.expect === 'ok') {
      kinds.ok++;
      if (!parsed.hasZone) problems.push(`${f} 自称有区但抽不到 ｜[#N]`);
      else if (missing.length) problems.push(`${f} 自称齐全但缺 ${missing.join(' ')}`);
    } else if (doc.expect === 'missing') {
      kinds.missing++;
      if (parsed.hasZone && missing.length === 0) {
        problems.push(`${f} 自称缺区但定界区与期望一致（样本没判别力）`);
      }
    } else {
      problems.push(`${f} expect 只能是 ok|missing`);
    }
  }
  if (kinds.ok === 0 || kinds.missing === 0) {
    fail('派工卡 comment 样本种类不够', '至少各要一份有区（expect:ok）和一份缺区（expect:missing），缺一种 = 没查成', `ok=${kinds.ok} missing=${kinds.missing}`);
    return;
  }
  if (problems.length) {
    fail(`派工卡 comment 样本对不上 ${problems.length} 处`, '样本的 expect 必须和定界区 vs expectedTickets 的独立核对一致', problems.join(' '));
    return;
  }
  green(`派工卡 comment 样本 ${files.length} 份（有区 ${kinds.ok} / 缺区 ${kinds.missing}）`);
}

runTests();
checkSkillFrontmatter();
checkSecretsNotTracked();
checkResidentBudget();
checkModelRouting();
checkMemoryIndex();
await checkCommandHelp();
checkModeHookAlive();     // master（#490/#496 侧）
checkMemoryLinkAlive();   // master（#504 侧）
checkFlowHeartbeat();     // #497 侧（b929782 引入）
checkExtractFixtures();   // master（#502 侧）
checkMasterTitleSamples(); // master（#502 侧）
checkCardCommentSamples(); // master（#502 侧）
await checkFlowVsDaoLibrary(); // #497 第三轮（⑨ 直拼对照）



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
