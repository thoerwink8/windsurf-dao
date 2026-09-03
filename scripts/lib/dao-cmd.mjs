// scripts/lib/dao-cmd.mjs —— 统一命令库的纯函数层（issue #482）
//
// 改这段前必须知道：派工启动 argv 只听 docs/model-routing.toml 的
// [providers.*].launch。scripts/lib/orca-agent-cmds.mjs 只读 Orca Desktop
// 做比较（多的建议补仓内、少的只报不删桌面），不得盖掉仓内旗标。
// 禁止在这里写死 codex / reclaude / grok 的参数。
// Orca 没查成（坏 JSON / 没扫到 settings）仍按仓内起，带 orcaReason；不挡派工。
// --help 自检的比对函数不调用 orca 自己的 schema（agent-context），只解析 --help 文本。

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ghAs } from './gh.mjs';
import { orcaErrorText } from './orca-error.mjs';
import { isModelRejectText } from './next-launch.mjs';
import { ROUTING_JSON } from './model-routing-json.mjs';
import { issueNumberFromWorktree, prNumberFromWorktree } from './card-identity.mjs';
export { formatDesktopLaunchNotes } from './orca-agent-cmds.mjs';

export const ROOT = resolve(import.meta.dirname, '..', '..');
export const ROUTING_FILE = join(ROOT, 'docs', 'model-routing.toml');
export const ROUTING_POLICY_FILE = ROUTING_JSON;
export const ESCAPE_LOG = join(ROOT, '_flow', 'cmd-escape.jsonl');
export const HELP_FIXTURE_DIR = join(ROOT, 'tests', 'fixtures', 'orca-help');

export const DEFAULT_THINK_GRACE_MS = 20 * 60 * 1000;
export const DEFAULT_PROCESS_ALIVE_MS = 2 * 60 * 1000;
/** 探针等屏默认值。一个所有已知情况都不成立的缺省值是陷阱：
 * grok 配 45s、codex 第一项实测 84s，没有任何 TUI 能在 8s 内跑完第一项。
 * 120s 盖住目前最慢的实测；表上仍给各 provider 显式值。
 * #559：waitAndVerify 原默认 8000ms 硬编码，pi 启动加载 skills 常常超过，
 * 派工连续死在这里——默认改为本常量，调用方再按 provider 的 probe_wait_ms 显式覆盖。 */
export const DEFAULT_PROBE_WAIT_MS = 120000;
/** worker-start 调用的物理上限（2026-08-23 fire-and-forget 拍板）：这不是认账钟——
 * orca 到点报 agent_prompt_stalled 只代表「没等到 agent 认账」，字已进终端
 * （763 实证：报 stalled 的工人其实在跑）。15s 盖住注入 + orca 返回；
 * 认账确认不在派工路做，交给 watchdog / flow / inbox.log。 */
export const WORKER_START_SEND_TIMEOUT_MS = 15000;

const SKIP_DIRS = new Set([
  '.git', 'node_modules', '_flow', '_tmp', '_scratch', '.codegraph',
  '__pycache__', 'derived', '.playwright-mcp',
]);

// #762 拆分：选型/启动域移到 scripts/lib/dispatch/launch.mjs（保持对外 API 不变）
export {
  probeWaitMs,
  loadRoutingProviders,
  loadRouting,
  resolveLaunch,
  materializeLaunch,
  providerLaunchProblems,
  orcaKnownAgentId,
  launchCliModel,
  agentStartSpec,
  DEFAULT_DAO_REPO,
  daoTaskId,
  daoActorId,
  buildDaoTraceEnv,
  isDaoTraceEnv,
  normalizeDaoTrace,
  shouldPrefixDaoTrace,
  prefixLaunchWithDaoTrace,
  applyDaoTraceToLaunch,
  preflightWorkerSlate,
  preflightStopReport,
} from './dispatch/launch.mjs';

// #802：start=agent 落裸 shell 的屏面分类 / 回退计划 / launchAttempts 行
export {
  classifyAgentScreen,
  shouldFallbackToCommand,
  planAgentScreenFallback,
  launchAttempt,
  terminalAgentIdentity,
  classifyTerminalRole,
  pickAgentTerminal,
  terminalHandles,
  planInjectTarget,
  requireBookForRepair,
  planRepairSends,
  planDeferredRepair,
} from './dispatch/agent-ready.mjs';

// ── orca 参数表（从 builder 扫，不另抄清单） ────────────────────────

// #762 拆分：orca 参数构造域移到 scripts/lib/dispatch/args.mjs（保持对外 API 不变）
import {
  argsTerminalCreate, argsTerminalRead, newlineCodec, encodeSendText, argsTerminalSend,
  classifyWorkerStartSend, argsWorktreeCreate, argsWorktreeSet, argsWorktreeRm, argsWorktreePs,
  argsTaskCreate, argsTaskUpdate, argsWorkerStart, argsWorkerList,
  argsWorkerShow, argsWorkerRelease, argsWorkerStop, argsWorkerRead,
  argsOrchestrationReply, argsOrchestrationCheck, argsRunList, argsGateCreate, argsGateResolve, argsGateList,
  argsTerminalList, argsTerminalClose, argsTerminalWait, commandKey, flagsOf,
  argsOrchestrationSend, argsOrchestrationInbox, argsRunShow, argsRunCurrent, argsRunUse, argsRunCreate, argsRunCreateSelf,
} from './dispatch/args.mjs';
export {
  argsTerminalCreate, argsTerminalRead, newlineCodec, encodeSendText, argsTerminalSend,
  classifyWorkerStartSend, argsWorktreeCreate, argsWorktreeSet, argsWorktreeRm, argsWorktreePs,
  argsTaskCreate, argsTaskUpdate, argsWorkerStart, argsWorkerList,
  argsWorkerShow, argsWorkerRelease, argsWorkerStop, argsWorkerRead,
  argsOrchestrationReply, argsOrchestrationCheck, argsRunList, argsGateCreate, argsGateResolve, argsGateList,
  argsTerminalList, argsTerminalClose, argsTerminalWait, commandKey, flagsOf,
  argsOrchestrationSend, argsOrchestrationInbox, argsRunShow, argsRunCurrent, argsRunUse, argsRunCreate, argsRunCreateSelf,
} from './dispatch/args.mjs';

/** stalled 响应没带 dispatchId 时的兜底：worker-list 按 taskId 精确找回。
 * 763 实证：stalled 的 worker-start 照样落了 dispatch 记账（taskId 对上）。
 * 同 taskId 理论只有一条；防御取数组尾（最新）。 */
export function findDispatchForTask(workerListJson, taskId) {
  const workers = workerListJson?.result?.workers;
  if (!Array.isArray(workers)) {
    return { ok: false, unscanned: true, error: 'worker-list 结构不认识（缺 result.workers 数组）' };
  }
  const want = String(taskId || '').trim();
  if (!want) return { ok: false, error: 'findDispatchForTask 没给 taskId' };
  const hits = workers.filter(w => w && w.taskId === want && w.dispatchId);
  if (hits.length === 0) {
    return { ok: false, error: `worker-list 里找不到 task=${want} 的 dispatch 记账`, scanned: workers.length };
  }
  return { ok: true, dispatchId: hits[hits.length - 1].dispatchId, scanned: workers.length };
}
// #762 拆分：repo 选择符移到 scripts/lib/dispatch/repo.mjs（保持对外 API 不变）
export { argsRepoList, normalizeRepoRemote, resolveRepoSelector } from './dispatch/repo.mjs';

// #762 拆分：worktree 生命周期域移到 scripts/lib/dispatch/worktree.mjs（保持对外 API 不变）
import {
  findWorktreeBySel, worktreeSelMatches,
  planWorktreeRm, applyWorktreeRmPlan, prepareWorktreeRm,
  formatStrayLedgerError, listStrayLedgerEvents, occupyingAgents, resolveWorktreeSelector,
} from './dispatch/worktree.mjs';
export {
  resolveWorktreeSelector, planWorktreeRm, applyWorktreeRmPlan,
  formatStrayLedgerError, listStrayLedgerEvents, prepareWorktreeRm,
  worktreeSelMatches, findWorktreeBySel, occupyingAgents,
} from './dispatch/worktree.mjs';

/**
 * #631：reviewer-attach 树→dispatch 映射的归属校验。
 * 树↔dispatch 是 issue 派工时绑死的（dispatch 绑 issue 树），PR 号是后开出来的——
 * issue 号 ≠ PR 号是常态（issue #N 派工 → PR #M），所以这里不比对「dispatch 关联号 == --pr」，
 * 只校验「传进来的树是不是这个 PR 的工人树」：
 *   1) 树上的 issue 号（linkedIssue/卡名）必须 ∈ PR 署名 issue 号（title+body 的 Closes/署名 issue）；
 *   2) 树分支必须 == refs/heads/<PR headRefName>（flow.mjs 同款判据）。
 * 两条都查不到（树不在盘面/已归档）→ verified:false，不硬拦，交给后续 dispatch 查找与活性闸。
 * 查到任何一条对不上 → ok:false，不许硬塞（#631：串号会烧掉审官 600s 再误诊成「实属别的单」）。
 */
