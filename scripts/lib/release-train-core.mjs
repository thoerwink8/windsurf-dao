// 发布列车纯函数核心（issue #800）。无 IO、无网络、无 git；输入进、判断出。
//
// 分工：本文件只做「一堆 PR 标题 → 档位 → 下一个版本号」与「现在该不该切版」的判断；
// 读 git、读策略文件、打 tag、发群消息全在 scripts/release-train.mjs（有 IO 的壳）。
//
// 版本号语义不抄第二份：nextVersion 复用 host/skills/dao-commit/bump.mjs 的 bump()
// （feat→minor / fix→patch / breaking→major / 其他→不动）。档位表默认与
// docs/release-policy.json 的 version.bump_by_commit_type 同口径，可由调用方传真相源覆盖。

import { bump } from '../../host/skills/dao-commit/bump.mjs';

// conventional commits 档位表：类型 → 版本位。默认口径与 release-policy.json 一致。
// 调用方（CLI）可把 policy.version.bump_by_commit_type 传进来当真相源，避免两处漂移。
export const DEFAULT_BUMP_TABLE = {
  fix: 'patch',
  docs: 'patch',
  chore: 'patch',
  refactor: 'patch',
  perf: 'patch',
  style: 'patch',
  test: 'patch',
  build: 'patch',
  ci: 'patch',
  feat: 'minor',
  'feat!': 'major',
  'BREAKING CHANGE': 'major',
};

const LEVEL_RANK = { none: 0, patch: 1, minor: 2, major: 3 };
const RANK_LEVEL = ['none', 'patch', 'minor', 'major'];

/**
 * 从一条 PR 标题里抽 conventional 类型。
 * 允许开头有宿主标 `[cc]`/`[grok]` 等前缀（可多个）。破坏性标记：type 后带 `!`，或标题里含 `BREAKING CHANGE`。
 * 认不出类型（没有 `type:` 结构）返回 null —— 计入 others，不贡献档位。
 */
export function parseTitleType(title) {
  let s = String(title ?? '').trim();
  // 剥掉开头的宿主标 [..]（可连着好几个）
  while (/^\[[^\]]*\]\s*/.test(s)) s = s.replace(/^\[[^\]]*\]\s*/, '');
  const m = s.match(/^([a-zA-Z]+)(\([^)]*\))?(!)?:/);
  const breaking = /BREAKING CHANGE/.test(String(title ?? '')) || Boolean(m && m[3]);
  if (!m) {
    // 没有 type: 结构；只有在整条含 BREAKING CHANGE 时才算破坏性（无类型的破坏性变更）
    return breaking ? { type: null, breaking: true } : null;
  }
  return { type: m[1].toLowerCase(), breaking };
}

/**
 * 汇总一批 PR 标题 → { level, feats, fixes, breaking, others }。
 * level：含破坏性 ⇒ major；否则含 feat ⇒ minor；否则含 patch 类（fix/docs/chore…）⇒ patch；
 *        一个 conventional 类型都认不出 ⇒ null（不发版）。
 * bumpTable：类型 → 版本位，默认 DEFAULT_BUMP_TABLE；CLI 传 policy 的表即以真相源为准。
 */
export function classifyTitles(titles, bumpTable = DEFAULT_BUMP_TABLE) {
  const list = Array.isArray(titles) ? titles : [];
  const feats = [];
  const fixes = [];
  const breaking = [];
  const others = [];
  let maxRank = 0;

  for (const title of list) {
    const p = parseTitleType(title);
    if (!p) {
      others.push(title);
      continue;
    }
    if (p.breaking) {
      breaking.push(title);
      const lv = bumpTable['feat!'] || bumpTable['BREAKING CHANGE'] || 'major';
      maxRank = Math.max(maxRank, LEVEL_RANK[lv] ?? 0);
    }
    if (p.type === 'feat') {
      feats.push(title);
    } else if (p.type && (bumpTable[p.type] === 'patch')) {
      fixes.push(title);
    } else if (p.type && bumpTable[p.type]) {
      // 表里映射到 minor/major 的非 feat 类型（少见），归 feats 展示
      feats.push(title);
    } else if (p.type) {
      others.push(title);
    }
    if (p.type && bumpTable[p.type]) {
      maxRank = Math.max(maxRank, LEVEL_RANK[bumpTable[p.type]] ?? 0);
    }
  }

  const level = maxRank === 0 ? null : RANK_LEVEL[maxRank];
  return { level, feats, fixes, breaking, others };
}

