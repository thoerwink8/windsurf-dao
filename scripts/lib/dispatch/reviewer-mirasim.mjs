// scripts/lib/dispatch/reviewer-mirasim.mjs —— 审官流的 mirasim 路径（#880 卡 C）
//
// reviewer-create / worker-done 在 executor=mirasim 时走这里：不建 Orca 树 / 终端，改用
// mirasim-runtime 五动词——ensureWorkspace 建审官树、**读回 HEAD 与 PR head 对齐才起会话**
// （不审空气，#541 假审的根治），startSession 起审官会话（prompt = 审官任务书；模型按
// agentRoutes 映射到 mirasim agent，gpt-5.6-luna → codex relay）。
//
// 判定落地不发明第二种协议（#807 判定行协议已删）：审官仍用 `gh-as reviewer -- pr review
// --approve|--request-changes` 落 GitHub review 状态，这就是机器可读的「判定行」。本模块的
// readReviewVerdict 以 GitHub review 状态为主判据、会话正文为次级证据。
//
// 分层：judge* / parse* / read* 是纯判官，只吃入参；mirasim* 是编排，IO（runtime / gh /
// readTreeHead / registry）全注入，测试不碰真服务。跨厂闸复用 assertCrossVendor（照旧）。

import { analyzeGithubReviews } from '../review-state.mjs';
import { assertCrossVendor } from '../reviewer-vendor-gate.mjs';
import { listPrReviews } from './worker-done.mjs';
import { judgeAgentRoute } from '../executor-binding.mjs';
import { assessPrMergeable } from './git.mjs';

/** readSession 回的 phase 里代表「这条会话已经废了」的那几个。废了才准新建，别的一律复用。 */
const DEAD_PHASES = new Set(['error', 'failed', 'aborted', 'cancelled', 'canceled']);

// ── 纯判官 ────────────────────────────────────────────────────────────────────

/** 读回审官树 HEAD 与 PR head oid 对不上 → 拒起会话（审空气的根治）。 */
export function judgeReviewerHead({ treeHead, expectedOid } = {}) {
  const got = treeHead == null ? '' : String(treeHead).trim();
  const want = expectedOid == null ? '' : String(expectedOid).trim();
  if (!want) return { ok: false, error: '没拿到 PR head oid（没查成，不起会话）' };
  if (!got) return { ok: false, error: '读不回审官树 HEAD（没查成，不起会话）' };
  // 允许一方是另一方的前缀（短 sha 与全 sha），否则一律判不符。
  if (got !== want && !got.startsWith(want) && !want.startsWith(got)) {
    return {
      ok: false,
      error: `审官树 HEAD ${got.slice(0, 12)} 与 PR head ${want.slice(0, 12)} 对不上——拒起会话（不审空气）`,
      treeHead: got, expectedOid: want,
    };
  }
  return { ok: true, treeHead: got, expectedOid: want };
}

/**
 * 返工轮：审官树该不该同步到 PR 新 head，以及能不能同步。
 *
 * 帅位 2026-09-04 实咬：PR #884 返工变基后审官树还停在首轮 oid，没有任何动作会推它，
 * 于是 `worker-done --executor mirasim` 每次都被 HEAD 闸拒（`rework:head`），要人手
 * `git reset --hard`。闸本身是对的，缺的是同步——所以这里只判「同步」还是「没查成」，
 * **绝不放宽 judgeReviewerHead 那道闸**：同步完还要再读回一次 HEAD 重判。
 *
 *   action='noop'     —— 已对齐，什么都不用做
 *   action='sync'     —— 读回了 HEAD 但停在旧 oid，可同步（reset 到 expectedOid）
 *   action='unscanned' —— PR head 没拿到 / 树 HEAD 读不回，同步无从下手，只能报没查成
 */
export function judgeReviewTreeSync({ treeHead, expectedOid } = {}) {
  const gate = judgeReviewerHead({ treeHead, expectedOid });
  if (gate.ok) return { ok: true, action: 'noop', treeHead: gate.treeHead, expectedOid: gate.expectedOid };
  const got = treeHead == null ? '' : String(treeHead).trim();
  const want = expectedOid == null ? '' : String(expectedOid).trim();
  if (!want || !got) return { ok: false, action: 'unscanned', error: gate.error };
  return { ok: false, action: 'sync', from: got, to: want, error: gate.error };
}

