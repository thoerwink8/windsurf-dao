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
// 2026-08-16 拆旧（issue #529）：memory 整体搬到独立仓 thoerwink8/windsurf-dao-memory（#518），
// ⑥ 主仓 memory 索引双向齐随检查对象删除（索引齐的价值转到新仓自己的 gen-index.mjs --check）；
// ⑨ 判据从「Junction 指向仓内 memory 真相源」改为「Junction 目标仓的 origin ==
// thoerwink8/windsurf-dao-memory」。编号不复位：⑥ 的坑位消失，⑦~⑫ 保持原号，
// ⑨ 的引用在 NEW-MACHINE / tests / skills 里按 ⑨ 记账。
// 当前检查：①跑 tests/ 下所有测试 ②skill 装载 ③密钥不进 git 追踪面 ④常驻文件 token 预算
// ⑤模型路由表（TOML 可解析 + 必填字段 + providers.launch）
// ⑦命令库 --help 参数存活（local-only：本机必须真跑 orca --help；
//   CI 无 orca 输出 SKIP「本项需本机 orca，CI 无法验证」，不计失败。
//   不许静默跳过——SKIP 和 ok 必须能分开）。
// ⑧态注入 hook 装载面点得到且真跑得动（issue #488），全部扫描自发现。
// ⑨本机 memory 是否指向 windsurf-dao-memory 仓的 Junction（local-only，#503 判据改写 #529）：
//   Junction 目标必须是 git 仓且 origin remote 指向 thoerwink8/windsurf-dao-memory（从 URL 抽
//   owner/repo 再比，SSH/HTTPS 两种形式都认）；普通目录/悬空/目标不是 memory 仓/无 origin/
//   origin 不对均红；本机无该项目 memory 目录（CI/新机/未接 worktree）出 SKIP 不是绿。
// ⑩ extract* 解析外部 JSON 必须有真语料存档（#499）
// ⑪ 主帅标题核对样本（一致 / 过期 各至少一份）
// ⑫ 派工卡 comment 必须有单号定界区（#495：有区 / 缺区 各至少一份）
// ⑬ 派工闸 PreToolUse 活着且 fail-closed（#546 #517 #553）：挂载面=随仓 .claude/settings.json（#553 从 plugin 换挂法），
// 装载（有 dispatch-gate 条目）→ 指向（脚本真存在）→ 行为（旁路 exit 2、逃生口放行、崩了也 exit 2）三层全验
// ⑭ open issue 数量阈值（#556）：知识网堆回工作队列要报红；gh 不可用 SKIP 不是绿
// ⑮ 可立即起但没起（#577）：已消歧且无在途 PR/卡 → 打可见行，不报红；没查成 ≠ 0
// ⑯ 完工信号契约（#575 ⑥）：flow 读的「首行完工」与 worker-brief / dispatch skill 教的必须是同一句
//   （检查器自己持有标记文本，不 import flow/judgment 的正则）
// ⑰ 账本断流差集（#581）：GitHub 已合并带标 PR ∖ job.closed.pr_number；禁 Date.now；
//    两个反例都要过（有差集必红、无差集必绿）；基准 PR 号之后才对照

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { checkOrcaJsonFixtures } from './lib/orca-json-fixtures.mjs';
import { checkModeHook } from './lib/dao-mode-hook-check.mjs';
import { checkMemoryLink } from './lib/dao-memory-link-check.mjs';
import { checkDispatchGate } from './lib/dispatch-gate-check.mjs';
import { inspectReadyQueue } from './lib/ready-queue-check.mjs';
import { checkCompletionSignal } from './lib/completion-signal-check.mjs';
import {
  inspectLedgerGap, readClosedPrNumbers, LEDGER_GAP_BASELINE_PR, LEDGER_GAP_NEWEST_BUFFER,
} from './lib/ledger-gap-check.mjs';

const require = createRequire(import.meta.url);
// 标准 TOML 解析器（smol-toml，BSD-3，TOML 1.0 兼容，vendored 进 scripts/lib/smol-toml.cjs）。
// 不自己写正则拼凑：自己解析自己的格式等于自己查自己，查不出格式错。
const { parse: parseToml } = require('./lib/smol-toml.cjs');

const ROOT = resolve(import.meta.dirname, '..');
const t0 = Date.now();

const failures = [];
const greens = [];
const skips = [];
const notes = [];

