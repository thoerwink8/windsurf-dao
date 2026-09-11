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
import { EXECUTION_FINISHED, sessionStateOf } from '../execution-states.mjs';
import { assertCrossVendor } from '../reviewer-vendor-gate.mjs';
import { isCapacityDeath } from '../dianjiangtai-reviewer-slot.mjs';
import { listPrReviews } from './worker-done.mjs';
import { judgeAgentRoute } from '../executor-binding.mjs';
import { assessPrMergeable, fetchPrMergeable, resolveMergeable } from './git.mjs';
import { repoPrKey } from './repo.mjs';

/**
 * readSession 回的 phase 里代表「这条会话**废了**、必须换一个」的那几个。
 *
 * 注意与 `EXECUTION_FINISHED` 的区别（别把两者混成一个）：
 * 终态 = 「结束了」；废了 = 「结束了但没干成事」。**done 是终态但不是废**——
 * 它把审完了，复用它是「一 PR 一审官」的本意；`judgeReviewerSessionReuse` 的用例
 * 明确钉着 `phase:'done' → reuse:true`。
 *
 * 2026-09-11：原来手打 5 个词（error/failed/aborted/cancelled/canceled），
 * **漏了 stopped / incomplete / gone / rejected**——那四个正是本机最常见的死法
 * （实测登记里 stopped 16 条、incomplete 1 条、gone 1 条、rejected 1 条）。
 * 漏判的后果不是「多起一个会话」，是**把 PR 锁死在一个死审官上**：
 * 判成「还能复用」→ 永远不新建 → 那个 PR 永远等不到判定。
 *
 * 所以从正典里**显式减去「干成了」的三个词**，而不是另抄一份清单——
 * 正典加新终态时这里自动跟上，不会再漂。
 */
const DEAD_PHASES = new Set([...EXECUTION_FINISHED].filter((p) => !['done', 'completed', 'complete'].includes(p)));

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
  // 状态词统一走正典。view 有**两种形状**：快照路给 phase（+incomplete 标记），
  // 清单路给 state/phase。各写一份兜底链必然漏（本晚的病），所以两处都经 sessionStateOf。
  const phase = sessionStateOf(view) || '';
  // #1056：incomplete 不是在役。phase=done 只说明那一轮结束了，
  // 会话自己已经卡死（Selected model is at capacity / 30 分钟计时）。复用 = 把 PR 锁死在死审官上。
  // 兜底 `view.incomplete === true`：快照路的 incomplete 标记比 phase 更权威（它标的是
  // 「收尾了但没跑完」），而那时 phase 可能已经是 done。
  if (view.incomplete === true || phase === 'incomplete') {
    return {
      reuse: false, sessionKey: key, checked: true,
      why: `会话 ${key} phase=incomplete（一轮卡死，不是在役）→ 可新建`,
    };
  }
  if (phase && DEAD_PHASES.has(phase)) {
    return { reuse: false, sessionKey: key, checked: true, why: `会话 ${key} phase=${phase}（已废）→ 可新建` };
  }
  // #1122：phase=done 但带着满载/看门狗死因，不是「审完了」——复用 = 把 PR 锁死在死审官上。
  // 空 error 仍复用：那才是正常完工，换厂例外口不是常开。
  if (isCapacityDeath(view.error)) {
    return {
      reuse: false, sessionKey: key, checked: true,
      why: `会话 ${key} 死于「${String(view.error).trim().slice(0, 60)}」→ 可新建（撞满载换厂）`,
    };
  }
  return { reuse: true, sessionKey: key, checked: true, phase: phase || null, why: `登记里有在役会话 ${key}，复用（一 PR 一审官）` };
}

/**
 * 满载/看门狗死会话必须另起，不依赖 requested 是否刚好等于下一位。
 *
 * `planReviewerOnCapacityDeath` 在「点名正好是下一位」时返回 switched:false。
 * 若另起只认 switched，锁内会把刚死的那位当成「并发抢锁已起过」复用掉。
 */
export function reviewerMustReplaceDead({ force, switched, deadError } = {}) {
  return force === true || switched === true || isCapacityDeath(deadError);
}

/**
 * 锁内复查：有 sessionKey 不等于「并发已起」。
 * 满载/看门狗死会话走同一套 judgeReviewerSessionReuse，不算 raced。
 */
