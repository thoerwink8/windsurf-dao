#!/usr/bin/env node
// scripts/flow.mjs —— 闭环自动流转器（issue #455 实现）
//
// 分工定论（#455 实录）：看门狗（scripts/watchdog.mjs）管事故（屏面异常），
// 本脚本管完工（GitHub 确定性信号）——两者正交，不要把完工检测塞回看门狗；
// 反过来同理：屏面特征（如「待授权」）归看门狗，不塞进本脚本。
// 规格源 = issue #455 正文 + 全部评论（拍板、需求语料、边界）。
//
// 触发源只用 GitHub 确定性信号，不靠屏面猜测：
//   ① review 判定行：「判定：红 N 项」「复核结论：绿/红 N 项」——
//      解析逻辑与 scripts/calibrate.mjs 共用 scripts/lib/judgment.mjs（唯一真相源，不复制两份）
//   ② 完工 comment：行首「完工」「返工(完成|处置)」（完工报告/完工自报/返工完成/返工处置）
//   ③ PR MERGED 状态
//
// 决策规则（②）：
//   - 工人完工且无审官  → 按 docs/model-routing.toml 审官选型序输出起审官配置
//   - 审官红 N 项       → 输出注入工人返工的指令文本（机械转发，不做内容判断）
//   - 复核绿            → 报帅终审（终审+校准+合并归档归帅，不自动合并）
//   - 乒乓两轮仍红      → 报帅换人（换人决策归帅）
//   - 判定行缺失/格式不符 → 报帅分诊（「没查成」≠「无需流转」）
//
// 执行注入（③）：
//   - 起审官：oneShot（codex/grok）走官方首注入通道 `--agent X --prompt <任务书>`
//     （orca worktree create --help：--prompt sends initial work to that agent），
//     不手工 send 进就绪竞态；两步走（claude）注入前先 terminal read 轮询就绪
//     （[providers.claude] 配置同步期抢跑注入必被吞），就绪后才 send。
//   - 验开工：增量判据为主（read 记 nextCursor → send → read --cursor，有新输出
//     = token 在动）；回显判据为辅（TUI 回显注入文本头）。被吞第一处置补一记裸回车
//     （#455 连带教训：输入框残留，第二遍全文同样堆积），仍无 → fail-visible 报帅。
//   - 注入目标确定性定位：起审官时记 handle+审官卡 id；返工注入按任务卡 worktree 内
//     唯一候选终端（排除审官句柄与 shell），选不出唯一目标就报帅，不挑第一个。
//   - 复核注入：优先记录句柄，其次记录审官卡，兜底反查「审官·」子卡；全找不到
//     报「待帅接手复核」——这是 #455 原痛点的存量场景（帅手起审官、流转器后启动）。
//
// 帅保留四类判断不得自动化（④）：报警分诊 / 换人 / 弹窗放行 / 终审合并。
// 「新工位问、闭环内不问」：自动注入只覆盖闭环内流转；新工位（无完工信号）
// 不出任何自动动作。
//
// 待帅处置常驻行（对抗审红 3）：有待帅事项（复核绿待终审 / 判定行缺失待分诊 /
// 乒乓仍红待换人 / 注入失败待接手）的 PR，每轮都输出「[flow] 待帅处置：#N（原因）」
// 且 exit 1——「0 需流转」只允许用在真没有待办时；待办不能因报过一次就转绿。
//
// 存量清点（#455 的 prime 吞存量教训）：本脚本不做「只监听新事件」——
// 每轮对每个在途 PR 重放全部信号（comments+reviews）推导当前态；首次启动
// （状态文件为空）即等价于存量清点，存量里已有的完工/判定会被识别并动作，
// 不会被吞。状态文件 _flow/state.json 只是「已处理信号」游标缓存（GitHub 才是
// 真相源），可丢可重算：删掉重跑即重新清点。
//
// 退出码（与 watchdog 同口径）：0 扫完 0 需流转 / 1 有动作、报帅或待帅处置 /
// 2 NO_TARGETS（本轮没查成）/ 3 基础设施失败（gh/orca 拉不到、参数错）。
//
// 用法：
//   node scripts/flow.mjs                     轮询模式（默认每 90s 一轮，供 Monitor 挂载）
//   node scripts/flow.mjs --once              跑单轮后退出（给测试用）
//   node scripts/flow.mjs --interval 90       轮询间隔秒数
//   node scripts/flow.mjs --state-file <path> 状态文件位置（默认 _flow/state.json）
//   node scripts/flow.mjs --dry-run           只输出动作与将执行的命令，不碰 orca 写操作
//                                             （目标解析仍跑——快照/实读，测试可覆盖）
//   node scripts/flow.mjs --snapshot-dir <dir> 从录制的 gh/orca JSON 快照跑（测试/复现用）
//   node scripts/flow.mjs --repo <nameWithOwner> 显式指定仓库（默认 gh repo view 推断）
//
// 快照目录可选文件（round-N/ 子目录同 watchdog 约定）：
//   prs.json / pr-<N>-comments.json / pr-<N>-reviews.json / pr-<N>.json（gh 侧）
//   orca-worktrees.json / orca-terminals.json（orca 侧，可缺省为无数据）

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { judgmentFromReview, isCompletionComment } from './lib/judgment.mjs';
import { classifyPr } from './calibrate.mjs';

const require = createRequire(import.meta.url);
const { parse: parseToml } = require('./lib/smol-toml.cjs');

const ROOT = resolve(import.meta.dirname, '..');
const DEFAULT_STATE = join(ROOT, '_flow', 'state.json');
const ROUTING_FILE = join(ROOT, 'docs', 'model-routing.toml');
const ORCA_TIMEOUT_MS = 30000;
const GH_TIMEOUT_MS = 30000;
const VERIFY_WAIT_MS = 2500;      // 注入后等待新输出的静默时间
const READY_WAIT_MS = 2000;       // 就绪轮询间隔
const READY_TIMEOUT_MS = 120000;  // 两步走（claude 配置同步期）就绪等待上限
const STALE_24H_MS = 24 * 60 * 60 * 1000;

// ══════════════════════════════════════════════════════════════════════
// 参数
// ══════════════════════════════════════════════════════════════════════

