// scripts/lib/close-issue.mjs —— 关单只认这里（issue #657）
//
// 删掉 GitHub `Closes`/`Fixes` 自动关单：关单只走本脚本判定——
//   署名 issue 的 PR 已 MERGED **且** check 全绿才 `issue close`；
//   合进但 check 红（FAILURE/未完成/无 check/没查成）的不许关，若单已关而关它的 PR
//   check 红 → `issue reopen`。没查成 ≠ 绿。
//
// 生产唯一入口：flow.mjs 合后钩 per-PR；人工调试：`close-issues.mjs --pr N`。
// 制度：docs/decisions/2026-08-21-close-issue-from-zero.md（删相对绿/祖父/sweep 实跑）。
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

/** 判定：非 MERGED → none；MERGED 且全绿 → close；否则 → reopen（不许关）。 */
export function closeDecision(pr) {
  const state = String((pr && pr.state) || '').toUpperCase();
  if (state !== 'MERGED') return { action: 'none', reason: `state=${(pr && pr.state) || '?'} 非 MERGED` };
  const checks = allChecksGreen(pr);
  if (checks.green) return { action: 'close', reason: 'MERGED 且 check 全绿' };
  return { action: 'reopen', reason: `MERGED 但 check 不绿(${checks.reason})——不许自动关，若已关须重开` };
}

/**
 * 对单个 PR 执行关单判定并落动作。
 * 返回 { ok, action, reason, issue?, pr?, dryRun? }。
 */
export function closeIssueForPr({ pr, runGh, dryRun = false } = {}) {
  const number = String((pr && (pr.number ?? pr.pr)) ?? '');
  const issue = attributedIssueNumber(pr);
  if (!issue) return { ok: true, action: 'none', reason: '无署名单号', pr: number };
  const dec = closeDecision(pr);
  if (dec.action === 'none') return { ok: true, action: 'none', reason: dec.reason, pr: number };
  const iv = runGh(['issue', 'view', String(issue), '--json', 'state,url,labels']);
  if (!iv.ok) {
    const msg = String(iv.error || '');
    // 署名目标不存在：署名解析误中（标题/正文随手引用 #N），不是关单失败——跳过不污染 exit code。
    if (/could not resolve|not found|NOT_FOUND/i.test(msg)) {
      return { ok: true, action: 'none', reason: `署名目标 #${issue} 不存在（署名解析误中？），跳过`, issue, pr: number };
    }
    return { ok: false, action: dec.action, error: `gh issue view #${issue} 失败（网络/权限？）：${iv.error}`, issue, pr: number };
  }
  let issueState, issueUrl;
  try { ({ state: issueState, url: issueUrl } = iv.json || {}); } catch { return { ok: false, error: `gh issue view #${issue} 非 JSON`, issue, pr: number }; }
  if (issueState == null) return { ok: false, error: `gh issue view #${issue} 没读到 state（没查成）`, issue, pr: number };
  // 署名目标其实是 PR（gh issue view 对 PR 号也答得出，url 才是照妖镜）：跳过不污染 exit code。
  if (typeof issueUrl === 'string' && issueUrl.includes('/pull/')) {
    return { ok: true, action: 'none', reason: `署名目标 #${issue} 是 PR 不是 issue（标题/正文引用误中），跳过`, issue, pr: number };
  }
  // 人工判定「已顶替」的单不弹回（2026-09-04 实咬：#633/#651/#683/#684/#686/#693 六张被 sweep
  // 反复 reopen——署名 PR 合入时历史 check 红，脚本不区分「谁关的、为什么关」。带标签 = 人拍过，机器让路）。
  const labels = Array.isArray(iv.json?.labels) ? iv.json.labels.map((l) => String(l?.name || '')) : [];
  if (dec.action === 'reopen' && labels.includes('已顶替')) {
    return { ok: true, action: 'none', reason: `issue #${issue} 带「已顶替」标签（人工拍过），不弹回`, issue, pr: number };
  }
  const expectOpen = dec.action === 'close';
  if (expectOpen && String(issueState).toUpperCase() === 'CLOSED') return { ok: true, action: 'none', reason: `issue #${issue} 已关`, issue, pr: number };
  if (!expectOpen && String(issueState).toUpperCase() !== 'CLOSED') return { ok: true, action: 'none', reason: `issue #${issue} 未关(${issueState})，无需重开`, issue, pr: number };
  if (dryRun) return { ok: true, action: dec.action, issue, pr: number, reason: dec.reason, dryRun: true };
  const verb = dec.action === 'close' ? 'close' : 'reopen';
  const op = runGh(['issue', verb, String(issue)]);
  if (!op.ok) return { ok: false, action: dec.action, error: `gh issue ${verb} #${issue} 失败：${op.error}`, issue, pr: number };
  return { ok: true, action: dec.action, issue, pr: number, reason: dec.reason };
}