/**
 * 当前版本号 + 档位 → 下一个版本号（复用 bump.mjs）。
 * level 为 null ⇒ 不发版，返回 null。current 非法 semver ⇒ 返回 { error }。
 */
export function nextVersion(current, level) {
  if (!level) return null;
  const typeForLevel = { major: 'breaking', minor: 'feat', patch: 'fix' }[level];
  if (!typeForLevel) return null;
  const r = bump(current, typeForLevel);
  if (r.error) return { error: r.error, from: r.from };
  return r.to;
}

/** 距 now 最近一次「周 weekday」的 00:00（UTC）。weekday: 0=周日…6=周六。 */
export function lastWeekdayStartUTC(now, weekday) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const diff = (d.getUTCDay() - weekday + 7) % 7;
  d.setUTCDate(d.getUTCDate() - diff);
  return d;
}

/** 把 weekday 配置（'sunday'/'sun'/0…6/数字串）归一成 0–6，认不出退回 0（周日）。 */
export function normalizeWeekday(w) {
  if (w == null || w === '') return 0;
  if (typeof w === 'number' && Number.isInteger(w) && w >= 0 && w <= 6) return w;
  const s = String(w).trim().toLowerCase();
  if (/^[0-6]$/.test(s)) return Number(s);
  const names = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
  const key = s.slice(0, 3);
  return names[key] ?? 0;
}

/**
 * 现在该不该切版。触发三选一，任一成立即发（都要求列车里至少有 1 个合并——「一个都没有 ⇒ 不发」）：
 *   ① 攒够：mergedSinceTag >= minMerged
 *   ② 定时：到发布日（每周 weekday），且距最近那个 weekday 起还没发过版
 *   ③ 兜底：maxWaitH 若给了，距上次发版超过它（#817 旧口径，策略不再配则不触发）
 * now/lastReleaseAt 用 Date；lastReleaseAt=null 表示从没发过版。
 */
export function shouldRelease({
  now,
  mergedSinceTag = 0,
  lastReleaseAt = null,
  minMerged = 5,
  weekday = 0,
  maxWaitH = null,
} = {}) {
  const nowDate = now instanceof Date ? now : new Date(now);
  const last = lastReleaseAt == null ? null : (lastReleaseAt instanceof Date ? lastReleaseAt : new Date(lastReleaseAt));
  const wd = normalizeWeekday(weekday);
  const reasons = [];

  if (!Number.isFinite(mergedSinceTag) || mergedSinceTag < 1) {
    return { release: false, reasons: ['列车为空（自上次发布以来 0 个合并），一个都没有不发'], mergedSinceTag, minMerged, weekday: wd };
  }

  if (mergedSinceTag >= minMerged) {
    reasons.push(`攒够 ${mergedSinceTag}≥${minMerged} 个合并，提前发`);
  }

  const wkStart = lastWeekdayStartUTC(nowDate, wd);
  if (last == null || last.getTime() < wkStart.getTime()) {
    reasons.push(`到发布日（每周 ${wd}），本周期还没发过版`);
  }

  if (maxWaitH != null && Number.isFinite(maxWaitH)) {
    if (last == null) {
      reasons.push('从没发过版，超过兜底等待');
    } else if (nowDate.getTime() - last.getTime() >= maxWaitH * 3600 * 1000) {
      reasons.push(`距上次发版超过 ${maxWaitH}h 兜底`);
    }
  }

  const release = reasons.length > 0;
  if (!release) {
    reasons.push(`未到发布点：攒了 ${mergedSinceTag}/${minMerged} 个、且本周期已过发布日（每周 ${wd}）`);
  }
  return { release, reasons, mergedSinceTag, minMerged, weekday: wd };
}

/**
 * 渲染一段 CHANGELOG（Markdown）。version 不带 v；date 是 YYYY-MM-DD。
 * 分「破坏性变更 / 新功能 / 修复与维护」三节，空节不渲染。
 */
export function renderChangelog({ version, date, classification, compareUrl } = {}) {
  const c = classification || { feats: [], fixes: [], breaking: [], others: [] };
  const lines = [`## v${version} — ${date}`, ''];
  const section = (title, items) => {
    if (!items || items.length === 0) return;
    lines.push(`### ${title}`);
    for (const it of items) lines.push(`- ${it}`);
    lines.push('');
  };
  section('破坏性变更', c.breaking);
  section('新功能', c.feats);
  section('修复与维护', c.fixes);
  section('其它', c.others);
  if (compareUrl) {
    lines.push(`[对比](${compareUrl})`, '');
  }
  return lines.join('\n').replace(/\n+$/, '\n');
}