export function verifyReviewerAttachTree({ prIssueNumbers, headRefName, worktrees, worktreeSel } = {}) {
  if (!Array.isArray(worktrees)) {
    return { ok: false, unscanned: true, error: 'worktree list 没查成，树→PR 归属校验做不了（不许硬塞）' };
  }
  const wt = findWorktreeBySel(worktrees, worktreeSel);
  if (!wt) {
    return { ok: true, verified: false, reason: '盘面查不到该树（已归档或选择符不对），归属校验无样本' };
  }
  const via = [];
  const refs = Array.isArray(prIssueNumbers) ? prIssueNumbers.map(Number).filter(Number.isInteger) : [];
  const wtIssue = issueNumberFromWorktree(wt);
  if (wtIssue && refs.length > 0) {
    if (!refs.includes(wtIssue)) {
      return {
        ok: false, verified: false,
        error: `树关联 issue #${wtIssue}，PR 署名的是 #${refs.join('/#')}——树→PR 对不上（传错树？）`,
        wtIssue, prIssueNumbers: refs,
      };
    }
    via.push(`issue #${wtIssue} ∈ PR 署名`);
  }
  const branch = wt?.branch || wt?.git?.branch || null;
  const want = headRefName ? `refs/heads/${headRefName}` : null;
  if (branch && want) {
    if (branch !== want) {
      return {
        ok: false, verified: false,
        error: `树分支 ${branch} ≠ PR head 分支 ${want}——树→PR 对不上（传错树？）`,
        branch, want,
      };
    }
    via.push('分支 == PR head');
  }
  return { ok: true, verified: via.length > 0, via };
}

/**
 * #631：审官要等的「士兵完工」只可能来自 worker-done 自己建的审官（完工消息由 worker-done 投递）。
 * reviewer-attach 是 worker-done 失败后的手动补派——工人那边不会再发完工，硬等 = 烧 600s 再误诊。
 * 决策矩阵（纯函数，判别性测试钉死）：
 *   没 --skip-wait：必须有活着的士兵 dispatch（显式给或树映射来），否则拒（#552：已结算禁止当收件人）。
 *   有 --skip-wait：不要求 dispatch；但 `d=` 只给 worker-show 确认活的 dispatch——显式 id 同闸
 *     （#631 返工：显式 id 不得绕过活性复核；已结算 → 清空 + deadWarning 红项上帅；
 *     worker-show 没查成 → fail-close，不许把没查成当可投递）。
 */
export function planAttachSoldierDispatch({ explicitDispatch, found, dispatchLive, skipWait } = {}) {
  const explicit = String(explicitDispatch || '').trim() || null;
  const foundId = found && found.ok ? String(found.dispatchId || '').trim() || null : null;
  if (!skipWait) {
    if (explicit) {
      if (dispatchLive === false) {
        return { ok: false, error: `--soldier-dispatch ${explicit} 已结算（worker-show 复核），禁止当收件人（#552）。工人确定不会再发完工 → 加 --skip-wait 补审官` };
      }
      if (dispatchLive == null) {
        return { ok: false, unscanned: true, error: `--soldier-dispatch ${explicit} 给了，但 worker-show 没查成（不许当活人）` };
      }
      return { ok: true, soldierDispatchId: explicit, skipWait: false };
    }
    if (!found || !found.ok) {
      return {
        ok: false,
        unscanned: !!found?.unscanned,
        error: `找不到士兵 dispatch（${found?.error || '没查'}）。工人确定不会再发完工 → 加 --skip-wait；或显式给 --soldier-dispatch`,
      };
    }
    if (dispatchLive === false) {
      return { ok: false, error: `树映射到的士兵 dispatch ${foundId} 已结算（worker-show 复核），禁止当收件人（#552）。工人确定不会再发完工 → 加 --skip-wait 补审官` };
    }
    if (dispatchLive == null) {
      return { ok: false, unscanned: true, error: `树映射到的士兵 dispatch ${foundId} 但 worker-show 没查成（不许当活人）` };
    }
    return { ok: true, soldierDispatchId: foundId, runId: found.runId || null, skipWait: false };
  }
  const probeTarget = explicit || foundId;
  if (!probeTarget) {
    return { ok: true, soldierDispatchId: null, runId: null, skipWait: true, reason: 'none' };
  }
  if (dispatchLive === false) {
    return {
      ok: true,
      soldierDispatchId: null,
      runId: found?.ok ? found.runId || null : null,
      skipWait: true,
      reason: explicit ? 'explicit-dead' : 'tree-mapped-dead',
      deadWarning: `士兵 dispatch ${probeTarget} 已结算：不注入 d=，红项按任务书直接上帅转达`,
    };
  }
  if (dispatchLive == null) {
    return {
      ok: false,
      unscanned: true,
      error: `士兵 dispatch ${probeTarget} 的 worker-show 没查成（不许当活人）：skip-wait 下不注入 d=，红项上帅。重试或确认 id`,
    };
  }
  return {
    ok: true,
    soldierDispatchId: probeTarget,
    runId: found?.ok ? found.runId || null : null,
    skipWait: true,
    reason: explicit ? 'explicit' : 'tree-mapped',
  };
}

/**
 * #799：reviewer-create / worker-done 起审官时的士兵 dispatch 决策。
 * 与 planAttachSoldierDispatch 的差别：create 没有 --skip-wait，完工消息仍由
 * worker-done 投给新审官；已结算只影响「d= 当收件人」，整跳必须继续。
 *
 * 活 dispatch → 注入 d=id，身份消息可投。
 * 已结算（#552）→ 不当收件人，但整跳继续：d= 留空，红项上帅，跳过身份投递。
 * worker-show 没查成 → 拒（不许把没查成当已结算）。
 * 找不到且无显式 id → 拒（给 --soldier-dispatch / --parent-worktree）。
 */
export function planCreateSoldierDispatch({ explicitDispatch, found, dispatchLive } = {}) {
  const explicit = String(explicitDispatch || '').trim() || null;
  const foundId = found && found.ok ? String(found.dispatchId || '').trim() || null : null;
  const foundSettled = Boolean(
    found && found.ok === false && !found.unscanned && /已结算/.test(String(found.error || '')),
  );

  const continueDead = (id, reason) => ({
    ok: true,
    soldierDispatchId: '',
    skipIdentity: true,
    reason,
    deadWarning: id
      ? `士兵 dispatch ${id} 已结算：不注入 d=，红项按任务书直接上帅转达（#799）`
      : '士兵 dispatch 已结算：不注入 d=，红项按任务书直接上帅转达（#799）',
  });

  if (explicit) {
    if (dispatchLive === false) return continueDead(explicit, 'explicit-dead');
    if (dispatchLive == null) {
      return {
        ok: false,
        unscanned: true,
        error: `--soldier-dispatch ${explicit} 给了，但 worker-show 没查成（不许当活人，也不许当已结算）`,
      };
    }
    return { ok: true, soldierDispatchId: explicit, skipIdentity: false, reason: 'explicit' };
  }

  if (found && found.unscanned) {
    return { ok: false, unscanned: true, error: found.error || '士兵 dispatch 没查成（不许猜）' };
  }

  if (foundId) {
    if (dispatchLive === false) return continueDead(foundId, 'tree-mapped-dead');
    if (dispatchLive == null) {
      return {
        ok: false,
        unscanned: true,
        error: `树映射到的士兵 dispatch ${foundId} 但 worker-show 没查成（不许当活人）`,
      };
    }
    return {
      ok: true,
      soldierDispatchId: foundId,
      runId: found.runId || null,
      skipIdentity: false,
      reason: 'tree-mapped',
    };
  }

  if (foundSettled) return continueDead(null, 'tree-only-settled');

  return {
    ok: false,
    error: `找不到士兵 dispatch（${found?.error || '没查'}）。给 --soldier-dispatch 或 --parent-worktree`,
  };
}

/** 从 worker-list JSON 里找某棵树的士兵 dispatch。没查成与查到 0 条分开。
 * #781：worker-list 项没有 last_failure 字段（生产数据确认，审官扫 303 个 failed Dispatch），
 * agent_prompt_stalled 例外只能用 resolveLastFailure 回调调 worker-show/dispatch-show 取真实
 * last_failure 来判；不传回调 / 查失败 → failed 候选 fail-close 判死（不许因没查成当活人，#552）。 */