/**
 * 一 PR 一审官：登记里已有会话时该复用还是新建。
 *
 * 判据方向是 fail-closed 向「不重复烧额度」：只有**确认**登记缺失或会话已废才新建；
 * 会话状态没查成（view=null / 只读到会话清单）一律复用——把「没查成」当成「没有会话」
 * 就是重复起会话的那条路（审官第 2 条实咬：worker-done 在起会话后重试会再起一个）。
 *
 * @param record 登记记录（defaultReviewerRegistry.read().record）
 * @param view   runtime.readSession(sessionKey) 的返回；没查就传 null
 * @param force  人工 --force：明说要另起一个
 */
export function judgeReviewerSessionReuse({ record, view, force } = {}) {
  if (force === true) return { reuse: false, checked: false, why: '--force：人工要求另起审官会话' };
  const key = record && record.sessionKey ? String(record.sessionKey).trim() : '';
  if (!key) return { reuse: false, checked: false, why: '登记里没有 sessionKey（确认缺失）→ 可新建' };
  if (view == null) {
    return { reuse: true, sessionKey: key, checked: false, why: '会话状态没查成，按登记复用（不许把没查成当成没有会话去重复烧额度）' };
  }
  if (view.missing === true) {
    return { reuse: false, sessionKey: key, checked: true, why: `会话 ${key} 服务端查不到，登记失效 → 可新建：${view.why || ''}`.trim() };
  }
  const phase = view.phase == null ? '' : String(view.phase).trim().toLowerCase();
  if (phase && DEAD_PHASES.has(phase)) {
    return { reuse: false, sessionKey: key, checked: true, why: `会话 ${key} phase=${phase}（已废）→ 可新建` };
  }
  return { reuse: true, sessionKey: key, checked: true, phase: phase || null, why: `登记里有在役会话 ${key}，复用（一 PR 一审官）` };
}

/**
 * 审官任务书的 merge-policy 必须来自原派工，不许硬编码 auto。
 * policyPlan 就是 resolveReviewerMergePolicy 的返回（显式旗标 > 账本 > 卡备注 > 回退 auto）。
 * 读不出合法策略 → 当场拒渲染（宁可不派，也不给审官注入错的合并边界）。
 *
 * @param render buildReviewerInject（注入，纯函数层不 import 模板 IO）
 */
export function buildMirasimReviewerPrompts({
  pr, issue, soldierDispatchId, policyPlan, render,
} = {}) {
  if (typeof render !== 'function') return { ok: false, error: '要注入 render（buildReviewerInject）' };
  if (!pr) return { ok: false, error: '要 pr' };
  if (!policyPlan || policyPlan.ok === false) {
    return { ok: false, error: `merge-policy 没定成，拒渲染审官任务书：${(policyPlan && policyPlan.error) || '没查成'}` };
  }
  const policy = policyPlan.mergePolicy;
  if (policy !== 'auto' && policy !== 'manual') {
    return { ok: false, error: `merge-policy 只认 auto|manual，实际 ${policy == null ? '空' : policy}——拒渲染（不许硬编码 auto）` };
  }
  const reason = policy === 'manual' ? (policyPlan.mergeReason || null) : null;
  if (policy === 'manual' && !reason) {
    return { ok: false, error: 'm=manual 必须带 r=<原因>，否则审官看不出为什么要人工合并' };
  }
  const common = {
    issue: issue || null,
    pr: String(pr),
    soldierDispatchId: soldierDispatchId != null ? String(soldierDispatchId) : '',
    mergePolicy: policy,
    mergeReason: reason,
    fallbackReason: policyPlan.fallbackReason || null,
    executor: 'mirasim',
  };
  try {
    return {
      ok: true,
      mergePolicy: policy,
      mergeReason: reason,
      source: policyPlan.source || null,
      prompt: render({ ...common, spec: `按审官任务书审 PR #${pr}` }),
      reworkPrompt: render({ ...common, spec: `返工完成，复审 PR #${pr} 最新 HEAD` }),
    };
  } catch (e) {
    return { ok: false, error: `审官任务书渲染失败：${String(e?.message || e)}` };
  }
}

