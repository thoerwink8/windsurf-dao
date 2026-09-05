// scripts/lib/ask-gate.mjs —— 「这件事该问用户，还是我自己拍」的判据。
//
// 改这段代码前必须知道的五条：
//
// 1. 判据早就有了，缺的是触发。docs/release-policy.json（用户 2026-09-03 拍板）里
//    human_holds 那四条就是「永远问人」的全集，confirm.patch.who=auto 就是「其余自己拍」。
//    它从来没进过每轮注入面，名字又叫 release-policy，看起来像发布策略不像问不问用户——
//    2026-09-05 实测帅位问了 5 次，2 次不该问（拦一个切错基线的 PR、关一张四轮没过的单，
//    两件都不在四条里）。本模块只负责回答，怎么触发在 host/skills/ask-gate/hooks/。
//
// 2. 三态不许压成两态。ask / auto / unscanned，其中 unscanned 最要紧：
//    JSON 读不到、字段对不上 ⇒ 一律 unscanned，**绝不许退回 auto**。
//    退回 auto 的方向是「AI 替用户拍了不该拍的」，不可逆；退回 ask 顶多多问一句。
//
// 3. 关键词是从 JSON 现算的，不是抄下来的。human_holds 改一个字，判据跟着改；
//    抄一份常量在这里，就等于给自己造了一个会过期的副本（撞「关于别处的事实只记位置」）。
//
// 4. 本文件自己 readFile + JSON.parse，不 import release-policy-check.mjs 或任何
//    release-policy 消费方——检查逻辑不得复用被检查对象自己的解析。
//
// 5. 语义判断不在这里。「这件事算不算花钱」是 AI 自己交代的（写一句「依据：花钱」），
//    本模块只验「依据在不在四条里」。想让机器自动判语义 = 假阳假阴，比没有更糟。

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export const POLICY_REL = 'docs/release-policy.json';

/** 提问类工具：这两个是全局约定里的解析顺序（AskUserQuestion 优先，没有才 mirasim）。 */
export const ASK_TOOLS = ['AskUserQuestion', 'mcp__mirasim__im_ask_user'];

// ── 解析策略文件 ────────────────────────────────────────────────────

/**
 * 解析 release-policy.json 的文本。纯函数：给什么字解什么，不碰文件系统。
 *
 * 必须齐的字段（缺一个就是 unscanned，不是 auto）：
 *   human_holds                 —— 永远问人的全集
 *   confirm.{patch,minor,major}.who —— 各级谁拍板；patch.who 就是「自己拍」的依据本身
 *   version.bump_by_commit_type —— 分级判据（fix→patch / feat→minor / feat!→major）
 * 少任何一个，「按 patch 级自己拍」这句话就没有出处了——没出处不许当结论。
 */
export function parsePolicy(text) {
  let doc;
  try {
    doc = JSON.parse(String(text ?? '').replace(/^﻿/, ''));
  } catch (e) {
    return { unscanned: `${POLICY_REL} 解析不了：${String(e.message).slice(0, 80)}` };
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    return { unscanned: `${POLICY_REL} 顶层不是对象` };
  }

  const holds = Array.isArray(doc.human_holds)
    ? doc.human_holds.filter((h) => typeof h === 'string' && h.trim())
    : null;
  if (!holds) return { unscanned: `${POLICY_REL} 缺 human_holds 或它不是数组——红线清单没读到` };
  if (!holds.length) return { unscanned: `${POLICY_REL} 的 human_holds 是空的——0 条红线跟「没读到」一样，不许当「什么都能自己拍」` };

  const levelWho = {};
  for (const lvl of ['patch', 'minor', 'major']) {
    const who = doc?.confirm?.[lvl]?.who;
    if (typeof who !== 'string' || !who.trim()) {
      return { unscanned: `${POLICY_REL} 缺 confirm.${lvl}.who——查不出这一级谁拍板` };
    }
    levelWho[lvl] = who.trim();
  }

  const table = doc?.version?.bump_by_commit_type;
  if (!table || typeof table !== 'object' || Array.isArray(table) || !Object.keys(table).length) {
    return { unscanned: `${POLICY_REL} 缺 version.bump_by_commit_type——分级判据没读到` };
  }
  const bumpByType = {};
  for (const [k, v] of Object.entries(table)) {
    if (typeof v === 'string' && levelWho[v.trim()]) bumpByType[normKey(k)] = v.trim();
  }
  if (!Object.keys(bumpByType).length) {
    return { unscanned: `${POLICY_REL} 的 bump_by_commit_type 一条都对不上 patch/minor/major` };
  }

  return { holds, levelWho, bumpByType, updated: typeof doc.updated === 'string' ? doc.updated : null };
}