export function findDispatchForWorktree(workerListJson, worktreeSel, resolveLastFailure) {
  const workers = workerListJson?.result?.workers;
  if (!Array.isArray(workers)) {
    return { ok: false, unscanned: true, error: 'worker-list 结构不认识（缺 result.workers 数组）' };
  }
  const sel = String(worktreeSel || '').trim();
  if (!sel) return { ok: false, error: 'findDispatchForWorktree 没给 worktree' };
  const hits = workers.filter(w => {
    const id = String(w?.resource?.worktreeId || '');
    return worktreeSelMatches(id, sel);
  });
  if (hits.length === 0) {
    return { ok: false, error: `worker-list 里找不到 worktree=${sel} 的士兵 dispatch`, scanned: workers.length };
  }

  const isReadyLike = w => w.workerState === 'ready' || w.workerState === 'working'
    || w.dispatchStatus === 'dispatched' || w.dispatchStatus === 'running';
  const pickFrom = live => {
    const ready = live.filter(isReadyLike);
    const pick = ready[0] || live[0];
    if (!pick) return null;
    if (!pick.dispatchId) {
      return { ok: false, error: `worktree=${sel} 的记账没有 dispatchId`, scanned: workers.length };
    }
    return { ok: true, dispatchId: pick.dispatchId, taskId: pick.taskId || null, runId: pick.runId || null, scanned: workers.length };
  };
  const deadResult = () => ({
    ok: false, unscanned: false,
    error: `worktree=${sel} 只有已结算 dispatch，禁止当收件人（#552：下一跳必须新 Dispatch）`,
    scanned: workers.length, deadCount: hits.length,
  });

  // Pass 1：状态本身判活（ready/working/waiting + 非 failed dispatch）——不需 last_failure。
  const clearlyLive = hits.filter(w => isLiveDispatchRecipient({
    workerState: w.workerState, dispatchStatus: w.dispatchStatus, lastFailure: null,
  }));
  if (clearlyLive.length > 0) {
    const r = pickFrom(clearlyLive);
    if (r) return r;
  }

  // Pass 2：仅当没有状态判活的候选，才对 failed 候选用 resolveLastFailure 取真实 last_failure
  // （worker-list 项没这字段）。非 failed 死态（completed/succeeded/...）无条件死，不查。
  if (typeof resolveLastFailure !== 'function') return deadResult();
  const stalledLive = [];
  for (const w of hits) {
    const wLow = String(w.workerState || '').toLowerCase();
    const dLow = String(w.dispatchStatus || '').toLowerCase();
    if (wLow !== 'failed' && dLow !== 'failed') continue;
    const lastFailure = resolveLastFailure(w.dispatchId);
    if (isLiveDispatchRecipient({
      workerState: w.workerState, dispatchStatus: w.dispatchStatus, lastFailure,
    })) {
      stalledLive.push(w);
    }
  }
  if (stalledLive.length > 0) {
    const r = pickFrom(stalledLive);
    if (r) return r;
  }
  return deadResult();
}

export function extractWorktreeId(json) {
  return json?.result?.worktree?.id
    || json?.result?.id
    || json?.worktree?.id
    || null;
}

export function extractWorktreePath(json) {
  return json?.result?.worktree?.path
    || json?.result?.worktree?.git?.path
    || json?.worktree?.path
    || json?.path
    || null;
}

export function extractHandleFromCreate(json) {
  return json?.result?.handle
    || json?.result?.terminal?.handle
    || json?.handle
    || json?.result?.startupTerminal?.handle
    || json?.result?.agentTerminalHandle
    || null;
}

/** #633：worktree create 回包经常没有 startupTerminal，要用 terminal list 找默认空壳。 */
export function unwrapTerminalList(json) {
  const list = json?.result?.terminals;
  if (!Array.isArray(list)) {
    return { ok: false, unscanned: true, error: 'terminal list 结构不认识', terminals: [] };
  }
  return { ok: true, unscanned: false, terminals: list };
}

export function looksLikeAgentPreview(text) {
  return /Grok Build|always-approve|ctrl\+q|╭─|╰─/i.test(String(text || ''));
}

export function looksLikeShellPrompt(text) {
  const s = String(text || '').trimEnd();
  if (!s) return false;
  if (looksLikeAgentPreview(s)) return false;
  return /(?:^|\n)PS .*>\s*$/.test(s)
    || /(?:^|\n)[A-Z]:\\[^>\n]*>\s*$/.test(s)
    || /(?:^|\n)\$\s*$/.test(s);
}

export function extractHandleFromWorkerStart(json) {
  return json?.result?.worker?.agent_terminal_handle
    || json?.result?.dispatch?.assignee_handle
    || json?.result?.handle
    || json?.result?.terminal?.handle
    || extractHandleFromCreate(json);
}

/** worker-done 起审官遇 consumer_fenced：扫到 0 次 和 没扫到样本 必须分开。 */
export function inspectConsumerFence(error) {
  if (error === undefined || error === null) {
    return { unscanned: true, scanned: false, fenced: false, count: null, error: '没给错误文本（没扫到样本，不是扫到 0 次 fence）' };
  }
  const text = String(error);
  const fenced = /consumer_fenced/i.test(text);
  return { unscanned: false, scanned: true, fenced, count: fenced ? 1 : 0 };
}

/** retire → 再起 → ensure。起不成不许当成功。 */
export function planFenceHeal({ error, runId, retired, retried, ensured } = {}) {
  const inspect = inspectConsumerFence(error);
  if (inspect.unscanned) {
    return { ok: false, unscanned: true, action: 'unscanned', fences: null, error: inspect.error };
  }
  if (!inspect.fenced) {
    return { ok: true, unscanned: false, action: 'none', fences: 0 };
  }
  if (!runId) {
    return { ok: false, unscanned: false, action: 'retire', fences: 1, error: 'consumer_fenced 但没 Run id，没法 retire 信箱台' };
  }
  if (!retired || (retired.ok !== true && retired.alreadyGone !== true && retired.state !== 'run_not_found')) {
    return { ok: false, unscanned: false, action: 'retire', fences: 1, error: retired?.error || 'retire 信箱台没做成' };
  }
  if (!retried || retried.ok !== true) {
    return { ok: false, unscanned: false, action: 'retry', fences: 1, error: retried?.error || 'retire 后再起审官失败' };
  }
  if (!ensured || ensured.ok !== true) {
    return { ok: false, unscanned: false, action: 'ensure', fences: 1, error: ensured?.error || '审官已起但 ensure 信箱台失败' };
  }
  return { ok: true, unscanned: false, action: 'healed', fences: 1 };
}

/** 建卡默认空壳：title 为 null / 空 / "Terminal N"；已是 agent 的不碰。
 * 只拿来关，禁止 send 启动命令进去。 */
export function isReusableDefaultTerminal(term) {
  if (!term || !term.handle) return false;
  if (term.orphaned) return false;
  if (term.connected === false || term.writable === false) return false;
  const title = term.title;
  const titleOk = title == null || title === '' || /^Terminal\s+\d+$/i.test(String(title).trim());
  if (!titleOk) return false;
  const preview = String(term.preview || '');
  if (preview && looksLikeAgentPreview(preview)) return false;
  return true;
}

export function findReusableDefaultTerminal(listJson, { worktreeId } = {}) {
  const unwrapped = unwrapTerminalList(listJson);
  if (!unwrapped.ok) {
    return { ok: false, unscanned: true, error: unwrapped.error, handle: null };
  }
  let terms = unwrapped.terminals;
  if (worktreeId && String(worktreeId).includes('::')) {
    terms = terms.filter(t => t.worktreeId === worktreeId);
  }
  const hits = terms.filter(isReusableDefaultTerminal);
  if (hits.length === 0) {
    return { ok: true, unscanned: false, handle: null, reason: '没有默认空壳终端' };
  }
  return { ok: true, unscanned: false, handle: hits[0].handle, terminal: hits[0] };
}

/**
 * #633：空壳一律先关再 create，禁止 send 进 pwsh 当复用。
 * leftoverIfCreateNow=true 表示「现在直接 create 会留下第二个终端」。
 */
export function planLaunchFallback({ foundHandle } = {}) {
  if (foundHandle) {
    return { action: 'close-then-create', closeHandle: foundHandle, leftoverIfCreateNow: true };
  }
  return { action: 'create', closeHandle: null, leftoverIfCreateNow: false };
}

/** 按启动计划演算终态 handle 列表。用来证明 close-then-create 不会留第二个终端。 */
export function terminalsAfterLaunchPlan({ existingHandles, plan, createdHandle } = {}) {
  const next = new Set(Array.isArray(existingHandles) ? existingHandles : []);
  if (!plan || plan.action === 'reuse') return [...next];
  if (plan.closeHandle) next.delete(plan.closeHandle);
  if (createdHandle) next.add(createdHandle);
  return [...next];
}

/** terminal send --json 的回执。真返回在 result.send；accepted=true 才算送达。
 * 不带 --json 的人读回执由 parseOrcaStdout 归一成同一形状（#580）。 */
export function extractTerminalSend(json) {
  const s = json?.result?.send;
  if (!s || s.accepted !== true) return null;
  return {
    handle: s.handle ?? null,
    accepted: true,
    bytesWritten: Number.isFinite(s.bytesWritten) ? s.bytesWritten : null,
  };
}

/** 真返回在 result.task.id。result.id / 顶层 id 是 RPC id，不能当 taskId（#497/#502）。 */
export function extractTaskId(json) {
  return json?.result?.task?.id || null;
}