function printUsage() {
  console.log(`用法：
  node scripts/flow.mjs [--once] [--interval 秒] [--state-file <path>] [--dry-run]
                        [--snapshot-dir <目录>] [--repo <nameWithOwner>]

  --once              跑单轮后退出（给测试用）
  --interval <秒>     轮询间隔（默认 90，与垫片 Monitor 同频）
  --state-file <path> 状态文件位置（默认 _flow/state.json）
  --dry-run           只输出动作与将执行的命令，不碰 orca 写操作（目标解析仍跑）
  --snapshot-dir <目录> 从录制的 gh/orca JSON 快照跑（测试/复现用），跑完即退出
  --repo <nameWithOwner> 显式指定仓库（默认 gh repo view 推断）`);
}

function parseArgs(argv) {
  const args = { once: false, interval: 90, stateFile: DEFAULT_STATE, dryRun: false, snapshotDir: null, repo: null };
  const take = (i, name) => {
    const v = Number(argv[i + 1]);
    if (!Number.isFinite(v) || v <= 0) {
      console.error(`参数 ${name} 需要正整数`);
      process.exit(3);
    }
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--once': args.once = true; break;
      case '--interval': args.interval = take(i++, '--interval'); break;
      case '--state-file': args.stateFile = resolve(process.cwd(), argv[++i] || ''); break;
      case '--dry-run': args.dryRun = true; break;
      case '--snapshot-dir': args.snapshotDir = resolve(process.cwd(), argv[++i] || ''); break;
      case '--repo': args.repo = argv[++i] || ''; break;
      case '--help': printUsage(); process.exit(0); break;
      default:
        console.error(`未知参数: ${a}`);
        printUsage();
        process.exit(3);
    }
  }
  return args;
}

// ══════════════════════════════════════════════════════════════════════
// 工具
// ══════════════════════════════════════════════════════════════════════

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function runCmd(cmd, args, timeout = 30000) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout });
  if (r.error || r.status !== 0) {
    return { ok: false, error: String(r.error?.message || r.stderr || `exit ${r.status}`).trim().slice(0, 300) };
  }
  return { ok: true, out: r.stdout };
}

function runGh(args) {
  const r = runCmd('gh', args, GH_TIMEOUT_MS);
  if (!r.ok) return { ok: false, error: `gh ${args[0]} 失败：${r.error}` };
  try {
    return { ok: true, json: JSON.parse(r.out) };
  } catch (e) {
    return { ok: false, error: `gh ${args[0]} 输出不是 JSON：${e.message}` };
  }
}

function runOrca(args) {
  const r = runCmd('orca', args, ORCA_TIMEOUT_MS);
  if (!r.ok) return { ok: false, error: r.error };
  try {
    return { ok: true, json: JSON.parse(r.out) };
  } catch (e) {
    return { ok: false, error: `orca 输出不是 JSON：${e.message}` };
  }
}

function unwrap(json, pathKey, topKey) {
  const viaPath = json?.result?.[pathKey];
  if (Array.isArray(viaPath)) return viaPath;
  if (Array.isArray(json?.[topKey])) return json[topKey];
  return null;
}

// ══════════════════════════════════════════════════════════════════════
// 信号提取（纯函数，快照与 live 共用）
// ══════════════════════════════════════════════════════════════════════

// 完工信号：PR comment 首行命中「完工」或「返工(完成|处置)」。
function completionSignals(comments) {
  const out = [];
  for (const c of comments || []) {
    if (!c || c.id == null) continue;
    if (isCompletionComment(c.body)) {
      out.push({ type: 'completion', id: `c:${c.id}`, at: c.createdAt || '', body: c.body });
    }
  }
  return out;
}

function reviewSignals(reviews) {
  const out = [];
  for (const r of reviews || []) {
    if (!r || r.id == null) continue;
    const v = judgmentFromReview(r.body);
    out.push({
      type: 'review', id: `r:${r.id}`, at: r.submittedAt || '', body: r.body,
      verdict: v, url: r.url || null,
    });
  }
  return out;
}