/**
 * 会话正文里的判定行（次级证据）。审官落判定主路是 gh-as reviewer 发 review，正文常回显判词。
 * 认 review 状态词（APPROVED / CHANGES_REQUESTED 及其变体、--approve / --request-changes）
 * 与中文判绿 / 判红。两种都出现时按**最后出现**的为准（回显命令再回显结果）。
 */
export function parseSessionVerdict(text) {
  const s = String(text || '');
  const redRe = /CHANGES[_\s-]?REQUESTED|REQUEST[_\s-]?CHANGES|--request-changes|判红|判定[:：]?\s*红/gi;
  const greenRe = /\bAPPROVED\b|--approve\b|\bAPPROVE\b|判绿|判定[:：]?\s*绿/gi;
  let lastRed = -1;
  let lastGreen = -1;
  let m;
  while ((m = redRe.exec(s))) lastRed = m.index;
  while ((m = greenRe.exec(s))) lastGreen = m.index;
  if (lastRed === -1 && lastGreen === -1) return { found: false, verdict: null };
  const verdict = lastRed > lastGreen ? 'red' : 'green';
  return { found: true, verdict, at: Math.max(lastRed, lastGreen) };
}

/**
 * 判定汇总：GitHub review 状态为主判据（机器可读），会话正文为次级。
 * 两者都没有 → {ok:false}「没查成」，不许把「没读到判定」说成「判了」。
 */
export function readReviewVerdict({ reviews, sessionText } = {}) {
  const gh = analyzeGithubReviews(reviews);
  if (gh.scanned && (gh.latestGreen || gh.latestRed)) {
    return {
      ok: true,
      verdict: gh.latestGreen ? 'green' : 'red',
      via: 'github', partial: false, github: gh,
    };
  }
  const say = parseSessionVerdict(sessionText);
  if (say.found) {
    return {
      ok: true, verdict: say.verdict, via: 'session', partial: true, github: gh,
      why: '只在会话正文里读到判定行，GitHub 还没有判别态 review（次级证据，别当已判绿合并）',
    };
  }
  return {
    ok: false, verdict: null, scanned: gh.scanned, github: gh,
    why: '既没读到 GitHub review 判别态，也没在会话正文里找到判定行（没查成）',
  };
}

// ── 编排（IO 全注入） ─────────────────────────────────────────────────────────

function readPrHead(gh, pr) {
  const r = gh(['pr', 'view', String(pr), '--json', 'headRefName,headRefOid,mergeable']);
  if (!r.ok) return { ok: false, error: `gh 读 PR #${pr} 失败（没查成）：${r.error}` };
  let j;
  try { j = JSON.parse(r.out); }
  catch { return { ok: false, error: `gh 读 PR #${pr} 返回非 JSON` }; }
  if (!j || !j.headRefName || !j.headRefOid) {
    return { ok: false, error: `gh 读 PR #${pr} 缺 headRefName/headRefOid` };
  }
  return { ok: true, headRefName: j.headRefName, expectedOid: j.headRefOid, mergeable: j.mergeable ?? null };
}

/**
 * reviewer-create 的 mirasim 路径：跨厂闸 → 读 PR head → 建审官树 → 读回 HEAD 对齐 →
 * 起审官会话。任何一步没查成/被拒都返回 {ok:false, stage}，绝不静默往下走。
 *
 * 注入依赖：
 *   runtime      —— mirasim-runtime.createRuntime() 或假 runtime（ensureWorkspace/startSession）
 *   gh           —— ghRunner（role reviewer）
 *   readTreeHead —— (treePath) => 该树当前 HEAD 的 sha（默认 git -C <path> rev-parse HEAD）
 *   prepareRef   —— 可选：(repo, branch) => 把 origin/<branch> 取到本地（默认 git fetch）
 *   syncTree     —— 可选：(treePath, oid) => 把复用的旧审官树推到 PR 新 head（返工轮要）
 *   prompt       —— 审官会话的启动 prompt（审官任务书 inject 文本，调用方渲染）
 */
