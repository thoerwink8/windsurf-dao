#!/usr/bin/env node

// 专注/值守三态状态机 —— 状态的唯一读写入口（issue #488）。
//
// 改这个文件前必须知道的四条：
//   1. 承重的是 hook 不是 skill 正文。skill 的字只在调用那一轮进上下文，二十轮后就没了；
//      每轮把态注入上下文的只有 `hook` 子命令。任何依赖「AI 会记得去读 state.json」的设计都是错的。
//   2. 失效方向必须朝安全一侧：脚本崩了 = 无输出 = 宿主放行 = 退回常态。
//      绝不能出现「崩了却把用户锁死」。所以 hook 路径全程 try/catch，且不写文件、不联网。
//   3. 「读到了且是常态」和「压根没读到」必须输出不同的字。两者同形，就等于把
//      「hook 没跑」记成了「用户没在专注」。
//   4. 态只有三个：normal / focus / standby，互斥。加第四个态之前先读 issue #488 第二节
//      （用户已否决「独立双开关」）。
//
// 行为规范不在这里：无人值守该怎么干已常驻在全局 CLAUDE.md，本文件只造「AI 怎么知道
// 你在不在、该只干哪一件」这一个比特的开关，不复述规范（撞「关于别处的事实只记位置」）。

import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

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
 *   ④ 文件在但用不了（坏 JSON / mode 字段不认识）—— 读到了但坏了（unreadable, kind='corrupt'）
 * ③ 和 ④ 是两件事：③ 多半是没装/没切过态，④ 是文件被写坏了，处置不一样。
 * 合并它们等于把「没读到」和「读坏了」记成同一件事，跟把「没查成」记成「查过没事」一个性质。
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
 */
function runOrca(args) {
  const win = process.platform === 'win32';
  const direct = spawnSync(win ? 'orca.exe' : 'orca', args, { encoding: 'utf8', timeout: 20000 });
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

function localTime(iso) {
  try {
    return new Date(iso).toLocaleString('zh-CN', { hour12: false });
  } catch { return iso; }
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
  lines.push(`━━ 当前态：${head} ━━（本段由 UserPromptSubmit hook 每轮注入，来源 ${STATE_FILE}，进入于 ${localTime(doc.since)}）`);

  if (doc.focus?.what) lines.push(`焦点：${doc.focus.what}`);
  if (doc.focus?.doneWhen) lines.push(`什么算完：${doc.focus.doneWhen}`);

  if (doc.mode === 'standby') {
    const can = doc.standby?.canDecideAlone || [];
    const hold = doc.standby?.alwaysHold || [];
    if (can.length) lines.push(`可以自己拍：${can.join('；')}`);
    if (hold.length) lines.push(`恒挂起等用户：${hold.join('；')}`);
    lines.push('值守期间该怎么干，见全局 CLAUDE.md「用户不在场时…」那两行，此处不复述。');
  }

  lines.push('守则：只干焦点内的事。**只有「用户指派一个新的工作对象」才算偏离**——问进度、纠偏、闲聊、焦点内的追问，都不算。');
  lines.push(driftHint(prompt, doc.focus?.what).trimEnd() || null);

  if ((doc.offTopicStreak || 0) >= 1) {
    lines.push(`⚠️ offTopicStreak=${doc.offTopicStreak}（上次偏离：${doc.lastOffTopic?.what || '?'}）`);
    lines.push('   判定本轮又是偏离 ⇒ **不要直接照办**，先调 `/dao-mode` 让用户在「换焦点」和「保持当前焦点」之间拍板。');
  } else {
    lines.push(`offTopicStreak=0（判定本轮是偏离 ⇒ 照办，但回复末尾必须挂一行「⚠️ 不在焦点 ${doc.focus?.what || '(未填)'} 内，已照办，焦点仍锁」，并按下面记一笔）`);
  }
  lines.push(`记账：\`node "${SELF}" drift --what "..."\`（判定为偏离时记）/ \`park --what "..."\`（值得留但现在不做）；退出、换焦点、改授权都调 \`/dao-mode\`。`);

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
  // 这条路径只读不写。宿主给的 payload 拿不到也无所谓——拿不到就没有启发式提示。
  let prompt = '';
  if (!process.stdin.isTTY) {
    const raw = readStdin();
    try { prompt = JSON.parse(raw)?.prompt || ''; } catch { prompt = ''; }
  }
  process.stdout.write(renderInjection(readState(), prompt) + '\n');
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
