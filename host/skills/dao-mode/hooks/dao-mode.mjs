#!/usr/bin/env node

// 专注/值守三态状态机 —— 状态的唯一读写入口（issue #488 / #607）。
//
// 改这个文件前必须知道的五条：
//   1. 承重的是 hook 不是 skill 正文。skill 的字只在调用那一轮进上下文，二十轮后就没了；
//      每轮把态注入上下文的只有 `hook` 子命令。任何依赖「AI 会记得去读 state.json」的设计都是错的。
//   2. 失效方向必须朝安全一侧：脚本崩了 = 无输出 = 宿主放行 = 退回常态。
//      绝不能出现「崩了却把用户锁死」。所以 hook 路径全程 try/catch，且不联网。
//      hook 唯一会写的动作是「用户消息计数 +1」（issue #607 在场侦测），写失败静默跳过、
//      不阻断注入——少计一次比锁死用户安全。
//   3. 「读到了且是常态」和「压根没读到」必须输出不同的字。两者同形，就等于把
//      「hook 没跑」记成了「用户没在专注」。
//   4. 态只有三个：normal / focus / standby，互斥。加第四个态之前先读 issue #488 第二节
//      （用户已否决「独立双开关」）。
//   5. 注入的是结论不是原料（issue #607）：每轮只有 态 + 该不该问退出的结论 + 一行指针，
//      授权清单全文留在 state.json 里自己读。「该不该问」的判定在 should-ask-exit.mjs（纯函数）。
//
// 行为规范不在这里：无人值守该怎么干已常驻在全局 CLAUDE.md，本文件只造「AI 怎么知道
// 你在不在、该只干哪一件」这一个比特的开关，不复述规范（撞「关于别处的事实只记位置」）。

import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { shouldAskExit, EXIT_DEFAULTS } from './should-ask-exit.mjs';

// ── 落点 ────────────────────────────────────────────────────────────
// 默认 ~/.claude/state.json（用户级、跨会话跨工作区唯一）。测试与实证用 DAO_STATE_FILE 覆写。

const STATE_FILE = process.env.DAO_STATE_FILE || join(homedir(), '.claude', 'state.json');

// 注入文本里要给 AI 一条能照抄的记账命令，所以 SELF 要是**装载路径**而不是 symlink 解析后的仓内路径。
// 宿主跑插件 hook 时会给 CLAUDE_PLUGIN_ROOT；拿不到就退回自己的真实路径（直接手跑 CLI 的情形）。
const SELF = process.env.DAO_MODE_SELF
  || (process.env.CLAUDE_PLUGIN_ROOT
    ? `${process.env.CLAUDE_PLUGIN_ROOT.replace(/\\/g, '/')}/hooks/dao-mode.mjs`
    : fileURLToPath(import.meta.url).replace(/\\/g, '/'));

const MODES = ['normal', 'focus', 'standby'];
const MODE_CN = { normal: '常态', focus: '专注', standby: '值守' };

// ── 读写 ────────────────────────────────────────────────────────────

/**
 * 读态。四种结局，各自不同形，一个都不许合并：
 *   ① 读到了且 mode=normal        —— 常态，没锁
 *   ② 读到了且 mode≠normal        —— 专注 / 值守
 *   ③ 文件不在                    —— 压根没读到（unreadable, kind='absent'）
 *   ④ 文件在但用不了（坏 JSON / mode 字段不认识 / since 缺失）—— 读到了但坏了（unreadable, kind='corrupt'）
 * ③ 和 ④ 是两件事：③ 多半是没装/没切过态，④ 是文件被写坏了，处置不一样。
 * 合并它们等于把「没读到」和「读坏了」记成同一件事，跟把「没查成」记成「查过没事」一个性质。
 *
 * #607 补一条：mode≠normal 时 since 缺失/不是合法时间 ⇒ 归 ④（corrupt）。
 * 时长是「该不该问退出」的输入，算不出时长时不许静默当常态，也不许拿 0 冒充——报了「态没查成」，
 * AI 会去调 /dao-mode 重切，重切后 since 就有了。
 * userMessages 缺失 ⇒ 视为 0 不报：它是 #607 新字段，旧文件没有它照样是合法状态。
 */
