// scripts/lib/quick-fix.mjs —— 微通道纯函数层（#682）
//
// 改这段前必须知道：微通道 = 几行改动 20 秒合完的原子通道，主会话红线唯一例外。
// 判定逻辑只在这里，scripts/quick-fix.mjs 是薄 CLI；检查器（quick-fix-check.mjs）
// 自己持正则扫源码，不 import 本文件——自己查自己查不出错。
//
// #679 闸照走：工人模型 = 主会话模型，脚本必须显式声明；查不到 / 同厂 = fail-closed。

import { assertCrossVendor } from './reviewer-vendor-gate.mjs';
import { pickReviewer } from './dao-cmd.mjs';

export const QUICK_FIX_TYPE_LABEL = 'type/微修';
export const QUICK_FIX_BRANCH_PREFIX = 'thoerwink8/quickfix-';
export const QUICK_FIX_COMMIT_PREFIX = '[qf]';
export const QUICK_FIX_MAX_SLUG = 48;

/**
 * 审官模型：显式 --reviewer 优先；没有就只认 issue 的唯一 reviewer/* label。
 * 三态分开：查到一个 / 扫完 0 条 / 没拿到列表。后两者都不许猜。
 */
export function resolveQuickFixReviewer({ explicit, labels } = {}) {
  const flag = String(explicit ?? '').trim();
  if (flag) return { ok: true, modelId: flag, source: 'flag' };
  if (labels == null || !Array.isArray(labels)) {
    return {
      ok: false,
      state: 'unscanned',
      error: 'issue 的 label 列表没拿到（没查成，不许猜审官）',
    };
  }
  const picked = pickReviewer(labels);
  if (!picked.ok) return picked;
  return { ...picked, source: 'label' };
}

/**
 * 微通道同厂闸。工人模型未声明 = 没查成；审官没查成 = 没查成；
 * 同厂 = same_vendor。三种失败话面必须不同（#679 三态）。
 */
export function planQuickFixGate({ workerModel, reviewerId, models } = {}) {
  const worker = String(workerModel ?? '').trim();
  const reviewer = String(reviewerId ?? '').trim();
  if (!worker) {
    return {
      ok: false,
      state: 'unscanned',
      error: '主会话模型未声明（--model 必填，脚本不许猜）',
    };
  }
  if (!reviewer) {
    return {
      ok: false,
      state: 'unscanned',
      error: '审官模型没查成（--reviewer 或 issue 的 reviewer/* 缺一不可）',
    };
  }
  return assertCrossVendor({ workerId: worker, reviewerId: reviewer, models });
}

