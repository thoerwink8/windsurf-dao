// scripts/lib/dispatch/constraints.mjs —— 派工约束/拆分域（#762 拆分）
//
// 改这段前必须知道：CLI 是约束载体，不是提醒（issue #482 规格重定义）。
// 缺参数就跑不起来。拦旁路的闸门在 dispatch-gate.mjs（#546）。
// --split 判据的真相源是 SPLIT_CRITERION（#611），skill 只留指针。

import { assembleCardName } from './card.mjs';

export const MERGE_POLICIES = ['auto', 'manual'];
export const DISPATCH_VERBS = ['dispatch', 'worker-start'];

export function minutesInBeijing(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date instanceof Date ? date : new Date(date));
  const h = Number(parts.find(p => p.type === 'hour')?.value);
  const m = Number(parts.find(p => p.type === 'minute')?.value);
  if (!Number.isFinite(h) || !Number.isFinite(m)) throw new Error('算不出北京时间');
  return h * 60 + m;
}

export function windowContains(beijing, minutes) {
  const windows = String(beijing || '').split(',').map(s => s.trim()).filter(Boolean);
  if (windows.length === 0) return false;
  return windows.some((w) => {
    const [a, b] = w.split('-');
    if (!a || !b) return false;
    const toMin = (t) => {
      const [hh, mm] = t.split(':').map(Number);
      return hh * 60 + mm;
    };
    const start = toMin(a);
    const end = toMin(b);
    return minutes >= start && minutes < end;
  });
}

export function recommendModel({ role, routing, now = new Date() } = {}) {
  if (!role) return { ok: false, error: 'recommendModel 要 role' };
  if (!routing) return { ok: false, error: 'recommendModel 要 routing' };
  const order = typeof routing.rankOrderFor === 'function'
    ? routing.rankOrderFor('工人', role)
    : [];
  if (order.length === 0) {
    return { ok: false, error: `角色 ${role} 没在 docs/model-routing.json 职责树里扫到顺位，请显式 --model` };
  }
  return {
    ok: true,
    model: order[0],
    fallback: order[1] || null,
    role,
    rank: 1,
    why: 'JSON 职责树顺位',
  };
}

/**
 * 派工约束硬闸。缺一即失败，并列出缺什么。
 * --role 而无 --model：读 JSON 职责树顺位给推荐，必须 --confirm，禁静默默认。
 * --merge-policy 默认 auto（拍板 issue #511：帅不再是合并关口）；选 manual 必须
 * 同时给 --merge-reason（例外留痕，理由为空即退出，不靠记性）。
 */
export function resolveDispatchConstraints({
  mergePolicy, mergeReason, model, role, reviewer, confirm, routing, now = new Date(),
} = {}) {
  const missing = [];
  const policy = mergePolicy || 'auto';
  if (!MERGE_POLICIES.includes(policy)) {
    return {
      ok: false,
      missing: [],
      error: `--merge-policy 只允许 auto|manual，实际 ${policy}`,
    };
  }
  if (policy === 'manual' && !String(mergeReason || '').trim()) {
    return {
      ok: false,
      missing: ['--merge-reason'],
      error: '--merge-policy manual 必须给 --merge-reason（例外留痕；只限改协作约定 / 改 model-routing.toml 决策字段 / 花钱，见 #511）',
    };
  }

  if (!model && !role) missing.push('--model 或 --role');
  if (!reviewer) missing.push('--reviewer');

  if (missing.length) {
    return { ok: false, missing, error: `缺 ${missing.join('、')}` };
  }

  if (!routing) {
    return { ok: false, missing: [], error: '读路由表失败（无 routing）' };
  }

  const models = Array.isArray(routing.models) ? routing.models : [];
  let resolvedModel = model || null;
  let recommendation = null;

  if (!model && role) {
    recommendation = recommendModel({ role, routing, now });
    if (!recommendation.ok) {
      return { ok: false, missing: ['--model'], error: recommendation.error, recommendation };
    }
    if (!confirm) {
      return {
        ok: false,
        needsConfirm: true,
        missing: ['--confirm'],
        recommendation,
        error: `JSON 顺位推荐 ${recommendation.model}（角色 ${role}，顺位 ${recommendation.rank || 1}）。加 --confirm 采用，或显式 --model。禁静默默认`,
      };
    }
    resolvedModel = recommendation.model;
  }

  if (resolvedModel && !models.some(m => m && m.id === resolvedModel)) {
    return { ok: false, missing: [], error: `模型 ${resolvedModel} 不在路由表` };
  }
  if (reviewer && !models.some(m => m && m.id === reviewer)) {
    return { ok: false, missing: [], error: `审官 --reviewer ${reviewer} 不在路由表` };
  }

  // 同厂闸不在派工预检（2026-08-23 delete-all-ceremony 拍板）：dispatch 时审官还不存在，
  // 闸是查空气。真闸在审官落地时：reviewer-create / reviewer-attach / worker-done / 换人。

  return {
    ok: true,
    mergePolicy: policy,
    mergeReason: policy === 'manual' ? String(mergeReason || '').trim() : null,
    model: resolvedModel,
    role: role || null,
    reviewer,
    recommendation,
  };
}