function readState() {
  let raw;
  try {
    raw = readFileSync(STATE_FILE, 'utf8');
  } catch (e) {
    return { unreadable: true, kind: 'absent', why: `${e.code || 'ERR'} ${STATE_FILE}` };
  }
  let doc;
  try {
    doc = JSON.parse(raw.replace(/^﻿/, ''));
  } catch (e) {
    return { unreadable: true, kind: 'corrupt', why: `JSON 解析失败：${String(e.message).slice(0, 60)}` };
  }
  if (!doc || typeof doc !== 'object' || !MODES.includes(doc.mode)) {
    return { unreadable: true, kind: 'corrupt', why: `mode 字段不是 ${MODES.join('/')} 之一，读到的是 ${JSON.stringify(doc?.mode)}` };
  }
  if (doc.mode !== 'normal') {
    const entered = Date.parse(doc.since);
    if (!doc.since || Number.isNaN(entered)) {
      return { unreadable: true, kind: 'corrupt', why: `mode=${doc.mode} 但 since 字段缺失或不是合法时间（读到 ${JSON.stringify(doc.since)}）——时长算不了，调 /dao-mode 重切一次态即可覆盖重写` };
    }
  }
  return doc;
}

/** 写态。先写临时文件再 rename，避免半截文件被下一轮 hook 读到。utf8 无 BOM。 */
function writeState(doc) {
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  const tmp = `${STATE_FILE}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n', { encoding: 'utf8' });
  renameSync(tmp, STATE_FILE);
}

function nowIso() {
  return new Date().toISOString();
}

function blank(mode) {
  return {
    mode,
    since: nowIso(),
    focus: null,          // { what, doneWhen }
    standby: null,        // { canDecideAlone: [], alwaysHold: [] }
    offTopicStreak: 0,    // 连续偏离次数；第二次才弹确认（复用「同一种办法连错两次就换路」）
    lastOffTopic: null,   // { at, what }
    parked: [],           // [{ at, what }] 专注/值守期间攒下的暂存队列，退出时回放
    userMessages: 0,      // 进入本态后用户消息数（#607 在场侦测：UserPromptSubmit 每触发一次 +1，hook 路径写）
    decisions: [],        // [{ at, what, category, basis }] 值守自拍登记（#607：先记再做，退出时回放）
    updatedBy: `dao-mode.mjs @ ${process.env.ORCA_TERMINAL_HANDLE || process.env.USERNAME || 'unknown'}`,
    updatedAt: nowIso(),
  };
}

// ── Orca 态标（给用户看的那一半）─────────────────────────────────────
// 非 Orca 环境（或 orca 命令不在）必须静默降级：只写 state.json，不报错、不非零退出。

const BADGE_RE = /^\[(?:专注|值守)[^\]]*\]\s*/;

function orcaBadge(doc) {
  if (doc.mode === 'focus') return `[专注 ${doc.focus?.what || '?'}] `;
  if (doc.mode === 'standby') return `[值守${doc.focus?.what ? ' ' + doc.focus.what : ''}] `;
  return '';
}

/**
 * 跑一次 orca。先按精确文件名 spawn（不过 shell，参数里的中文/分号不会被 shell 再解析一次），
 * 只有找不到可执行文件时才退到 shell 里试一次——那条路径把参数拼进单条命令，
 * 避免 Node 对「shell:true + args 数组」的弃用告警污染输出。
 *
 * 本文件作为 Claude 插件分发（CLAUDE_PLUGIN_ROOT 场景仓外没有 scripts/lib），必须自包含，
 * 不能 import 仓内共享实现。唯一真源是 scripts/lib/orca-run.mjs 的 runOrcaRaw——
 * 改 spawn 行为（timeout/回落）先改那边，再把本拷贝对齐。#807：不再传 windowsHide。
 */
function runOrca(args) {
  const direct = spawnSync('orca', args, { encoding: 'utf8', timeout: 20000 });
  if (!direct.error) return direct;
  const line = ['orca', ...args.map(a => `"${String(a).replace(/"/g, '\\"')}"`)].join(' ');
  return spawnSync(line, { encoding: 'utf8', shell: true, timeout: 20000 });
}