export async function mirasimReviewerCreate({
  runtime, gh, readTreeHead, prepareRef, syncTree,
  pr, repo, reviewerModel, workerModel, models, mirasimPolicy, prompt, reviewBranch,
  now = () => Date.now(),
} = {}) {
  if (!runtime || typeof runtime.ensureWorkspace !== 'function' || typeof runtime.startSession !== 'function') {
    return { ok: false, stage: 'inputs', error: 'mirasimReviewerCreate 要注入 runtime（含 ensureWorkspace/startSession）' };
  }
  if (typeof gh !== 'function') return { ok: false, stage: 'inputs', error: '要注入 gh 执行器' };
  if (typeof readTreeHead !== 'function') return { ok: false, stage: 'inputs', error: '要注入 readTreeHead' };
  if (!pr) return { ok: false, stage: 'inputs', error: '要 --pr' };
  if (!repo) return { ok: false, stage: 'inputs', error: '要 repo 路径' };
  if (!reviewerModel || !workerModel) return { ok: false, stage: 'inputs', error: '要 reviewerModel 与 workerModel（跨厂闸要）' };
  if (!prompt || !String(prompt).trim()) return { ok: false, stage: 'inputs', error: '要审官会话 prompt（任务书）' };

  // 1. 跨厂闸（照旧）：同厂当场拒，不静默换厂。
  const vendorGate = assertCrossVendor({ workerId: workerModel, reviewerId: reviewerModel, models });
  if (!vendorGate.ok) return { ok: false, stage: 'vendor', error: vendorGate.error, vendorGate };

  // 2. agent 路由：模型 → mirasim agent（gpt → codex relay）。查不到就拒派。
  const route = judgeAgentRoute(reviewerModel, mirasimPolicy);
  if (!route.ok) return { ok: false, stage: 'route', error: route.error, route };

  // 3. 读 PR head。
  const head = readPrHead(gh, pr);
  if (!head.ok) return { ok: false, stage: 'pr-read', error: head.error };

  // 3b. mergeable 硬闸（复用 orca 路径同一判据 assessPrMergeable，#575 ⑦）：
  //     UNKNOWN 不是绿、CONFLICTING 要先 rebase。**建树/起会话之前**就拒，别让审官白审。
  const mergeable = assessPrMergeable(head.mergeable);
  if (!mergeable.ok) {
    return { ok: false, stage: 'mergeable', error: mergeable.error, mergeable, expectedOid: head.expectedOid, headRefName: head.headRefName };
  }

  // 审官树用独立分支停在 PR head OID（等同 orca「新树停在 PR head」），避开「PR 分支已被
  // 别的树 checkout」的撞车；不给 reviewBranch 才退回直接用 PR 分支名。
  const branch = reviewBranch || head.headRefName;

  // 4. 可选：把 origin/<PR 分支> 取到本地并把 reviewBranch 建/移到 PR head OID，addWorktree 才检得出。
  if (typeof prepareRef === 'function') {
    const pre = await prepareRef(repo, head.headRefName, head.expectedOid, branch);
    if (pre && pre.ok === false) return { ok: false, stage: 'fetch', error: pre.error || 'fetch/建审官分支失败（没查成）' };
  }

  // 5. 建审官树。
  let ws;
  try { ws = await runtime.ensureWorkspace(repo, branch); }
  catch (e) { return { ok: false, stage: 'ensure', error: `建审官树没查成：${String(e?.message || e)}`, code: e?.code }; }
  const treePath = ws && ws.path ? ws.path : null;
  if (!treePath) return { ok: false, stage: 'ensure', error: '建审官树没返回 path（没查成）', ws };

  // 6. 读回 HEAD 对齐——对不上先试同步（返工轮复用旧树的常态），同步完**再读回一次**重判；
  //    还对不上就**不起会话**。这道闸一步没放宽：同步只是多给一次机会，不是绕过。
  let treeHead;
  try { treeHead = await readTreeHead(treePath); }
  catch (e) { return { ok: false, stage: 'head', error: `读回审官树 HEAD 失败（没查成）：${String(e?.message || e)}`, treePath }; }
  let headOk = judgeReviewerHead({ treeHead, expectedOid: head.expectedOid });
  let treeSync = null;
  if (!headOk.ok) {
    const plan = judgeReviewTreeSync({ treeHead, expectedOid: head.expectedOid });
    if (plan.action !== 'sync') {
      return { ok: false, stage: 'head', error: headOk.error, treePath, treeHead: headOk.treeHead, expectedOid: head.expectedOid, ws };
    }
    if (typeof syncTree !== 'function') {
      return {
        ok: false, stage: 'head-sync', treePath, treeHead: plan.from, expectedOid: plan.to, ws,
        error: `审官树停在旧 HEAD ${plan.from.slice(0, 12)}，PR head 已到 ${plan.to.slice(0, 12)}，但没注入 syncTree，推不动（没查成，不起会话）`,
      };
    }
    let synced;
    try { synced = await syncTree(treePath, plan.to); }
    catch (e) { synced = { ok: false, error: String(e?.message || e) }; }
    if (!synced || synced.ok !== true) {
      // fail-visible：同步不成就明说，不静默继续、也不放宽 HEAD 闸。
      return {
        ok: false, stage: 'head-sync', treePath, treeHead: plan.from, expectedOid: plan.to, ws, sync: synced || null,
        error: `把审官树同步到 PR head ${plan.to.slice(0, 12)} 没成（没查成，不起会话）：${(synced && synced.error) || '没给原因'}`,
      };
    }
    try { treeHead = await readTreeHead(treePath); }
    catch (e) { return { ok: false, stage: 'head', error: `同步后读回审官树 HEAD 失败（没查成）：${String(e?.message || e)}`, treePath }; }
    headOk = judgeReviewerHead({ treeHead, expectedOid: head.expectedOid });
    if (!headOk.ok) {
      return { ok: false, stage: 'head', error: `同步后仍对不上：${headOk.error}`, treePath, treeHead: headOk.treeHead, expectedOid: head.expectedOid, ws, sync: synced };
    }
    treeSync = { done: true, from: plan.from, to: plan.to, ...synced };
  }

  // 7. 起审官会话。
  //   注：mirasim 服务端只有 claude/codex/pi 三个 agent；具体上游模型由执行体自己配置决定。
  //   这里把审官模型 id 当 model 传进去**尝试**覆盖——0.0.282 认不认是实测题（见 PR 正文
  //   「选型脱节」：真机看账本 model= 那行）。认→精确；不认→选型退化为「只选族/agent」。
  let sess;
  try { sess = await runtime.startSession({ agent: route.agent, workdir: treePath, prompt, model: reviewerModel, clientRef: `dao-review-${pr}-${now()}` }); }
  catch (e) { return { ok: false, stage: 'start', error: `起审官会话没查成：${String(e?.message || e)}`, code: e?.code, treePath }; }
  if (!sess || !sess.sessionKey) return { ok: false, stage: 'start', error: '起审官会话没返回 sessionKey（没查成）', treePath, sess };

  return {
    ok: true,
    stage: 'started',
    sessionKey: sess.sessionKey,
    taskId: sess.taskId || null,
    startedAt: sess.startedAt || now(),
    agent: route.agent,
    mode: route.mode,
    attemptedModel: reviewerModel,
    treePath,
    reviewBranch: branch,
    headRefName: head.headRefName,
    expectedOid: head.expectedOid,
    treeHead: headOk.treeHead,
    mergeable: mergeable.mergeable,
    treeSync,
    vendorGate,
    route,
  };
}