/** 从仓里读一份策略。找不到就是 unscanned——「文件不在」不是「没有红线」。 */
export function loadPolicy({ root, file } = {}) {
  const path = file || (root ? join(root, ...POLICY_REL.split('/')) : null);
  if (!path) return { unscanned: '没给仓库根，找不到策略文件' };
  if (!existsSync(path)) return { unscanned: `${path} 不在——策略没读到` };
  try {
    return { ...parsePolicy(readFileSync(path, 'utf8')), file: path };
  } catch (e) {
    return { unscanned: `${path} 读不了：${String(e.message).slice(0, 80)}`, file: path };
  }
}

// ── 关键词：从每条红线现算，不抄常量 ────────────────────────────────

/**
 * 一条红线拆成可匹配的说法。"对用户发布(minor/major)" ⇒
 *   ["对用户发布(minor/major)", "对用户发布", "minor", "major"]
 * 括号内是同义写法（用户在 JSON 里就是这么写的），拆开才能匹配到 AI 的白话。
 * 半角/全角括号都认；两个字以下的碎片丢掉（"改" 这种会匹配到一切）。
 */
export function holdKeywords(hold) {
  const s = String(hold || '').trim();
  if (!s) return [];
  const out = new Set([s]);
  const m = s.match(/^(.*?)[(（]([^)）]*)[)）]\s*$/);
  if (m) {
    if (m[1].trim()) out.add(m[1].trim());
    for (const part of m[2].split(/[/／、,，]/)) {
      const p = part.trim();
      if (p) out.add(p);
    }
  }
  return [...out].filter((k) => k.length >= 2);
}

/** probe 里有没有提到某条红线。返回命中的那条与命中它的哪个说法。 */
export function matchHold(probe, holds) {
  const hay = normKey(probe);
  if (!hay) return null;
  for (const hold of holds || []) {
    for (const kw of holdKeywords(hold)) {
      if (hay.includes(normKey(kw))) return { hold, keyword: kw };
    }
  }
  return null;
}

/**
 * 抽显式依据行：「依据：花钱」「basis: 删数据」。
 * 写了依据就只按依据判——AI 自己交代它归哪一类，机器只验这句话在不在四条里。
 * 一句话里可能夹着别的字，取到行尾或右括号为止。
 */
export function extractBasis(text) {
  const m = String(text ?? '').match(/(?:依据|依據|basis)\s*[:：]\s*([^\n）)]+)/i);
  return m ? m[1].trim() : null;
}

// ── 判定 ────────────────────────────────────────────────────────────

/**
 * 这件事该问人还是自己拍。
 *
 * @param {{text?: string, hints?: {commitType?: string}, policy: object}} input
 *   text   —— 这件事的描述（提问原文，或一句话说明）
 *   hints  —— 可选分级线索；commitType 走 version.bump_by_commit_type 换算成 patch/minor/major
 *   policy —— parsePolicy / loadPolicy 的结果
 * @returns {{verdict:'ask'|'auto'|'unscanned', why:string, matched?:string, basis?:string|null}}
 *
 * 顺序是硬的：红线优先于分级。human_holds 写着「永远问人，不论大小」——
 * 一个 fix 级的改动只要碰了删数据，照样得问。
 */