function orderedSignals(comments, reviews) {
  return [...completionSignals(comments), ...reviewSignals(reviews)]
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

// 由全部信号推导当前态（纯函数，每轮重放——存量清点即此步）：
//   working → awaiting-review（完工，无审）→ rework-needed（红 N，待返工）
//   → awaiting-recheck（返工完成，待复核）→ approved（复核绿）/ pingpong（乒乓两轮仍红）
//   error = 存在判定行缺失/格式不符的 review（报帅分诊，不作为红/绿处理）。
function deriveState(signals) {
  let state = 'working';
  let redReviews = 0;
  let lastRed = null;
  let lastSignalId = null;
  for (const sig of signals) {
    lastSignalId = sig.id;
    if (sig.type === 'completion') {
      if (state === 'working') state = 'awaiting-review';
      else if (state === 'rework-needed') state = 'awaiting-recheck';
      continue;
    }
    const v = sig.verdict;
    // 判定行缺失（kind=null）或格式不符（红绿都判不出）→ 报帅分诊，不作为红/绿处理
    if (!v.kind || v.malformed) { state = 'error'; continue; }
    if (v.green) { state = 'approved'; lastRed = null; continue; }
    redReviews += 1;
    lastRed = v.red;
    // 乒乓两轮仍红 → 报帅换人（第 3 次红判定起不再自动注入返工）
    state = redReviews >= 3 ? 'pingpong' : 'rework-needed';
  }
  return { state, redReviews, lastRed, lastSignalId };
}

// 当前态的待办动作（纯函数）：null = 无需流转（扫完 0 需流转）。
// blocked = 验开工失败后帅持有，不再自动重发（fail-visible，不重试狂发）。
function pendingAction(derived, rec) {
  if (derived.state === 'working') return null;
  if (derived.state === 'awaiting-review') {
    if (rec.blocked['start-reviewer']) return null;
    return { kind: 'start-reviewer', round: 0 };
  }
  if (derived.state === 'awaiting-recheck') {
    if (rec.blocked['inject-recheck']) return null;
    return { kind: 'inject-recheck', round: derived.redReviews };
  }
  if (derived.state === 'rework-needed') {
    if (rec.blocked['inject-rework']) return null;
    return { kind: 'inject-rework', red: derived.lastRed, round: derived.redReviews };
  }
  if (derived.state === 'approved') return { kind: 'report-final' };
  if (derived.state === 'pingpong') return { kind: 'report-switch', round: derived.redReviews };
  return null; // error 态由 malformed review 逐条报帅 + 待帅处置常驻行覆盖
}

// 待帅处置原因（红 3：卡着的 PR 每轮都要显形，不能报一次就转绿）
function awaitingShuaiReason(derived, rec) {
  if (derived.state === 'approved') return '复核绿待帅终审';
  if (derived.state === 'error') return '判定行缺失/格式不符待帅分诊';
  if (derived.state === 'pingpong') return '乒乓两轮仍红待帅换人';
  if (Object.keys(rec.blocked || {}).length > 0) return '注入/目标解析失败待帅接手';
  return null;
}

// ══════════════════════════════════════════════════════════════════════
// 审官选型序（docs/model-routing.toml 真相源）
// ══════════════════════════════════════════════════════════════════════

function loadRouting() {
  if (!existsSync(ROUTING_FILE)) return { ok: false, error: `${ROUTING_FILE} 不存在` };
  try {
    return { ok: true, toml: parseToml(readFileSync(ROUTING_FILE, 'utf8')) };
  } catch (e) {
    return { ok: false, error: `${ROUTING_FILE} 解析失败：${String(e.message || e).split(/\r?\n/)[0]}` };
  }
}

// 审官选型序（规则「审官选型序」+「审查默认换厂商」+ bans[gpt UI 类]）：
//   候选 = roles 含「审查」的模型；UI/复审类 → GPT 禁入；工人是 gpt 厂商 → GPT 排除
//   （审查必换厂商）；结果按「GPT 优先、Claude(Opus) 次之」取第一个。
function pickReviewer(toml, workerModelId, taskType) {
  const models = Array.isArray(toml.models) ? toml.models : [];
  const worker = models.find(m => m.id === workerModelId);
  const workerProvider = worker ? worker.provider : null;
  const uiLike = /UI|复审/.test(taskType || '');
  const isGpt = m => m.provider === 'gpt' || /^gpt/i.test(m.id || '');
  const candidates = models.filter(m => Array.isArray(m.roles) && m.roles.includes('审查'));
  let pool = candidates.filter(m => !(uiLike && isGpt(m)));
  if (workerProvider === 'gpt' || /^gpt/i.test(workerModelId || '')) pool = pool.filter(m => !isGpt(m));
  return pool.find(m => isGpt(m)) || pool.find(m => !isGpt(m)) || null;
}

// 审官启动配方（dispatch skill 命令链口径，provider 真相源 = toml providers）：
//   gpt(codex) oneShot --agent codex --prompt（官方首注入通道，免就绪竞态）；
//   claude(reclaude) 两步走 terminal create --command "reclaude --model opus"，
//   注入前必须先等配置同步（抢跑必被吞）。
//   grok 不在审查角色（toml roles 无「审查」），pickReviewer 选不到——不写启动配方，
//   免得 env/命令看似生效实则从未执行（对抗审观察 4）。
function reviewerLaunch(reviewer) {
  if (reviewer.provider === 'gpt') return { oneShot: true, agent: 'codex', model: reviewer.id };
  if (reviewer.provider === 'claude') return { oneShot: false, command: 'reclaude --model opus', model: reviewer.id };
  return null;
}

function reviewerLabel(reviewer) {
  return reviewer.provider === 'claude' ? '审官·Claude' : `审官·${reviewer.id}`;
}

// ══════════════════════════════════════════════════════════════════════
// 动作文本（决策输出，人读 + 机器可 grep）
// ══════════════════════════════════════════════════════════════════════

function reviewTaskBook(pr, workerModel, reviewerLabel) {
  return [
    `【复核任务书 · 闭环自动流转 · ${reviewerLabel}】`,
    `任务 PR：#${pr.number} ${pr.title}`,
    '请审读本 PR 的 diff 与正文（规格源引用、完工自报、验收清单），逐条核对验收标准。',
    '判定格式（机器可读，写在 review 正文首行）：',
    '  首审：「判定：红 N 项」或「判定：绿」',
    '  复核：「复核结论：红 N 项」或「复核结论：绿，可合并」',
    '同账号不能 request-changes，以 COMMENT 提交 review。红项逐条列明；质疑拍板/规格本身要上帅，不自行改判。',
  ].join('\n');
}

function reworkInstruction(pr, red, round, reviewUrl) {
  return [
    `【返工指令 · 闭环自动流转 · 第 ${round} 轮】`,
    `审官对 PR #${pr.number} 判定红 ${red} 项。请读 review：${reviewUrl || `PR #${pr.number} 的最新 review`}`,
    '逐条处置红项；修完 push，并回一条「返工完成」comment 自报。质疑拍板/规格本身要上帅，不自行改判。',
  ].join('\n');
}

function recheckInstruction(pr, round, reviewerLabel) {
  return [
    `【复核指令 · 闭环自动流转 · 第 ${round} 轮返工后 · ${reviewerLabel}】`,
    `工人已完成第 ${round} 轮返工处置。请复核 PR #${pr.number} 最新 diff 与返工自报，`,
    '判定格式「复核结论：绿/红 N 项」写在 review 正文首行。',
  ].join('\n');
}

// ══════════════════════════════════════════════════════════════════════
// orca 终端操作（live 用；注入目标解析走 source，dry-run 也能覆盖）
// ══════════════════════════════════════════════════════════════════════

function readTerminalData(handle, cursor) {
  const args = ['terminal', 'read', '--terminal', handle, '--limit', '80', '--json'];
  if (cursor != null) args.push('--cursor', String(cursor));
  const r = runOrca(args);
  if (!r.ok) return { ok: false, error: r.error };
  const t = r.json?.result?.terminal;
  if (!t || typeof t.status !== 'string' || !Array.isArray(t.tail)) return { ok: false, error: 'read 成功响应但 status/tail 字段缺失（结构畸形）' };
  return { ok: true, terminal: t };
}

// 注入前证就绪（红 1）：两步走（claude）配置同步期抢跑必被吞——轮询到
// 屏面有内容且不在启动占位态才放行；终端退出/超时 fail-visible。
function waitTerminalReady(handle, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  const starting = /Starting|Connecting|登录|login|初始化|配置同步|请稍候|加载中/i;
  for (;;) {
    if (Date.now() >= deadline) return { ok: false, error: `等待终端就绪超时（${label}，${Math.round(timeoutMs / 1000)}s）——未见到可收输入迹象` };
    const r = readTerminalData(handle, null);
    if (!r.ok) { sleep(READY_WAIT_MS); continue; }
    if (r.terminal.status === 'exited') return { ok: false, error: `终端已退出（${label}）` };
    const tail = r.terminal.tail.map(l => String(l)).join('\n').trim();
    if (tail.length > 0 && !starting.test(tail)) return { ok: true }; // 有内容且不在启动态 = 可收输入
    sleep(READY_WAIT_MS);
  }
}

// 验开工（红 1 首审）：增量判据为主（cursor 前进 = 有新输出 = token 在动），
// 回显判据为辅且不单独成立——回显命中但 cursor 没动 = 文本还在输入框未提交
// （#455 输入框残留原场景），第一处置补一记裸回车（不是再注入一遍全文）再判。
// 观察 3：只有 send 路径（echoHead 非空）才补回车——--prompt 路径活已交出去，
// 空回车没必要（agent 启动慢时会吃到一记无谓 Enter）。
function verifyStarted(handle, echoHead, terminalName) {
  const first = readTerminalData(handle, null);
  if (!first.ok) return { ok: false, error: `读终端失败：${first.error}` };
  const prev = first.terminal.nextCursor;
  sleep(VERIFY_WAIT_MS);
  const second = readTerminalData(handle, prev);
  if (second.ok && Number(second.terminal.returnedLineCount || 0) > 0) return { ok: true, judge: 'cursor 增量（有新输出）' };
  if (!echoHead) {
    // --prompt 路径：无回显概念，不补回车，直接 fail-visible
    return { ok: false, error: `注入后无新输出（${terminalName}）——疑似未开工` };
  }
  // send 路径：看回显，无论是否回显都补一记裸回车再验增量
  const all = readTerminalData(handle, null);
  const tailText = all.ok ? all.terminal.tail.map(l => String(l)).join('\n') : '';
  const echoed = tailText.includes(echoHead);
  runOrca(['terminal', 'send', '--terminal', handle, '--enter']);
  sleep(VERIFY_WAIT_MS);
  const third = readTerminalData(handle, null);
  const grew3 = third.ok && Number(third.terminal.returnedLineCount || 0) > 0;
  if (grew3) return { ok: true, judge: echoed ? '回显+补回车（输入框残留提交）' : '补回车后开工' };
  return { ok: false, error: `注入后无新输出（${terminalName}）——疑似吞注入（${echoed ? '回显命中但回车未提交' : '无回显'}）` };
}

// 注入 + 验开工（两步走路径：send 任务文本）
function injectAndVerify(handle, text, terminalName) {
  const echoHead = text.replace(/\r?\n/g, ' ').slice(0, 24).trim();
  const sendR = runOrca(['terminal', 'send', '--terminal', handle, '--text', text]);
  if (!sendR.ok) return { ok: false, error: `terminal send 失败：${sendR.error}` };
  return verifyStarted(handle, echoHead, terminalName);
}

// ══════════════════════════════════════════════════════════════════════
// 注入目标定位（红 2/红 4：确定性定位，选不出唯一就报帅，不挑第一个）
// ══════════════════════════════════════════════════════════════════════

const SHELL_LIKE = /^(PS |PowerShell|Terminal \d|cmd|bash|zsh)/;

// worktree 里活着的终端里挑唯一注入目标：
//   connected+writable+非 orphaned；排除审官句柄（返工不能注给审官）；
//   排除 shell（title 空 / PS / Terminal N / cmd / bash / zsh —— agent 的 title
//   会被 orca 覆写成对话摘要，不能按「角色·模型」猜，对抗审红 4 实录）。
//   候选恰 1 个 → 用；0 个 → 报错；多个 → 报帅指定（不挑第一个）。
function pickUniqueTerminal(terminals, wtId, excludeHandle) {
  const inWt = (terminals || []).filter(t => t.worktreeId === wtId && t.connected && t.writable && !t.orphaned);
  const candidates = inWt
    .filter(t => t.handle !== excludeHandle)
    .filter(t => {
      const title = (t.title || '').trim();
      return title !== '' && !SHELL_LIKE.test(title);
    });
  if (candidates.length === 1) return { ok: true, terminal: candidates[0] };
  if (candidates.length === 0) {
    const why = inWt.length === 0 ? 'worktree 无活着终端' : `全部 ${inWt.length} 个终端被排除（shell/审官句柄）`;
    return { ok: false, error: `worktree ${wtId} 没有唯一可用终端（${why}）` };
  }
  return { ok: false, error: `worktree ${wtId} 有 ${candidates.length} 个候选终端（${candidates.map(t => t.handle).join('、')}），选不出唯一注入目标——请帅指定，不挑第一个` };
}

// 审官终端反查（红 2）：①起审官时记下的句柄（优先）②记下的审官卡 id
// ③兜底存量反查：任务卡子卡里找「审官」卡（帅手起审官、流转器后启动的场景）。
function findReviewerTerminal(source, pr, rec, workerWt) {
  const termsR = source.orcaTerminals();
  if (!termsR.ok) return { ok: false, error: termsR.error };
  const terms = termsR.terminals;
  if (rec.reviewer?.handle && terms.some(t => t.handle === rec.reviewer.handle)) {
    return { ok: true, terminal: terms.find(t => t.handle === rec.reviewer.handle), via: '起审官记录句柄' };
  }
  if (rec.reviewer?.worktree) {
    const t = pickUniqueTerminal(terms, rec.reviewer.worktree, null);
    if (t.ok) return { ok: true, terminal: t.terminal, via: '起审官记录审官卡' };
  }
  if (workerWt && Array.isArray(workerWt.childWorktreeIds) && workerWt.childWorktreeIds.length > 0) {
    const wtsR = source.orcaWorktrees();
    if (wtsR.ok) {
      const reviewerWt = wtsR.worktrees.find(w => workerWt.childWorktreeIds.includes(w.id) && /审官/.test(w.displayName || ''));
      if (reviewerWt) {
        const t = pickUniqueTerminal(terms, reviewerWt.id, null);
        if (t.ok) return { ok: true, terminal: t.terminal, via: '存量反查（审官· 子卡）' };
      }
    }
  }
  return { ok: false, error: '找不到审官终端（未记录句柄/审官卡，子卡里也没有审官卡）——待帅接手复核' };
}

// ══════════════════════════════════════════════════════════════════════
// 状态文件（游标缓存，GitHub 才是真相源）
// ══════════════════════════════════════════════════════════════════════

function loadState(path) {
  if (!existsSync(path)) return { version: 1, inventoried: false, records: {} };
  try {
    const s = JSON.parse(readFileSync(path, 'utf8'));
    if (!s.records || typeof s.records !== 'object') throw new Error('records 缺失');
    return { version: 1, inventoried: !!s.inventoried, records: s.records };
  } catch (e) {
    return { version: 1, inventoried: false, records: {}, loadError: String(e.message) };
  }
}

function saveState(path, state) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  renameSync(tmp, path);
}