/** worker-start / dispatch-show / worker-show 的 Dispatch id。
 * 真返回位置：worker-start 的 result.dispatchId（CLI 源码 worker-start 格式化器直接读它）；
 * dispatch-show / worker-show 的 result.dispatch.id；worker-show 的 worker 对象另有 worker.dispatch_id。
 * 顶层 id 是 RPC id，不能当 dispatchId（#502 同款教训）。
 * #559：闭环发信改用 --to dispatch:<id>，派工流程从 worker-start 返回里取它。 */
export function extractDispatchId(json) {
  return json?.result?.dispatchId
    || json?.result?.worker?.dispatchId
    || json?.result?.worker?.dispatch_id
    || json?.result?.dispatch?.id
    || null;
}

export function isRunRequired(error) {
  return /run_required/i.test(orcaErrorText(error));
}

export const RUN_REQUIRED_HINT = '未绑 orchestration Run：本 TUI 自己 run-create（不要 --from 信箱台，会 consumer_fenced）。不要先试 run-use（#667：人用窗口永不当 coordinator，派工不从帅窗 run-use）';

/** 库实际会发出的 orca 命令 + 参数。用「全开」调用 builder 扫出来，不另维护清单。 */
export function catalogUsedFlags() {
  const samples = [
    argsTerminalCreate({ worktree: 'w', title: 't', command: 'c' }),
    argsTerminalList({ worktree: 'w' }),
    argsTerminalRead({ terminal: 't', limit: 80, cursor: 1 }),
    argsTerminalSend({ terminal: 't', text: 'x', enter: true }),
    argsWorktreeCreate({
      name: 'n', noParent: true, setup: 'skip',
      parentWorktree: 'p', baseBranch: 'b', comment: 'c', issue: 559,
    }),
    argsWorktreeSet({ worktree: 'w', displayName: 'n', comment: 'c', workspaceStatus: 'in-progress' }),
    argsWorktreeRm({ worktree: 'w', force: true }),
    argsWorktreePs(),
    argsTaskCreate({ spec: 's', run: 'r', from: 'h' }),
    argsTaskUpdate({ id: 't', status: 'failed' }),
    argsWorkerStart({ task: 't', worktree: 'w', terminal: 'h', retryOf: 'd', from: 'h', run: 'r' }),
    argsWorkerStart({ task: 't', worktree: 'w', agent: 'cursor', model: 'kimi-k3-high' }),
    argsWorkerShow({ dispatch: 'd' }),
    argsWorkerRelease({ dispatch: 'd' }),
    argsWorkerStop({ dispatch: 'd' }),
    argsWorkerRead({ dispatch: 'd', source: 'auto', limit: 50 }),
    argsTerminalClose({ terminal: 't', tab: true }),
    argsOrchestrationSend({ to: 'h', subject: 's', body: 'b', type: 'status', outcome: 'succeeded' }),
    argsOrchestrationSend({
      subject: 's', body: 'b', type: 'worker_done', outcome: 'succeeded',
      taskId: 't', dispatchId: 'd', dispatchCapability: 'c', from: 'h',
      filesModified: 'a.js', reportPath: 'r.md',
    }),
    argsOrchestrationReply({ id: 'm', body: 'b' }),
    argsGateCreate({ task: 't', question: 'q', options: '["a"]' }),
    argsGateResolve({ id: 'g', resolution: 'r' }),
    argsGateList({ task: 't', status: 'pending' }),
    argsOrchestrationInbox({ terminal: 'h', limit: 50, full: true }),
    argsOrchestrationCheck({ run: 'r', terminal: 't', peek: true }),
    argsRunShow({ id: 'r' }),
    argsRunCurrent({ from: 'h' }),
    argsRunUse({ id: 'r', from: 'h' }),
    argsRunCreate({ objective: 'dao-dispatch', from: 'h' }),
    argsRunCreateSelf({ objective: 'dao dispatch' }),
    argsRunList(),
    argsOrchestrationReply({ id: 'm', body: 'b', run: 'r', from: 'h' }),
  ];
  return samples.map(args => ({
    cmd: commandKey(args),
    flags: flagsOf(args),
    args,
  }));
}

export function parseHelpFlags(helpText) {
  const flags = new Set();
  const re = /(--[a-z0-9][a-z0-9-]*)/gi;
  let m;
  const text = String(helpText || '');
  while ((m = re.exec(text))) flags.add(m[1]);
  return flags;
}

export function isCiEnv(env = process.env) {
  return env.GITHUB_ACTIONS === 'true' || env.CI === 'true';
}

export function orcaHelpAvailable(spawn = spawnSync) {
  const r = spawn('orca', ['--help'], { encoding: 'utf8', timeout: 15000, windowsHide: true });
  if (r.error) {
    const msg = r.error.message || String(r.error);
    const missing = r.error.code === 'ENOENT' || /ENOENT/i.test(msg);
    return { ok: false, missing, error: msg };
  }
  const text = `${r.stdout || ''}${r.stderr || ''}`;
  if (!String(text).trim()) return { ok: false, missing: false, error: 'orca --help 无输出' };
  return { ok: true, missing: false };
}

/**
 * --help 自检是 local-only：真跑 orca --help。
 * CI 无 orca → SKIP（可见，不计失败）；本机无 orca → FAIL（不许悄悄跳过）。
 * 静默跳过会把「没查成」当成「查过没事」；直接 FAIL 会让 CI 永远红。
 */
export function helpCheckPolicy({ ci, orca } = {}) {
  if (orca && orca.ok) return { action: 'run' };
  if (ci && orca && orca.missing) {
    return { action: 'skip', reason: '本项需本机 orca，CI 无法验证' };
  }
  return { action: 'fail', reason: (orca && orca.error) || '本机 orca 不在 PATH，--help 自检没查成' };
}

export function fetchOrcaHelp(cmd, spawn = spawnSync) {
  const parts = String(cmd).trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) throw new Error('fetchOrcaHelp 没给命令');
  const r = spawn('orca', [...parts, '--help'], { encoding: 'utf8', timeout: 20000, windowsHide: true });
  if (r.error) throw new Error(r.error.message || 'spawn orca 失败');
  const text = `${r.stdout || ''}${r.stderr || ''}`;
  if (!String(text).trim()) throw new Error(`orca ${cmd} --help 无输出`);
  return text;
}

export function helpFixturePath(cmd, root = ROOT) {
  return join(root, 'tests', 'fixtures', 'orca-help', `${String(cmd).trim().replace(/\s+/g, '-')}.txt`);
}

/** 先跑真 --help；orca 不在 PATH 时才用语料夹具（夹具必须是某次真 --help 落盘）。 */
export function fetchHelpPreferLive(cmd, { spawn = spawnSync, root = ROOT } = {}) {
  try {
    return { text: fetchOrcaHelp(cmd, spawn), source: 'live' };
  } catch (e) {
    const p = helpFixturePath(cmd, root);
    if (!existsSync(p)) throw new Error(`orca ${cmd} --help 没查成（${e.message}）且无夹具`);
    const text = readFileSync(p, 'utf8');
    if (!String(text).trim()) throw new Error(`${p} 夹具是空的`);
    return { text, source: 'fixture' };
  }
}

export function checkHelpLiveness({ catalog, fetchHelp }) {
  if (!catalog || catalog.length === 0) {
    return { ok: false, unscanned: true, missing: [], scanned: [], error: '没扫到任何库命令' };
  }
  const missing = [];
  const scanned = [];
  for (const item of catalog) {
    let text;
    try {
      text = fetchHelp(item.cmd);
    } catch (e) {
      return {
        ok: false, unscanned: true, missing: [], scanned,
        error: `${item.cmd} --help 没查成: ${e.message}`,
      };
    }
    if (!text || !String(text).trim()) {
      return {
        ok: false, unscanned: true, missing: [], scanned,
        error: `${item.cmd} --help 无输出`,
      };
    }
    const available = parseHelpFlags(text);
    if (available.size === 0) {
      return {
        ok: false, unscanned: true, missing: [], scanned,
        error: `${item.cmd} --help 一个参数都没解析到`,
      };
    }
    scanned.push(item.cmd);
    for (const flag of item.flags || []) {
      if (!available.has(flag)) missing.push(`${item.cmd} ${flag}`);
    }
  }
  return { ok: missing.length === 0, unscanned: false, missing, scanned };
}

// ── 验开工 / 活性 ───────────────────────────────────────────────────