// ── PR→会话 登记（rework 轮找回审官会话） ─────────────────────────────────────

/** 默认登记 IO：_flow/mirasim/reviewer-<pr>.json。测试注入内存版。 */
export function defaultReviewerRegistry({ readFile, writeFile, mkdir, join, flowDir } = {}) {
  const dir = flowDir;
  const path = (pr) => join(dir, `reviewer-${pr}.json`);
  return {
    read(pr) {
      try {
        const t = readFile(path(pr));
        const j = JSON.parse(t);
        return { ok: true, record: j };
      } catch (e) {
        return { ok: false, missing: true, why: `没有 PR ${pr} 的审官会话登记：${String(e?.message || e)}` };
      }
    },
    write(pr, record) {
      try {
        mkdir(dir);
        writeFile(path(pr), JSON.stringify(record, null, 2));
        return { ok: true, path: path(pr) };
      } catch (e) {
        return { ok: false, error: `写审官会话登记失败：${String(e?.message || e)}` };
      }
    },
  };
}

/**
 * worker-done 的 mirasim 路径：定完工轮 → 首审/无会话则起审官会话；返工且有会话则
 * interact（有等答问题）或新起一针注入返工。判定仍靠 GitHub review（收口官核）。
 *
 * 注入依赖同 mirasimReviewerCreate，另加 registry（PR→会话登记）与 reworkPrompt（返工 prompt）。
 */