function freshRecord(pr) {
  return { pr, seenComments: {}, seenReviews: {}, blocked: {}, reportedMalformed: {}, reportedStale: false, actedOn: null, reviewer: null, workerWorktree: null };
}

function fingerprint(derived) {
  return `${derived.state}|${derived.redReviews}|${derived.lastSignalId || ''}`;
}

// ══════════════════════════════════════════════════════════════════════
// 数据源（live：gh/orca 实调；快照：录制 JSON；两者接口一致）
// ══════════════════════════════════════════════════════════════════════

function makeLiveSource(repo) {
  return {
    listOpenPrs() {
      const r = runGh(['pr', 'list', '--state', 'open', '--limit', '100', '--json',
        'number,title,isDraft,state,createdAt,updatedAt,mergedAt,headRefName,labels,body']);
      if (!r.ok) return { ok: false, error: r.error };
      return { ok: true, prs: r.json };
    },
    getPr(number) {
      const r = runGh(['pr', 'view', String(number), '--json', 'number,title,isDraft,state,createdAt,updatedAt,mergedAt,headRefName,labels,body']);
      if (!r.ok) return { ok: false, error: r.error };
      return { ok: true, pr: r.json };
    },
    getComments(number) {
      const r = runGh(['pr', 'view', String(number), '--json', 'comments']);
      if (!r.ok) return { ok: false, error: r.error };
      return { ok: true, comments: r.json.comments || [] };
    },
    getReviews(number) {
      // 红 1（复核）：gh pr view 的 review id 是 GraphQL node id（PRR_...），拼不出真锚点——
      // 返工指令必须给活链接。改走 gh api 直取数字 id + html_url。
      // 注意：--paginate 配 --jq 会逐页输出多段独立 JSON（观察 1：多页时 JSON.parse 必炸）——
      // 所以不带 --jq，让 --paginate 合并成单个数组，字段在 JS 里映射。
      const r = runGh(['api', `repos/${repo}/pulls/${number}/reviews`, '--paginate']);
      if (!r.ok) return { ok: false, error: r.error };
      const reviews = (Array.isArray(r.json) ? r.json : []).map(rv => ({
        id: rv.id,
        body: rv.body || '',
        submittedAt: rv.submitted_at || '',
        url: rv.html_url || null,
      }));
      return { ok: true, reviews };
    },
    orcaWorktrees() {
      const r = runOrca(['worktree', 'list', '--json']);
      if (!r.ok) return { ok: false, error: r.error };
      const wts = unwrap(r.json, 'worktrees', 'worktrees');
      return Array.isArray(wts) ? { ok: true, worktrees: wts } : { ok: false, error: 'worktree list 结构不认识' };
    },
    orcaTerminals() {
      const r = runOrca(['terminal', 'list', '--json']);
      if (!r.ok) return { ok: false, error: r.error };
      const terms = unwrap(r.json, 'terminals', 'terminals');
      return Array.isArray(terms) ? { ok: true, terminals: terms } : { ok: false, error: 'terminal list 结构不认识' };
    },
  };
}