// #762 拆分：注入/验证域移到 scripts/lib/dispatch/inject.mjs（保持对外 API 不变）
import {
  CONFIRM_PATTERNS, sleepSync, extractTerminalText, classifyRead, verifyStarted, waitAndVerify,
  CODEX_CAPABLE_FLAG, PROBE_LABELS, PROBE_MARK_RE, probeMarkFound, assertCodexLaunch, assertReviewerLaunch,
  WRITE_PROBE_FILE, writeProbeScript, probeCommand, terminalProbeExec, runCapabilityProbes, hostProbeExec,
  PASTED_CONTENT_RE, CURSOR_PASTE_RE, CURSOR_WORKING_RE, CURSOR_FOLLOWUP_RE, UNSUBMITTED_PASTE_REASON,
  isCursorStartChannel, stripCursorPasteResidue, cursorStartEvidence, unsubmittedPasteForStart,
  cursorUnsubmittedPaste, cursorFollowupEvidence, cursorUnsubmittedEvidence, pastedContentMatch,
  LEFTOVER_DISPATCH_RE, leftoverDispatchMatch, TUI_LOADING_RE, proofUnavailableReason,
  verifyInjection, verifyStartedPolling, verifyWorkerStarted,
} from './dispatch/inject.mjs';
export {
  CONFIRM_PATTERNS, sleepSync, extractTerminalText, classifyRead, verifyStarted, waitAndVerify,
  CODEX_CAPABLE_FLAG, PROBE_LABELS, PROBE_MARK_RE, probeMarkFound, assertCodexLaunch, assertReviewerLaunch,
  WRITE_PROBE_FILE, writeProbeScript, probeCommand, terminalProbeExec, runCapabilityProbes, hostProbeExec,
  PASTED_CONTENT_RE, CURSOR_PASTE_RE, CURSOR_WORKING_RE, CURSOR_FOLLOWUP_RE, UNSUBMITTED_PASTE_REASON,
  isCursorStartChannel, stripCursorPasteResidue, cursorStartEvidence, unsubmittedPasteForStart,
  cursorUnsubmittedPaste, cursorFollowupEvidence, cursorUnsubmittedEvidence, pastedContentMatch,
  LEFTOVER_DISPATCH_RE, leftoverDispatchMatch, TUI_LOADING_RE, proofUnavailableReason,
  verifyInjection, verifyStartedPolling, verifyWorkerStarted,
} from './dispatch/inject.mjs';

// #762 拆分：git / gh 执行域移到 scripts/lib/dispatch/git.mjs（保持对外 API 不变）
import {
  gitCapture, gitHeadOid, gitBranchName, gitRemoteOriginUrl, assessPrMergeable,
  trialMergeMaster, verifyReviewerTree, verifyReviewerFiles, parseGhPullFiles,
  parseDiffNameStatus, runGh, originRefForBranch, prepareReviewerOriginRef, checkoutOriginRef,
} from './dispatch/git.mjs';
export {
  gitCapture, gitHeadOid, gitBranchName, gitRemoteOriginUrl, assessPrMergeable,
  trialMergeMaster, verifyReviewerTree, verifyReviewerFiles, parseGhPullFiles,
  parseDiffNameStatus, runGh, originRefForBranch, prepareReviewerOriginRef, checkoutOriginRef,
} from './dispatch/git.mjs';

export function envProbeWorktree(cwd) {
  return runCapabilityProbes({ exec: hostProbeExec(cwd) });
}

// #762 拆分：回滚域移到 scripts/lib/dispatch/rollback.mjs（保持对外 API 不变）
import {
  unboundTaskIds, planDispatchFence, planDispatchDestroy, planDispatchRollback,
  execRollbackStep, inspectRollbackResidue, applyDispatchRollback,
  classifyDispatchResidue, rollbackReport, rollbackErrorAlreadyGone,
} from './dispatch/rollback.mjs';
export {
  unboundTaskIds, planDispatchFence, planDispatchDestroy, planDispatchRollback,
  execRollbackStep, inspectRollbackResidue, applyDispatchRollback,
  classifyDispatchResidue, rollbackReport, rollbackErrorAlreadyGone,
} from './dispatch/rollback.mjs';

// #762 拆分：批派域移到 scripts/lib/dispatch/batch.mjs（保持对外 API 不变）
import {
  parseDispatchBatchItems, loadDispatchBatchFile, planDispatchBatch, runDispatchBatch,
} from './dispatch/batch.mjs';
export {
  parseDispatchBatchItems, loadDispatchBatchFile, planDispatchBatch, runDispatchBatch,
} from './dispatch/batch.mjs';

// #762 拆分：活性域移到 scripts/lib/dispatch/liveness.mjs（保持对外 API 不变）
import {
  isProcessFile, isWorkFile, scanWorktreeTimes, readGitTimes,
  assessLiveness, assessWorktreeLiveness,
} from './dispatch/liveness.mjs';
export {
  isProcessFile, isWorkFile, scanWorktreeTimes, readGitTimes,
  assessLiveness, assessWorktreeLiveness,
} from './dispatch/liveness.mjs';

// ── 派工约束（CLI 是约束载体，不是提醒。issue #482 规格重定义）────────
// 缺参数就跑不起来。拦旁路的闸门在 dispatch-gate.mjs（#546）：载体只有在「唯一入口」时才是约束。

// #762 拆分：派工约束/拆分域移到 scripts/lib/dispatch/constraints.mjs（保持对外 API 不变）
import {
  MERGE_POLICIES, DISPATCH_VERBS, minutesInBeijing, windowContains, recommendModel,
  resolveDispatchConstraints, SPLIT_CRITERION, resolveSplitConstraint, sliceFileTokens,
  resolveSliceAssignments, decideSplit, planSplitCards, buildSplitRoleSpec, startSplitChildren,
} from './dispatch/constraints.mjs';
export {
  MERGE_POLICIES, DISPATCH_VERBS, minutesInBeijing, windowContains, recommendModel,
  resolveDispatchConstraints, SPLIT_CRITERION, resolveSplitConstraint, sliceFileTokens,
  resolveSliceAssignments, decideSplit, planSplitCards, buildSplitRoleSpec, startSplitChildren,
} from './dispatch/constraints.mjs';

// ── 消歧门（#565）：项化派工前的硬门控 ────────────────────────────────────
// dao-project skill 第二节：待拍板不是停车场，是所有项都要过的一道门，过不了不许派。
// dispatch / worker-start 带 --issue 时，目标 issue 必须已打「已消歧」label，读不到拒派（fail-close）。
// 三态必须分得开（#565 硬约束）：查成且有 label / 查成但没 label / 没查成（gh 失败）。
// 没查成不许当有 label 放行——「没查成」当「查过没事」是事故类（#532 通用原则）。

// #762 拆分：卡名/消歧门/label 域移到 scripts/lib/dispatch/card.mjs（保持对外 API 不变）
import {
  DISAMBIGUATED_LABEL, checkIssueDisambiguated, assembleCardName,
} from './dispatch/card.mjs';
export {
  DISAMBIGUATED_LABEL, checkIssueDisambiguated, assembleCardName,
} from './dispatch/card.mjs';

// ── #564 label 自动打：dispatch 记 issue，帅合并时同步到 PR ─────────
// calibrate 读的是 PR 上的 model/* 与 type/*（每 label 必须有程序读它）；派工时 PR 还不存在，
// 所以：dispatch 成功时把 model/<模型> type/<角色> 打到目标 issue；帅合并时由
// `dao pr-sync-labels --pr <N>` 从 issue 同步到 PR。角色缺省写码（dispatch 默认写码类派工）。
// #586：审官选型另记 reviewer/<模型>。label 记「决定」，工人完工时用 pickReviewer 复算。

// #762 拆分：完工结算 + label 选型域移到 scripts/lib/dispatch/worker-done.mjs（保持对外 API 不变）
import {
  DEFAULT_DISPATCH_TYPE, REVIEWER_LABEL_PREFIX, dispatchLabelNames,
  pickReviewer, pickModel, requireWorkerModel, collectIssueLabelsFromPr,
  resolveWorkerFromPr, resolveReviewerFromPr, listPrReviews, planWorkerDone,
  completeWorkerDoneNotify, pickWorkerDoneDispatchId, linkedIssueNumbers,
} from './dispatch/worker-done.mjs';
export {
  DEFAULT_DISPATCH_TYPE, REVIEWER_LABEL_PREFIX, dispatchLabelNames,
  pickReviewer, pickModel, requireWorkerModel, collectIssueLabelsFromPr,
  resolveWorkerFromPr, resolveReviewerFromPr, listPrReviews, planWorkerDone,
  completeWorkerDoneNotify, pickWorkerDoneDispatchId, linkedIssueNumbers,
} from './dispatch/worker-done.mjs';

// #762 拆分：审官闭环域移到 scripts/lib/dispatch/reviewer.mjs（保持对外 API 不变）
import {
  reviewerCardName, collectReviewerCardsForPr, gateReviewerCreate, resolveReviewerReuse,
  currentReviewerSeat, assertReviewerSeat, planAfterSettledReviewer, planReviewerCreateAfterFail,
  classifyReviewerSpawnError, reviewerSpawnFailComment, postIssueComment, postPrComment,
  commentAlreadyPosted, listComments, postCommentOnce, REVIEWER_CREATE_OUTCOMES,
  pickMergePolicyFromLedger, resolveReviewerMergePolicy, planReviewerAttachReuse,
  planReviewerDone, preflightReviewer,
} from './dispatch/reviewer.mjs';
export {
  reviewerCardName, collectReviewerCardsForPr, gateReviewerCreate, resolveReviewerReuse,
  currentReviewerSeat, assertReviewerSeat, planAfterSettledReviewer, planReviewerCreateAfterFail,
  classifyReviewerSpawnError, reviewerSpawnFailComment, postIssueComment, postPrComment,
  commentAlreadyPosted, listComments, postCommentOnce, REVIEWER_CREATE_OUTCOMES,
  pickMergePolicyFromLedger, resolveReviewerMergePolicy, planReviewerAttachReuse,
  planReviewerDone, preflightReviewer,
} from './dispatch/reviewer.mjs';

