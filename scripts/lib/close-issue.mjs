// scripts/lib/close-issue.mjs —— 关单只认这里（issue #657）
//
// 删掉 GitHub `Closes`/`Fixes` 自动关单：关单只走本脚本判定——
//   署名 issue 的 PR 已 MERGED **且** check 全绿才 `issue close`；
//   合进但 check 红（FAILURE/未完成/无 check/没查成）的不许关，若单已关而关它的 PR
//   check 红 → `issue reopen`。没查成 ≠ 绿。
//
// 相对绿（基线化）：PR check 绑定历史 merge commit，基线红期间合入的 PR 永远不可能
// 转绿，绝对绿会把关单管线整体卡死（#696/#700 实证）。所以：PR 的硬红 check 若
// **全部**属于「合并时 master 基线硬红」（merge commit 首父的 check-runs），视为可关。
// 从严红线不破：基线取数任何一步没查成（无 mergeCommit / api 失败 / 无父 commit /
// 基线 0 条 check）都保持现状从严——相对绿必须建立在「基线确实查成了」上；
// PR 自己有 check 未完成/无结论同样不可赦免。粒度是 check（job）名：同 job 内新增
// 失败会被同名基线红掩盖，窗口仅限基线红期间——master 转绿后新 PR 的红全是自己的。
//
// 纯函数 + 注入 runGh，可被 tests 用假 gh 单独验；不依赖 orca / 真网络。
// runGh(args) 契约：接收 gh 参数数组，返回 { ok, json?, out?, error? }（json 为解析后的对象）。