export function classifyAsk({ text = '', hints = {}, policy } = {}) {
  if (!policy || policy.unscanned) {
    return { verdict: 'unscanned', why: policy?.unscanned || '没拿到策略——判据本身没读到' };
  }

  const basis = extractBasis(text);
  const probe = basis || text;
  const hit = matchHold(probe, policy.holds);
  if (hit) {
    return {
      verdict: 'ask',
      matched: hit.hold,
      basis,
      why: `命中 human_holds「${hit.hold}」${basis ? `（依据写的是「${basis}」）` : `（凭「${hit.keyword}」这个说法认出来的）`}`,
    };
  }

  // 分级线索：给了就必须解得出来，解不出来是 unscanned 不是 auto。
  let level = 'patch';
  let levelWhy = `没给分级线索，按最轻的 patch 级算`;
  if (hints && hints.commitType != null && String(hints.commitType).trim()) {
    const raw = String(hints.commitType).trim();
    const got = policy.bumpByType[normKey(raw)];
    if (!got) {
      return { verdict: 'unscanned', basis, why: `分级线索「${raw}」不在 version.bump_by_commit_type 表里——级都定不了，不许当 auto` };
    }
    level = got;
    levelWhy = `${raw} → ${level} 级`;
  }

  const who = policy.levelWho[level];
  if (who !== 'auto') {
    return { verdict: 'ask', matched: `confirm.${level}.who=${who}`, basis, why: `${levelWhy}，confirm.${level}.who=${who}——这一级要人确认` };
  }
  return {
    verdict: 'auto',
    basis,
    why: `不在 human_holds 那 ${policy.holds.length} 条里；${levelWhy}，confirm.${level}.who=auto ⇒ 自己拍`,
  };
}

// ── 注入文本 ────────────────────────────────────────────────────────

/**
 * 判定渲染成给 AI 看的字。三态各自不同形——这是本仓硬规矩：
 * 「没查成」和「查过没事」在输出上必须分得开。
 *
 * auto 那形是承重的：它不禁止提问（禁止会拦错，而用户可能正等着被问），
 * 它要求 AI 交代依据。带不出依据 = 它不在红线里 = 不该问。
 */
export function renderAskGate(verdict, { policy, tool } = {}) {
  const who = tool ? `（${tool}）` : '';
  if (!verdict || verdict.verdict === 'unscanned') {
    return [
      `[问人闸] 没查成${who}：${verdict?.why || '判据没读到'}`,
      `  「没查成」不是「可以自己拍」。先把 ${POLICY_REL} 修好再决定问不问；这次拿不准就问。`,
    ].join('\n');
  }
  if (verdict.verdict === 'ask') {
    return `[问人闸] 该问${who}：${verdict.why}。`;
  }
  const lines = (policy?.holds || []).map((h) => `    · ${h}`).join('\n');
  return [
    `[问人闸] 这次提问没落在「永远问人」里${who}：${verdict.why}。`,
    verdict.basis ? `  你写的依据是「${verdict.basis}」，它不在下面四条里。` : null,
    `  人只拍这几条（${POLICY_REL} 的 human_holds）：`,
    lines,
    `  · 真属于其中一条 ⇒ 在问题里带一句「依据：<上面的原话>」，本行就不再出现。`,
    `  · 不属于 ⇒ 别问，自己拍板并在回复里说明理由。拍错了能回滚，问错了花的是用户的时间。`,
  ].filter(Boolean).join('\n');
}

// ── 工具输入取文 ────────────────────────────────────────────────────

/**
 * 把提问工具的 tool_input 压成一段文本。
 * 故意不认字段名：AskUserQuestion 是 {questions:[{question,header,options:[{label,description}]}]}，
 * mirasim 是 {question,header,hint,options:[...]}，将来还会有第三种。递归收所有字符串，
 * 谁把依据写在哪个字段里都能收到。深度设上限，坏 payload 不许把 hook 转晕。
 */
export function askToolText(input, depth = 0) {
  if (depth > 6) return '';
  if (typeof input === 'string') return input;
  if (typeof input === 'number' || typeof input === 'boolean') return String(input);
  if (Array.isArray(input)) return input.map((v) => askToolText(v, depth + 1)).filter(Boolean).join('\n');
  if (input && typeof input === 'object') {
    return Object.values(input).map((v) => askToolText(v, depth + 1)).filter(Boolean).join('\n');
  }
  return '';
}

/** 归一化：大小写、空白、全角括号统一，让「Minor」「 minor 」「（minor）」都能对上。 */
function normKey(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/（/g, '(').replace(/）/g, ')')
    .replace(/\s+/g, '');
}