// #762 拆分：卡名/消歧门/label 域与任务书模板域移到 dispatch/card.mjs + dispatch/template.mjs
import {
  ghLabelNames, ensureRepoLabels, stampIssueLabels, syncPrLabelsFromIssue, dispatchComment,
  parseDispatchComment, progressDispatchComment, planStampIssueLabels,
} from './dispatch/card.mjs';
export {
  ghLabelNames, ensureRepoLabels, stampIssueLabels, syncPrLabelsFromIssue, dispatchComment,
  parseDispatchComment, progressDispatchComment, planStampIssueLabels,
} from './dispatch/card.mjs';
import {
  DISPATCH_TEMPLATE_DIR, listDispatchTemplates, readDispatchTemplate, renderDispatchTemplate,
  INJECT_MAX_BYTES, INJECT_OVER_LIMIT_HINT, INJECT_GATE_SCOPE, ORCA_WORKER_PREAMBLE_BYTES_MEASURED,
  INJECT_GATE_NOTE, injectUtf8Bytes, stripInjectEof, assertInjectText, assertInjectLen,
  buildSoldierInject, buildBatchInject, buildReviewerInject,
} from './dispatch/template.mjs';
export {
  DISPATCH_TEMPLATE_DIR, listDispatchTemplates, readDispatchTemplate, renderDispatchTemplate,
  INJECT_MAX_BYTES, INJECT_OVER_LIMIT_HINT, INJECT_GATE_SCOPE, ORCA_WORKER_PREAMBLE_BYTES_MEASURED,
  INJECT_GATE_NOTE, injectUtf8Bytes, stripInjectEof, assertInjectText, assertInjectLen,
  buildSoldierInject, buildBatchInject, buildReviewerInject,
} from './dispatch/template.mjs';

// ── 闭环投递（发不到必须炸，#548 红项 1）──────────────────────────
//
// 为什么判据放在「发之前」而不是 delivered_at：
// orca orchestration send 对**不存在的 handle** 也返回 exit 0 / ok:true / delivered_at:null；
// 而对**活着的 handle**（自发自收实测）返回的同样是 delivered_at:null。
// 也就是说 delivered_at 在本机这版 Orca 上分不开「链断了」和「刚发出去」，
// 拿它当门 = 每条都判红的假守卫。真正能分辨收件人在不在的只有两处：
//   term_ handle → terminal read 报 terminal_handle_stale
//   run: 信箱    → run-show 报 run_not_found
// 所以：投递前先证收件人在，投递后核回执与落库，delivered_at 只如实报出、不当唯一判据。

// #762 拆分：闭环投递域移到 scripts/lib/dispatch/deliver.mjs（保持对外 API 不变）
import {
  planWorkerDoneSend, readDispatchSettlement, isWrongPaneWorkerDoneError, planCallerRun,
  extractRunId, classifyNotifyTarget, extractSoldierTerminal, extractDispatchRunId,
  extractDispatchWorktreeId, isSoldierReworkHop, isCompletedDispatchProbe,
  isLiveDispatchRecipient, probeRecipient, extractSentMessage, findInboxMessage,
  deliverMessage, settleDispatch, pickDispatchAgentTerminal, resolveSendTarget,
  COORDINATOR_TITLE, isCoordinatorTerminal, pickCoordinatorHandle, resolveIdentitySender,
  planIdentityKeep,
} from './dispatch/deliver.mjs';
export {
  planWorkerDoneSend, readDispatchSettlement, isWrongPaneWorkerDoneError, planCallerRun,
  extractRunId, classifyNotifyTarget, extractSoldierTerminal, extractDispatchRunId,
  extractDispatchWorktreeId, isSoldierReworkHop, isCompletedDispatchProbe,
  isLiveDispatchRecipient, probeRecipient, extractSentMessage, findInboxMessage,
  deliverMessage, settleDispatch, pickDispatchAgentTerminal, resolveSendTarget,
  COORDINATOR_TITLE, isCoordinatorTerminal, pickCoordinatorHandle, resolveIdentitySender,
  planIdentityKeep,
} from './dispatch/deliver.mjs';

export {
  REVIEW_PENDING_KIND, REVIEW_PENDING_VERSION, reviewPendingDir, reviewPendingPath,
  buildReviewPendingTicket, writeReviewPending, readReviewPending, listReviewPending,
  planReviewPendingDrain, consumeReviewPending, drainReviewPending,
} from './dispatch/review-pending.mjs';

// ── 逃生口留痕 ──────────────────────────────────────────────────────

export function recordEscape({ argv, ts = new Date().toISOString(), cwd = process.cwd() } = {}, logPath = ESCAPE_LOG) {
  if (!argv || !argv.length) throw new Error('逃生口没给命令');
  mkdirSync(dirname(logPath), { recursive: true });
  const line = JSON.stringify({ ts, cwd, argv: [...argv] });
  appendFileSync(logPath, `${line}\n`, 'utf8');
  return logPath;
}

// ── CLI 参数 ────────────────────────────────────────────────────────

export const VERBS = [
  'dispatch', 'dispatch-exec', 'start', 'worktree-create', 'worktree-rm', 'task-create',
  'worker-start', 'worker-release', 'worker-read', 'worker-done', 'reviewer-create', 'reviewer-attach',
  'reviewer-done', 'review-pending-drain', 'send', 'notify', 'reply',
  'gate-create', 'gate-resolve', 'gate-list', 'liveness', 'check-help', 'pr-sync-labels', 'ledger-query', 'amend', 'next',
  'inbox-collect', 'run-gc', 'ask', 'board-archive', 'board-reset', 'preflight', 'raw',
];

const BOOL_FLAGS = new Set(['no-parent', 'force', 'enter', 'dry-run', 'json', 'confirm', 'unclosed', 'apply', 'peek', 'skip-wait', 'allow-dup', 'no-preflight']);
const MULTI_FLAGS = new Set(['slice']);

export const FLAGS_BY_VERB = {
  start: new Set(['--provider', '--model', '--worktree', '--title', '--dry-run', '--json', '--help', '-h']),
  dispatch: new Set([
    '--name', '--merge-policy', '--merge-reason', '--split', '--split-reason', '--slice', '--model', '--role', '--reviewer', '--confirm',
    '--spec', '--task', '--issue', '--now', '--batch', '--dry-run', '--allow-dup', '--no-preflight', '--json', '--help', '-h',
  ]),
  preflight: new Set(['--model', '--json', '--help', '-h']),
  'dispatch-exec': new Set(['--order', '--json', '--help', '-h']),
  'worktree-create': new Set([
    '--name', '--no-parent', '--setup', '--parent-worktree', '--base-branch',
    '--issue', '--comment', '--json', '--help', '-h',
  ]),
  'worktree-rm': new Set(['--worktree', '--force', '--json', '--help', '-h']),
  'task-create': new Set(['--spec', '--run', '--agent', '--json', '--help', '-h']),
  'worker-start': new Set([
    '--task', '--worktree', '--terminal', '--retry-of', '--issue', '--merge-policy', '--merge-reason',
    '--model', '--role', '--reviewer', '--confirm', '--now', '--json', '--help', '-h',
  ]),
  'worker-release': new Set(['--dispatch', '--retry-request', '--json', '--help', '-h']),
  'worker-read': new Set(['--dispatch', '--source', '--cursor', '--limit', '--json', '--help', '-h']),
  'worker-done': new Set([
    '--pr', '--body', '--body-file', '--parent-worktree', '--soldier-dispatch', '--from',
    '--dry-run', '--json', '--help', '-h',
  ]),
  'reviewer-create': new Set([
    '--pr', '--name', '--reviewer', '--parent-worktree', '--comment', '--issue',
    '--soldier-dispatch', '--merge-policy', '--merge-reason', '--from', '--dry-run', '--no-preflight', '--json', '--help', '-h',
  ]),
  'reviewer-done': new Set(['--pr', '--dry-run', '--json', '--help', '-h']),
  'reviewer-attach': new Set([
    '--pr', '--worktree', '--reviewer', '--name', '--soldier-dispatch', '--spec',
    '--merge-policy', '--merge-reason', '--comment', '--issue', '--skip-wait', '--run',
    '--start-timeout-ms', '--model', '--from', '--dry-run', '--no-preflight', '--json', '--help', '-h',
  ]),
  'review-pending-drain': new Set(['--pr', '--dry-run', '--json', '--help', '-h']),
  send: new Set(['--terminal', '--dispatch', '--text', '--enter', '--agent', '--json', '--help', '-h']),
  notify: new Set([
    '--to', '--subject', '--body', '--type', '--outcome', '--hop',
    '--task-id', '--dispatch-id', '--dispatch-capability', '--from',
    '--files-modified', '--report-path',
    '--json', '--help', '-h',
  ]),
  reply: new Set(['--id', '--body', '--from', '--run', '--json', '--help', '-h']),
  'inbox-collect': new Set(['--peek', '--json', '--help', '-h']),
  'run-gc': new Set(['--apply', '--json', '--help', '-h']),
  'board-archive': new Set(['--out', '--json', '--help', '-h']),
  'board-reset': new Set(['--apply', '--out', '--json', '--help', '-h']),
  ask: new Set(['--question', '--options', '--timeout-ms', '--run', '--json', '--help', '-h']),
  'gate-create': new Set(['--task', '--question', '--options', '--from', '--json', '--help', '-h']),
  'gate-resolve': new Set(['--id', '--resolution', '--from', '--json', '--help', '-h']),
  'gate-list': new Set(['--task', '--status', '--run', '--json', '--help', '-h']),
  liveness: new Set(['--path', '--json', '--help', '-h']),
  'check-help': new Set(['--json', '--help', '-h']),
  'pr-sync-labels': new Set(['--pr', '--json', '--help', '-h']),
  'ledger-query': new Set(['--recent', '--issue', '--unclosed', '--json', '--help', '-h']),
  amend: new Set(['--issue', '--pr', '--why', '--by', '--model', '--dry-run', '--json', '--help', '-h']),
  next: new Set(['--help', '-h']),
};