export function judgeReviewerCreateRace({ forceNew, record, view } = {}) {
  if (forceNew === true) {
    return { raced: false, why: '必须另起（force / 换厂 / 满载死会话）' };
  }
  if (!record || !record.sessionKey) {
    return { raced: false, why: '锁内复查没有 sessionKey' };
  }
  const reuse = judgeReviewerSessionReuse({ record, view, force: false });
  if (reuse.reuse) {
    return { raced: true, record, sessionKey: reuse.sessionKey, why: reuse.why };
  }
  return { raced: false, why: reuse.why };
}

/**
 * 外层复用 + 锁内 raced 用同一份 forceNew。
 *
 * requested 正好是下一位时 switched=false，但满载死因仍必须另起。
 * 第二次 peek 失败（view=null）时，没 force 会按「没查成」复用死会话——
 * 所以 forceNew 认死因，不认 requested 变没变。
 */
export function decideReviewerCreateStart({ force, switched, deadError, record, view } = {}) {
  const forceNew = reviewerMustReplaceDead({ force, switched, deadError });
  const reuse = judgeReviewerSessionReuse({ record, view, force: forceNew });
  const race = judgeReviewerCreateRace({ forceNew, record, view });
  return {
    forceNew,
    reuse,
    race,
    start: reuse.reuse !== true && race.raced !== true,
  };
}

/**
 * 锁内：满载死会话不算 raced，必须走到 create（startSession）。
 * reviewer-create 的锁内块只调这一份，不许再手写 sessionKey 判断。
 */
