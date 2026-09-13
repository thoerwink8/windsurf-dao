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

/**
 * 被否定的分句不算认领。
 *
 * 2026-09-13 实咬（PR #1096 / issue #1051）：正文「## 不做什么」一节写着
 * **「不写 `closes #1051`」**——那是在**声明不做这件事**，正则却把 `closes #1051`
 * 当成认领读走了，在真机上把 #1051 焊死 7 天（见 `attributedIssueNumber` 注释）。
 *
 * 判据是「同一分句里出现了否定词」。按行与句读切分，只丢掉命中的那一分句——
 * 不整段屏蔽，别处重复署名的仍认。在 250 张真 PR 正文上回放：只改变 #1096 一张，反面零误伤。
 */
const NEGATED_CLAIM = /(?:不|别|勿|无需|不要|没有|未|非)\s*(?:再|去|会|要|来)?\s*(?:写|加|用|提|填|挂|打|标|带|记)?\s*[「『"'`]*\s*(?:close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved|署名)\b/i;

/** 丢掉被否定词管住的分句，保留其余原文。
 *  行界与句读位置保留（被打掉的分句换成空串，不挪走换行）——`attributedIssueNumber`
 *  靠「正文段落」的先后与有无决定优先级，改写行结构会连带改掉它的判据。 */
export function stripNegatedClaims(text) {
  const src = String(text || '');
  if (!NEGATED_CLAIM.test(src)) return src;
  const kept = [];
  for (const line of src.split(/\r?\n/)) {
    // 按句读与粗体标记切分句：否定只作用于它所在的那一分句。
    let out = line;
    for (const seg of line.split(/(?<=[。；;！!？?])|(?=\*\*)/)) {
      if (seg && NEGATED_CLAIM.test(seg)) out = out.replace(seg, '');
    }
    kept.push(out);
  }
  return kept.join('\n');
}

/** PR 正文里的署名单号：认新规范「署名 issue #N」（非 GitHub 关单词，不触发自动关单）与旧 GitHub 关单词。
 *  被否定的分句先剥掉——「不写 closes #N」是声明不做，不是认领。 */
export function attributedIssueNumbers(text) {
  const found = [];
  const re = /(?:署名\s+issue\s*#?\s*|(?:close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved)\s+#)(\d+)/gi;
  let m;
  const scan = stripNegatedClaims(text);
  while ((m = re.exec(scan))) {
    const n = Number(m[1]);
    if (Number.isInteger(n) && !found.includes(n)) found.push(n);
  }
  return found;
}

/**
 * 单个署名 issue 号。
 *
 * 优先级（2026-09-11 实咬 PR #1159 / issue #1182）：
 *   1. 正文「署名 issue #N」或旧关单词（Closes/Fixes）——任务书和关单脚本的权威署名。
 *   2. 标题里的「署名 issue #N」/关单词（少见，`Fixes #21` 写在标题也算）。
 *   3. 标题裸 #N（旧约定 `[pi] #657 关单`，也是 `修一处 #945`）、`（原 #305 重开版）` 这类。
 *      标题先剥 `[chain:名#序号]`。
 *
 * 正文署名必须压过标题随手引用。PR #1159 标题「堵 #565 假会话泄漏」、正文「署名 issue #1152」，
 * 旧规则标题优先 → 去查已关闭、没有 reviewer/ 的 #565，自动补标也补不上
 * （#565 连 model/ 都没有），交卷可合的 PR 一直挂着。用户拍板：不要给标题里无关的 #565 补标签。
 *
 * **第 3 级退路的危险只对「还开着的单」成立**（2026-09-13 实咬 #1051，别再叠词表规则）：
 * 黑名单式的「说明性介词」（的/基于/挂回/根因…）试过，把 #1126→#1125、#1123→#1121 这些
 * 真署名一起丢了，按 `patch-stacking-is-two-strikes` 停手——不再给同一判据叠第二层。
 * 改成先看事实：把 14 张走退路的 PR 逐个对目标单的真实状态核一遍，只有 2 张是误判
 * （#1216→#1143、#1096→#1051），且**两张的目标单都是 OPEN**；另外 12 张目标单全部
 * CLOSED/MERGED（#1125/#1122/#1121/#1117/#931/#880/#800/#762/#708/#715…），即那些退路本来是对的。
 * 所以退路本身不用改口径，改的是**「拦谁」**：已关闭的单被标题误捞无害（它已经关了，
 * 关单与派工都不再动它，历史 PR 本就该这么归因）；**只有目标单还开着时，退路才必须收严**。
 * 收严的口径 = 不猜：拿不准就不返号，由调用方按「没有署名单号」处理（拒绝/跳过，不污染）。
 *
 * 两个真实消费方都在「开着的单」的语境里，所以 `openIssues` 不是可选装饰：
 *   · `otherOpenSignedPrs`（关单前查「还有没有别的 OPEN 署名 PR」）——调用点已确认 issue 是 OPEN；
 *   · `ready-queue-check`（判「这张已消歧的单有没有在途 PR」）——手里就是开放单名单。
 * 传不进来时退回原行为，是为了老夹具不炸；**新调用点必须传**，见 `tests/close-issue.test.js` 与 `tests/ready-queue.test.js`。
 *
 * 挡掉 #0：issue 号从 1 起，`#0` 一定是别的东西被误当成了单号。
 */
export function attributedIssueNumber(pr, { openIssues = null } = {}) {
  const bodyNums = attributedIssueNumbers((pr && pr.body) || '').filter((n) => n > 0);
  if (bodyNums.length) return bodyNums[0];
  const title = String((pr && pr.title) || '').replace(/\[chain:[^\]]*\]/gi, '');
  const titleExplicit = attributedIssueNumbers(title).filter((n) => n > 0);
  if (titleExplicit.length) return titleExplicit[0];
  const t = title.match(/#(\d+)/);
  if (!t || !(Number(t[1]) > 0)) return null;
  const n = Number(t[1]);
  // 没有开放单名单（老调用方/夹具）→ 保持原行为，不凭猜收严。
  if (!openIssues || typeof openIssues.has !== 'function') return n;
  // 目标单还开着，而这条号只来自标题裸匹配（第 3 级）——退路够不着判据，不返号。
  return openIssues.has(n) ? null : n;
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

/**
 * 同一张单还有别的 OPEN 署名 PR 时，本张合了也不许关（#1065：#1075 合了，#1104 还开着，定时器又把单关了）。
 * pr list 没查成 → ok:false，调用方不许当成「没有别的 PR」。
 */
export function otherOpenSignedPrs({ issue, exceptPr, runGh } = {}) {
  const n = Number(issue);
  if (!Number.isInteger(n) || n <= 0) return { ok: false, error: 'otherOpenSignedPrs 没给有效 issue' };
  if (typeof runGh !== 'function') return { ok: false, error: 'otherOpenSignedPrs 没拿到 gh（没查成）' };
  const r = runGh(['pr', 'list', '--state', 'open', '--limit', '100', '--json', 'number,title,body']);
  if (!r.ok) return { ok: false, error: `gh pr list 失败：${r.error || '没查成'}` };
  if (!Array.isArray(r.json)) return { ok: false, error: 'gh pr list 不是数组（没查成）' };
  // 本函数**只在判「#n 已 MERGED 且全绿、要不要关掉」时被调**——调用点已确认 #n 是 OPEN。
  // 所以 #n 就是那张「还开着的单」：标题裸匹配够不着判据，别把「提到」当「认领」挡住关单
  // （2026-09-13 实咬：PR #1096 标题「挂回 #1051」会让 #1051 永远关不掉）。
  const openIssues = new Set([n]);
  const hits = [];
  for (const p of r.json) {
    const pn = Number(p && p.number);
    if (!pn || String(pn) === String(exceptPr)) continue;
    const nums = attributedIssueNumbers(`${p.title || ''}\n${p.body || ''}`);
    const titled = attributedIssueNumber(p, { openIssues });
    if (titled === n || nums.includes(n)) hits.push(pn);
  }
  return { ok: true, prs: hits };
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
export function hasCompletedChecklist(body) {
  let checked = 0, fence = null, comment = false;
  for (const raw of String(body || '').split(/\r?\n/)) {
    if (fence) {
      const close = raw.match(/^ {0,3}(`{3,}|~{3,})\s*$/);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) fence = null;
      continue;
    }
    const opening = !comment && raw.match(/^ {0,3}(`{3,}|~{3,})/);
    if (opening) { fence = opening[1]; continue; }
    let line = raw;
    for (;;) {
      if (comment) {
        const end = line.indexOf('-->');
        if (end < 0) { line = ''; break; }
        line = line.slice(end + 3); comment = false;
      }
      const start = line.indexOf('<!--');
      if (start < 0) break;
      const end = line.indexOf('-->', start + 4);
      if (end < 0) { line = line.slice(0, start); comment = true; break; }
      line = line.slice(0, start) + line.slice(end + 3);
    }
    const delimiter = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (delimiter) { fence = delimiter[1]; continue; }
    const item = line.match(/^\s*(?:[-*+]|\d+[.)])\s+\[([ xX])\]/);
    if (!item) continue;
    if (item[1] === ' ') return false;
    if (/^(?: {4}|\t)/.test(line)) continue; // Do not use an indented code example as completion proof.
    checked++;
  }
  return checked > 0 && !comment && !fence;
}

export function closeIssueForPr({ pr, runGh, writeIssue, dryRun = false, repo = 'thoerwink8/windsurf-dao' } = {}) {
  const number = String((pr && (pr.number ?? pr.pr)) ?? '');
  const issue = attributedIssueNumber(pr);
  if (!issue) return { ok: true, action: 'none', reason: '无署名单号', pr: number };
  const dec = closeDecision(pr);
  if (dec.action === 'none') return { ok: true, action: 'none', reason: dec.reason, pr: number };
  const iv = runGh(['issue', 'view', String(issue), '--json', 'state,url,labels,body']);
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
  if (dec.action === 'close' && labels.includes('统领单')) {
    const body = iv.json?.body;
    if (typeof body !== 'string') return { ok: false, action: 'none', issue, pr: number, error: '统领单验收清单未读取成功，不自动关闭' };
    if (!hasCompletedChecklist(body)) {
      return { ok: true, action: 'none', issue, pr: number, reason: '统领单验收清单尚未全部完成，单个 PR 合并不代表整项完成' };
    }
  }
  if (dec.action === 'reopen' && labels.includes('已顶替')) {
    return { ok: true, action: 'none', reason: `issue #${issue} 带「已顶替」标签（人工拍过），不弹回`, issue, pr: number };
  }
  const expectOpen = dec.action === 'close';
  if (expectOpen && String(issueState).toUpperCase() === 'CLOSED') return { ok: true, action: 'none', reason: `issue #${issue} 已关`, issue, pr: number };
  if (!expectOpen && String(issueState).toUpperCase() !== 'CLOSED') return { ok: true, action: 'none', reason: `issue #${issue} 未关(${issueState})，无需重开`, issue, pr: number };
  if (dec.action === 'close') {
    const others = otherOpenSignedPrs({ issue, exceptPr: number, runGh });
    if (!others.ok) {
      return { ok: false, action: 'close', error: `还有没有别的 OPEN 署名 PR 没查成：${others.error}（没查成不许关）`, issue, pr: number };
    }
    if (others.prs.length) {
      return {
        ok: true,
        action: 'none',
        reason: `还有 OPEN 署名 PR ${others.prs.map((p) => `#${p}`).join('、')}，本张合了也不关`,
        issue,
        pr: number,
      };
    }
  }
  if (dryRun) return { ok: true, action: dec.action, issue, pr: number, reason: dec.reason, dryRun: true };
  const verb = dec.action === 'close' ? 'close' : 'reopen';
  if (typeof writeIssue !== 'function') {
    return { ok: false, action: dec.action, error: `issue-gateway 没注入，不许退回裸 gh issue ${verb}`, issue, pr: number };
  }
  const op = writeIssue({
    action: verb === 'close' ? 'issue_close' : 'issue_reopen',
    repo,
    issue,
    host: 'close-issues',
    idempotency_key: `close-issues:${verb}:pr-${number}:issue-${issue}`,
    reason: verb === 'close' ? 'completed' : undefined,
  });
  if (!op || !op.ok) {
    return { ok: false, action: dec.action, error: `issue-gateway ${verb} #${issue} 失败：${op && op.error ? op.error : '没查成'}`, issue, pr: number };
  }
  return { ok: true, action: dec.action, issue, pr: number, reason: dec.reason };
}