/** 微修分支名：thoerwink8/quickfix-<issue>-<slug>。slug 清洗后截断，空则 fix。 */
export function quickFixBranchName({ issue, slug } = {}) {
  const n = String(issue ?? '').trim();
  if (!/^\d+$/.test(n)) throw new Error('quickFixBranchName 要合法 issue 号');
  const clean = String(slug ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-')
    .slice(0, QUICK_FIX_MAX_SLUG);
  return `${QUICK_FIX_BRANCH_PREFIX}${n}-${clean || 'fix'}`;
}

/** 微修 PR/commit 的 label 组合（校准数据源 #564：PR 上必须带 model/* 与 type/*）。 */
export function quickFixLabels({ model, reviewer } = {}) {
  const names = [QUICK_FIX_TYPE_LABEL];
  const m = String(model ?? '').trim();
  if (m) names.unshift(`model/${m}`);
  const r = String(reviewer ?? '').trim();
  if (r) names.push(`reviewer/${r}`);
  return names;
}

export function quickFixCommitMessage({ issue, message } = {}) {
  const msg = String(message ?? '').trim() || '微修';
  return `${QUICK_FIX_COMMIT_PREFIX} 微修 #${issue}：${msg}`;
}

/** 从正文抽「署名 issue #N」的单号。只认首个；没抽到返回 null（与抽到分开）。 */
export function signedIssueNumber(text) {
  const m = String(text || '').match(/署名\s+issue\s*#?\s*(\d+)/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isInteger(n) ? n : null;
}

/**
 * PR 正文三段式（目标 / 验收标准 / 进展）+ 署名 issue（关单脚本解析源）。
 * custom 给整段正文（必须自带「署名 issue #N」且 N 必须等于本次 issue——否则关单与
 * pr-sync-labels 会关联错单，破坏数据契约）。
 */
export function buildQuickFixPrBody({ issue, message, files, seconds, custom } = {}) {
  const customText = String(custom ?? '').trim();
  if (customText) {
    const signed = signedIssueNumber(customText);
    if (signed === null) {
      return {
        ok: false,
        error: `--body-file 正文必须含「署名 issue #${issue}」行（关单与 label 同步都读它）`,
      };
    }
    if (signed !== Number(issue)) {
      return {
        ok: false,
        error: `--body-file 正文署名的是 issue #${signed}，不是本次 issue #${issue}——不许关错单`,
      };
    }
    return { ok: true, body: customText, custom: true };
  }
  const msg = String(message ?? '').trim() || '微修';
  const fileList = (Array.isArray(files) ? files : [])
    .map((f) => `  - ${f}`)
    .join('\n') || '  - （文件清单没查成）';
  const secs = Number.isFinite(seconds) ? `${seconds.toFixed(1)}s` : '?';
  const body = [
    '## 目标',
    '',
    `微修 #${issue}：${msg}（quick-fix 微通道，一条命令 20 秒内落地）`,
    '',
    '## 验收标准',
    '',
    '- [ ] 改动文件：',
    fileList,
    '- [ ] CI 绿；审官判定落 GitHub；auto-merge 合并',
    '',
    '## 进展',
    '',
    '- [x] quick-fix 原子通道：分支 → commit → push → PR → label → 异步审官',
    `- [x] 实测计时：${secs}（命令启动 → PR 落地）`,
    '',
    `署名 issue #${issue}，关单交给 \`scripts/close-issues.mjs\`。`,
  ].join('\n');
  return { ok: true, body, custom: false };
}

/**
 * attach 失败的整体回滚计划（#682 验收契约：attach 也是原子步骤，任一步失败
 * 不留半成品分支/PR）。纯函数，执行与日志由调用方注入。
 * 顺序：先删壳卡（它占着微修分支），再关 PR（连带删远端分支），最后删本地分支。
 */
export function planAttachFailureRollback({ pr, branch, worktreeId } = {}) {
  const steps = [];
  if (worktreeId) steps.push({ cmd: `worktree-rm --worktree ${worktreeId} --force`, kind: 'worktree-rm' });
  if (pr) {
    steps.push({ cmd: `pr close ${pr} --delete-branch`, kind: 'pr-close' });
  } else if (branch) {
    steps.push({ cmd: `push origin --delete ${branch}`, kind: 'branch-delete-remote' });
  }
  if (branch) steps.push({ cmd: `branch -D ${branch}`, kind: 'branch-delete-local' });
  return { ok: true, steps };
}

/** 执行回滚计划；exec 注入（测试传假执行器），每步结果与失败都显式留痕。 */
export function runAttachFailureRollback(plan, { exec, log } = {}) {
  if (!plan || !Array.isArray(plan.steps)) {
    return { ok: false, unscanned: true, error: '回滚计划没查成', results: [] };
  }
  if (typeof exec !== 'function') {
    return { ok: false, unscanned: true, error: '回滚没拿到执行器（没查成）', results: [] };
  }
  const results = [];
  for (const step of plan.steps) {
    const r = exec(step.cmd);
    const out = { ...step, ok: !!r.ok, error: r.ok ? undefined : r.error };
    results.push(out);
    if (typeof log === 'function') log(`回滚 ${out.cmd} -> ${out.ok ? 'ok' : `失败 ${out.error}`}`);
  }
  const failed = results.filter((r) => !r.ok);
  return {
    ok: failed.length === 0,
    results,
    failed,
    error: failed.length ? `回滚失败 ${failed.length} 步：${failed.map((f) => f.error).join('；')}` : undefined,
  };
}

/**
 * issue 侧 label 补缺计划：微修通道要求 issue 的 model/* 与主会话模型一致
 * （reviewer-attach 从 issue 读工人模型过 #679 闸），type/* 与 reviewer/* 只补缺、不覆盖。
 * 模型不一致 = 拒（fail-closed，不许覆盖既有派工标签）。
 */
export function planIssueLabelStamps({ labels, model, reviewer, typeLabel = QUICK_FIX_TYPE_LABEL } = {}) {
  if (labels == null || !Array.isArray(labels)) {
    return { ok: false, state: 'unscanned', error: 'issue 的 label 列表没拿到（没查成，不许补标）' };
  }
  const names = labels.map((l) => (typeof l === 'string' ? l : (l && l.name) || '')).filter(Boolean);
  const modelHits = names.filter((n) => n.startsWith('model/') && n.length > 'model/'.length);
  const add = [];
  let source = 'model-match';
  if (modelHits.length === 0) {
    add.push(`model/${model}`);
    source = 'model-missing';
  } else if (modelHits.length > 1) {
    return {
      ok: false,
      state: 'many',
      error: `issue 有多个 model/*（${modelHits.join('、')}），微修通道不许猜一个`,
    };
  } else if (modelHits[0] !== `model/${model}`) {
    return {
      ok: false,
      state: 'conflict',
      error: `issue 的 model/*（${modelHits[0]}）与 --model（${model}）不一致——微修通道不覆盖既有派工标签，换 issue 或确认标签`,
    };
  }
  // type/* 与 reviewer/* 只补缺、不覆盖：reviewer-attach 从 issue 读工人模型过 #679 闸，
  // 合并侧 pr-sync-labels 需要 issue 有 model/* 与 type/*，缺了合并会卡。
  if (!names.some((n) => n.startsWith('type/'))) add.push(typeLabel);
  if (!names.some((n) => n.startsWith('reviewer/'))) add.push(`reviewer/${reviewer}`);
  return { ok: true, add, source };
}