function readJson(file) {
  if (!existsSync(file)) return { ok: false, error: `缺文件 ${file}` };
  try {
    return { ok: true, json: JSON.parse(readFileSync(file, 'utf8')) };
  } catch (e) {
    return { ok: false, error: `${file} 不是合法 JSON：${String(e.message).split(/\r?\n/)[0]}` };
  }
}

function loadSnapshotRounds(dir) {
  if (!existsSync(dir)) return { ok: false, error: `快照目录不存在：${dir}` };
  const roundSubs = readdirSync(dir).filter(d => /^round-\d+$/.test(d))
    .sort((a, b) => Number(a.slice(6)) - Number(b.slice(6)));
  const dirs = roundSubs.length > 0 ? roundSubs.map(d => join(dir, d)) : [dir];
  return { ok: true, dirs };
}

function makeSnapshotSource(roundDir, repo) {
  return {
    listOpenPrs() {
      const r = readJson(join(roundDir, 'prs.json'));
      if (!r.ok) return r;
      if (!Array.isArray(r.json)) return { ok: false, error: 'prs.json 不是数组' };
      return { ok: true, prs: r.json };
    },
    getPr(number) {
      const r = readJson(join(roundDir, `pr-${number}.json`));
      if (!r.ok) return r;
      return { ok: true, pr: r.json };
    },
    getComments(number) {
      const r = readJson(join(roundDir, `pr-${number}-comments.json`));
      return r.ok ? { ok: true, comments: r.json } : { ok: true, comments: [] };
    },
    getReviews(number) {
      const r = readJson(join(roundDir, `pr-${number}-reviews.json`));
      if (!r.ok) return { ok: true, reviews: [] };
      return {
        ok: true,
        // 镜像 live 形态：有 html_url 用真锚点（gh api 口径），没有才退回拼（数字 id 才能拼出活链接）
        reviews: r.json.map(rv => ({
          id: rv.id,
          body: rv.body,
          submittedAt: rv.submitted_at || rv.submittedAt,
          url: rv.html_url || `https://github.com/${repo}/pull/${number}#pullrequestreview-${rv.id}`,
        })),
      };
    },
    orcaWorktrees() {
      const r = readJson(join(roundDir, 'orca-worktrees.json'));
      if (!r.ok) return { ok: true, worktrees: [] };
      const wts = unwrap(r.json, 'worktrees', 'worktrees');
      return Array.isArray(wts) ? { ok: true, worktrees: wts } : { ok: false, error: 'orca-worktrees.json 结构不认识' };
    },
    orcaTerminals() {
      const r = readJson(join(roundDir, 'orca-terminals.json'));
      if (!r.ok) return { ok: true, terminals: [] };
      const terms = unwrap(r.json, 'terminals', 'terminals');
      return Array.isArray(terms) ? { ok: true, terminals: terms } : { ok: false, error: 'orca-terminals.json 结构不认识' };
    },
  };
}

// ══════════════════════════════════════════════════════════════════════
// 动作执行（红 1/2/4/5 落点：目标解析走 source，dry-run 也覆盖解析路径）
// ══════════════════════════════════════════════════════════════════════