/** 返回一行人话，说明态标打上了还是跳过了、为什么。 */
function applyOrcaBadge(doc) {
  if (process.env.DAO_NO_ORCA === '1') return 'orca 态标：跳过（DAO_NO_ORCA=1）';
  const show = runOrca(['worktree', 'show', '--worktree', 'active', '--json']);
  if (show.error || show.status !== 0) {
    return `orca 态标：跳过（非 Orca 环境或命令不可用：${show.error?.code || `exit ${show.status}`}）`;
  }
  let comment = '';
  try {
    comment = JSON.parse(show.stdout)?.result?.worktree?.comment || '';
  } catch {
    return 'orca 态标：跳过（worktree show 输出不是 JSON）';
  }
  const next = orcaBadge(doc) + comment.replace(BADGE_RE, '');
  const set = runOrca(['worktree', 'set', '--worktree', 'active', '--comment', next, '--json']);
  if (set.error || set.status !== 0) {
    return `orca 态标：写不进（${set.error?.code || `exit ${set.status}`}），state.json 已写`;
  }
  return `orca 态标：已打「${next.slice(0, 40) || '(已清空)'}」`;
}

// ── 注入文本（承重墙）────────────────────────────────────────────────
// 每轮 UserPromptSubmit 都把这段字放进上下文。它必须自带守则——因为 skill 正文早滚走了，
// AI 上下文里除了这段字，没有任何东西会提醒它自己被锁着。
// #607 瘦身原则：注入 态 + 结论 + 一行指针；授权清单全文、记账细则留在 state.json / skill 里自己读。

function localTime(iso) {
  try {
    return new Date(iso).toLocaleString('zh-CN', { hour12: false });
  } catch { return iso; }
}

/** 环境变量可配的阈值：解析不出正数就退回默认（坏 env 不许让注入崩）。 */
function numEnv(name, dflt) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : dflt;
}