export async function mirasimWorkerDone({
  runtime, gh, readTreeHead, prepareRef, syncTree, registry,
  pr, repo, prompt, reworkPrompt, reworkAnswer, reviewBranch,
  reviewerModel, workerModel, models, mirasimPolicy,
  round, force, now = () => Date.now(),
} = {}) {
  if (typeof gh !== 'function') return { ok: false, stage: 'inputs', error: '要注入 gh 执行器' };
  if (!pr) return { ok: false, stage: 'inputs', error: '要 --pr' };
  if (!registry || typeof registry.read !== 'function' || typeof registry.write !== 'function') {
    return { ok: false, stage: 'inputs', error: '要注入 registry（read/write）' };
  }

  // 定轮：给了 round 用给的，否则按已有 review 条数判（有=返工，无=首审）。
  let theRound = round;
  let reviewCount = null;
  if (!theRound) {
    const listed = listPrReviews({ pr, runGh: gh });
    if (!listed.ok) return { ok: false, stage: 'round', error: `定完工轮没查成：${listed.error}` };
    reviewCount = listed.count;
    theRound = listed.count > 0 ? 'rework' : 'first';
  }

  const existing = registry.read(pr);
  const record = existing.ok ? existing.record : null;
  const sessionKey = record && record.sessionKey ? String(record.sessionKey) : '';

  // 登记里已有会话时先判复用（一 PR 一审官）。审官第 2 条实咬：原来 `first || !hasSession`
  // 让「起完会话后重试 worker-done」再起一个会话，重复烧额度。
  let reuse = { reuse: false, checked: false, why: '登记里没有 sessionKey（确认缺失）→ 可新建' };
  if (sessionKey) {
    const peek = await peekReviewerSession(runtime, sessionKey);
    reuse = judgeReviewerSessionReuse({ record, view: peek.view, force });
    reuse.view = peek.view;
    if (peek.why) reuse.peekWhy = peek.why;
  }

  // 首审轮 + 已有在役会话 → 复用，不再起第二个（幂等重试的正解）。
  if (theRound === 'first' && reuse.reuse) {
    return {
      ok: true, action: 'reused', round: theRound, reviewCount,
      sessionKey: reuse.sessionKey, reuse, session: null,
      why: reuse.why,
    };
  }

  // 首审，或返工但登记里没有可复用会话 → 起新审官会话。
  if (theRound === 'first' || !reuse.reuse) {
    const created = await mirasimReviewerCreate({
      runtime, gh, readTreeHead, prepareRef, syncTree,
      pr, repo, reviewerModel, workerModel, models, mirasimPolicy, reviewBranch,
      prompt: theRound === 'rework' ? (reworkPrompt || prompt) : prompt,
      now,
    });
    if (!created.ok) return { ...created, stage: `create:${created.stage}`, round: theRound, reviewCount, reuse };
    const w = writeReviewerRecord({
      registry, pr, created, round: theRound, prevSessionKey: sessionKey || null, now,
    });
    if (!w.ok) return { ...w, round: theRound, reviewCount, session: created, reuse };
    return {
      ok: true, action: sessionKey ? 'reworked-new' : 'created',
      round: theRound, reviewCount, session: created, registryWrite: w.write, reuse,
    };
  }

  // 返工且有在役会话：审官仍在那棵首轮的树里，**先把树同步到 PR 新 head**，再决定
  // interact 还是新起一针。不同步就 interact = 让审官审旧代码（审官第 1 条 + 帅位实咬）。
  const prHead = readPrHead(gh, pr);
  if (!prHead.ok) return { ok: false, stage: 'rework:pr-read', error: prHead.error, round: theRound, reviewCount, sessionKey };
  const mergeable = assessPrMergeable(prHead.mergeable);
  if (!mergeable.ok) {
    return { ok: false, stage: 'rework:mergeable', error: mergeable.error, mergeable, round: theRound, reviewCount, sessionKey };
  }
  const treePath = record.treePath || null;
  if (!treePath) {
    return {
      ok: false, stage: 'rework:tree', round: theRound, reviewCount, sessionKey,
      error: `登记里没有 treePath，核不出审官在哪棵树（没查成，不许在没核过的树上复审）`,
    };
  }
  let treeHead;
  try { treeHead = await readTreeHead(treePath); }
  catch (e) {
    return { ok: false, stage: 'rework:tree', error: `读回审官树 HEAD 失败（没查成）：${String(e?.message || e)}`, treePath, round: theRound, reviewCount, sessionKey };
  }
  const plan = judgeReviewTreeSync({ treeHead, expectedOid: prHead.expectedOid });
  let treeSync = { done: false, action: plan.action, from: plan.from || treeHead, to: prHead.expectedOid };
  if (plan.action === 'unscanned') {
    return { ok: false, stage: 'rework:tree', error: plan.error, treePath, round: theRound, reviewCount, sessionKey };
  }
  if (plan.action === 'sync') {
    if (typeof prepareRef === 'function') {
      const pre = await prepareRef(repo, prHead.headRefName, prHead.expectedOid, reviewBranch || prHead.headRefName);
      if (pre && pre.ok === false) {
        return { ok: false, stage: 'rework:fetch', error: pre.error || 'fetch 新 head 失败（没查成）', treePath, round: theRound, reviewCount, sessionKey };
      }
    }
    if (typeof syncTree !== 'function') {
      return {
        ok: false, stage: 'rework:tree-sync', treePath, round: theRound, reviewCount, sessionKey,
        error: `审官树停在旧 HEAD ${plan.from.slice(0, 12)}，PR head 已到 ${plan.to.slice(0, 12)}，但没注入 syncTree，推不动（没查成，不复审旧树）`,
      };
    }
    let synced;
    try { synced = await syncTree(treePath, plan.to); }
    catch (e) { synced = { ok: false, error: String(e?.message || e) }; }
    if (!synced || synced.ok !== true) {
      return {
        ok: false, stage: 'rework:tree-sync', treePath, round: theRound, reviewCount, sessionKey, sync: synced || null,
        error: `把审官树同步到 PR head ${plan.to.slice(0, 12)} 没成（没查成，不复审旧树）：${(synced && synced.error) || '没给原因'}`,
      };
    }
    // 读回自证：同步完再读一次 HEAD 重判，对不上一律拒（闸没放宽）。
    try { treeHead = await readTreeHead(treePath); }
    catch (e) {
      return { ok: false, stage: 'rework:tree', error: `同步后读回审官树 HEAD 失败（没查成）：${String(e?.message || e)}`, treePath, round: theRound, reviewCount, sessionKey };
    }
    const after = judgeReviewerHead({ treeHead, expectedOid: prHead.expectedOid });
    if (!after.ok) {
      return { ok: false, stage: 'rework:tree-sync', error: `同步后仍对不上：${after.error}`, treePath, treeHead, round: theRound, reviewCount, sessionKey, sync: synced };
    }
    treeSync = { done: true, action: 'sync', from: plan.from, to: plan.to, ...synced };
  }

  // 树已在新 head：登记里的 expectedOid 也要跟上（帅位实咬：它还是首轮的值，下一轮又对不上）。
  const refreshed = registry.write(pr, {
    ...record,
    pr: String(pr), sessionKey, treePath,
    round: theRound, headRefName: prHead.headRefName, expectedOid: prHead.expectedOid,
    treeHead, ts: now(),
  });
  if (!refreshed || refreshed.ok !== true) {
    return {
      ok: false, stage: 'rework:registry', round: theRound, reviewCount, sessionKey, treePath, treeSync,
      registryWrite: refreshed || null,
      error: `审官树已同步到 ${String(prHead.expectedOid).slice(0, 12)}，但刷新登记 expectedOid 失败（fail-closed，别当返工已交卷）：${(refreshed && refreshed.error) || '写盘没回 ok'}`,
    };
  }

  // 树对齐了才轮到「怎么通知审官」：有等答问题就 interact，没有就新起一针注入返工。
  if (typeof runtime?.readSession === 'function' && typeof runtime?.interact === 'function') {
    let view = reuse.view;
    if (view == null) view = (await peekReviewerSession(runtime, sessionKey)).view;
    const pending = view && view.via === 'snapshot' && view.snapshot
      && Array.isArray(view.snapshot.interactions)
      && view.snapshot.interactions.some(x => x && x.promptId && !x.answeredAt && x.answered !== true && x.done !== true);
    if (pending) {
      let r = null;
      try { r = await runtime.interact(sessionKey, reworkAnswer || '返工完成，请复审最新 HEAD'); }
      catch (e) { r = { ok: false, why: String(e?.message || e) }; }
      if (r && r.ok) {
        return {
          ok: true, action: 'reworked-interact', round: theRound, reviewCount, sessionKey,
          interact: r, treePath, treeHead, expectedOid: prHead.expectedOid, treeSync, reuse,
        };
      }
      // interact 没成 → 退到新起一针（不静默）。
    }
  }
  const created = await mirasimReviewerCreate({
    runtime, gh, readTreeHead, prepareRef, syncTree,
    pr, repo, reviewerModel, workerModel, models, mirasimPolicy, reviewBranch,
    prompt: reworkPrompt || prompt, now,
  });
  if (!created.ok) return { ...created, stage: `rework:${created.stage}`, round: theRound, reviewCount, treeSync };
  const w = writeReviewerRecord({ registry, pr, created, round: theRound, prevSessionKey: sessionKey, now });
  if (!w.ok) return { ...w, round: theRound, reviewCount, session: created, treeSync };
  return { ok: true, action: 'reworked-new', round: theRound, reviewCount, session: created, registryWrite: w.write, treeSync };
}