function executeAction(action, pr, toml, source, rec, dryRun) {

  if (action.kind === 'start-reviewer') {
    const cls = classifyPr(pr);
    if (!cls.model) {
      return { ok: false, error: `PR #${pr.number} 缺 model/* 标签（有 type/${cls.taskType || '?'}），不能按选型序确定性选审官`, needsReport: 'report-unknown' };
    }
    const reviewer = pickReviewer(toml, cls.model, cls.taskType);
    if (!reviewer) {
      return { ok: false, error: '按 docs/model-routing.toml 选不出审官（审查角色模型为空）', needsReport: 'report-unknown' };
    }
    const launch = reviewerLaunch(reviewer);
    if (!launch) {
      return { ok: false, error: `审官 ${reviewer.id} 的 provider 无启动配方（${reviewer.provider}）`, needsReport: 'report-unknown' };
    }
    const label = reviewerLabel(reviewer);
    const taskBook = reviewTaskBook(pr, cls.model, label);
    // 任务卡名按全局约定「#PR号 - 动宾短语」（观察 3：终端名角色·模型、卡名带号）
    const cardName = `#${pr.number} - ${label}`;
    // 红 5：--parent-worktree 合法 selector 是 branch:/issue:/id:/path:/folder:/worktree:，
    // name: 是 --repo 的 selector 不是 worktree 的——用 branch:<headRefName>（现成合法）。
    const parentSel = `branch:${pr.headRefName}`;
    const steps = launch.oneShot
      ? [`orca worktree create --parent-worktree ${parentSel} --name "${cardName}" --agent ${launch.agent} --prompt <复核任务书> --json`]
      : [`orca worktree create --parent-worktree ${parentSel} --name "${cardName}" --setup skip --json`,
         `orca terminal create --worktree <新建审官卡 id> --command "${launch.command}" --json`,
         '（注入前先 terminal read 轮询就绪，再 send 任务书——配置同步期抢跑必被吞）'];
    if (dryRun) {
      return {
        ok: true, dry: true,
        line: `[flow] 动作：起审官 #${pr.number}（${label}，model=${reviewer.id}，provider=${reviewer.provider}）`
          + '\n' + steps.map(s => '  ' + s).join('\n')
          + '\n  ' + '注入复核任务书：' + taskBook.replace(/\n/g, '\n  '),
      };
    }
    // live：起卡 + 起终端 + （两步走先证就绪）+ 注入 + 验开工
    const createR = runOrca(launch.oneShot
      ? ['worktree', 'create', '--parent-worktree', parentSel, '--name', cardName, '--agent', launch.agent, '--prompt', taskBook, '--json']
      : ['worktree', 'create', '--parent-worktree', parentSel, '--name', cardName, '--setup', 'skip', '--json']);
    if (!createR.ok) return { ok: false, error: `起审官卡失败：${createR.error}` };
    const newWtId = createR.json?.result?.worktree?.id || null;
    let handle;
    if (launch.oneShot) {
      handle = createR.json?.result?.agentTerminalHandle || createR.json?.result?.startupTerminal?.handle;
      if (!handle) return { ok: false, error: '起审官成功响应但缺 terminal handle（结构畸形）' };
      const v = verifyStarted(handle, null, label);
      if (!v.ok) return { ok: false, error: v.error };
      return { ok: true, handle, worktree: newWtId, label, taskBook, line: `[flow] 动作：起审官 #${pr.number}（${label}，model=${reviewer.id}）：--prompt 官方通道注入，验开工（${v.judge}）` };
    }
    const termR = runOrca(['terminal', 'create', '--worktree', newWtId, '--command', launch.command, '--json']);
    if (!termR.ok) return { ok: false, error: `起审官终端失败：${termR.error}` };
    handle = termR.json?.result?.terminal?.handle;
    if (!handle) return { ok: false, error: '起审官成功响应但缺 terminal handle（结构畸形）' };
    const ready = waitTerminalReady(handle, READY_TIMEOUT_MS, label);
    if (!ready.ok) return { ok: false, error: ready.error };
    const v = injectAndVerify(handle, taskBook, label);
    if (!v.ok) return { ok: false, error: v.error };
    return { ok: true, handle, worktree: newWtId, label, taskBook, line: `[flow] 动作：起审官 #${pr.number}（${label}，model=${reviewer.id}）：就绪后注入，验开工（${v.judge}）` };
  }

  if (action.kind === 'inject-rework') {
    const instruction = reworkInstruction(pr, action.red, action.round, action.reviewUrl || null);
    const wtsR = source.orcaWorktrees();
    const workerWt = wtsR.ok ? wtsR.worktrees.find(w => (w.branch || w.git?.branch) === `refs/heads/${pr.headRefName}`) : null;
    const wtErr = !wtsR.ok ? wtsR.error : workerWt ? null : `找不到 branch ${pr.headRefName} 的 worktree`;
    const termsR = source.orcaTerminals();
    let target = null;
    if (workerWt && termsR.ok) target = pickUniqueTerminal(termsR.terminals, workerWt.id, rec.reviewer?.handle || null);
    else if (!termsR.ok) target = { ok: false, error: termsR.error };
    if (dryRun) {
      if (target?.ok) {
        return { ok: true, dry: true, line: `[flow] 动作：返工注入 #${pr.number}（第 ${action.round} 轮，红 ${action.red} 项）（注入目标：工人终端 ${target.terminal.handle}）` + '\n  ' + instruction.replace(/\n/g, '\n  ') };
      }
      // 观察 1：解析失败不用「动作：」前缀（grep 动作 应只数真实动作），改「预览-阻塞：」
      return { ok: true, dry: true, line: `[flow] 预览-阻塞：#${pr.number}（返工注入——注入目标解析失败：${target?.error || wtErr || '终端列表不可用'}）` + '\n  ' + instruction.replace(/\n/g, '\n  ') };
    }
    if (!workerWt) return { ok: false, error: `找不到工人终端：${wtErr}` };
    if (!target?.ok) return { ok: false, error: `找不到工人终端：${target.error}` };
    const v = injectAndVerify(target.terminal.handle, instruction, pr.title);
    if (!v.ok) return { ok: false, error: v.error };
    return { ok: true, line: `[flow] 动作：返工注入 #${pr.number}（第 ${action.round} 轮，红 ${action.red} 项）：指令已注入工人终端并验开工（${v.judge}）` };
  }

  if (action.kind === 'inject-recheck') {
    const instruction = recheckInstruction(pr, action.round, action.reviewerLabel || '审官');
    const wtsR = source.orcaWorktrees();
    const workerWt = wtsR.ok ? wtsR.worktrees.find(w => (w.branch || w.git?.branch) === `refs/heads/${pr.headRefName}`) : null;
    const target = wtsR.ok ? findReviewerTerminal(source, pr, rec, workerWt || undefined) : { ok: false, error: wtsR.error };
    if (dryRun) {
      if (target?.ok) {
        return { ok: true, dry: true, line: `[flow] 动作：复核注入 #${pr.number}（第 ${action.round} 轮返工后）（复核目标：审官终端 ${target.terminal.handle}${target.via ? '，' + target.via : ''}）` + '\n  ' + instruction.replace(/\n/g, '\n  ') };
      }
      return { ok: true, dry: true, line: `[flow] 预览-阻塞：#${pr.number}（复核注入——审官终端解析失败：${target.error}）` + '\n  ' + instruction.replace(/\n/g, '\n  ') };
    }
    if (!target?.ok) return { ok: false, error: `找不到审官终端：${target.error}`, needsReport: 'reviewer-unfound' };
    const v = injectAndVerify(target.terminal.handle, instruction, '审官');
    if (!v.ok) return { ok: false, error: v.error };
    return { ok: true, line: `[flow] 动作：复核注入 #${pr.number}（第 ${action.round} 轮返工后）：复核指令已注入审官终端并验开工（${v.judge}）` };
  }

  return { ok: false, error: `未知动作 ${action.kind}` };
}