export function verbFlagGaps(verbs = VERBS, table = FLAGS_BY_VERB) {
  return verbs.filter(v => v !== 'raw' && !table[v]);
}

function camelFlag(s) {
  return s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

export function parseArgs(argv) {
  const rest = argv.slice(2);
  if (rest.length === 0 || rest[0] === '--help' || rest[0] === '-h') {
    return { verb: 'help' };
  }
  const verb = rest[0];
  if (verb === 'raw') {
    const dd = rest.indexOf('--', 1);
    const cmd = dd >= 0 ? rest.slice(dd + 1) : rest.slice(1);
    if (cmd.length === 0) throw new Error('raw 后面要有命令（dao raw -- <命令>）');
    return { verb: 'raw', cmd };
  }
  if (!VERBS.includes(verb)) throw new Error(`未知动词: ${verb}（只要 ${VERBS.join(' / ')}）`);
  const allowed = FLAGS_BY_VERB[verb];
  if (!allowed) throw new Error(`动词 ${verb} 没登记参数表`);
  const args = { verb };
  for (let i = 1; i < rest.length; i++) {
    const a = rest[i];
    const flag = a.split('=')[0];
    if (flag === '--help' || flag === '-h') { args.help = true; continue; }
    if (!flag.startsWith('--')) throw new Error(`未知参数: ${a}`);
    if (!allowed.has(flag)) throw new Error(`未知参数: ${flag}`);
    const key = flag.slice(2);
    if (BOOL_FLAGS.has(key)) { args[camelFlag(key)] = true; continue; }
    const val = rest[++i];
    if (val == null || String(val).startsWith('--')) throw new Error(`参数 --${key} 缺值`);
    const ck = camelFlag(key);
    if (MULTI_FLAGS.has(key)) {
      if (!Array.isArray(args[ck])) args[ck] = [];
      args[ck].push(val);
      continue;
    }
    args[ck] = val;
  }
  return args;
}

export const USAGE = `用法: node scripts/dao.mjs <verb> [args]

派工（约束载体，缺一即退；merge-policy 默认 auto）：
  dispatch --name <动宾短语> [--issue <issue号>] [--merge-policy auto|manual] [--merge-reason <文>] --split <no|N> [--split-reason <文>] [--slice <分块>]... --reviewer <模型id> --spec <文> (--model <id> | --role <角色>) [--confirm] [--dry-run] [--allow-dup]
                  # 异步发射（2026-08-23 async-launch 拍板）：热路只做参数校验+写派工单到 _flow/queue/+拉起 detached 执行体，<1s 返回「已受理」；
                  # 消歧门/账本查重（索引增量读，不再全量扫账本）/建卡/起终端/送字/记账都在后台执行体，结果落 _flow/queue/<id>.out.json；
                  # 10 分钟内同 issue 已有未结派工 → 执行体拒派（防 #759 重复建卡；队列内在途单也算）；确要重派加 --allow-dup
  dispatch-exec --order <派工单路径>
                  # 内部动词：dispatch 拉起的后台执行体；结果落 <id>.out.json（派工失败请重派，不要手动重跑——复用旧 Run 会 consumer_fenced，见 #762）
  dispatch --batch <file.json> --name <批名> --issue <号> --model <id> [--dry-run]
                  # 一批只读工人共享 1 张卡：建 1 棵树，循环 N 次 task-create + worker-start
                  # 不产 PR，硬编码跳过审官与 --split；--dry-run 只打印 N 条计划（name/spec/handle 占位）
启动:
  start --provider <名> | --model <id> --worktree <sel> [--title <名>] [--dry-run]
                  # #633：空壳先关；认识的 agent 走 worker-start --agent；reclaude 走 --command；禁止 send 进 pwsh
编排:
  worktree-create --name <动宾短语> [--issue <issue号>] [--no-parent] [--setup skip] [--parent-worktree <sel>] [--base-branch <ref>] [--comment <文>]
  reviewer-create --pr <N> [--name <名>] [--reviewer <模型id>] [--parent-worktree <sel>] [--comment <文>] [--issue <号>] [--soldier-dispatch <id>] [--from <handle>] [--dry-run]
                  # 不传 --reviewer 时自读署名 issue 的 reviewer/*（#586）；工人路径不传模型
                  # 建树后空壳先关再 create --command（#633）；--dry-run 只打印选型不建树
                  # #575 ⑦：mergeable!=MERGEABLE 拒建树；建树后试合 master 再 abort，HEAD 仍停在 PR head
                  # #679：工人审官同厂当场拒；工人模型没查成 / 扫完没有 model/* 都拒绝起审官
                  # 一 PR 一审官：已有审官树/卡则复用或拒绝新建，不许再 create（防 Orca -2/-3）；失败停手报，不许换厂
                  # #799：士兵 dispatch 已结算 → d= 留空仍起审官（红项上帅），整跳不败；merge-policy 继承派工记账，读不到才回退 auto 并 fb= 写原因
                  # #826：身份消息失败不整树回滚（树与终端保留，只记红项并提示 notify --from 补发）
                  # #826：--from 显式发信人；读不到时自动取该树「派工协调（勿关）」终端。--skip-wait 是 reviewer-attach 的旗标，本动词没有
  worker-done --pr <N> [--body <文> | --body-file <文件>] [--parent-worktree <工人卡>] [--soldier-dispatch <id>] [--from <handle>] [--dry-run]
                  # 交卷：发完工/返工 comment；无审官卡才 reviewer-create；已有则复用；终端已关也不许再建；失败停手不许换厂；两条路径都 notify 审官（投失败即停）
                  # #677：成功路径不结算士兵 Dispatch。判定绿才允许 notify --type worker_done。失败不得假装已下班。
                  # #826：身份消息失败不整树回滚；--from 与 reviewer-create 同口径
  reviewer-done --pr <N> [--dry-run]
                  # #826：审官合法收口，不需要 Run id / task-id / dispatch-id。PR 已合 + 审官已 approve 即过
                  # 给帅手起的审官、或士兵已结算（d= 空）一条不伪造身份的下班路径
  reviewer-attach --pr <N> --worktree <工人卡> --reviewer <模型id> [--name <名>] [--soldier-dispatch <id>] [--spec <文>] [--skip-wait] [--model <工人模型>]
                  # 给已有工人卡补派审官（#575）：建树+空壳先关再 create --command（#633）+验开工，一条命令，不碰 raw
                  # #679：与工人同厂当场拒（#678 实咬的口），不许 attach 成工人那一厂
                  # #631：树→PR 归属校验（树的 issue/分支对不上 PR 当场拒）；士兵 dispatch 注入前 worker-show 复核活性，已结算禁止当收件人（#552）
                  # #631：--skip-wait 显式跳过等完工——worker-done 失败后补审官时工人不会再发完工，硬等烧 600s；
                  #       d= 只给 worker-show 确认活的 dispatch（显式 --soldier-dispatch 同闸）：已结算 → 红项上帅；
                  #       worker-show 没查成 → 拒（不许当活人）；没有 → 空（红项上帅，见 reviewer-book 第 1 步）
                  # #799：merge-policy 继承派工记账（账本 / 卡备注）；读不到才回退 auto，任务书 fb= 写明回退原因
                  # #815：复用旧审官前 worker-read 核活性，不活或已结算就新建树；建树前 fetch origin/<分支> 按远端检出
                  # #815：--model 显式指定工人模型（接手派单多个 model/* 时不许猜）
  review-pending-drain [--pr <N>]
                  # #815：消费 _flow/queue/review-pending/<pr>.json，逐条 reviewer-attach --skip-wait（供 #800 轮转）
                  # worker-done 起审官失败时写队列；扫完 0 条是空转成功，目录读不了才没查成
  pr-sync-labels --pr <N>   # 合并前把署名 issue 的 model/* type/* reviewer/* label 同步到 PR（#564 + #586）
  worktree-rm --worktree <sel> [--force]
                  # 一条命令整树后序删（子卡先于父卡）。任一棵有 working/waiting agent 则整树不删，报清是哪棵
                  # #826：PR 已合并且审官已 approve 时，working/waiting 不挡归档（审官 d= 空无法结算的兜底）
                  # 树内 ledger/events 有未进本机账本（~/.dao/ledger/events）的事件文件 → 整树不删，报清是哪几条
                  # #593：同一动作退役该单不再被其它在途树占用的 Run（关信箱台 + 删租约）
  inbox-collect [--peek]
                  # 按在途单的 Run 收信箱。三态：empty / unscanned / run_not_found。默认 --peek 不标已读
  run-gc [--apply]
                  # 列出无在途单对应的 Run；--apply 才关台退役。在途的不许退役
盘面（重测派单前的存档与清盘；存档只留本机 ~/.dao/board-archive/，不进 git）：
  board-archive [--out <目录>]
                  # 全量存档（卡片/终端/workers/Run/信箱）→ board-<时间戳>.{json,md}
                  # 任何一节没查成：存档照写（标 unscanned）但非零退出——没查成 ≠ 扫完是空的
  board-reset [--apply] [--out <目录>]
                  # 默认 dry-run 只列将删/将跳过的卡，不改态
                  # --apply：先存档再逐卡整树删（复用 worktree-rm 的占用闸与账本孤本闸）+ 收尾 run-gc
                  # 硬闸：任何一节盘面没查成 → 一张都不删；主树永不删；占用中的卡跳过并列清原因
  ask --question <文> [--options <csv>] [--timeout-ms <n>] [--run <id>]
                  # 替代 orca orchestration ask：超时打 ASK_TIMEOUT 非零退出，不许空转
  task-create --spec <文>
  worker-start --task <id> --terminal <handle> [--worktree <sel>] [--issue <issue号>] [--merge-policy auto|manual] [--merge-reason <文>] --reviewer <id> (--model <id> | --role <角色>) [--confirm] [--retry-of <id>]
  worker-release --dispatch <id>   # 结算后收尾：release 或转移所有权（#559 ⑤），不 release 会留孤儿工位
  worker-read --dispatch <id> [--source auto|transcript|terminal] [--limit <n>]   # 读工人输出/开工证明（#559 ⑥）
  send (--terminal <handle> | --dispatch <id>) --text <文> [--enter] [--agent grok|claude|pi|codex]
                  # grok 发送前把 \\n 转成 ESC+CR（Alt+Enter）；claude/pi 原样；codex 不转（换行留不住）
                  # #802/#815：--dispatch 用 worker-read 的 terminal.handle（真 agent），不要信派工单 workerHandle（常是空壳）
  notify --subject <文> [--to <term_…|run:…|dispatch:…>] [--body <文>] [--type <类>] [--outcome succeeded|failed] [--hop <跳名>]
                  [--task-id <id> --dispatch-id <id> --from <handle> --dispatch-capability <token>]
                  # 普通通知：dispatch: 活人直接投递。hop 审官→士兵 打进还活着的 id；已完工 fail-visible，不开下一跳救人（#677）
                  # --type worker_done：省略 --to，必须带 --task-id/--dispatch-id/--outcome；发出后核 Dispatch 变 completed（#551）。士兵侧判定绿才允许发。
  reply --id <消息id> --body <回答> [--from <handle>] [--run <id>]
                  # 帅回答工人的 ask。不抢信箱台：缺 --from 时自动用该 Run 的 coordinator_handle
  gate-create --task <task_id> --question <问题> [--options <json数组>]   # 上帅裁定建原生决策门（#559 ④）
  gate-resolve --id <gate_id> --resolution <裁定>                          # 帅裁定决议门
  gate-list [--task <task_id>] [--status <状态>]
其他:
  liveness [--path <工作树>]
  check-help
  next                        # 盘面动作候选一行（#576）：只读本地文件零 GitHub；standby 态不含「待消歧」
  ledger-query (--recent <n> | --issue <号> | --unclosed)
                  # 按事件 ts 查账本，不按文件 mtime、不 grep 数字。查到 0 条 ≠ 没查成
  preflight --model <id> [--json]
                  # 派前探一针（#842）：同路径流式探一次，输出与 ~/.dao/preflight ndjson 同形（只读，不建卡不起终端）
                  # 派工/审官起终端前自动探（红换下一位、全红报帅停手）；单次跳过用 dispatch/reviewer-create 的 --no-preflight
  amend --issue <号> --why <一句话> [--pr <号>] [--by 帅|用户] [--model <id>]
                  # 帅追加职责：写 job.override(scope) 并往 issue 发正文。不靠「记得记一条」
  raw -- <任意命令...>     逃生口，必须留痕

notify 是闭环三跳（士兵→审官 / 审官→士兵 / 审官→帅）唯一的发信口：收件人不在、回执拿不到、
落库查不到，一律非零退出并在 stderr 打「链断」，不许当「发成功了只是还没读」。
收件人形态：dispatch:<id>（官方结构化收件箱，士兵↔审官互发用；#559 ①）、run:…（审官→帅）、
term_…（低层通道）、省略（自己那条 Run 信箱）。
delivered_at 只如实报出，不当判据（本机 Orca 对活着的收件人也常留 null，当门就是天天假红）。
普通 notify 验的是**投递**不是**结算**：ok:true 只说明消息进了收件人信箱。
--type worker_done 是结算口（#551）：必须带 --task-id/--dispatch-id/--outcome，省略 --to，
发出后核 worker-show Dispatch 为 completed。缺身份、错 pane、落库但未 completed
一律非零并报「未结算」。状态没查成标 unscanned，不许当成「查过仍是 dispatched」。

启动模板只读 docs/model-routing.toml [providers.*].launch，读失败非零退出。
派工不给 --model 时只推荐、要 --confirm，禁静默默认；手写 --model 偏离该工种（默认写码）顺位 1 也要 --confirm（#754）。未知 --参数 一律非零。
merge-policy 默认 auto（#511 拍板：帅只感知不再是关口）；选 manual 必须给 --merge-reason，
理由写进任务卡 comment 留痕，只限改协作约定 / 改 model-routing.toml 决策字段 / 花钱三类。
--split 必填（#611）：no 或 ≥2 的整数；两个都不给 → 非零退出。--split no 必须给 --split-reason（理由入账本）。
--split N 建父卡 + N 张子卡（子卡 --parent-worktree 挂父卡、--base-branch 用任务分支），父卡工人是头工人。
--split N 必须给 N 个 --slice（每块一份非空、互不重叠的分块说明；抽到的文件路径不得跨块）。失败回滚先 worker-stop / task-update failed，再关终端删树。
判据：产出物能不能按文件切开？能切 + 块数 ≥2 + 每块够一个工人干 → --split N；切不开（同几个文件反复改）→ --split no + 理由。
worker-start 的 --worktree 可省略：复用已存在终端续 Dispatch（worker_done 后同一终端绑到新 Task，
#559 ②）时工作区由终端决定；新开工人位仍建议显式给 --worktree。
换人（乒乓两轮仍红）走 worker-start --task <同单> --retry-of <旧 dispatch id>，不重开一单（#559 ⑦）。
续活/审官场景的 merge-policy 约束：新开派工语义。reviewer-create / reviewer-attach 继承派工记账的 merge-policy（#799）；读不到记账才回退默认 auto，并在任务书 fb= 写明原因。flow.mjs 内部不归本动词管，见 dispatch skill。
给了 --issue 时卡名走 assembleCardName（#589：格式只认那一处，本页不复制；号对不上也不拿名字当钥匙）。
并把 --issue 透传给 orca worktree create 把卡链到 GitHub issue（派工那一刻 PR 不存在，卡名先带 ISSUE-）。
dispatch / worker-start 带 --issue 时走消歧门（#565）：目标 issue 缺「已消歧」label 拒派（fail-close）——
去该 issue 补消歧记录再打「已消歧」label（dao-project skill 第二节）；gh 查失败单独报「没查成」，不许当有 label 放行。
dispatch 的消歧门在后台执行体里（async-launch）：被拦 = <id>.out.json 落 ok:false，热路退出码只管「受没受理」。
dispatch --dry-run 不走门控（不实际派工，disambiguation 只作报告，不影响退出码；#565 返工）。无 --issue 的派工不受门控（辅助终端不经 dispatch）。
`;