export async function runLockedReviewerCreate({ forceNew, record, view, create } = {}) {
  if (typeof create !== 'function') {
    return { ok: false, error: '要注入 create（起审官会话）' };
  }
  const race = judgeReviewerCreateRace({ forceNew, record, view });
  if (race.raced) {
    return {
      ok: true,
      raced: true,
      outcome: 'reused',
      record,
      sessionKey: race.sessionKey || (record && record.sessionKey) || null,
      why: race.why,
    };
  }
  const created = await create();
  return { ok: true, raced: false, res: created };
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
  const profile = runtime.profileForModel?.(reviewerModel);
  const route = profile ? { ok: true, agent: profile.agent, mode: profile.route, family: profile.modelFamily, profileId: profile.id } : judgeAgentRoute(reviewerModel, mirasimPolicy);
  if (!route.ok) return { ok: false, stage: 'route', error: route.error, route };

  // 3. 读 PR head。
  const head = readPrHead(gh, pr);
  if (!head.ok) return { ok: false, stage: 'pr-read', error: head.error };

  // 3b. mergeable 硬闸（复用 orca 路径同一判据 assessPrMergeable，#575 ⑦）：
  //     UNKNOWN 不是绿、CONFLICTING 要先 rebase。**建树/起会话之前**就拒，别让审官白审。
  //     #1017：多字段 view 上 mergeable 常恒 UNKNOWN，未知态才单张只查 mergeable。
  const resolved = resolveMergeable(
    { number: pr, mergeable: head.mergeable },
    { viewMergeable: (n) => fetchPrMergeable(gh, n) },
  );
  const mergeable = assessPrMergeable(resolved.mergeable);
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
  catch (e) {
    // 门里的**背压**标记必须原样透出去（#1145 / #1085）：租约被占、渠道满员都带
    // detail.busy=true，它们不是「起审官失败」而是「这轮轮不到」。丢掉这个标记的后果是
    // 背压被当成失败去烧重试预算（drain 的 3 次上限），最后把 PR 判成认输——
    // 而实际上一个审官都还没起过。dao.mjs 那侧 `fail(res.error, {...res})` 会把这里的字段
    // 整份摊进 JSON，所以只要在这儿带上，调用方一行都不用改。
    const busy = e && e.detail && e.detail.busy === true;
    return {
      ok: false, stage: 'start',
      error: `起审官会话没查成：${String(e?.message || e)}`,
      code: e?.code, treePath,
      ...(busy ? {
        busy: true, reason: e.detail.reason || null,
        channel: e.detail.channel || null, holders: e.detail.holders || undefined,
      } : {}),
    };
  }
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

/** 默认登记 IO：~/.dao/mirasim/reviewer-<pr>.json（本仓）或 reviewer-<owner>__<name>__<pr>.json（跨仓）。测试注入内存版。 */
export function defaultReviewerRegistry({ readFile, writeFile, mkdir, readdir, join, flowDir } = {}) {
  const dir = flowDir;
  const loc = (pr, repo) => {
    const keyed = repoPrKey({ repo, pr });
    if (!keyed.ok) return keyed;
    return { ok: true, path: join(dir, `reviewer-${keyed.stem}.json`), keyed };
  };
  const parseStem = (name) => {
    const f = String(name || '');
    const m = /^reviewer-(?:([A-Za-z0-9_.-]+)__([A-Za-z0-9_.-]+)__(\d+)|(\d+))\.json$/.exec(f);
    if (!m) return null;
    if (m[4]) return { pr: m[4], repo: null };
    return { pr: m[3], repo: `${m[1]}/${m[2]}` };
  };
  return {
    /**
     * 全部登记（#1125 数在役审官要）。**读不了目录回 null，不回空数组**——
     * 「一条都没有」和「没读成」在下游是两种判决：前者可以拉满，后者一张都不许拉。
     * #1024：跨仓文件名 reviewer-<owner>__<name>__<pr>.json 也要扫进来，否则跨仓在役审官不占位。
     */
    listAll() {
      if (typeof readdir !== 'function') return null;
      let names;
      try {
        names = readdir(dir);
      } catch (e) {
        // 目录不在 = 一条都没有（可以拉满）；读不了才是没查成。
        const code = e && e.code;
        if (code === 'ENOENT' || code === 'ENOTDIR') return [];
        return null;
      }
      const out = [];
      for (const f of names) {
        const parsed = parseStem(f);
        if (!parsed) continue;
        const r = this.read(parsed.pr, parsed.repo);
        if (r.ok && r.record) out.push(r.record);
      }
      return out;
    },
    read(pr, repo) {
      const place = loc(pr, repo);
      if (!place.ok) return { ok: false, missing: true, why: place.error };
      try {
        const t = readFile(place.path);
        const j = JSON.parse(t);
        if (place.keyed.scoped) {
          const recRepo = j && j.repo ? String(j.repo).trim() : '';
          if (!recRepo || recRepo.toLowerCase() !== place.keyed.ownerName.toLowerCase()) {
            return {
              ok: false,
              missing: true,
              why: `PR ${pr} 的审官登记不是 ${place.keyed.ownerName}（旧无仓或不匹配），跨仓请求不复用`,
            };
          }
        }
        return { ok: true, record: j, path: place.path };
      } catch (e) {
        return { ok: false, missing: true, why: `没有 PR ${pr} 的审官会话登记：${String(e?.message || e)}` };
      }
    },
    write(pr, record) {
      const place = loc(pr, record && record.repo);
      if (!place.ok) return { ok: false, error: place.error };
      try {
        mkdir(dir);
        writeFile(place.path, JSON.stringify(record, null, 2));
        return { ok: true, path: place.path };
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
  pr, repo, ownerName, prompt, reworkPrompt, reworkAnswer, reviewBranch,
  reviewerModel, workerModel, models, mirasimPolicy,
  round, force, enqueueOnly = false, now = () => Date.now(),
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

  const existing = registry.read(pr, ownerName);
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

  // 短命会话：交卷只入队，审官由指挥官按空位 drain。旧的起会话/interact 路留给单测。
  if (enqueueOnly) {
    return {
      ok: true, action: 'queued', round: theRound, reviewCount,
      sessionKey: sessionKey || null, reuse,
      why: 'worker-done 只入队，不起审官会话',
    };
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
      registry, pr, ownerName, created, round: theRound, prevSessionKey: sessionKey || null, now, reviewerModel,
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
  const resolved = resolveMergeable(
    { number: pr, mergeable: prHead.mergeable },
    { viewMergeable: (n) => fetchPrMergeable(gh, n) },
  );
  const mergeable = assessPrMergeable(resolved.mergeable);
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
    pr: String(pr), repo: ownerName || record.repo || null, sessionKey, treePath,
    round: theRound, headRefName: prHead.headRefName, expectedOid: prHead.expectedOid,
    treeHead, ts: now(),
  });
  // 注：这里 `...record` 打头，所以上一轮记下的 reviewer 会被带过来——复审换不换人由调用方决定，
  // 不在这里猜。#1122 的换厂链读的就是这一栏。
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
  const w = writeReviewerRecord({ registry, pr, ownerName, created, round: theRound, prevSessionKey: sessionKey, now, reviewerModel });
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
function writeReviewerRecord({ registry, pr, ownerName, created, round, prevSessionKey, now, reviewerModel }) {
  const rec = {
    pr: String(pr), repo: ownerName ? String(ownerName) : null,
    sessionKey: created.sessionKey, agent: created.agent, treePath: created.treePath,
    // reviewer：#1122 换厂链靠它认「上一位是谁」。漏了它链子就卡在第一格（见 dao.mjs 同名注释）。
    ...(reviewerModel ? { reviewer: reviewerModel } : {}),
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