// ══════════════════════════════════════════════════════════════════════
// 一轮扫描
// ══════════════════════════════════════════════════════════════════════

// 一轮：返回 { events, noTargets, infraError }；events 是输出行。
// noTargets = 本轮没查成（读不到数据，语义「没扫到」）；infraError = 基础设施失败。
// 两者都要与「扫完 0 需流转」（正常 OK 行）可区分（仓规：数到 0 和没看到样本不是一回事）。
function processOneRound(source, state, args) {
  const events = [];
  const routing = loadRouting();
  const toml = routing.ok ? routing.toml : null;
  if (!routing.ok) {
    return { events: [`[flow] NO_TARGETS：${routing.error}——本轮没查成`], noTargets: true, infraError: true };
  }

  const list = source.listOpenPrs();
  if (!list.ok) return { events: [`[flow] NO_TARGETS：${list.error}——本轮没查成`], noTargets: true, infraError: true };
  const open = list.prs;
  const openByNumber = new Map(open.map(p => [p.number, p]));
  const records = state.records;
  let noTargets = false;
  let infraError = false;

  // 退役：上一轮在途、本轮不在 open 列表的 PR → 查终态（MERGED/CLOSED）
  for (const key of Object.keys(records)) {
    const rec = records[key];
    if (openByNumber.has(rec.pr)) continue;
    if (rec.retired) continue;
    const prView = source.getPr(rec.pr);
    const st = prView.ok ? (prView.pr.state || '') : '';
    if (st === 'MERGED') {
      rec.retired = true;
      events.push(`[flow] 退役：PR #${rec.pr} MERGED——完工闭环收口（终审+校准+归档归帅）`);
    } else if (st === 'CLOSED') {
      rec.retired = true;
      events.push(`[flow] 退役：PR #${rec.pr} CLOSED（未合并关闭）`);
    } else if (!prView.ok) {
      noTargets = true;
      events.push(`[flow] NO_TARGETS：读 PR #${rec.pr} 终态失败：${prView.error}——本轮没查成`);
    }
  }

  const awaitingShuai = []; // 红 3：卡着的 PR 每轮常驻显形

  for (const pr of open) {
    const rec = records[pr.number] || (records[pr.number] = freshRecord(pr.number));
    if (rec.retired) continue;

    const commentsR = source.getComments(pr.number);
    const reviewsR = source.getReviews(pr.number);
    if (!commentsR.ok || !reviewsR.ok) {
      noTargets = true;
      events.push(`[flow] NO_TARGETS：读 PR #${pr.number} 信号失败（${commentsR.ok ? '' : commentsR.error}${reviewsR.ok ? '' : reviewsR.error}）——本轮没查成`);
      continue;
    }
    const comments = commentsR.comments || [];
    const reviews = reviewsR.reviews || [];

    // 判定行缺失/格式不符的 review：逐条报帅（「没查成」，非「无需流转」），不猜红绿
    for (const rv of reviews) {
      if (rec.seenReviews[rv.id]) continue;
      if (rv.id == null) continue;
      const v = judgmentFromReview(rv.body);
      if (v.kind && !v.malformed) continue;
      if (!rec.reportedMalformed[rv.id]) {
        rec.reportedMalformed[rv.id] = true;
        events.push(`[flow] 报帅：判定行缺失/格式不符 #${pr.number}（review id=${rv.id}，无「判定/复核结论」行或红绿都判不出）——本脚本不能确定红绿，没查成，请帅分诊`);
      }
    }

    // 新信号（完工 comment + 全部 review）按时间序重放推导当前态
    const all = orderedSignals(comments, reviews);
    const derived = deriveState(all);
    const fp = fingerprint(derived);

    // 动作去重：同一指纹只动作一次（重启后存量重放同指纹不重复动作）
    if (rec.actedOn !== fp) {
      const action = pendingAction(derived, rec);
      if (action) {
        if (action.kind === 'report-final') {
          // 复核绿 → 报帅终审（终审 + 校准 + 合并归档归帅，本脚本不自动合并）
          events.push(`[flow] 报帅：终审 #${pr.number}（复核结论：绿）——终审 + 校准 + 合并归档归帅，本脚本不自动合并`);
          rec.actedOn = fp;
        } else if (action.kind === 'report-switch') {
          // 乒乓两轮仍红 → 报帅换人（换人决策归帅）
          events.push(`[flow] 报帅：换人 #${pr.number}（乒乓两轮仍红——两轮返工后第 ${action.round} 次红判定）——换人决策归帅`);
          rec.actedOn = fp;
        } else {
          const extra = {
            reviewUrl: action.kind === 'inject-rework' ? lastReviewUrl(reviews) : null,
            reviewerHandle: rec.reviewer?.handle || null,
            reviewerWorktree: rec.reviewer?.worktree || null,
            reviewerLabel: rec.reviewer?.label || null,
          };
          const exec = executeAction({ ...action, ...extra }, pr, toml, source, rec, args.dryRun);
          if (exec.ok) {
            events.push(exec.line);
            rec.actedOn = fp;
            if (exec.line.startsWith('[flow] 预览-阻塞')) {
              // 观察 2：dry-run 的解析失败也进 blocked——长跑时不能第二轮转绿
              rec.blocked[action.kind] = true;
            }
            if (action.kind === 'start-reviewer' && exec.handle) {
              rec.reviewer = { handle: exec.handle, label: exec.label, taskBook: exec.taskBook, worktree: exec.worktree || null };
            }
          } else {
            // fail-visible：验不过报帅、不重试狂发（#455 连带教训）
            events.push(`[flow] 报帅：${exec.error}——fail-visible，不重试狂发（PR #${pr.number} 待帅处置）`);
            if (exec.needsReport !== 'report-unknown' && exec.needsReport !== 'reviewer-unfound') {
              rec.blocked[action.kind] = true; // 注入失败 → 帅持有，不再自动重发
            }
            rec.actedOn = fp;
          }
        }
      } else {
        rec.actedOn = fp; // 无需流转：已扫描该态（防止每轮重复推导输出）
      }
    }

    // 新信号记账（动作失败也记账——fail-visible 后不重发，帅持有）
    for (const c of comments) if (c && c.id != null) rec.seenComments[c.id] = true;
    for (const rv of reviews) if (rv && rv.id != null) rec.seenReviews[rv.id] = true;

    // 待帅处置常驻行（红 3）：approved/error/pingpong/blocked 每轮显形
    const reason = awaitingShuaiReason(derived, rec);
    if (reason) awaitingShuai.push({ pr: pr.number, reason });

    // 制度类 PR 停留超 24h 提醒一声（S5 拍板；正文含「体系类改动」段 = 制度类；
    // 用 updatedAt 算停留——天天在推的长战线 PR 不算「停留」，对抗审观察 7）
    if (isInstitutional(pr) && !rec.reportedStale && (pr.updatedAt || pr.createdAt)) {
      const age = Date.now() - Date.parse(pr.updatedAt || pr.createdAt);
      if (age > STALE_24H_MS) {
        rec.reportedStale = true;
        events.push(`[flow] 提醒：制度类 PR #${pr.number} ${pr.title} 已停留超 24h（updatedAt=${pr.updatedAt || pr.createdAt}）——垫片在顶着，请帅安排收口`);
      }
    }
  }

  for (const item of awaitingShuai) {
    events.push(`[flow] 待帅处置：#${item.pr}（${item.reason}）`);
  }

  // 退役记录清除（MERGED/CLOSED 的 PR 不再在途，状态文件不堆积）
  for (const key of Object.keys(records)) {
    if (records[key].retired) delete records[key];
  }

  const scanned = open.length;
  const acted = events.some(e => e.startsWith('[flow] 动作') || e.startsWith('[flow] 预览-阻塞') || e.startsWith('[flow] 报帅') || e.startsWith('[flow] 提醒') || e.startsWith('[flow] 退役') || e.startsWith('[flow] 待帅处置'));
  if (!acted && !noTargets) {
    events.push(`[flow] OK 扫完 ${scanned} 个 PR，0 需流转`);
  }
  return { events, noTargets, infraError };
}