function driftHint(prompt, focusWhat) {
  // 廉价启发式：只提醒 AI 去判断，不代替判断（什么算偏离是语义问题，正则判不了）。
  if (!prompt || !focusWhat) return '';
  const focusNums = new Set((String(focusWhat).match(/#\d+/g) || []));
  const inPrompt = [...new Set(String(prompt).match(/#\d+/g) || [])].filter(n => !focusNums.has(n));
  if (inPrompt.length === 0) return '';
  return `  · 本轮 prompt 里出现了 ${inPrompt.join(' ')}，不在焦点内——先判断这是不是「指派一个新的工作对象」。\n`;
}

function renderInjection(doc, prompt) {
  if (doc.unreadable) {
    const head = doc.kind === 'absent'
      ? `[态] 未知 · 状态文件不在，一个字都没读到 —— 按常态办，但这是降级不是常态。`
      : `[态] 未知 · 状态文件读到了但用不了（内容坏了）—— 按常态办，但这是降级不是常态。`;
    return [
      head,
      `     文件：${STATE_FILE}`,
      `     原因：${doc.why}`,
      doc.kind === 'absent'
        ? '     多半是没装或从没切过态。要确认当前是不是专注/值守，调 `/dao-mode`。'
        : '     文件被写坏了。调 `/dao-mode` 重切一次态即可覆盖重写，不要手改。',
    ].join('\n');
  }

  if (doc.mode === 'normal') {
    return `[态] 常态 · 无锁（状态文件已读到，mode=normal，自 ${localTime(doc.since)}）`;
  }

  const lines = [];
  const head = doc.mode === 'focus' ? '专注' : '值守（用户不在场）';
  lines.push(`━━ 当前态：${head} ━━（来源 ${STATE_FILE}，进入于 ${localTime(doc.since)}）`);

  // 结论行（#607 ①：判定在 hook 里算，注入的是结论不是原料——不能指望 AI 记得去调函数）。
  const hours = (Date.now() - Date.parse(doc.since)) / 3600000;
  const verdict = shouldAskExit({
    mode: doc.mode,
    hours,
    messages: doc.userMessages || 0,
    offTopicStreak: doc.offTopicStreak || 0,
    thresholds: {
      hours: numEnv('DAO_EXIT_HOURS', EXIT_DEFAULTS.hours),
      messages: numEnv('DAO_EXIT_MESSAGES', EXIT_DEFAULTS.messages),
      offTopic: numEnv('DAO_EXIT_OFFTOPIC', EXIT_DEFAULTS.offTopic),
    },
  });
  if (verdict.ask) {
    const action = doc.mode === 'standby' ? '现在必须问是否退出值守' : '建议问用户是否还在专注';
    lines.push(`⚠️ ${verdict.reasons.join('，')} → ${action}（调 /dao-mode 拍板；AI 永不自行切态）`);
  }

  if (doc.focus?.what) lines.push(`焦点：${doc.focus.what}${doc.focus?.doneWhen ? `（什么算完：${doc.focus.doneWhen}）` : ''}`);

  // 偏离守则（承重，不瘦：skill 正文滚走后这是唯一提醒）
  if ((doc.offTopicStreak || 0) >= 1) {
    lines.push(`⚠️ offTopicStreak=${doc.offTopicStreak}（上次偏离：${doc.lastOffTopic?.what || '?'}）——判定本轮又是偏离 ⇒ 不要直接照办，先调 /dao-mode 让用户拍板。`);
  } else {
    lines.push(`守则：只干焦点内的事，只有「用户指派一个新的工作对象」算偏离；判定偏离 ⇒ 照办，回复末尾挂「⚠️ 不在焦点内，已照办，焦点仍锁」。`);
  }
  lines.push(driftHint(prompt, doc.focus?.what).trimEnd() || null);

  // 一行指针（#607 ③：授权清单全文留 state.json；记账命令只留名字与必填参数，签名同源可查）
  lines.push(`记账/查授权：\`node "${SELF}" status --json\`（授权边界全文在此）；值守自拍先登记 \`selfie\`、偏离记 \`drift\`、暂存记 \`park\`（都要 --what）；退出/换焦点/改授权调 \`/dao-mode\`。`);

  return lines.filter(Boolean).join('\n');
}

// ── 子命令 ──────────────────────────────────────────────────────────

function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch { return ''; }
}

function argOf(argv, name) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

function listOf(argv, name) {
  const v = argOf(argv, name);
  if (!v) return [];
  return v.split(/[;；]/).map(s => s.trim()).filter(Boolean);
}

function cmdHook(argv) {
  // 这条路径只读不写——唯一的例外是 #607 在场侦测的「用户消息计数」。
  // 宿主给的 payload 拿不到也无所谓——拿不到就没有启发式提示。
  let prompt = '';
  if (!process.stdin.isTTY) {
    const raw = readStdin();
    try { prompt = JSON.parse(raw)?.prompt || ''; } catch { prompt = ''; }
  }
  // 测试崩溃样本（#607 验收：hook 崩溃退回常态的实证）。生产环境不会设这个变量。
  if (process.env.DAO_MODE_TEST_CRASH === '1') throw new Error('DAO_MODE_TEST_CRASH 崩溃样本');
  const doc = readState();
  // 消息计数：UserPromptSubmit 每触发一次 = 一条用户消息，只在非常态计（常态计数无意义）。
  // 写失败静默跳过——少计一次顶多少一条提醒，锁死用户才是真错。多会话并发丢一两次计数
  // 也朝这个方向（少计不误报），不为此加重试。
  if (!doc.unreadable && doc.mode !== 'normal') {
    doc.userMessages = (doc.userMessages || 0) + 1;
    doc.updatedAt = nowIso();
    try { writeState(doc); } catch { /* 计数写失败不阻断注入 */ }
  }
  process.stdout.write(renderInjection(doc, prompt) + '\n');
}

function cmdStatus(argv) {
  const doc = readState();
  if (argv.includes('--json')) {
    process.stdout.write(JSON.stringify(doc, null, 2) + '\n');
    return;
  }
  if (doc.unreadable) {
    process.stdout.write(`态：未知（${doc.kind === 'absent' ? '状态文件不在' : '状态文件坏了'}）\n文件：${STATE_FILE}\n原因：${doc.why}\n`);
    return;
  }
  process.stdout.write(`态：${MODE_CN[doc.mode]}\n` +
    (doc.focus?.what ? `焦点：${doc.focus.what}\n` : '') +
    (doc.focus?.doneWhen ? `什么算完：${doc.focus.doneWhen}\n` : '') +
    `自：${localTime(doc.since)}\n连续偏离：${doc.offTopicStreak || 0}\n暂存：${(doc.parked || []).length} 条\n`);
}

function cmdFocus(argv) {
  const what = argOf(argv, 'what');
  const doneWhen = argOf(argv, 'done-when');
  if (!what || !doneWhen) {
    process.stderr.write('focus 必须同时给 --what 和 --done-when：删掉任何一个，专注就退化成「我说我专注了」（issue #488 明列不可删）\n');
    process.exit(2);
  }
  const prev = readState();
  const doc = blank('focus');
  doc.focus = { what, doneWhen };
  // 换焦点时保留暂存队列（用户可能还想回放），但偏离计数归零。
  if (!prev.unreadable && Array.isArray(prev.parked)) doc.parked = prev.parked;
  writeState(doc);
  process.stdout.write(`已进入专注：${what}\n什么算完：${doneWhen}\n${applyOrcaBadge(doc)}\n`);
}

function cmdStandby(argv) {
  const prev = readState();
  const doc = blank('standby');
  const what = argOf(argv, 'what');
  if (what) doc.focus = { what, doneWhen: argOf(argv, 'done-when') || null };
  doc.standby = { canDecideAlone: listOf(argv, 'decide'), alwaysHold: listOf(argv, 'hold') };
  if (!prev.unreadable && Array.isArray(prev.parked)) doc.parked = prev.parked;
  writeState(doc);
  process.stdout.write(`已进入值守${what ? `（今晚只把 ${what} 干完）` : ''}\n` +
    `可以自己拍：${doc.standby.canDecideAlone.join('；') || '(未填)'}\n` +
    `恒挂起：${doc.standby.alwaysHold.join('；') || '(未填)'}\n${applyOrcaBadge(doc)}\n`);
}

function cmdNormal(argv) {
  const prev = readState();
  const doc = blank('normal');
  writeState(doc);
  const parked = prev.unreadable ? [] : (prev.parked || []);
  process.stdout.write(`已回常态（此前：${prev.unreadable ? '未知' : MODE_CN[prev.mode]}${prev.focus?.what ? ' ' + prev.focus.what : ''}）\n`);
  // #607 ②：值守自拍登记回放 + 「拍板可能没登记」的机械检测。
  // 真正「拍了板但没登记」无法被任何脚本观测（AI 行为不在状态机视野内），
  // 能查的是痕迹：值守期间有偏离（连续 ≥2 次）却 0 条登记 → 报警对账。
  if (!prev.unreadable && prev.mode === 'standby') {
    const decisions = prev.decisions || [];
    if (decisions.length) {
      process.stdout.write(`值守期间自拍登记 ${decisions.length} 条，随三行摘要一并回放：\n` +
        decisions.map((d, i) => `  ${i + 1}. [${localTime(d.at)}] ${d.what}（${d.category}，依据：${d.basis}）`).join('\n') + '\n');
    } else if ((prev.offTopicStreak || 0) >= 2) {
      process.stdout.write(`⚠️ 值守期间连续偏离 ${prev.offTopicStreak} 次，但 0 条自拍登记——偏离伴随的拍板可能没登记，请对账（AI 行为本身无法机械检测，这是可查的信号）\n`);
    }
  }
  if (parked.length) {
    process.stdout.write(`暂存队列 ${parked.length} 条，逐条回放给用户：\n` +
      parked.map((p, i) => `  ${i + 1}. [${localTime(p.at)}] ${p.what}`).join('\n') + '\n');
  } else {
    process.stdout.write('暂存队列：空\n');
  }
  process.stdout.write(applyOrcaBadge(doc) + '\n');
}

function cmdDrift(argv) {
  const doc = readState();
  if (doc.unreadable) {
    process.stderr.write(`记不了偏离：${doc.why}\n`);
    process.exit(1);
  }
  if (doc.mode === 'normal') {
    process.stdout.write('当前是常态，没有焦点可偏离，不记账\n');
    return;
  }
  doc.offTopicStreak = (doc.offTopicStreak || 0) + 1;
  doc.lastOffTopic = { at: nowIso(), what: argOf(argv, 'what') || '(未填)' };
  doc.updatedAt = nowIso();
  writeState(doc);
  process.stdout.write(`已记：连续偏离 ${doc.offTopicStreak} 次` +
    (doc.offTopicStreak >= 2
      ? '\n下一步：调 `/dao-mode` 让用户在「换焦点」和「保持当前焦点」之间拍板\n'
      : '\n下一步：照办，回复末尾挂 ⚠️ 提示行，焦点仍锁\n'));
}

function cmdPark(argv) {
  const doc = readState();
  if (doc.unreadable) {
    process.stderr.write(`存不了：${doc.why}\n`);
    process.exit(1);
  }
  const what = argOf(argv, 'what');
  if (!what) { process.stderr.write('park 要 --what\n'); process.exit(2); }
  doc.parked = doc.parked || [];
  doc.parked.push({ at: nowIso(), what });
  doc.updatedAt = nowIso();
  writeState(doc);
  process.stdout.write(`已暂存第 ${doc.parked.length} 条，退出当前态时回放\n`);
}

function cmdClearDrift() {
  const doc = readState();
  if (doc.unreadable) { process.stderr.write(`改不了：${doc.why}\n`); process.exit(1); }
  doc.offTopicStreak = 0;
  doc.updatedAt = nowIso();
  writeState(doc);
  process.stdout.write('连续偏离已归零（用户判定这只是插曲，焦点不变）\n');
}

function cmdSelfie(argv) {
  // #607 ②：值守态自拍登记。先记再做——拍板生效之前落账，不许靠「记得补记」。
  // 语义分类（归为哪一类、依据哪一条）仍由 AI 自己写，但必须显式写出来，用户事后能逐条对账。
  const doc = readState();
  if (doc.unreadable) {
    process.stderr.write(`记不了自拍：${doc.why}\n`);
    process.exit(1);
  }
  if (doc.mode !== 'standby') {
    process.stdout.write(doc.mode === 'normal'
      ? '当前是常态，用户在场，拍板应直接问用户，无需登记\n'
      : '当前是专注，用户在场，拍板应直接问用户，无需登记\n');
    return;
  }
  const what = argOf(argv, 'what');
  if (!what) { process.stderr.write('selfie 要 --what（拍了什么）\n'); process.exit(2); }
  const category = argOf(argv, 'category') || '(未分类)';
  const basis = argOf(argv, 'basis') || '(未填依据)';
  doc.decisions = doc.decisions || [];
  doc.decisions.push({ at: nowIso(), what, category, basis });
  doc.updatedAt = nowIso();
  writeState(doc);
  process.stdout.write(`已登记第 ${doc.decisions.length} 条自拍：${what}（${category}，依据：${basis}）——先记后做，退出值守时随摘要回放\n`);
}

// ── 入口 ────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const cmd = argv[0] || 'hook';

const TABLE = {
  hook: cmdHook,
  status: cmdStatus,
  focus: cmdFocus,
  standby: cmdStandby,
  normal: cmdNormal,
  drift: cmdDrift,
  park: cmdPark,
  'clear-drift': cmdClearDrift,
  selfie: cmdSelfie,
};

if (cmd === 'hook') {
  // hook 路径独立兜底：任何异常都不许把用户锁住，也不许让宿主看见非零退出。
  try {
    cmdHook(argv);
  } catch (e) {
    process.stdout.write(`[态] 未知 · 状态机自己出错了 —— 按常态办\n     原因：${String(e.message || e).slice(0, 120)}\n`);
  }
  process.exit(0);
}

const fn = TABLE[cmd];
if (!fn) {
  process.stderr.write(`不认识的子命令：${cmd}\n可用：${Object.keys(TABLE).join(' / ')}\n`);
  process.exit(2);
}
fn(argv);