/** PR 正文里的署名单号：认新规范「署名 issue #N」（非 GitHub 关单词，不触发自动关单）与旧 GitHub 关单词。 */
export function attributedIssueNumbers(text) {
  const found = [];
  const re = /(?:署名\s+issue\s*#?\s*|(?:close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved)\s+#)(\d+)/gi;
  let m;
  while ((m = re.exec(String(text || '')))) {
    const n = Number(m[1]);
    if (Number.isInteger(n) && !found.includes(n)) found.push(n);
  }
  return found;
}

/** 单个署名 issue 号：标题 #N 优先（与 flow.ticketIssueNumber 同口径），再正文署名/关单词。 */
export function attributedIssueNumber(pr) {
  const title = String((pr && pr.title) || '');
  const t = title.match(/#(\d+)/);
  if (t) return Number(t[1]);
  const nums = attributedIssueNumbers((pr && pr.body) || '');
  return nums.length ? nums[0] : null;
}

const HARD_RED = new Set(['FAILURE', 'CANCELLED', 'ACTION_REQUIRED', 'TIMED_OUT', 'STALE', 'STARTUP_FAILURE']);

/** 单条 check 是否「已完成且硬红」（commits check-runs 返回小写、PR rollup 返回大写，统一大写再比）。 */
function isHardRed(c) {
  const status = String((c && c.status) || '').toUpperCase();
  const conclusion = String((c && c.conclusion) || '').toUpperCase();
  return status === 'COMPLETED' && HARD_RED.has(conclusion);
}

/** PR 自己的硬红 check 名（只数已完成且硬红的；未完成/无结论属「没查成」，不可被基线赦免）。 */
export function failedCheckNames(pr) {
  const rollup = pr && pr.statusCheckRollup;
  if (!Array.isArray(rollup)) return [];
  return rollup.filter(isHardRed).map(c => String(c.name || c.context || '?'));
}

/** 全部 check 绿：statusCheckRollup 必须存在、非空，且每条都是已完成的 SUCCESS。没查成/空 ≠ 绿。 */
export function allChecksGreen(pr) {
  const rollup = pr && pr.statusCheckRollup;
  if (rollup == null) return { green: false, reason: '没查成(statusCheckRollup 缺失)' };
  if (!Array.isArray(rollup) || rollup.length === 0) return { green: false, reason: '无任何 check（没查成 ≠ 绿）' };
  for (const c of rollup) {
    const status = String((c && c.status) || '').toUpperCase();
    const conclusion = String((c && c.conclusion) || '').toUpperCase();
    if (status && status !== 'COMPLETED') return { green: false, reason: `check 未完成(${status})` };
    if (HARD_RED.has(conclusion)) return { green: false, reason: `check ${conclusion}` };
    if (!conclusion) return { green: false, reason: '有 check 无结论（没查成 ≠ 绿）' };
  }
  return { green: true };
}

/**
 * 合并时 master 基线的硬红 check 名集合：取 PR merge commit 的首个父 commit
 * （= 合并前 master 尖头；squash/rebase 合并同样首父即合并前基线）的 check-runs。
 * 返回 { ok, red?, base?, reason? }。任何一步没查成都 ok:false——没查成 ≠ 基线全绿，从严。
 */
export function baselineRedChecks({ pr, runGh } = {}) {
  const sha = pr && pr.mergeCommit && pr.mergeCommit.oid;
  if (!sha) return { ok: false, reason: 'PR 无 mergeCommit 字段' };
  const meta = runGh(['api', `repos/{owner}/{repo}/commits/${sha}`]);
  if (!meta.ok) return { ok: false, reason: `读 merge commit 失败：${meta.error}` };
  const parents = meta.json && Array.isArray(meta.json.parents) ? meta.json.parents : null;
  if (!parents || parents.length === 0 || !parents[0] || !parents[0].sha) {
    return { ok: false, reason: 'merge commit 无父 commit（或输出形态不对）' };
  }
  const base = parents[0].sha;
  const runs = runGh(['api', `repos/{owner}/{repo}/commits/${base}/check-runs?filter=latest&per_page=100`]);
  if (!runs.ok) return { ok: false, reason: `读基线 check-runs 失败：${runs.error}` };
  const list = runs.json && Array.isArray(runs.json.check_runs) ? runs.json.check_runs : null;
  if (!list) return { ok: false, reason: '基线 check-runs 输出形态不对（要 check_runs 数组）' };
  if (list.length === 0) return { ok: false, reason: `基线 commit ${base.slice(0, 7)} 无任何 check（基线没查成 ≠ 基线全绿）` };
  const red = new Set(list.filter(isHardRed).map(c => String(c.name || c.context || '?')));
  return { ok: true, red, base };
}

/**
 * 相对绿判定：PR 全量 check 已查完（每条 COMPLETED 且有结论）、存在硬红项、
 * 且硬红项全部落在基线硬红集合里。基线没查成或 PR 自己没查完都不适用。
 */
function relativeGreen(pr, baseline) {
  const rollup = pr && pr.statusCheckRollup;
  if (!Array.isArray(rollup) || rollup.length === 0) return { green: false, reason: '；相对绿不适用：PR 侧无任何 check（没查成）' };
  for (const c of rollup) {
    const status = String((c && c.status) || '').toUpperCase();
    const conclusion = String((c && c.conclusion) || '').toUpperCase();
    if (status && status !== 'COMPLETED') return { green: false, reason: '；相对绿不适用：PR 有 check 未完成（没查成 ≠ 绿）' };
    if (!conclusion) return { green: false, reason: '；相对绿不适用：PR 有 check 无结论（没查成 ≠ 绿）' };
  }
  const failed = [...new Set(failedCheckNames(pr))];
  if (failed.length === 0) return { green: false, reason: '' };
  if (!baseline || !baseline.ok) {
    return { green: false, reason: `；基线没查成（${(baseline && baseline.reason) || '未取基线'}），从严` };
  }
  const extra = failed.filter(n => !baseline.red.has(n));
  if (extra.length) {
    return { green: false, reason: `；失败项超出合并时基线：${extra.join('、')}（基线红：${[...baseline.red].join('、') || '无'}）` };
  }
  return { green: true, reason: `MERGED 且相对绿：PR 失败项（${failed.join('、')}）全属合并时 master 基线红（基线 ${String(baseline.base || '').slice(0, 7)} 已查成）` };
}

/** 判定：非 MERGED → none；MERGED 且全绿（含相对绿）→ close；否则 → reopen（不许关）。 */
export function closeDecision(pr, { baseline } = {}) {
  const state = String((pr && pr.state) || '').toUpperCase();
  if (state !== 'MERGED') return { action: 'none', reason: `state=${(pr && pr.state) || '?'} 非 MERGED` };
  const checks = allChecksGreen(pr);
  if (checks.green) return { action: 'close', reason: 'MERGED 且 check 全绿' };
  const rel = relativeGreen(pr, baseline);
  if (rel.green) return { action: 'close', reason: rel.reason };
  return { action: 'reopen', reason: `MERGED 但 check 不绿(${checks.reason})${rel.reason}——不许自动关，若已关须重开` };
}

/**
 * 对单个 PR 执行关单判定并落动作。
 * 返回 { ok, action, reason, issue?, pr?, dryRun? }。
 */
export function closeIssueForPr({ pr, runGh, dryRun = false } = {}) {
  const number = String((pr && (pr.number ?? pr.pr)) ?? '');
  const issue = attributedIssueNumber(pr);
  if (!issue) return { ok: true, action: 'none', reason: '无署名单号', pr: number };
  let dec = closeDecision(pr);
  if (dec.action === 'reopen') {
    // 绝对绿不成立才花两次 api 取基线试相对绿；绿单/未合单零额外开销。
    dec = closeDecision(pr, { baseline: baselineRedChecks({ pr, runGh }) });
  }
  if (dec.action === 'none') return { ok: true, action: 'none', reason: dec.reason, pr: number };
  const iv = runGh(['issue', 'view', String(issue), '--json', 'state']);
  if (!iv.ok) return { ok: false, action: dec.action, error: `gh issue view #${issue} 失败：${iv.error}`, issue, pr: number };
  let issueState;
  try { issueState = (iv.json || {}).state; } catch { return { ok: false, error: `gh issue view #${issue} 非 JSON`, issue, pr: number }; }
  if (issueState == null) return { ok: false, error: `gh issue view #${issue} 没读到 state（没查成）`, issue, pr: number };
  const expectOpen = dec.action === 'close';
  if (expectOpen && String(issueState).toUpperCase() === 'CLOSED') return { ok: true, action: 'none', reason: `issue #${issue} 已关`, issue, pr: number };
  if (!expectOpen && String(issueState).toUpperCase() !== 'CLOSED') return { ok: true, action: 'none', reason: `issue #${issue} 未关(${issueState})，无需重开`, issue, pr: number };
  if (dryRun) return { ok: true, action: dec.action, issue, pr: number, reason: dec.reason, dryRun: true };
  const verb = dec.action === 'close' ? 'close' : 'reopen';
  const op = runGh(['issue', verb, String(issue)]);
  if (!op.ok) return { ok: false, action: dec.action, error: `gh issue ${verb} #${issue} 失败：${op.error}`, issue, pr: number };
  return { ok: true, action: dec.action, issue, pr: number, reason: dec.reason };
}