/**
 * 探一眼会话状态，专门把两件事分开：
 *  - readSession **返回** {missing:true} —— 服务端答了「不认识这条会话」= 确认失效；
 *  - readSession **抛错**（连不上服务端 / 契约不符）—— 没查成，绝不许当成会话失效，
 *    否则服务端一抽风就给同一个 PR 起第二个审官（审官第 2 条的反面坑）。
 * 后者回 view:null，交给 judgeReviewerSessionReuse 走「没查成 → 复用」。
 */
export async function peekReviewerSession(runtime, sessionKey) {
  if (typeof runtime?.readSession !== 'function') {
    return { view: null, why: 'runtime 没有 readSession，会话状态没查成' };
  }
  try { return { view: await runtime.readSession(sessionKey), why: null }; }
  catch (e) {
    return { view: null, why: `读会话抛错，状态没查成（不当成会话失效）：${String(e?.message || e)}` };
  }
}

/**
 * 登记写盘 fail-closed（审官第 3 条实咬）：write() 回 {ok:false} 时原来仍报 ok:true/created，
 * 于是重试会把「没持久化」当成「没有 session」再起第二个会话。这里把写失败翻成 ok:false，
 * 并把已起的 sessionKey 一并交出——人能顺着这个 key 收摊，不至于起了会话又丢了线头。
 */
function writeReviewerRecord({ registry, pr, created, round, prevSessionKey, now }) {
  const rec = {
    pr: String(pr), sessionKey: created.sessionKey, agent: created.agent, treePath: created.treePath,
    round, headRefName: created.headRefName, expectedOid: created.expectedOid,
    treeHead: created.treeHead || null,
    ...(prevSessionKey ? { prevSessionKey } : {}),
    ts: now(),
  };
  const w = registry.write(pr, rec);
  if (w && w.ok === true) return { ok: true, write: w };
  return {
    ok: false, stage: 'registry', write: w || null,
    sessionKey: created.sessionKey, treePath: created.treePath,
    error: `审官会话已起（sessionKey=${created.sessionKey}）但写登记失败，判失败（fail-closed，不许当 created）：${(w && w.error) || '写盘没回 ok'}`,
  };
}