/** --split 判据的真相源（#611）。skill 只留指针，勿在别处复制一份。 */
export const SPLIT_CRITERION = '产出物能不能按文件切开？能切 + 块数 ≥2 + 每块够一个工人干 → --split N；切不开（同几个文件反复改）→ --split no + --split-reason';

/**
 * dispatch --split 硬闸。取值只允许 no 或 ≥2 的整数；缺了就退。
 * --split no 必须同时给非空 --split-reason（入账本，防仪式化）。
 */
export function resolveSplitConstraint({ split, splitReason } = {}) {
  const raw = split == null ? '' : String(split).trim();
  if (!raw) {
    return {
      ok: false,
      missing: ['--split'],
      error: `dispatch 要 --split <no|N>（N≥2）。${SPLIT_CRITERION}`,
    };
  }
  if (/^no$/i.test(raw)) {
    const reason = String(splitReason || '').trim();
    if (!reason) {
      return {
        ok: false,
        missing: ['--split-reason'],
        error: '--split no 必须给 --split-reason（理由入账本，防仪式化）',
      };
    }
    return { ok: true, split: 'no', splitReason: reason, childCount: 0 };
  }
  if (!/^\d+$/.test(raw)) {
    return {
      ok: false,
      missing: [],
      error: `--split 只允许 no 或 ≥2 的整数，实际「${raw}」`,
    };
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 2) {
    return {
      ok: false,
      missing: [],
      error: `--split N 必须 ≥2，实际 ${n}（切不开请用 --split no --split-reason）`,
    };
  }
  const reason = String(splitReason || '').trim();
  return { ok: true, split: n, splitReason: reason || null, childCount: n };
}

const FILE_TOKEN = /[A-Za-z0-9_./\\-]+\.[A-Za-z0-9]+/g;

export function sliceFileTokens(text) {
  return [...String(text || '').matchAll(FILE_TOKEN)].map(m => m[0].replace(/\\/g, '/').toLowerCase());
}

/**
 * --split N 必须给 N 份非空、互不重叠的 --slice。
 * 重叠：两份原文相同，或抽到的文件路径出现在两块里（a.js / b.js 反例）。
 */
export function resolveSliceAssignments({ childCount = 0, slices } = {}) {
  const list = Array.isArray(slices)
    ? slices.map(s => String(s == null ? '' : s).trim())
    : (slices == null || String(slices).trim() === '' ? [] : [String(slices).trim()]);
  if (!childCount) {
    if (list.length) {
      return { ok: false, missing: [], error: '--split no 不要给 --slice' };
    }
    return { ok: true, slices: [] };
  }
  if (list.length !== childCount) {
    return {
      ok: false,
      missing: ['--slice'],
      error: `--split ${childCount} 必须给 ${childCount} 个 --slice（每块一份非空分块说明），实际 ${list.length}`,
    };
  }
  if (list.some(s => !s)) {
    return { ok: false, missing: ['--slice'], error: '--slice 不能为空' };
  }
  if (list.some(s => !/[\p{L}\p{N}]/u.test(s))) {
    return { ok: false, missing: ['--slice'], error: '--slice 必须有实质内容（字母或数字）' };
  }
  const seenText = new Set();
  for (const s of list) {
    if (seenText.has(s)) {
      return { ok: false, error: `--slice 边界重叠：两块说明相同「${s}」` };
    }
    seenText.add(s);
  }
  const owner = new Map();
  for (let i = 0; i < list.length; i++) {
    for (const file of sliceFileTokens(list[i])) {
      if (owner.has(file)) {
        return {
          ok: false,
          error: `--slice 边界重叠：${file} 同时出现在第 ${owner.get(file)} 块和第 ${i + 1} 块`,
        };
      }
      owner.set(file, i + 1);
    }
  }
  return { ok: true, slices: list };
}