function lastReviewUrl(reviews) {
  const withUrl = (reviews || []).filter(r => r.url);
  return withUrl.length > 0 ? withUrl[withUrl.length - 1].url : null;
}

// 制度类识别：PR 正文「体系类改动」段为主（PR 模板必答节）；标题兜底只认
// 「制度|体系」不认「拍板」（拍板一词会误伤普通任务 PR，对抗审观察 7）。
function isInstitutional(pr) {
  return /体系类改动/.test(pr.body || '') || /(制度|体系)/.test(pr.title || '');
}

// ══════════════════════════════════════════════════════════════════════
// 主流程
// ══════════════════════════════════════════════════════════════════════

// 纯函数导出（供 tests/flow.tests.js 单测；import 时不执行主流程）
export { deriveState, pendingAction, pickReviewer, orderedSignals, completionSignals, reviewSignals, isInstitutional, loadRouting, awaitingShuaiReason };

let args = null;
let anyEmitted = false;
let anyNoTargets = false;
let anyInfra = false;

export function main(argv = process.argv.slice(2)) {
  args = parseArgs(argv);
  if (args.snapshotDir) snapshotRun();
  else liveLoop();
  process.exit(anyInfra ? 3 : anyNoTargets ? 2 : anyEmitted ? 1 : 0);
}

function runOneRound(source, state) {
  const round = processOneRound(source, state, args);
  for (const line of round.events) {
    console.log(line);
    if (line.startsWith('[flow] NO_TARGETS')) anyNoTargets = true;
    else if (!line.startsWith('[flow] OK ')) anyEmitted = true;
  }
  if (round.infraError) anyInfra = true;
  saveState(args.stateFile, state);
  return round;
}

function liveLoop() {
  let repo = args.repo;
  if (!repo) {
    const r = runGh(['repo', 'view', '--json', 'nameWithOwner']);
    if (!r.ok) {
      console.log(`[flow] NO_TARGETS：${r.error}——本轮没查成`);
      process.exit(3);
    }
    repo = r.json.nameWithOwner;
  }
  console.log(`# flow live：每 ${args.interval}s 一轮（repo=${repo}${args.dryRun ? '，dry-run 不碰 orca 写操作' : ''}）`);
  for (;;) {
    const state = loadState(args.stateFile);
    if (state.loadError) {
      console.log(`[flow] NO_TARGETS：状态文件损坏（${state.loadError}）——本轮没查成，先修状态文件`);
      if (args.once) process.exit(2);
      sleep(args.interval * 1000);
      continue;
    }
    if (!state.inventoried) {
      console.log('[flow] 存量清点：首次启动，重放全部在途 PR 信号作为基线（prime 吞存量防线）');
      state.inventoried = true;
    }
    const source = makeLiveSource(repo);
    const round = runOneRound(source, state);
    if (args.once) break;
    sleep(args.interval * 1000);
  }
}

function snapshotRun() {
  const loaded = loadSnapshotRounds(args.snapshotDir);
  if (!loaded.ok) {
    console.log(`[flow] NO_TARGETS：${loaded.error}`);
    process.exit(3);
  }
  const state = loadState(args.stateFile);
  if (state.loadError) {
    console.log(`[flow] NO_TARGETS：状态文件损坏（${state.loadError}）`);
    process.exit(2);
  }
  if (!state.inventoried) {
    console.log('[flow] 存量清点：首次启动，重放全部在途 PR 信号作为基线（prime 吞存量防线）');
    state.inventoried = true;
  }
  const multi = loaded.dirs.length > 1;
  for (const dir of loaded.dirs) {
    if (multi) console.log(`# snapshot round ${basename(dir)}`);
    const source = makeSnapshotSource(dir, args.repo || 'thoerwink8/windsurf-dao');
    runOneRound(source, state);
  }
}

const isDirectRun = process.argv[1]
  && resolve(process.argv[1]) === import.meta.filename;
if (isDirectRun) {
  main();
}