/** 报失败只有三个槽位：什么坏了 / 怎么修 / 机器自己给的一行证据。 */
function fail(what, howToFix, evidence) {
  failures.push([what, howToFix, evidence].filter(Boolean).slice(0, 3));
}
function green(line) { greens.push(line); }
function skip(line) { skips.push(line); }

/** 取测试失败行：只认固定格式前缀「  FAIL  」（各测试套 check() 共用的输出形态），
 * 不按关键词匹配——测试名里带 fail/错误/红 字样的 PASS 行不许冒充失败证据（#566 排查实证）。
 * 一套红多条就全列，不许只报第一条（只报头一条会让人以为修完就绿了，然后再红一轮）。
 * 退出非 0 却没标准 FAIL 行 = 崩了/格式变了：返回 null，证据说「没查成」，不许拿别的行冒充。 */
function extractFailLines(output) {
  const lines = String(output || '').split(/\r?\n/);
  const fails = lines.filter(l => /^ {2}FAIL  /.test(l));
  if (fails.length) return fails.map(l => l.trim().slice(0, 200));
  return null;
}

function failLinesEvidence(output) {
  const fails = extractFailLines(output);
  if (fails) return `测试输出 ${fails.length} 条红：\n${fails.join('\n')}`;
  return '退出非 0 但没扫到标准「  FAIL  」行——测试崩了或输出格式变了，本次没查成，需人工复现';
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
    else fail(`测试红：${f}`, `复现：node tests/${f}`, failLinesEvidence(out));
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

function checkDispatchGateAlive() {
  const r = checkDispatchGate({ root: ROOT });
  if (r.green) green(r.green);
  else fail(...r.fail);
}

// ── ⑨ 本机 memory 断链检查（local-only，issue #503 / 判据改写 #529）───────────────────
// 正确状态（NEW-MACHINE §10）：本机 `~/.claude/projects/<编码>/memory` 是指向
// **windsurf-dao-memory 独立仓 clone** 的 Junction（memory 已自 #518 搬出主仓），
// Claude 每写一条 memory，memory 仓 git status 就多一条未提交变更。
// #529 之前的判据是「Junction 必须指向仓内 memory 真相源」，memory 搬家后本机必红——
// 判据改为：Junction 目标必须是一个 git 仓库，且它的 origin remote 指向
// thoerwink8/windsurf-dao-memory（从 URL 抽 owner/repo 再比，SSH/HTTPS 两种形态都认），
// 不硬编码本机路径，换机成立。
// #503 的病：本机 memory 是**普通目录**，与真相源完全漂移——今天写的每条教训
// 只在本机，换机即丢；而 dao-check 只查仓内副本（CI 没有本机 ~/.claude）……本项只验本机
// 文件系统，CI/新机/未接 worktree 无该项目目录时出 SKIP 不是绿（SKIP 与绿分不开 ⇒
// CI 永远绿、本机永远没人查）。
// 实现放 scripts/lib/dao-memory-link-check.mjs，让 tests/memory-link.tests.js 拿假 HOME 造
// 违规样本（普通目录/悬空/目标不是 git 仓/无 origin/origin 不是 memory 仓=红，
// 正确 Junction=绿，SSH/HTTPS 两种 origin 形式都验，无目录=SKIP）单独验判别力。

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

// ── ⑭ open issue 数量阈值（#556；#564 口径改版：只数没在做的单）──────────────────
// 知识网堆回工作队列是不可感知型失效：每张单只多一条，看见时已细成一团（#556 实测：
// 四天积 45 张、缠绕度 89%）。超过阈值报红，附「过一遍 ideas 分流」。
//
// #564 阈值口径改版：原来把在途单也算进积压，开两张施工单就撞顶。改成只数**没在做的**单，
// 判据用**有无在途 PR / worktree 卡关联**（机器可见的事实），不用 label（靠自觉打标会烂）。
//   在途 PR 面：gh pr list --state open，正文/标题里 Closes/Fixes 署名的 issue 号（独立正则，
//             不调用 dao-cmd 的解析——自己查自己查不出错）。
//   在途卡面：orca worktree list，卡名 ^#N 的号（master 主树与 archived 不算）。
// 两道面缺一道 = 判不全面，不许当查过没事：缺了 orca 面会把在途卡算成积压（惩罚正在工作，
// 正是本改版要防的）；gh 面缺了本来就什么都查不了。CI 无 GH_TOKEN → SKIP 不是绿。
// 判据独立：直接 JSON.parse gh/orca 的输出。「没查成」与「查了是 0」必须分得开。
// 阈值是棘轮：只降不升，默认取当前 backlog 数 + 1。#556 分流关掉 14 张后由 44 降到 30；
// 帅批量分流后应随之下调，目标 10（一组在施 + 下一批小活）。
// 变异测试：DAO_CHECK_OPEN_ISSUE_MAX=0 必红（当前非零数据）；边界：N/N 绿、N+1/N 红。

const OPEN_ISSUE_MAX_DEFAULT = 30;

/** PR/标题/正文里的署名 issue 号（只认 GitHub 关闭关键词；本检查自己的正则，不调用 dao-cmd）。 */
function closesNumbers(text) {
  const found = [];
  const re = /(?:close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved)\s+#(\d+)/gi;
  let m;
  while ((m = re.exec(String(text || '')))) {
    const t = Number(m[1]);
    if (!found.includes(t)) found.push(t);
  }
  return found;
}

function runGhJson(args) {
  const r = spawnSync('gh', args, { encoding: 'utf8', cwd: ROOT });
  if (r.error) return { unscanned: true, error: `gh 不可用（${r.error.code}）` };
  if (r.status !== 0) return { unscanned: true, error: String(r.stderr || r.stdout || '').trim().slice(0, 100) };
  let doc;
  try { doc = JSON.parse(r.stdout); } catch (e) { return { unscanned: true, error: `输出不是 JSON（${String(e.message || e).slice(0, 80)}）` }; }
  if (!Array.isArray(doc)) return { unscanned: true, error: `输出形态不对（要数组：${typeof doc}）` };
  return { array: doc };
}

function runOrcaWorktrees() {
  const win = process.platform === 'win32';
  const direct = spawnSync(win ? 'orca.exe' : 'orca', ['worktree', 'list', '--json'], { encoding: 'utf8', cwd: ROOT });
  const r = direct.error ? (() => {
    const line = ['orca', 'worktree', 'list', '--json'].map(a => `"${a.replace(/"/g, '\\"')}"`).join(' ');
    return spawnSync(line, { encoding: 'utf8', shell: true, cwd: ROOT });
  })() : direct;
  if (r.error || r.status !== 0) return { unscanned: true, error: r.error?.code || `exit ${r.status}` };
  let doc;
  try { doc = JSON.parse(r.stdout || ''); } catch { return { unscanned: true, error: 'orca worktree list 输出不是 JSON' }; }
  const wts = Array.isArray(doc?.result?.worktrees) ? doc.result.worktrees : null;
  if (!wts) return { unscanned: true, error: 'orca worktree list 没有 result.worktrees 数组' };
  return { worktrees: wts };
}

function loadOpenBoard() {
  return {
    issues: runGhJson(['issue', 'list', '--state', 'open', '--limit', '500', '--json', 'number,title,body,labels']),
    prs: runGhJson(['pr', 'list', '--state', 'open', '--limit', '500', '--json', 'number,title,body']),
    worktrees: runOrcaWorktrees(),
  };
}

function checkOpenIssueCount(board) {
  const max = Number(process.env.DAO_CHECK_OPEN_ISSUE_MAX || OPEN_ISSUE_MAX_DEFAULT);
  if (!Number.isFinite(max) || max < 0) {
    fail('open 单阈值没查成', `DAO_CHECK_OPEN_ISSUE_MAX 不是非负数: ${process.env.DAO_CHECK_OPEN_ISSUE_MAX}`);
    return;
  }
  const issues = board.issues;
  if (issues.unscanned) {
    skip(`open 单数量阈值：gh issue list 没查成（${issues.error}），本次没查成，不是绿`);
    return;
  }
  const prs = board.prs;
  if (prs.unscanned) {
    skip(`open 单数量阈值：open PR 面没查成（${prs.error}）——在途排除做不全，不是绿`);
    return;
  }
  const wt = board.worktrees;
  if (wt.unscanned) {
    skip('open 单数量阈值：worktree 卡面没查成（orca 不可用或输出畸形）——少这张卡面会把在途单算成积压，本次没查成，不是绿');
    return;
  }
  const cards = [];
  for (const w of wt.worktrees) {
    if (!w || w.isMainWorktree || w.isArchived) continue;
    const name = String(w.displayName || '');
    const m = name.match(/^#(\d+)/);
    if (m) cards.push(Number(m[1]));
  }
  const inPr = new Set();
  for (const p of prs.array) {
    for (const n of closesNumbers(`${p.title || ''}\n${p.body || ''}`)) inPr.add(n);
  }
  const inCard = new Set(cards);
  if (issues.array.some(i => !i || typeof i.number !== 'number')) {
    fail('open 单数量没查成', 'gh issue list 输出形态不对（要 number 对象数组）', `拿到 ${typeof issues.array[0]}`);
    return;
  }
  const backlog = issues.array.filter(i => !inPr.has(i.number) && !inCard.has(i.number));
  const n = backlog.length;
  if (n > max) {
    fail(`open 未在做单 ${n} 张，超阈值 ${max}（共 ${issues.array.length} 张 open，${inPr.size} 张有在途 PR、${inCard.size} 张有本地卡）`, '过一遍 ideas 分流：每张单答开单三问（#556），排不上队的转 docs/ideas.md', 'gh issue list --state open --limit 500 --json number,title,body');
    return;
  }
  green(`open 未在做单 ${n}/${max}（共 ${issues.array.length} 张 open，在途排除：PR ${inPr.size} 张 / 卡 ${inCard.size} 张）`);
}

// ── ⑮ 可立即起但没起（#577：规矩不配检查等于没有；本项只可见不报红）────────
// 已消歧 + 无在途 PR/卡 → 打「有 N 个可立即起的单没起」。帅可能有正当理由
// （并发满、真依赖），所以不翻转退出码；今晚的病是它完全不可见。
// 解析在 ready-queue-check.mjs，不复用 ⑭ 的 closesNumbers。
// 并发上限随 #576 落地，本项不发明数字。#576 的 next 接手列表后本项退役。

function checkReadyQueue(board) {
  if (board.issues.unscanned) {
    skip(`可立即起：没查成（issue 面：${board.issues.error}，≠ 扫完是 0）`);
    return;
  }
  if (board.prs.unscanned) {
    skip(`可立即起：没查成（PR 面：${board.prs.error}，≠ 扫完是 0）`);
    return;
  }
  if (board.worktrees.unscanned) {
    skip(`可立即起：没查成（卡面：${board.worktrees.error}，≠ 扫完是 0）`);
    return;
  }
  const r = inspectReadyQueue({
    issues: board.issues.array,
    prs: board.prs.array,
    worktrees: board.worktrees.worktrees,
  });
  if (r.kind === 'unscanned') skip(r.line);
  else if (r.kind === 'zero') green(r.line);
  else notes.push(r.line);
}

// ── ⑰ 账本断流差集（#581）──────────────────────────────────────────
// 判据是集合差不是时钟。样本必须两种都有：有差集必红、无差集必绿。
// 只验一种会把「永远红」或「永远绿」当生效。

function checkLedgerGapSamples() {
  const dir = join(ROOT, 'tests', 'fixtures', 'ledger-gap');
  if (!existsSync(dir)) {
    fail('账本断流样本目录不在', '本次没查成：恢复 tests/fixtures/ledger-gap/', dir);
    return;
  }
  const files = readdirSync(dir).filter(f => f.endsWith('.json')).sort();
  if (files.length === 0) {
    fail('账本断流一套样本都没扫到', '目录空了 ⇒ 本次等于没查', dir);
    return;
  }
  const kinds = { gap: 0, ok: 0 };
  const problems = [];
  for (const f of files) {
    let doc;
    try { doc = JSON.parse(readFileSync(join(dir, f), 'utf8')); }
    catch { problems.push(`${f} 不是 JSON`); continue; }
    if (!doc || !Array.isArray(doc.githubPrs) || !Array.isArray(doc.events) || !doc.expect) {
      problems.push(`${f} 缺 githubPrs/events/expect`);
      continue;
    }
    if (doc.expect !== 'gap' && doc.expect !== 'ok') {
      problems.push(`${f} expect 只能是 gap|ok`);
      continue;
    }
    const r = inspectLedgerGap({
      githubPrs: doc.githubPrs,
      closedNumbers: new Set(
        (doc.events || [])
          .filter(e => e && e.type === 'job.closed' && Number.isInteger(e.pr_number))
          .map(e => e.pr_number),
      ),
      baselinePr: doc.baselinePr ?? 0,
      newestBuffer: doc.newestBuffer ?? 0,
    });
    kinds[doc.expect] += 1;
    if (doc.expect === 'gap' && r.kind !== 'gap') {
      problems.push(`${f} 自称有差集但判成 ${r.kind}（样本没判别力）`);
    }
    if (doc.expect === 'ok' && r.kind !== 'ok') {
      problems.push(`${f} 自称无差集但判成 ${r.kind}：${r.line}`);
    }
  }
  if (kinds.gap === 0 || kinds.ok === 0) {
    fail('账本断流样本种类不够', '至少各要一份有差集（expect:gap）和一份无差集（expect:ok），缺一种 = 没查成', `gap=${kinds.gap} ok=${kinds.ok}`);
    return;
  }
  if (problems.length) {
    fail(`账本断流样本对不上 ${problems.length} 处`, '样本的 expect 必须和独立差集核对一致', problems.join(' '));
    return;
  }
  green(`账本断流样本 ${files.length} 份（有差集 ${kinds.gap} / 无差集 ${kinds.ok}）`);
}

function checkLedgerGapLive() {
  const prs = runGhJson([
    'pr', 'list', '--state', 'merged', '--limit', '1000',
    '--json', 'number,labels',
  ]);
  if (prs.unscanned) {
    skip(`账本断流：gh pr list 没查成（${prs.error}），本次没查成，不是绿`);
    return;
  }
  if (prs.array.some(p => !p || typeof p.number !== 'number')) {
    fail('账本断流没查成', 'gh pr list 输出形态不对（要 number 对象数组）', `拿到 ${typeof prs.array[0]}`);
    return;
  }
  const closed = readClosedPrNumbers(join(ROOT, 'ledger/events'));
  if (closed.unscanned) {
    fail('账本断流没查成', 'ledger/events 读失败，不是差集空', closed.error);
    return;
  }
  const r = inspectLedgerGap({
    githubPrs: prs.array,
    closedNumbers: closed.numbers,
    baselinePr: LEDGER_GAP_BASELINE_PR,
    newestBuffer: LEDGER_GAP_NEWEST_BUFFER,
  });
  if (r.kind === 'empty-github') {
    skip(r.line);
    return;
  }
  if (r.kind === 'gap') {
    fail(r.line, '先跑 dianjiangtai-backfill 补存量，或查 flow/dao 为何没写 job.closed', `缺 ${r.missing.map(n => `#${n}`).join(' ')}`);
    return;
  }
  green(r.line);
}

runTests();
checkSkillFrontmatter();
checkSecretsNotTracked();
checkResidentBudget();
checkModelRouting();
await checkCommandHelp();
checkModeHookAlive();
checkDispatchGateAlive();
checkMemoryLinkAlive();
checkExtractFixtures();
checkMasterTitleSamples();
checkCardCommentSamples();
const openBoard = loadOpenBoard();
checkOpenIssueCount(openBoard);
checkReadyQueue(openBoard);
checkCompletionSignalAlive();
checkLedgerGapSamples();
checkLedgerGapLive();

function checkCompletionSignalAlive() {
  const r = checkCompletionSignal({ root: ROOT });
  if (r.green) green(r.green);
  else fail(...r.fail);
}

const secs = ((Date.now() - t0) / 1000).toFixed(1);
const noteBit = notes.length ? `，${notes.length} 条可见` : '';

if (failures.length === 0) {
  for (const g of greens) console.log(`  ok  ${g}`);
  for (const n of notes) console.log(`  见  ${n}`);
  for (const s of skips) console.log(`  SKIP  ${s}`);
  const skipBit = skips.length ? `，${skips.length} 项跳过` : '';
  console.log(`\ndao check: 好的（${greens.length} 项${noteBit}${skipBit}，${secs}s）`);
  process.exit(0);
}

for (const [what, how, evidence] of failures) {
  console.log(`\n  X  ${what}`);
  if (how) console.log(`     修：${how}`);
  if (evidence) console.log(`     ${evidence}`);
}
for (const n of notes) console.log(`  见  ${n}`);
for (const s of skips) console.log(`  SKIP  ${s}`);
console.log(`\ndao check: 不好（${failures.length} 项红 / ${greens.length} 项绿 / ${skips.length} 项跳过${noteBit}，${secs}s）`);
process.exit(1);