/**
 * 三单回归用的那条可判定规则（#611）。
 * 只回答「该不该拆」：能按文件切开且块数≥2 且每块够干 → N；否则 no。
 * N 由调用方给（#608 是 24 个文件拆 4 工人），函数不猜块怎么切。
 */
export function decideSplit({ filesSeparable, chunkCount, eachChunkEnoughWork, n } = {}) {
  if (filesSeparable === true && Number(chunkCount) >= 2 && eachChunkEnoughWork === true) {
    const workers = n != null ? Number(n) : Number(chunkCount);
    if (Number.isInteger(workers) && workers >= 2) return { split: workers };
  }
  return { split: 'no' };
}

export function planSplitCards({
  name, issue, childCount = 0,
  role, model,
  parentSelector = '<父卡>',
  baseBranch = '<任务分支>',
} = {}) {
  const parentName = assembleCardName({ name, issue, role, model });
  const children = [];
  const n = Number(childCount) || 0;
  for (let i = 1; i <= n; i++) {
    children.push({
      name: parentName ? `${parentName} · ${i}` : String(i),
      parentWorktree: parentSelector,
      baseBranch,
      flags: ['--parent-worktree', parentSelector, '--base-branch', baseBranch],
    });
  }
  return {
    parent: { name: parentName, noParent: true },
    children,
  };
}

/** --split N 时给头工人 / 子工人可执行的分块职责。子块必须带调用方给的 --slice 原文。 */
export function buildSplitRoleSpec({ spec, role, index, total, slice } = {}) {
  const base = String(spec || '').trim();
  const n = Number(total) || 0;
  if (role === 'head') {
    return `${base}｜头工人：协调${n}块，不独占文件块`;
  }
  const part = String(slice || '').trim();
  if (!part) {
    throw new Error(`块${index}/${n} 缺 --slice，不能用同一份 spec 冒充分块`);
  }
  return `块${index}/${n}：${part}`;
}

/**
 * 真路径起 N 个独立子工人。startOne 负责终端/Task/Dispatch/验开工。
 * 任一子工人失败时返回已起的那些（含已有 handle 的失败者），供完整回滚。
 */
export function startSplitChildren({ children, spec, slices, startOne } = {}) {
  if (typeof startOne !== 'function') {
    return { ok: false, started: [], error: 'startSplitChildren 没拿到 startOne' };
  }
  const list = Array.isArray(children) ? children : [];
  const parts = Array.isArray(slices) ? slices : [];
  const total = list.length;
  if (parts.length !== total) {
    return { ok: false, started: [], error: `startSplitChildren 要 ${total} 个 slice，实际 ${parts.length}` };
  }
  const started = [];
  for (let i = 0; i < total; i++) {
    const child = list[i] || {};
    let sliceSpec;
    try {
      sliceSpec = buildSplitRoleSpec({ spec, role: 'child', index: i + 1, total, slice: parts[i] });
    } catch (e) {
      return { ok: false, started, error: String(e.message || e) };
    }
    const r = startOne({
      worktreeId: child.id,
      path: child.path,
      title: child.name,
      spec: sliceSpec,
      slice: parts[i],
      index: i + 1,
      total,
    }) || {};
    const record = {
      id: child.id,
      name: child.name,
      handle: r.handle || null,
      dispatchId: r.dispatchId || null,
      taskId: r.taskId || null,
      spec: sliceSpec,
    };
    if (record.handle || record.dispatchId) started.push(record);
    if (!r.ok) {
      return {
        ok: false,
        started,
        error: `子工人 ${i + 1}/${total} 没起成: ${r.error || '未知错误'}`,
      };
    }
  }
  return { ok: true, started };
}
