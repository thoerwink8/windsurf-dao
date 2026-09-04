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
 *   prompt       —— 审官会话的启动 prompt（审官任务书 inject 文本，调用方渲染）
 */
export async function mirasimReviewerCreate({
  runtime, gh, readTreeHead, prepareRef,
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

  // 6. 读回 HEAD 对齐——对不上就**不起会话**。
  let treeHead;
  try { treeHead = await readTreeHead(treePath); }
  catch (e) { return { ok: false, stage: 'head', error: `读回审官树 HEAD 失败（没查成）：${String(e?.message || e)}`, treePath }; }
  const headOk = judgeReviewerHead({ treeHead, expectedOid: head.expectedOid });
  if (!headOk.ok) return { ok: false, stage: 'head', error: headOk.error, treePath, treeHead: headOk.treeHead, expectedOid: head.expectedOid, ws };

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
    mergeable: head.mergeable,
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
  runtime, gh, readTreeHead, prepareRef, registry,
  pr, repo, prompt, reworkPrompt, reworkAnswer, reviewBranch,
  reviewerModel, workerModel, models, mirasimPolicy,
  round, now = () => Date.now(),
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
  const hasSession = existing.ok && existing.record && existing.record.sessionKey;

  // 首审，或返工但登记里没有会话 → 起新审官会话。
  if (theRound === 'first' || !hasSession) {
    const created = await mirasimReviewerCreate({
      runtime, gh, readTreeHead, prepareRef,
      pr, repo, reviewerModel, workerModel, models, mirasimPolicy, reviewBranch,
      prompt: theRound === 'rework' ? (reworkPrompt || prompt) : prompt,
      now,
    });
    if (!created.ok) return { ...created, stage: `create:${created.stage}`, round: theRound, reviewCount };
    const rec = {
      pr: String(pr), sessionKey: created.sessionKey, agent: created.agent, treePath: created.treePath,
      round: theRound, headRefName: created.headRefName, expectedOid: created.expectedOid, ts: now(),
    };
    const w = registry.write(pr, rec);
    return { ok: true, action: hasSession ? 'reworked-new' : 'created', round: theRound, reviewCount, session: created, registryWrite: w };
  }

  // 返工且有会话：先看会话有没有在等答的问题 → 有则 interact（补 interact 真机证据），
  // 没有则新起一针注入「返工完成」。
  const sessionKey = existing.record.sessionKey;
  if (typeof runtime?.readSession === 'function' && typeof runtime?.interact === 'function') {
    let view = null;
    try { view = await runtime.readSession(sessionKey); } catch (e) { view = { missing: true, why: String(e?.message || e) }; }
    const pending = view && view.via === 'snapshot' && view.snapshot
      && Array.isArray(view.snapshot.interactions)
      && view.snapshot.interactions.some(x => x && x.promptId && !x.answeredAt && x.answered !== true && x.done !== true);
    if (pending) {
      let r = null;
      try { r = await runtime.interact(sessionKey, reworkAnswer || '返工完成，请复审最新 HEAD'); }
      catch (e) { r = { ok: false, why: String(e?.message || e) }; }
      if (r && r.ok) {
        return { ok: true, action: 'reworked-interact', round: theRound, reviewCount, sessionKey, interact: r };
      }
      // interact 没成 → 退到新起一针（不静默）。
    }
  }
  const created = await mirasimReviewerCreate({
    runtime, gh, readTreeHead, prepareRef,
    pr, repo, reviewerModel, workerModel, models, mirasimPolicy, reviewBranch,
    prompt: reworkPrompt || prompt, now,
  });
  if (!created.ok) return { ...created, stage: `rework:${created.stage}`, round: theRound, reviewCount };
  const rec = {
    pr: String(pr), sessionKey: created.sessionKey, agent: created.agent, treePath: created.treePath,
    round: theRound, headRefName: created.headRefName, expectedOid: created.expectedOid,
    prevSessionKey: sessionKey, ts: now(),
  };
  const w = registry.write(pr, rec);
  return { ok: true, action: 'reworked-new', round: theRound, reviewCount, session: created, registryWrite: w };
}
