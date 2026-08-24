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
} from './dispatch/launch.mjs';

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

/** 从 worker-list JSON 里找某棵树的士兵 dispatch。没查成与查到 0 条分开。 */
export function findDispatchForWorktree(workerListJson, worktreeSel) {
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
  const live = hits.filter(w => isLiveDispatchRecipient({
    workerState: w.workerState, dispatchStatus: w.dispatchStatus,
  }));
  const ready = live.filter(w => w.workerState === 'ready' || w.workerState === 'working'
    || w.dispatchStatus === 'dispatched' || w.dispatchStatus === 'running');
  const pick = ready[0] || live[0];
  if (!pick) {
    return {
      ok: false,
      unscanned: false,
      error: `worktree=${sel} 只有已结算 dispatch，禁止当收件人（#552：下一跳必须新 Dispatch）`,
      scanned: workers.length,
      deadCount: hits.length,
    };
  }
  if (!pick.dispatchId) {
    return { ok: false, error: `worktree=${sel} 的记账没有 dispatchId`, scanned: workers.length };
  }
  return { ok: true, dispatchId: pick.dispatchId, taskId: pick.taskId || null, runId: pick.runId || null, scanned: workers.length };
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

export function rollbackErrorAlreadyGone(error) {
  return /tab_not_found|terminal_handle_stale|dispatch_not_found|already_stopped|already_fenced|already_released|task_not_found|already_failed/i.test(orcaErrorText(error));
}

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

export function gitCapture(cwd, args) {
  if (!cwd) return { ok: false, error: 'git 没给工作区路径' };
  const r = spawnSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8', windowsHide: true, timeout: 15000,
  });
  if (r.error || (r.status !== 0 && r.status != null)) {
    return { ok: false, error: String(r.error?.message || r.stderr || `git exit ${r.status}`).trim().slice(0, 200) };
  }
  return { ok: true, out: String(r.stdout || '').trim() };
}

export function gitHeadOid(cwd) {
  const r = gitCapture(cwd, ['rev-parse', 'HEAD']);
  if (!r.ok) return r;
  if (!/^[0-9a-f]{7,40}$/i.test(r.out)) return { ok: false, error: `git HEAD 不是 oid：${r.out.slice(0, 80)}` };
  return { ok: true, oid: r.out };
}

export function gitBranchName(cwd) {
  const r = gitCapture(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (!r.ok) return r;
  if (!r.out || r.out === 'HEAD') return { ok: false, error: '工作区处于 detached HEAD，推不出分支名' };
  return { ok: true, branch: r.out };
}

/** #762：git remote get-url origin，用于 repo 选择符匹配（执行体可能跑在任意 worktree）。 */
export function gitRemoteOriginUrl(cwd) {
  const r = gitCapture(cwd, ['remote', 'get-url', 'origin']);
  if (!r.ok) return r;
  const out = String(r.out || '').trim();
  if (!out) return { ok: false, error: 'git remote get-url origin 返回空（没查成）' };
  return { ok: true, url: out };
}

/**
 * #575 ⑦：审官开审前对齐 master。
 * rebase 会改 commit sha → review.commit_id != headRefOid → APPROVED 当场失效
 * （判例 review-green-must-match-head）。所以只能先对齐 → 再审 → 再合。
 *
 * mergeable 三态必须分开：MERGEABLE / CONFLICTING / UNKNOWN。
 * UNKNOWN 是「GitHub 还在算」，不是绿——没查成，不许当 MERGEABLE 放行。
 */
export function assessPrMergeable(raw) {
  const v = String(raw ?? '').trim().toUpperCase();
  if (v === 'MERGEABLE') return { ok: true, mergeable: 'MERGEABLE' };
  if (v === 'CONFLICTING') {
    return {
      ok: false,
      mergeable: 'CONFLICTING',
      error: '先让工人 rebase master，别派审官白审（mergeable=CONFLICTING）',
    };
  }
  if (!v || v === 'UNKNOWN') {
    return {
      ok: false,
      unscanned: true,
      mergeable: v || null,
      error: `mergeable=${v || '空'}——GitHub 还在算或没查成，不许当 MERGEABLE 放行`,
    };
  }
  return {
    ok: false,
    unscanned: true,
    mergeable: v,
    error: `mergeable 值不认识：${v}——没查成，不许当绿放行`,
  };
}

function gitRun(cwd, args, runGit) {
  if (typeof runGit === 'function') return runGit(args);
  return gitCapture(cwd, args);
}

/**
 * 试合 origin/master（或 origin/main），记录落后数/冲突/触及文件，然后 --abort。
 * 树必须停在原 HEAD：审官审的是 PR head，expectedOid 校验才有意义。
 *
 * 顺序陷阱：rebase 会改 commit sha，导致 review.commit_id != headRefOid、
 * 审官的 APPROVED 失效（判例 review-green-must-match-head）。
 * 只能「先对齐 master → 再审 → 再合」，不能审完再 rebase。
 */
export function trialMergeMaster({ cwd, runGit } = {}) {
  if (!cwd && typeof runGit !== 'function') {
    return { ok: false, unscanned: true, error: 'trialMergeMaster 没给工作区' };
  }
  const run = (args) => gitRun(cwd, args, runGit);
  const head = run(['rev-parse', 'HEAD']);
  if (!head.ok) return { ok: false, unscanned: true, error: `试合前 HEAD 没查成：${head.error}` };
  const before = head.out;

  let base = 'origin/master';
  const hasMaster = run(['rev-parse', '--verify', 'origin/master']);
  if (!hasMaster.ok) {
    const hasMain = run(['rev-parse', '--verify', 'origin/main']);
    if (!hasMain.ok) {
      return { ok: false, unscanned: true, error: 'origin/master 与 origin/main 都没有——试合没查成' };
    }
    base = 'origin/main';
  }

  const behindR = run(['rev-list', '--count', `HEAD..${base}`]);
  if (!behindR.ok) return { ok: false, unscanned: true, error: `落后 commit 数没查成：${behindR.error}` };
  const behind = Number(behindR.out);
  if (!Number.isFinite(behind)) {
    return { ok: false, unscanned: true, error: `落后 commit 数不是数字：${behindR.out}` };
  }

  const touchedR = run(['diff', '--name-only', `HEAD...${base}`]);
  const masterFiles = touchedR.ok
    ? String(touchedR.out || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean)
    : [];

  const merge = run(['merge', base, '--no-commit', '--no-ff']);
  // 冲突只认未合并文件。merge 非零可能是没配 user.name（CI 实证 #578）——那是没查成，不是冲突。
  const unmerged = run(['diff', '--name-only', '--diff-filter=U']);
  const conflict = !!(unmerged.ok && String(unmerged.out || '').trim());
  if (!merge.ok && !conflict) {
    run(['merge', '--abort']);
    return {
      ok: false,
      unscanned: true,
      behind,
      masterFiles,
      error: `试合没跑成（不是冲突）：${merge.error}`,
    };
  }
  const abort = run(['merge', '--abort']);
  // 没进合并时 abort 会失败——只要 HEAD 还原且工作区干净就算成功。
  const after = run(['rev-parse', 'HEAD']);
  if (!after.ok) {
    return { ok: false, error: `试合后 HEAD 没查成：${after.error}`, behind, conflict, masterFiles };
  }
  if (after.out !== before) {
    return {
      ok: false,
      error: `试合后 HEAD ${after.out} ≠ 原 ${before}（--abort 没还原，审官树漂了）`,
      behind, conflict, masterFiles, head: after.out, expectedOid: before,
    };
  }
  const st = run(['status', '--porcelain']);
  if (!st.ok) return { ok: false, error: `试合后 git status 没查成：${st.error}`, behind, conflict };
  if (String(st.out || '').trim()) {
    return {
      ok: false,
      error: `试合后工作区不干净（--abort 有残留）：${String(st.out).slice(0, 120)}`,
      behind, conflict, masterFiles,
    };
  }
  return {
    ok: true,
    behind,
    conflict,
    clean: true,
    base,
    masterFiles,
    head: before,
    abortOk: abort.ok,
    hint: behind === 0
      ? '与 master 同步'
      : conflict
        ? `落后 ${behind} 个 commit，试合有冲突——工人应先 rebase`
        : `落后 ${behind} 个 commit，试合无冲突。重点核这 ${behind} 个 commit 碰过的文件与本 PR 的交集`,
  };
}

export function verifyReviewerTree({ workerPath, reviewerPath, expectedOid } = {}) {
  const rev = gitHeadOid(reviewerPath);
  if (!rev.ok) return { ok: false, error: `审官树 HEAD 没查成：${rev.error}` };
  let want = expectedOid || null;
  if (!want) {
    const w = gitHeadOid(workerPath);
    if (!w.ok) return { ok: false, error: `工人树 HEAD 没查成：${w.error}` };
    want = w.oid;
  }
  if (rev.oid !== want) {
    return {
      ok: false,
      error: `审官树 HEAD ${rev.oid} ≠ 期望 ${want}（在审空气）`,
      reviewerHead: rev.oid,
      expectedOid: want,
    };
  }
  return { ok: true, reviewerHead: rev.oid, expectedOid: want };
}

export function verifyReviewerFiles({ reviewerPath, files } = {}) {
  if (!Array.isArray(files)) {
    return { ok: false, error: '被审文件清单没查成', missing: [], unscanned: true };
  }
  const missing = [];
  for (const f of files) {
    if (!existsSync(join(reviewerPath, f))) missing.push(f);
  }
  if (missing.length) return { ok: false, error: `审官树缺被审文件 ${missing.length} 个`, missing };
  return { ok: true, checked: files.length, missing: [] };
}

/** GitHub pull file 列表：跳过 removed，取 filename。没查成时返回 null。 */
export function parseGhPullFiles(json) {
  if (!Array.isArray(json)) return null;
  return json
    .filter(f => f && f.status !== 'removed' && f.filename)
    .map(f => f.filename);
}

export function parseDiffNameStatus(text) {
  const mustExist = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    const status = line.slice(0, tab).trim();
    const rest = line.slice(tab + 1);
    if (!status || status[0] === 'D') continue;
    const parts = rest.split('\t');
    mustExist.push(parts[parts.length - 1]);
  }
  return mustExist;
}

export function runGh(args, { cwd, role } = {}) {
  // role 有值 → 走 GitHub App 身份（#573）。其余裸调用先保持本人 gh，全量替换另开单。
  if (role) return ghAs(role, args, { cwd });
  const r = spawnSync('gh', args, {
    encoding: 'utf8', windowsHide: true, timeout: 30000, cwd,
  });
  if (r.error || (r.status !== 0 && r.status != null)) {
    return { ok: false, error: String(r.error?.message || r.stderr || `gh exit ${r.status}`).trim().slice(0, 240) };
  }
  return { ok: true, out: String(r.stdout || '') };
}

export function envProbeWorktree(cwd) {
  return runCapabilityProbes({ exec: hostProbeExec(cwd) });
}

export function unboundTaskIds({ taskIds, workers } = {}) {
  const bound = new Set((Array.isArray(workers) ? workers : []).map(w => w && w.taskId).filter(Boolean));
  return (Array.isArray(taskIds) ? taskIds : []).filter(id => id && !bound.has(id));
}

export function planDispatchFence({ dispatchIds, taskIds, workers } = {}) {
  const steps = [];
  const seenId = new Set();
  for (const id of (Array.isArray(dispatchIds) ? dispatchIds : []).filter(Boolean).slice().reverse()) {
    if (seenId.has(id)) continue;
    seenId.add(id);
    steps.push(argsWorkerStop({ dispatch: id }));
  }
  const seenTask = new Set();
  for (const id of unboundTaskIds({ taskIds, workers }).slice().reverse()) {
    if (seenTask.has(id)) continue;
    seenTask.add(id);
    steps.push(argsTaskUpdate({ id, status: 'failed' }));
  }
  return steps;
}

export function planDispatchDestroy({
  workerId, workerHandle, reviewerId, reviewerHandle, handles, childIds, childHandles,
} = {}) {
  const steps = [];
  if (reviewerHandle) steps.push(argsTerminalClose({ terminal: reviewerHandle, tab: true }));
  if (reviewerId) steps.push(argsWorktreeRm({ worktree: reviewerId, force: true }));
  for (const handle of Array.isArray(childHandles) ? childHandles : []) {
    if (handle) steps.push(argsTerminalClose({ terminal: handle, tab: true }));
  }
  const extra = Array.isArray(handles) ? handles.filter(Boolean) : [];
  const seen = new Set();
  for (const h of extra.slice().reverse()) {
    if (seen.has(h) || h === workerHandle || h === reviewerHandle) continue;
    if (Array.isArray(childHandles) && childHandles.includes(h)) continue;
    seen.add(h);
    steps.push(argsTerminalClose({ terminal: h, tab: true }));
  }
  if (workerHandle) steps.push(argsTerminalClose({ terminal: workerHandle, tab: true }));
  for (const id of Array.isArray(childIds) ? childIds : []) {
    if (id) steps.push(argsWorktreeRm({ worktree: id, force: true }));
  }
  if (workerId) steps.push(argsWorktreeRm({ worktree: workerId, force: true }));
  return steps;
}

export function planDispatchRollback(created = {}) {
  return [...planDispatchFence(created), ...planDispatchDestroy(created)];
}

export function execRollbackStep(args, exec) {
  let r = exec(args);
  const step = {
    cmd: args.join(' '),
    ok: !!r.ok,
    error: r.ok ? undefined : orcaErrorText(r.error),
  };
  if (!r.ok && rollbackErrorAlreadyGone(r.error)) {
    step.ok = true;
    step.alreadyGone = true;
    step.error = undefined;
  } else if (!r.ok && args[0] === 'terminal' && args[1] === 'close' && args.includes('--tab')) {
    const retryArgs = args.filter(a => a !== '--tab');
    const retry = exec(retryArgs);
    step.retryWithoutTab = {
      cmd: retryArgs.join(' '),
      ok: !!retry.ok,
      error: retry.ok ? undefined : orcaErrorText(retry.error),
    };
    if (retry.ok || rollbackErrorAlreadyGone(retry.error)) {
      step.ok = true;
      step.alreadyGone = !retry.ok;
      step.recovered = !!retry.ok;
      step.error = undefined;
    }
  }
  return step;
}

export function inspectRollbackResidue(created, exec) {
  const ids = Array.isArray(created?.dispatchIds) ? created.dispatchIds.filter(Boolean) : [];
  if (ids.length === 0) return { ok: true, leftover: [], skipped: true, unscanned: false };
  const listed = exec(argsWorkerList());
  if (!listed || !listed.ok) {
    return {
      ok: false,
      unscanned: true,
      leftover: [],
      error: `回滚后 worker-list 没查成：${orcaErrorText(listed && listed.error)}`,
    };
  }
  const workers = listed.json?.result?.workers;
  return classifyDispatchResidue({ dispatchIds: ids, workers });
}

/**
 * 生产回滚：先 fence（worker-stop + 未绑定 task 置 failed），再 worker-list 核残留。
 * 没查成或仍有活动 Dispatch → fail-visible，不删树。
 */
export function applyDispatchRollback(created, { exec } = {}) {
  if (typeof exec !== 'function') {
    return {
      ok: false,
      rollback: [],
      rollbackFailed: true,
      residue: { ok: false, unscanned: true, leftover: [], error: 'applyDispatchRollback 没拿到 exec（没查成）' },
      alarm: 'applyDispatchRollback 没拿到 exec（没查成）',
    };
  }
  const rollback = [];
  for (const args of planDispatchFence(created)) {
    rollback.push(execRollbackStep(args, exec));
  }
  const residue = inspectRollbackResidue(created, exec);
  if (!residue.ok) {
    for (const args of planDispatchDestroy(created)) {
      if (args[0] === 'worktree') continue;
      rollback.push(execRollbackStep(args, exec));
    }
    const report = rollbackReport(rollback);
    const alarm = residue.error || report.alarm;
    return { ok: false, rollback, rollbackFailed: true, residue, alarm };
  }
  for (const args of planDispatchDestroy(created)) {
    rollback.push(execRollbackStep(args, exec));
  }
  const report = rollbackReport(rollback);
  return {
    ok: !report.rollbackFailed,
    rollback,
    rollbackFailed: report.rollbackFailed,
    residue,
    alarm: report.alarm,
  };
}

/** #620：batch JSON → `[{name, spec}, ...]`。数组或 `{workers|items|batch: [...]}` 都收。 */
export function parseDispatchBatchItems(raw) {
  if (raw == null) return { ok: false, error: 'batch 文件是空的' };
  let list = raw;
  if (!Array.isArray(raw)) {
    if (!raw || typeof raw !== 'object') return { ok: false, error: 'batch 要 JSON 数组 [{name, spec}, ...]' };
    list = raw.workers || raw.items || raw.batch;
  }
  if (!Array.isArray(list)) return { ok: false, error: 'batch 要 JSON 数组 [{name, spec}, ...]' };
  if (list.length === 0) return { ok: false, error: 'batch 至少要 1 个工人' };
  const items = [];
  for (let i = 0; i < list.length; i++) {
    const row = list[i];
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      return { ok: false, error: `batch[${i}] 不是对象` };
    }
    const name = String(row.name ?? '').trim();
    const spec = String(row.spec ?? '').trim();
    if (!name) return { ok: false, error: `batch[${i}] 缺 name` };
    if (!spec) return { ok: false, error: `batch[${i}] 缺 spec` };
    items.push({ name, spec });
  }
  return { ok: true, items };
}

export function loadDispatchBatchFile(filePath, { readFile } = {}) {
  const p = String(filePath ?? '').trim();
  if (!p) return { ok: false, error: 'dispatch --batch 要 JSON 文件路径' };
  let text;
  try {
    text = (readFile || readFileSync)(p, 'utf8');
  } catch (e) {
    return { ok: false, error: `batch 文件读不到: ${p}（${String(e.message || e)}）` };
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: `batch 文件不是合法 JSON: ${String(e.message || e)}` };
  }
  return parseDispatchBatchItems(raw);
}

/** #620：一批只读工人的计划。不调审官，卡名就是 --name，不带 --no-parent。 */
export function planDispatchBatch({ name, issue, model, items } = {}) {
  const n = String(name ?? '').trim();
  const issueText = String(issue ?? '').trim();
  const modelId = String(model ?? '').trim();
  if (!n) return { ok: false, error: 'dispatch --batch 要 --name（批卡名）' };
  if (!issueText) return { ok: false, error: 'dispatch --batch 要 --issue（整批共享）' };
  if (!modelId) return { ok: false, error: 'dispatch --batch 要 --model' };

  let parsed;
  if (items && items.ok === true && Array.isArray(items.items)) parsed = items;
  else parsed = parseDispatchBatchItems(items);
  if (!parsed.ok) return parsed;

  const cardName = assembleCardName({ name: n, issue: issueText });
  const workers = [];
  for (let i = 0; i < parsed.items.length; i++) {
    const item = parsed.items[i];
    let inject;
    try {
      inject = buildBatchInject({ spec: item.spec, issue: issueText });
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    }
    workers.push({
      index: i,
      name: item.name,
      spec: item.spec,
      inject,
      handle: `<handle:${i}>`,
      worktree: cardName,
    });
  }
  return {
    ok: true,
    batch: true,
    cardName,
    issue: issueText,
    model: modelId,
    noParent: false,
    reviewerCreate: false,
    workers,
  };
}

/**
 * #620：批量原子编排。effects 由调用方注入（真路径走 orca，单测走假对象）。
 * 失败不自己回滚——调用方拿 created 走 failCreated / planDispatchRollback。
 */
export function runDispatchBatch({ plan, effects } = {}) {
  const created = { handles: [], workers: [], dispatchIds: [], taskIds: [] };
  if (!plan || !Array.isArray(plan.workers)) {
    return { ok: false, error: 'runDispatchBatch 要 plan.workers', created, workers: [] };
  }
  if (!effects) {
    return { ok: false, error: 'runDispatchBatch 要 effects', created, workers: [] };
  }
  const fail = (error) => ({ ok: false, error, created, workers: created.workers });

  const wt = effects.createWorktree({
    name: plan.cardName,
    issue: plan.issue,
    noParent: false,
  });
  if (wt && wt.id) created.workerId = wt.id;
  if (wt && wt.path) created.workerPath = wt.path;
  if (!wt || !wt.ok) return fail(`工人卡创建失败: ${(wt && wt.error) || '未知'}`);

  for (const w of plan.workers) {
    const term = effects.startTerminal({
      worktree: created.workerId,
      title: w.name,
      model: plan.model,
    });
    if (term && term.handle) created.handles.push(term.handle);
    if (!term || !term.ok) return fail(`工人终端创建失败（${w.name}）: ${(term && term.error) || '未知'}`);

    const task = effects.createTask({
      spec: w.inject || w.spec,
      name: w.name,
      issue: plan.issue,
    });
    if (!task || !task.ok) return fail(`task-create 失败（${w.name}）: ${(task && task.error) || '未知'}`);
    if (task.taskId) created.taskIds.push(task.taskId);

    const started = effects.startWorker({
      task: task.taskId,
      terminal: term.handle,
      worktree: created.workerId,
      issue: plan.issue,
      model: term.model || plan.model,
      agent: term.agentId,
      deferred: term.deferred === true,
    });
    if (started && started.dispatchId) created.dispatchIds.push(started.dispatchId);
    if (!started || !started.ok) {
      return fail(`worker-start 失败（${w.name}）: ${(started && started.error) || '未知'}`);
    }

    created.workers.push({
      index: w.index,
      name: w.name,
      spec: w.spec,
      inject: w.inject || w.spec,
      handle: started.handle || term.handle,
      taskId: task.taskId,
      dispatchId: started.dispatchId,
    });
  }
  return { ok: true, created, workers: created.workers };
}

/** 回滚后还剩没有结算的 Dispatch 吗。没查成与「扫完 0 条残留」分开。 */
export function classifyDispatchResidue({ dispatchIds, workers } = {}) {
  const ids = (Array.isArray(dispatchIds) ? dispatchIds : []).filter(Boolean).map(String);
  if (workers == null) {
    return {
      ok: false,
      unscanned: true,
      leftover: [],
      error: 'classifyDispatchResidue 没拿到 worker-list（没查成）',
    };
  }
  if (!Array.isArray(workers)) {
    return {
      ok: false,
      unscanned: true,
      leftover: [],
      error: 'classifyDispatchResidue 的 workers 不是数组（没查成）',
    };
  }
  const leftover = [];
  for (const id of ids) {
    const hit = workers.find(w => String(w?.dispatchId || '') === id);
    if (!hit) continue;
    const status = String(hit.dispatchStatus || '');
    const state = String(hit.workerState || '');
    const settled = /^(completed|failed|cancelled|stopped|fenced)$/i.test(status)
      || /^(succeeded|failed|cancelled|stopped)$/i.test(state);
    if (!settled) leftover.push({ dispatchId: id, dispatchStatus: status, workerState: state });
  }
  if (leftover.length) {
    return {
      ok: false,
      unscanned: false,
      leftover,
      error: `回滚后仍有活动 Dispatch：${leftover.map(x => x.dispatchId).join(',')}`,
    };
  }
  return { ok: true, unscanned: false, leftover: [] };
}

/** 回滚步骤跑完后的可见性：失败必须单独叫，不能只埋在返回 JSON 里。 */
export function rollbackReport(steps) {
  const list = (Array.isArray(steps) ? steps : []).map((s) => {
    if (!s || s.ok) return s;
    if (s.alreadyGone || rollbackErrorAlreadyGone(s.error)) {
      return { ...s, ok: true, alreadyGone: true, error: undefined };
    }
    return s;
  });
  const failed = list.filter(s => s && s.ok === false);
  if (failed.length === 0) {
    return { rollbackFailed: false, alarm: null, failed: [], steps: list };
  }
  const detail = failed.map(s => `${s.cmd || '?'} → ${s.error || '失败'}`).join('; ');
  return {
    rollbackFailed: true,
    alarm: `回滚失败，可能留下孤儿终端/树：${detail}`,
    failed,
    steps: list,
  };
}

export function isProcessFile(rel) {
  const n = String(rel || '').replace(/\\/g, '/').toLowerCase();
  if (n === 'state.json' || n.endsWith('/state.json')) return true;
  if (n === '.pi' || n.startsWith('.pi/') || n.includes('/.pi/')) return true;
  if (n.endsWith('.lease')) return true;
  if (/(^|\/)sessions?(\/|$)/.test(n)) return true;
  return false;
}

export function isWorkFile(rel) {
  const n = String(rel || '').replace(/\\/g, '/');
  if (!n || n.endsWith('/')) return false;
  if (isProcessFile(n)) return false;
  return true;
}

export function scanWorktreeTimes(root) {
  if (!root || !existsSync(root)) throw new Error(`工作树不在: ${root}`);
  let processNewestMtime = 0;
  let processStartedMs = Infinity;
  let workNewestMtime = 0;
  const walk = (dir) => {
    let ents;
    try { ents = readdirSync(dir, { withFileTypes: true }); }
    catch { return; }
    for (const ent of ents) {
      if (SKIP_DIRS.has(ent.name)) continue;
      const full = join(dir, ent.name);
      const rel = relative(root, full);
      if (ent.isDirectory()) { walk(full); continue; }
      if (!ent.isFile()) continue;
      let st;
      try { st = statSync(full); } catch { continue; }
      if (isProcessFile(rel)) {
        processNewestMtime = Math.max(processNewestMtime, st.mtimeMs);
        const birth = st.birthtimeMs > 0 ? st.birthtimeMs : st.mtimeMs;
        processStartedMs = Math.min(processStartedMs, birth);
      } else if (isWorkFile(rel)) {
        workNewestMtime = Math.max(workNewestMtime, st.mtimeMs);
      }
    }
  };
  walk(root);
  return {
    processNewestMtime,
    processStartedMs: Number.isFinite(processStartedMs) ? processStartedMs : 0,
    workNewestMtime,
  };
}

export function readGitTimes(cwd) {
  const log = spawnSync('git', ['log', '-1', '--format=%ct'], { cwd, encoding: 'utf8', windowsHide: true });
  if (log.error || log.status !== 0) {
    throw new Error(`git log 失败: ${String(log.stderr || log.error?.message || `exit ${log.status}`).trim()}`);
  }
  const status = spawnSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8', windowsHide: true });
  if (status.error || status.status !== 0) {
    throw new Error(`git status 失败: ${String(status.stderr || status.error?.message || `exit ${status.status}`).trim()}`);
  }
  const gitHeadMs = Number(String(log.stdout || '').trim()) * 1000;
  if (!Number.isFinite(gitHeadMs) || gitHeadMs <= 0) throw new Error('git log 没给出提交时间');
  return { gitHeadMs, gitDirty: String(status.stdout || '').trim().length > 0 };
}

export function assessLiveness({
  now = Date.now(),
  processNewestMtime = 0,
  processStartedMs = 0,
  workNewestMtime = 0,
  gitHeadMs = 0,
  gitDirty = false,
  thinkGraceMs = DEFAULT_THINK_GRACE_MS,
  processAliveMs = DEFAULT_PROCESS_ALIVE_MS,
} = {}) {
  const processAlive = processNewestMtime > 0 && (now - processNewestMtime) <= processAliveMs;
  const hasRecentWork = workNewestMtime > 0 && (now - workNewestMtime) <= thinkGraceMs;
  const hasWorkSinceCommit = gitHeadMs > 0 && workNewestMtime > gitHeadMs + 2000;
  const hasOutput = hasRecentWork || (gitDirty && hasWorkSinceCommit);
  const started = processStartedMs > 0 ? processStartedMs : processNewestMtime;
  const aliveFor = started > 0 ? now - started : 0;

  if (hasOutput) return { verdict: 'working', processAlive, hasOutput: true, aliveFor };
  if (processAlive && aliveFor < thinkGraceMs) return { verdict: 'thinking', processAlive, hasOutput: false, aliveFor };
  if (processAlive && aliveFor >= thinkGraceMs) return { verdict: 'fake-alive', processAlive, hasOutput: false, aliveFor };
  return { verdict: 'dead', processAlive: false, hasOutput: false, aliveFor };
}

export function assessWorktreeLiveness(root, opts = {}) {
  const times = scanWorktreeTimes(root);
  const git = readGitTimes(root);
  return { ...assessLiveness({ now: opts.now ?? Date.now(), ...times, ...git, ...opts }), ...times, ...git };
}

// ── 派工约束（CLI 是约束载体，不是提醒。issue #482 规格重定义）────────
// 缺参数就跑不起来。拦旁路的闸门在 dispatch-gate.mjs（#546）：载体只有在「唯一入口」时才是约束。

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

// ── 消歧门（#565）：项化派工前的硬门控 ────────────────────────────────────
// dao-project skill 第二节：待拍板不是停车场，是所有项都要过的一道门，过不了不许派。
// dispatch / worker-start 带 --issue 时，目标 issue 必须已打「已消歧」label，读不到拒派（fail-close）。
// 三态必须分得开（#565 硬约束）：查成且有 label / 查成但没 label / 没查成（gh 失败）。
// 没查成不许当有 label 放行——「没查成」当「查过没事」是事故类（#532 通用原则）。
export const DISAMBIGUATED_LABEL = '已消歧'; // 只认这一张；近义标（已拍板 / 已澄清 / disambiguated / 待拍板）不算过门（#565）
export function checkIssueDisambiguated({ issue, runGh } = {}) {
  const n = String(issue ?? '').trim();
  if (!n) return { ok: true, gated: false, issue: null };
  if (!/^\d+$/.test(n)) {
    return { ok: false, gated: true, issue: n, error: `--issue 必须是 issue 号，实际「${n}」` };
  }
  if (typeof runGh !== 'function') {
    return { ok: false, gated: true, issue: n, unscanned: true, error: '消歧门没拿到 gh 执行器——没查成，不许放行' };
  }
  const r = runGh(['issue', 'view', n, '--json', 'labels']);
  if (!r.ok) {
    return {
      ok: false, gated: true, issue: n, unscanned: true,
      error: `gh 读 issue #${n} labels 失败——不是查过没事，是没查成：${r.error}`,
    };
  }
  let labels = [];
  try {
    const parsed = JSON.parse(r.out);
    labels = Array.isArray(parsed?.labels) ? parsed.labels : [];
  } catch {
    return {
      ok: false, gated: true, issue: n, unscanned: true,
      error: `gh 读 issue #${n} labels 返回不是 JSON——没查成，不许放行：${String(r.out).slice(0, 120)}`,
    };
  }
  const names = labels.map(l => l && l.name).filter(Boolean);
  if (!names.includes(DISAMBIGUATED_LABEL)) {
    return {
      ok: false, gated: true, issue: n, hasLabel: false, labels: names,
      error: `issue #${n} 缺「${DISAMBIGUATED_LABEL}」label，拒派（fail-close，忘打标是拦住不是放行）。`
        + `去该 issue 补消歧记录（岔路清单 + 结论 + 依据，依据要用户拍的或有旧拍板可依，见 dao-project skill 第二节），`
        + `再打「${DISAMBIGUATED_LABEL}」label 后重试派工。`,
    };
  }
  return { ok: true, gated: true, issue: n, hasLabel: true, labels: names };
}

/** 卡名给人眼看（#589；号前带 #，2026-08-18 拍板）。
 * 组装只产出 `ISSUE-#589 工人·模型 短语` / `PR-#616 审官·模型`。
 * 解析认 `-#?(\d+)`，旧的 `PR-616` / `ISSUE-589` 仍读得懂。
 * 给了 pr 就升级前缀。没给号则原样返回。这是卡名格式的唯一真相源。 */
const CARD_ROLE_DOT = /^(工人|审官|辅助)·(\S+)(?:\s+(.*))?$/;
const CARD_NEW = /^(PR|ISSUE)-#?(\d+)\s+(.*)$/;
const CARD_OLD = /^#(\d+)\s*[-–—]\s*(.*)$/;

export function assembleCardName({ name, issue, pr, role, model } = {}) {
  const raw = String(name ?? '').trim();
  const prText = String(pr ?? '').trim();
  const issueText = String(issue ?? '').trim();
  const kind = /^\d+$/.test(prText) ? 'PR' : (/^\d+$/.test(issueText) ? 'ISSUE' : null);
  const num = kind === 'PR' ? prText : issueText;
  let stem = raw;
  let roleText = String(role ?? '').trim();
  let modelId = String(model ?? '').trim();

  const asNew = raw.match(CARD_NEW);
  if (asNew) stem = asNew[3];
  else {
    const asOld = raw.match(CARD_OLD);
    if (asOld) stem = asOld[2];
  }

  const roleDot = stem.match(CARD_ROLE_DOT);
  if (roleDot) {
    if (!roleText) roleText = roleDot[1];
    if (!modelId) modelId = roleDot[2];
    stem = (roleDot[3] || '').trim();
  }

  if (!kind) return raw;
  const mid = roleText && modelId ? `${roleText}·${modelId}` : (roleText || '');
  return [`${kind}-#${num}`, mid, stem].filter(Boolean).join(' ');
}

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
} from './dispatch/reviewer.mjs';
export {
  reviewerCardName, collectReviewerCardsForPr, gateReviewerCreate, resolveReviewerReuse,
  currentReviewerSeat, assertReviewerSeat, planAfterSettledReviewer, planReviewerCreateAfterFail,
  classifyReviewerSpawnError, reviewerSpawnFailComment, postIssueComment, postPrComment,
  commentAlreadyPosted, listComments, postCommentOnce, REVIEWER_CREATE_OUTCOMES,
} from './dispatch/reviewer.mjs';

/** 仓内现有 label 名。没查成返回 null（不许当「没有」去瞎建）。 */
export function ghLabelNames(runGh) {
  if (typeof runGh !== 'function') return null;
  const r = runGh(['label', 'list', '--limit', '1000', '--json', 'name']);
  if (!r.ok) return null;
  try {
    const arr = JSON.parse(r.out);
    return Array.isArray(arr) ? arr.map(x => x && x.name).filter(Boolean) : null;
  } catch { return null; }
}

/** 确保仓里存在这些 label（缺的建，已存在不动）。建 label 是仓库级一次性动作，幂等。 */
export function ensureRepoLabels({ names, runGh } = {}) {
  if (!Array.isArray(names) || !names.length) return { ok: true, created: [] };
  if (typeof runGh !== 'function') return { ok: false, unscanned: true, error: 'ensureRepoLabels 没拿到 gh 执行器' };
  const existing = ghLabelNames(runGh);
  if (existing === null) return { ok: false, unscanned: true, error: 'gh label list 没查成——不知道该建哪些' };
  const missing = names.filter(n => !existing.includes(n));
  const created = [];
  for (const name of missing) {
    const c = runGh(['label', 'create', name]);
    if (!c.ok) return { ok: false, error: `建 label「${name}」失败：${c.error}` };
    created.push(name);
  }
  return { ok: true, created, existing };
}

/** 派工成功侧：把 model/<模型> type/<角色> reviewer/<审官> 打到目标 issue（best-effort：失败只报告，不翻转派工结果）。 */
export function stampIssueLabels({ issue, model, role, reviewer, runGh } = {}) {
  const n = String(issue ?? '').trim();
  if (!/^\d+$/.test(n)) {
    return { ok: false, skipped: true, issue: n, error: '没给合法 issue 号，label 不打' };
  }
  const names = dispatchLabelNames({ model, role, reviewer });
  if (typeof runGh !== 'function') {
    return { ok: false, issue: n, unscanned: true, error: 'stampIssueLabels 没拿到 gh 执行器——label 没打' };
  }
  const ensured = ensureRepoLabels({ names, runGh });
  if (!ensured.ok) return { ok: false, issue: n, unscanned: ensured.unscanned === true, error: ensured.error };
  const add = [];
  for (const name of names) add.push('--add-label', name);
  const r = runGh(['issue', 'edit', n, ...add]);
  if (!r.ok) return { ok: false, issue: n, error: `issue #${n} 打 label 失败：${r.error}` };
  return { ok: true, issue: n, names, created: ensured.created, labels: names };
}

/** 合并侧（帅合并时跑）：PR 正文署名的 issue 上取 model/* type/* reviewer/* label，抄到 PR。
 * PR 上没署名 issue / 署名 issue 缺 model/* 或 type/* / gh 没查成——三种都要说清楚，不许静默。
 * reviewer/* 有则抄、没有不挡；但只有 reviewer/*、缺校准标签，不许 pr edit。 */
export function syncPrLabelsFromIssue({ pr, runGh } = {}) {
  const n = String(pr ?? '').trim();
  if (!n) return { ok: false, unscanned: true, error: 'syncPrLabelsFromIssue 没给 PR 号' };
  if (typeof runGh !== 'function') return { ok: false, unscanned: true, error: 'syncPrLabelsFromIssue 没拿到 gh 执行器' };
  const view = runGh(['pr', 'view', n, '--json', 'title,body']);
  if (!view.ok) return { ok: false, unscanned: true, error: `gh pr view #${n} 失败：${view.error}` };
  let meta;
  try { meta = JSON.parse(view.out); }
  catch { return { ok: false, unscanned: true, error: `gh pr view #${n} 返回非 JSON：${String(view.out).slice(0, 120)}` }; }
  const refs = linkedIssueNumbers(`${meta.title || ''}\n${meta.body || ''}`);
  if (!refs.length) {
    return { ok: false, unscanned: false, error: `PR #${n} 正文/标题里没有「署名 issue #N」/关单词署名单号——label 无从同步，需人工补` };
  }
  const from = [];
  for (const issueNum of refs) {
    const iv = runGh(['issue', 'view', String(issueNum), '--json', 'labels']);
    if (!iv.ok) return { ok: false, unscanned: true, error: `gh issue view #${issueNum} 失败：${iv.error}` };
    let labels = [];
    try {
      const parsed = JSON.parse(iv.out);
      labels = Array.isArray(parsed?.labels) ? parsed.labels : [];
    } catch { return { ok: false, unscanned: true, error: `gh issue view #${issueNum} 返回非 JSON` }; }
    const names = labels
      .map(l => (l && typeof l === 'object' ? l.name : l))
      .filter(name => typeof name === 'string' && /^(model\/|type\/|reviewer\/)/.test(name));
    if (names.length) from.push({ issue: issueNum, labels: names });
  }
  const want = [...new Set(from.flatMap(f => f.labels))];
  const hasModel = want.some(name => name.startsWith('model/'));
  const hasType = want.some(name => name.startsWith('type/'));
  if (!hasModel || !hasType) {
    const missing = [!hasModel && 'model/*', !hasType && 'type/*'].filter(Boolean).join(' 和 ');
    return {
      ok: false,
      unscanned: false,
      error: `PR #${n} 的署名 issue 上缺 ${missing} label（派工漏打？）——需人工补，不许只靠 reviewer/* 过关`,
      refs,
      labels: want,
    };
  }
  const ensured = ensureRepoLabels({ names: want, runGh });
  if (!ensured.ok) return { ok: false, unscanned: ensured.unscanned === true, error: ensured.error };
  const add = [];
  for (const name of want) add.push('--add-label', name);
  const edit = runGh(['pr', 'edit', n, ...add]);
  if (!edit.ok) return { ok: false, error: `PR #${n} 打 label 失败：${edit.error}` };
  return { ok: true, pr: n, labels: want, refs, from, created: ensured.created };
}


export function dispatchComment({ mergePolicy, mergeReason, model, reviewer, split, splitReason } = {}) {
  const parts = [`merge-policy:${mergePolicy}`, `model:${model}`, `reviewer:${reviewer}`];
  if (split != null && String(split).trim() !== '') {
    parts.push(`split:${split}`);
    if (String(split).toLowerCase() === 'no' && splitReason) {
      parts.push(`split 理由: ${splitReason}`);
    }
  }
  const base = parts.join(' · ');
  if (mergePolicy === 'manual' && mergeReason) {
    return `${base} · manual 理由: ${mergeReason}`;
  }
  return base;
}

// ── 闭环任务书模板（#546 追加第五件）──────────────────────────
// 士兵 / 审官任务书模板在 host/skills/dispatch/templates/，不硬编码进代码——
// 模板要能被读、被改（#507 教训：写原则 + 「以当时的任务书为准」，别写死会过时的具体职责）。
// 占位符 {{KEY}} 填充失败（模板缺文件 / 占位符没被换掉）必须失败退出，不许带着空位派出去。

export const DISPATCH_TEMPLATE_DIR = join(ROOT, 'host', 'skills', 'dispatch', 'templates');

export function listDispatchTemplates() {
  if (!existsSync(DISPATCH_TEMPLATE_DIR)) return [];
  return readdirSync(DISPATCH_TEMPLATE_DIR)
    .filter(f => f.endsWith('.md'))
    .sort();
}

/** 读模板原文。拿不到就抛（同 dao 全局：不许静默当成空模板）。 */
export function readDispatchTemplate(name) {
  if (!/^[a-z0-9-]+\.md$/.test(String(name || ''))) throw new Error(`模板名不合法: ${name}`);
  const p = join(DISPATCH_TEMPLATE_DIR, name);
  if (!existsSync(p)) throw new Error(`任务书模板不在: ${p}`);
  return readFileSync(p, 'utf8');
}

/** 填充 {{KEY}} 占位符。所有占位符必须全部被替换，剩一个就是失败。
 * #559 审官红项：占位符填成字面量 "undefined"/"null"（如 String(missingId)）等于没填，
 * 必须抛——否则渲染出 dispatch:undefined，士兵/审官把消息发进不存在的收件箱。 */
export function renderDispatchTemplate(name, vars = {}) {
  const text = readDispatchTemplate(name);
  const out = String(text).replace(/\{\{(\w+)\}\}/g, (m, key) => {
    const v = vars[key];
    if (v === undefined || v === null) throw new Error(`模板 ${name} 占位符 {{${key}}} 没给值`);
    const s = String(v);
    if (/^(undefined|null)$/i.test(s.trim())) {
      throw new Error(`模板 ${name} 占位符 {{${key}}} 填了无效值（${s.trim()}）——真 id 缺失，不许渲染出 dispatch:undefined`);
    }
    return s;
  });
  if (/\{\{\w+\}\}/.test(out)) throw new Error(`模板 ${name} 还有未替换占位符`);
  return out;
}

// ── 注入闸（#602 / #619）：主约束 = 一行指针。换行按 agent 转码（grok 转 ESC+CR），不禁换行。
// 唯一硬闸 = UTF-8 字节 ≤500。模板文件末尾允许一个 EOF 换行，渲染后剥掉。
// 二分实测（2026-08-17，grok 探针 term + 帅 701 截断）：
//   orca terminal send 单行 200/350/450/550/650/701 均送达（模型回出末尾标记）
//   帅经 TUI 输入框提交 701 字节：前半进消息、后半留输入框
// 安全值取 500：低于 TUI 截断点，高于目标 100，send 路径 550 仍绿。
//
// #619：本闸只量我们拼的 spec。Orca worker-start 还会再包一层 preamble（实测约 4600 字节），
// 那一层不在我们手里，量不到。preamble 单独就会触发 Codex/Grok 粘贴块，所以短指针仍要走提交第二拍。
export const INJECT_MAX_BYTES = 500;
export const INJECT_OVER_LIMIT_HINT = '正文挪去仓内文件或 GitHub，注入只给指针';
export const INJECT_GATE_SCOPE = 'our-spec-only';
export const ORCA_WORKER_PREAMBLE_BYTES_MEASURED = 4600;
export const INJECT_GATE_NOTE = '本闸只量我们拼的 spec，量不到 Orca worker-start preamble（实测约 4600 字节）。preamble 单独就会触发 Codex/Grok 粘贴块。';

export function injectUtf8Bytes(text) {
  return Buffer.byteLength(String(text ?? ''), 'utf8');
}

export function stripInjectEof(text) {
  return String(text ?? '').replace(/(?:\r\n|\n|\r)+$/g, '');
}

export function assertInjectText(text, { label } = {}) {
  const s = String(text ?? '');
  const bytes = injectUtf8Bytes(s);
  if (bytes > INJECT_MAX_BYTES) {
    return {
      ok: false,
      length: s.length,
      bytes,
      newlines: /[\r\n]/.test(s),
      limit: INJECT_MAX_BYTES,
      scope: INJECT_GATE_SCOPE,
      note: INJECT_GATE_NOTE,
      preambleBytesMeasured: ORCA_WORKER_PREAMBLE_BYTES_MEASURED,
      error: `注入 ${bytes} 字节超过上限 ${INJECT_MAX_BYTES}（${label || 'task spec'}）。${INJECT_OVER_LIMIT_HINT}。${INJECT_GATE_NOTE}`,
    };
  }
  return {
    ok: true,
    length: s.length,
    bytes,
    newlines: /[\r\n]/.test(s),
    limit: INJECT_MAX_BYTES,
    scope: INJECT_GATE_SCOPE,
    note: INJECT_GATE_NOTE,
    preambleBytesMeasured: ORCA_WORKER_PREAMBLE_BYTES_MEASURED,
  };
}

/** 兼容旧名：与 assertInjectText 相同，唯一硬闸是 UTF-8 字节上限。 */
export function assertInjectLen(text, opts) {
  return assertInjectText(text, opts);
}

function renderInjectTemplate(name, vars) {
  return stripInjectEof(renderDispatchTemplate(name, vars));
}

export function buildSoldierInject({ spec, issue } = {}) {
  const text = renderInjectTemplate('soldier-inject.md', {
    SPEC: spec,
    ISSUE_REF: issue ? ` #${issue}` : '',
  });
  const gate = assertInjectText(text, { label: '士兵注入' });
  if (!gate.ok) throw new Error(gate.error);
  return text;
}

export function buildBatchInject({ spec, issue } = {}) {
  const text = renderInjectTemplate('batch-inject.md', {
    SPEC: spec,
    ISSUE_REF: issue ? ` #${issue}` : '',
  });
  const gate = assertInjectText(text, { label: 'batch 注入' });
  if (!gate.ok) throw new Error(gate.error);
  return text;
}

export function buildReviewerInject({ spec, issue, pr, soldierDispatchId, mergePolicy, mergeReason, skipWait } = {}) {
  const policy = mergePolicy == null ? mergePolicy : String(mergePolicy);
  const text = renderInjectTemplate('reviewer-inject.md', {
    SPEC: spec,
    ISSUE_REF: issue ? ` #${issue}` : '',
    PR: pr,
    // #631：skip-wait（帅手动补审官）时 d 可以空——调用方显式传 ''（渲染成 `d=`，任务书认空 = 红项上帅）；
    // undefined/null 仍抛（dispatch:undefined 硬闸，worker-done 路径不许丢）。
    SOLDIER_DISPATCH_ID: soldierDispatchId,
    MERGE_POLICY: policy,
    MERGE_REASON_REF: policy === 'manual' && mergeReason ? ` r=${mergeReason}` : '',
    SKIP_WAIT_REF: skipWait ? ' s=1' : '',
  });
  const gate = assertInjectText(text, { label: '审官注入' });
  if (!gate.ok) throw new Error(gate.error);
  return text;
}

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

/** #551：worker_done 是 exact-Dispatch 结算口，不是普通投递。 */
export function planWorkerDoneSend({ type, to, outcome, taskId, dispatchId, from, dispatchCapability } = {}) {
  const t = type == null ? '' : String(type).trim();
  if (t !== 'worker_done') {
    return { ok: true, kind: 'notify', settle: false };
  }
  const missing = [];
  if (!String(taskId || '').trim()) missing.push('task-id');
  if (!String(dispatchId || '').trim()) missing.push('dispatch-id');
  const oc = String(outcome || '').trim();
  if (oc !== 'succeeded' && oc !== 'failed') missing.push('outcome');
  if (missing.length) {
    return {
      ok: false, kind: 'settle', settled: false, unscanned: false,
      error: `未结算：worker_done 缺 ${missing.join('/')}（exact-Dispatch 信号必须带身份，不能省略）`,
    };
  }
  const dest = to == null ? '' : String(to).trim();
  if (dest) {
    return {
      ok: false, kind: 'settle', settled: false, unscanned: false,
      error: '未结算：worker_done 不能带 --to（exact-Dispatch 信号须省略 --to，走活动 Dispatch 的 Run 信箱）',
    };
  }
  return {
    ok: true, kind: 'settle', settle: true, omitTo: true,
    taskId: String(taskId).trim(),
    dispatchId: String(dispatchId).trim(),
    outcome: oc,
    from: from ? String(from).trim() : null,
    dispatchCapability: dispatchCapability ? String(dispatchCapability).trim() : null,
  };
}

/**
 * 读 worker-show 判断 Dispatch 是否真的 completed。
 * 没查成（缺信封/缺 status）和「查到了但未 completed」必须分开。
 */
export function readDispatchSettlement(json) {
  if (!json || typeof json !== 'object') {
    return { ok: false, unscanned: true, settled: false, error: 'worker-show 返回空（没查成，不许当未结算）' };
  }
  const dispatch = json.result && json.result.dispatch;
  if (!dispatch || typeof dispatch !== 'object') {
    return { ok: false, unscanned: true, settled: false, error: 'worker-show 没有 result.dispatch（没查成，不许当未结算）' };
  }
  const status = dispatch.status == null ? null : String(dispatch.status);
  const workerState = json.result?.worker?.state == null ? null : String(json.result.worker.state);
  if (status == null) {
    return {
      ok: false, unscanned: true, settled: false,
      error: 'worker-show 查到了但没有 dispatch.status（没查成，不许当未结算）',
      dispatchId: dispatch.id || null, workerState,
    };
  }
  const settled = String(status).toLowerCase() === 'completed';
  return {
    ok: true, unscanned: false, settled,
    status, workerState,
    dispatchId: dispatch.id || null,
    taskId: dispatch.task_id || null,
    assigneeHandle: dispatch.assignee_handle || null,
    completedAt: dispatch.completed_at || null,
  };
}

export function isWrongPaneWorkerDoneError(error) {
  const text = orcaErrorText(error);
  return /not the Dispatch pane|not_dispatch_pane|caller is not the Dispatch|assignee|exact-Dispatch|stable pane|pane identity/i.test(text);
}

/** run-current 三态：没查成 / 已有 Run / 查到 null 需要本窗自开。 */
export function planCallerRun({ currentOk, currentJson, currentError } = {}) {
  if (!currentOk) {
    return { ok: false, unscanned: true, error: `run-current 没查成：${currentError || ''}`.trim() };
  }
  const runId = extractRunId(currentJson);
  if (runId) return { ok: true, runId, needCreate: false };
  return { ok: true, runId: null, needCreate: true };
}

/** 真返回在 result.run.id。顶层 id 是 RPC id，不能当 runId。 */
export function extractRunId(json) {
  return json?.result?.run?.id || null;
}

/** 收件人形态。闭环三跳只有四种合法收件人，其余一律拒发（发出去没人负责 = 静默断链）。
 * term_… = 终端 handle（低层通道）；run:… = Run 信箱；dispatch:… = 受监督工人的结构化收件箱
 * （#559 官方通道优先：`send --to dispatch:<id>` 是结构化收件箱邮件，不是 prompt injection，
 * worker 的下一步 orchestration check 会收到它）；省略 = 自己那条 Run 信箱。 */
export function classifyNotifyTarget(to) {
  const t = String(to ?? '').trim();
  if (!t) return { kind: 'own-run', id: null };
  if (/^term_/.test(t)) return { kind: 'terminal', id: t };
  if (/^run:/.test(t)) return { kind: 'run', id: t.slice(4) };
  if (/^dispatch:/.test(t)) return { kind: 'dispatch', id: t.slice('dispatch:'.length) };
  if (t.startsWith('@')) {
    return { kind: 'unsupported', error: `闭环通知不发组播（${t}）：组播没人负责签收，收不到也看不出来` };
  }
  return { kind: 'unsupported', error: `收件人形态不认识: ${t}（只收 term_… / run:… / dispatch:… / 省略=自己那条 Run 信箱）` };
}

function orcaErrText(error) {
  return orcaErrorText(error);
}

/** 从 worker-show JSON 取出士兵终端。已完工时 result.terminal 常为 null，退到 handle 字段。 */
export function extractSoldierTerminal(showJson) {
  const r = showJson?.result || {};
  return r.terminal?.handle
    || r.worker?.agent_terminal_handle
    || r.dispatch?.assignee_handle
    || r.terminalResource?.terminalHandle
    || null;
}

export function extractDispatchRunId(showJson) {
  return showJson?.result?.dispatch?.run_id || null;
}

export function extractDispatchWorktreeId(showJson) {
  const r = showJson?.result || {};
  return r.worker?.worktree_id
    || r.terminal?.worktreeId
    || r.terminalResource?.worktreeId
    || null;
}

/** hop 是不是「审官把红项打回士兵」这一跳。 */
export function isSoldierReworkHop(hop) {
  return /审官\s*→\s*士兵/.test(String(hop || ''));
}

/** probeRecipient 失败是不是「查到了、已完工」（不是没查成、不是不存在）。 */
export function isCompletedDispatchProbe(pre) {
  if (!pre || pre.kind !== 'dispatch' || pre.ok || pre.unscanned) return false;
  return !isLiveDispatchRecipient({ workerState: pre.status, dispatchStatus: pre.dispatchStatus })
    && !!(pre.status || pre.dispatchStatus);
}

function dispatchProbeExtras(showJson) {
  return {
    assigneeHandle: showJson?.result?.dispatch?.assignee_handle ?? null,
    agentTerminalHandle: showJson?.result?.worker?.agent_terminal_handle ?? null,
    terminalHandle: extractSoldierTerminal(showJson),
    runId: extractDispatchRunId(showJson),
    worktreeId: extractDispatchWorktreeId(showJson),
  };
}

/** dispatch 收件人必须还活着。completed/succeeded/failed 不是收件人。 */
export function isLiveDispatchRecipient({ workerState, dispatchStatus } = {}) {
  const live = new Set(['ready', 'working', 'waiting']);
  const dead = new Set(['completed', 'succeeded', 'failed', 'cancelled', 'canceled', 'released', 'stopped']);
  const w = String(workerState || '').toLowerCase();
  const d = String(dispatchStatus || '').toLowerCase();
  if (dead.has(w) || dead.has(d)) return false;
  if (live.has(w)) return true;
  return false;
}

/** 投递前证收件人真的在。拿不到 ≠ 没有：分不开就标 unscanned，一样非零。 */
export function probeRecipient(target, orca) {
  if (typeof orca !== 'function') throw new Error('probeRecipient 要 orca 执行器');
  if (target.kind === 'terminal') {
    const r = orca(argsTerminalRead({ terminal: target.id, limit: 1 }));
    if (r.ok) return { ok: true, kind: 'terminal', id: target.id, status: r.json?.result?.terminal?.status ?? null };
    const text = orcaErrText(r.error);
    if (/terminal_handle_stale|not_found/i.test(text)) {
      return { ok: false, kind: 'terminal', id: target.id, error: `收件人终端不存在或已失效（${text}）：${target.id}` };
    }
    return { ok: false, unscanned: true, kind: 'terminal', id: target.id, error: `收件人活性没查成（不等于收件人不在）：${text}` };
  }
  if (target.kind === 'run') {
    const r = orca(argsRunShow({ id: target.id }));
    if (r.ok && r.json?.result?.run) return { ok: true, kind: 'run', id: target.id };
    if (r.ok) return { ok: false, kind: 'run', id: target.id, error: `Run 信箱查无此 Run: ${target.id}` };
    const text = orcaErrText(r.error);
    if (/run_not_found/i.test(text)) {
      return { ok: false, kind: 'run', id: target.id, error: `Run 信箱不存在（run_not_found）：${target.id}` };
    }
    return { ok: false, unscanned: true, kind: 'run', id: target.id, error: `Run 信箱没查成: ${text}` };
  }
  if (target.kind === 'dispatch') {
    // #559 官方通道：dispatch:<id> 是受监督工人的结构化收件箱。
    // 活性判据 = worker-show 能查到该 Dispatch（dispatch_not_found = 收件人不在，链断当场炸）。
    const r = orca(argsWorkerShow({ dispatch: target.id }));
    if (r.ok && r.json?.result?.dispatch?.id === target.id) {
      const workerState = r.json?.result?.worker?.state ?? null;
      const dispatchStatus = r.json?.result?.dispatch?.status ?? null;
      const extras = dispatchProbeExtras(r.json);
      if (workerState == null && dispatchStatus == null) {
        return {
          ok: false, unscanned: true, kind: 'dispatch', id: target.id,
          error: `收件人 Dispatch 查到了但没有 state/status（没查成，不许当活人）：${target.id}`,
          ...extras,
        };
      }
      if (!isLiveDispatchRecipient({ workerState, dispatchStatus })) {
        return {
          ok: false, kind: 'dispatch', id: target.id,
          status: workerState,
          dispatchStatus,
          error: `收件人 Dispatch 已完工（state=${workerState} status=${dispatchStatus}）：禁止往已结算信箱发工作指令（#677：士兵没审完不该下班）。人走了 → 新开工人。`,
          ...extras,
        };
      }
      return {
        ok: true, kind: 'dispatch', id: target.id,
        status: workerState,
        dispatchStatus,
        ...extras,
      };
    }
    if (r.ok) {
      return { ok: false, kind: 'dispatch', id: target.id, error: `Dispatch 查无此 id: ${target.id}` };
    }
    const text = orcaErrText(r.error);
    if (/dispatch_not_found|not_found|stale/i.test(text)) {
      return { ok: false, kind: 'dispatch', id: target.id, error: `收件人 Dispatch 不存在或已失效（${text}）：${target.id}` };
    }
    return { ok: false, unscanned: true, kind: 'dispatch', id: target.id, error: `收件人 Dispatch 活性没查成（不等于收件人不在）：${text}` };
  }
  const r = orca(argsRunCurrent());
  if (!r.ok) {
    const text = orcaErrText(r.error);
    return { ok: false, unscanned: true, kind: 'own-run', error: `本终端绑的 Run 没查成: ${text}` };
  }
  const run = r.json?.result?.run;
  if (!run) return { ok: false, kind: 'own-run', error: '本终端没绑 orchestration Run（run-current 为 null），省略收件人 = 发进真空。工人/审官用 worker-show 的 dispatch.run_id 写成 --to run:<id>' };
  return { ok: true, kind: 'own-run', id: run.id || null };
}

/** send 的回执。真返回在 result.message，顶层 id 是 RPC id，不能当消息 id。
 * to_handle / to_dispatch 都可能是收件人落点（send --to dispatch:<id> 的消息字段形态以当时返回为准）。 */
export function extractSentMessage(json) {
  const m = json?.result?.message || json?.message || null;
  if (!m || !m.id) return null;
  return {
    id: m.id,
    toHandle: m.to_handle ?? null,
    toDispatch: m.to_dispatch ?? null,
    deliveredAt: m.delivered_at ?? null,
  };
}

/** 落库复核。扫不到任何样本 → unscanned（「没查成」不许当「查过没事」）。 */
export function findInboxMessage(inboxJson, messageId) {
  const list = inboxJson?.result?.messages;
  if (!Array.isArray(list)) return { scanned: false, found: false, message: null };
  const hit = list.find(m => m && m.id === messageId) || null;
  return { scanned: true, found: !!hit, message: hit, sampled: list.length };
}

/**
 * 闭环一跳的投递：收件人在 → 发 → 有回执 → 落库可查。四关缺一即失败。
 * 失败一律返回 ok:false（调用方非零退出并升级），不许当「发成功了只是还没读」。
 *
 * 普通 notify 四关验的是投递，不是结算：ok:true 只说明消息进了收件人信箱。
 * --type worker_done 是结算口（#551）：必须带 task-id/dispatch-id/outcome、省略 --to，
 * 发出后核 worker-show Dispatch 为 completed。落库但未 completed、缺身份、错 pane
 * 一律 ok:false 并报「未结算」。没查成（unscanned）和查到未 completed 分开。
 *
 * #677：hop 审官→士兵 打进还活着的 id。已完工 fail-visible，不开下一跳救人。
 */
export function deliverMessage({
  to = null, subject, body = '', type, outcome, hop = '闭环通知', orca, inboxLimit = 50,
  taskId, dispatchId, dispatchCapability, from, filesModified, reportPath,
} = {}) {
  if (typeof orca !== 'function') throw new Error('deliverMessage 要 orca 执行器');
  if (!subject) return { ok: false, hop, stage: '参数', error: `${hop}：缺 --subject，没主题的通知等于没通知` };

  const settlePlan = planWorkerDoneSend({ type, to, outcome, taskId, dispatchId, from, dispatchCapability });
  if (!settlePlan.ok) {
    return { ok: false, hop, stage: '结算', settled: false, unscanned: !!settlePlan.unscanned, error: `${hop}：${settlePlan.error}` };
  }
  if (settlePlan.kind === 'settle') {
    return settleDispatch({
      hop, subject, body, outcome: settlePlan.outcome,
      taskId: settlePlan.taskId, dispatchId: settlePlan.dispatchId,
      from: settlePlan.from, dispatchCapability: settlePlan.dispatchCapability,
      filesModified, reportPath, orca,
    });
  }

  const target = classifyNotifyTarget(to);
  if (target.kind === 'unsupported') return { ok: false, hop, stage: '收件人', error: `${hop}：${target.error}` };

  const pre = probeRecipient(target, orca);
  if (!pre.ok) {
    if (isSoldierReworkHop(hop) && isCompletedDispatchProbe(pre)) {
      return {
        ok: false, hop, stage: '收件人',
        error: `${hop}：士兵已下班（过早 worker_done），红项打不进活人。不要开下一跳救人（#677）。人走了才升级给帅。`,
        recipient: pre,
      };
    }
    return { ok: false, hop, stage: '收件人', unscanned: !!pre.unscanned, error: `${hop}：${pre.error}`, recipient: pre };
  }

  const sent = orca(argsOrchestrationSend({ to, subject, body, type, outcome }));
  if (!sent.ok) {
    const text = orcaErrText(sent.error);
    return { ok: false, hop, stage: '发送', error: `${hop}：orca send 失败: ${text}`, recipient: pre };
  }

  const msg = extractSentMessage(sent.json);
  if (!msg) {
    return { ok: false, hop, stage: '回执', error: `${hop}：orca 说发出去了却没给消息回执 —— 拿不到回执就当没送到`, recipient: pre };
  }
  if (to) {
    const expected = String(to);
    const badHandle = msg.toHandle && msg.toHandle !== expected;
    const badDispatch = msg.toDispatch
      && (expected.startsWith('dispatch:')
        ? msg.toDispatch !== expected && msg.toDispatch !== expected.slice('dispatch:'.length)
        : msg.toDispatch !== expected);
    if (badHandle || badDispatch) {
      return {
        ok: false, hop, stage: '回执', messageId: msg.id,
        error: `${hop}：回执收件人是 ${msg.toHandle || msg.toDispatch}，与请求的 ${expected} 不一致（错投）`, recipient: pre,
      };
    }
  }

  const inbox = orca(argsOrchestrationInbox({ limit: inboxLimit, full: true }));
  if (!inbox.ok) {
    const text = orcaErrText(inbox.error);
    return { ok: false, hop, stage: '复核', unscanned: true, messageId: msg.id, error: `${hop}：投递复核没查成: ${text}`, recipient: pre };
  }
  const found = findInboxMessage(inbox.json, msg.id);
  if (!found.scanned) {
    return { ok: false, hop, stage: '复核', unscanned: true, messageId: msg.id, error: `${hop}：复核没扫到任何消息样本，这次没查成`, recipient: pre };
  }
  if (!found.found) {
    return { ok: false, hop, stage: '复核', messageId: msg.id, error: `${hop}：回执给了 ${msg.id}，编排里却查不到这条消息`, recipient: pre };
  }

  return {
    ok: true, hop, stage: '已送达', messageId: msg.id,
    to: msg.toHandle ?? (pre.id || null),
    deliveredAt: found.message?.delivered_at ?? null,
    recipient: pre,
    sampled: found.sampled,
  };
}

/** #551：发 worker_done 后必须核 Dispatch 变成 completed，落库无效力 = 未结算。 */
export function settleDispatch({
  hop = '闭环结算', subject, body = '', outcome, taskId, dispatchId,
  from, dispatchCapability, filesModified, reportPath, orca,
} = {}) {
  if (typeof orca !== 'function') throw new Error('settleDispatch 要 orca 执行器');

  const shown = orca(argsWorkerShow({ dispatch: dispatchId }));
  if (!shown.ok) {
    const text = orcaErrText(shown.error);
    if (/dispatch_not_found|not_found/i.test(text)) {
      return { ok: false, hop, stage: '结算', settled: false, error: `${hop}：未结算：Dispatch 不存在（${text}）` };
    }
    return {
      ok: false, hop, stage: '结算', settled: false, unscanned: true,
      error: `${hop}：未结算：Dispatch 状态没查成（没查成 ≠ 未 completed）：${text}`,
    };
  }
  const before = readDispatchSettlement(shown.json);
  if (!before.ok) {
    return { ok: false, hop, stage: '结算', settled: false, unscanned: true, error: `${hop}：未结算：${before.error}` };
  }
  if (before.settled) {
    return {
      ok: false, hop, stage: '结算', settled: false,
      error: `${hop}：未结算：Dispatch 已经 completed，不能再发 worker_done`,
    };
  }
  const sender = from || before.assigneeHandle;
  if (!sender) {
    return {
      ok: false, hop, stage: '结算', settled: false,
      error: `${hop}：未结算：缺 --from，且 worker-show 没有 assignee_handle（错 pane 无法对齐）`,
    };
  }

  const sent = orca(argsOrchestrationSend({
    subject, body, type: 'worker_done', outcome,
    taskId, dispatchId, dispatchCapability, from: sender,
    filesModified, reportPath,
  }));
  if (!sent.ok) {
    const text = orcaErrText(sent.error);
    const pane = isWrongPaneWorkerDoneError(sent.error);
    return {
      ok: false, hop, stage: '结算', settled: false, wrongPane: pane,
      error: `${hop}：未结算：${pane ? '错误 pane 发送（发送方不是 Dispatch 本人）' : 'orca send 失败'}：${text}`,
    };
  }
  const msg = extractSentMessage(sent.json);

  const afterShow = orca(argsWorkerShow({ dispatch: dispatchId }));
  if (!afterShow.ok) {
    const text = orcaErrText(afterShow.error);
    return {
      ok: false, hop, stage: '结算', settled: false, unscanned: true, messageId: msg?.id || null,
      error: `${hop}：未结算：发出后 Dispatch 状态没查成（没查成 ≠ 未变 completed）：${text}`,
    };
  }
  const after = readDispatchSettlement(afterShow.json);
  if (!after.ok) {
    return {
      ok: false, hop, stage: '结算', settled: false, unscanned: true, messageId: msg?.id || null,
      error: `${hop}：未结算：${after.error}`,
    };
  }
  if (!after.settled) {
    return {
      ok: false, hop, stage: '结算', settled: false, messageId: msg?.id || null,
      status: after.status, workerState: after.workerState,
      error: `${hop}：未结算：消息已落库但 Dispatch 仍是 ${after.status || after.workerState || '非 completed'}（落库无结算效力）`,
    };
  }
  return {
    ok: true, hop, stage: '已结算', settled: true,
    messageId: msg?.id || null,
    dispatchId, taskId, outcome,
    status: after.status, workerState: after.workerState,
    from: sender,
  };
}

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
  'worker-start', 'worker-release', 'worker-read', 'worker-done', 'reviewer-create', 'reviewer-attach', 'send', 'notify', 'reply',
  'gate-create', 'gate-resolve', 'gate-list', 'liveness', 'check-help', 'pr-sync-labels', 'ledger-query', 'amend', 'next',
  'inbox-collect', 'run-gc', 'ask', 'board-archive', 'board-reset', 'raw',
];

const BOOL_FLAGS = new Set(['no-parent', 'force', 'enter', 'dry-run', 'json', 'confirm', 'unclosed', 'apply', 'peek', 'skip-wait', 'allow-dup']);
const MULTI_FLAGS = new Set(['slice']);

export const FLAGS_BY_VERB = {
  start: new Set(['--provider', '--model', '--worktree', '--title', '--dry-run', '--json', '--help', '-h']),
  dispatch: new Set([
    '--name', '--merge-policy', '--merge-reason', '--split', '--split-reason', '--slice', '--model', '--role', '--reviewer', '--confirm',
    '--spec', '--task', '--issue', '--now', '--batch', '--dry-run', '--allow-dup', '--json', '--help', '-h',
  ]),
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
    '--pr', '--body', '--body-file', '--parent-worktree', '--soldier-dispatch', '--dry-run', '--json', '--help', '-h',
  ]),
  'reviewer-create': new Set([
    '--pr', '--name', '--reviewer', '--parent-worktree', '--comment', '--issue',
    '--soldier-dispatch', '--merge-policy', '--merge-reason', '--dry-run', '--json', '--help', '-h',
  ]),
  'reviewer-attach': new Set([
    '--pr', '--worktree', '--reviewer', '--name', '--soldier-dispatch', '--spec',
    '--merge-policy', '--merge-reason', '--comment', '--issue', '--skip-wait', '--run',
    '--start-timeout-ms', '--dry-run', '--json', '--help', '-h',
  ]),
  send: new Set(['--terminal', '--text', '--enter', '--agent', '--json', '--help', '-h']),
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
  dispatch --name <动宾短语> [--issue <issue号>] [--merge-policy auto|manual] [--merge-reason <文>] --split <no|N> [--split-reason <文>] [--slice <分块>]... --reviewer <模型id> --spec <文> (--model <id> | --role <角色> [--confirm]) [--dry-run] [--allow-dup]
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
  reviewer-create --pr <N> [--name <名>] [--reviewer <模型id>] [--parent-worktree <sel>] [--comment <文>] [--issue <号>] [--soldier-dispatch <id>] [--dry-run]
                  # 不传 --reviewer 时自读署名 issue 的 reviewer/*（#586）；工人路径不传模型
                  # 建树后空壳先关再 create --command（#633）；--dry-run 只打印选型不建树
                  # #575 ⑦：mergeable!=MERGEABLE 拒建树；建树后试合 master 再 abort，HEAD 仍停在 PR head
                  # #679：工人审官同厂当场拒；工人模型没查成 / 扫完没有 model/* 都拒绝起审官
                  # 一 PR 一审官：已有审官树/卡则复用或拒绝新建，不许再 create（防 Orca -2/-3）；失败停手报，不许换厂
  worker-done --pr <N> [--body <文> | --body-file <文件>] [--parent-worktree <工人卡>] [--soldier-dispatch <id>] [--dry-run]
                  # 交卷：发完工/返工 comment；无审官卡才 reviewer-create；已有则复用；终端已关也不许再建；失败停手不许换厂；两条路径都 notify 审官（投失败即停）
                  # #677：成功路径不结算士兵 Dispatch。判定绿才允许 notify --type worker_done。失败不得假装已下班。
  reviewer-attach --pr <N> --worktree <工人卡> --reviewer <模型id> [--name <名>] [--soldier-dispatch <id>] [--spec <文>] [--skip-wait]
                  # 给已有工人卡补派审官（#575）：建树+空壳先关再 create --command（#633）+验开工，一条命令，不碰 raw
                  # #679：与工人同厂当场拒（#678 实咬的口），不许 attach 成工人那一厂
                  # #631：树→PR 归属校验（树的 issue/分支对不上 PR 当场拒）；士兵 dispatch 注入前 worker-show 复核活性，已结算禁止当收件人（#552）
                  # #631：--skip-wait 显式跳过等完工——worker-done 失败后补审官时工人不会再发完工，硬等烧 600s；
                  #       d= 只给 worker-show 确认活的 dispatch（显式 --soldier-dispatch 同闸）：已结算 → 红项上帅；
                  #       worker-show 没查成 → 拒（不许当活人）；没有 → 空（红项上帅，见 reviewer-book 第 1 步）
  pr-sync-labels --pr <N>   # 合并前把署名 issue 的 model/* type/* reviewer/* label 同步到 PR（#564 + #586）
  worktree-rm --worktree <sel> [--force]
                  # 一条命令整树后序删（子卡先于父卡）。任一棵有 working/waiting agent 则整树不删，报清是哪棵
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
  worker-start --task <id> --terminal <handle> [--worktree <sel>] [--issue <issue号>] [--merge-policy auto|manual] [--merge-reason <文>] --reviewer <id> (--model <id> | --role <角色> [--confirm]) [--retry-of <id>]
  worker-release --dispatch <id>   # 结算后收尾：release 或转移所有权（#559 ⑤），不 release 会留孤儿工位
  worker-read --dispatch <id> [--source auto|transcript|terminal] [--limit <n>]   # 读工人输出/开工证明（#559 ⑥）
  send --terminal <handle> --text <文> [--enter] [--agent grok|claude|pi|codex]
                  # grok 发送前把 \\n 转成 ESC+CR（Alt+Enter）；claude/pi 原样；codex 不转（换行留不住）
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
派工不给 --model 时只推荐、要 --confirm，禁静默默认。未知 --参数 一律非零。
merge-policy 默认 auto（#511 拍板：帅只感知不再是关口）；选 manual 必须给 --merge-reason，
理由写进任务卡 comment 留痕，只限改协作约定 / 改 model-routing.toml 决策字段 / 花钱三类。
--split 必填（#611）：no 或 ≥2 的整数；两个都不给 → 非零退出。--split no 必须给 --split-reason（理由入账本）。
--split N 建父卡 + N 张子卡（子卡 --parent-worktree 挂父卡、--base-branch 用任务分支），父卡工人是头工人。
--split N 必须给 N 个 --slice（每块一份非空、互不重叠的分块说明；抽到的文件路径不得跨块）。失败回滚先 worker-stop / task-update failed，再关终端删树。
判据：产出物能不能按文件切开？能切 + 块数 ≥2 + 每块够一个工人干 → --split N；切不开（同几个文件反复改）→ --split no + 理由。
worker-start 的 --worktree 可省略：复用已存在终端续 Dispatch（worker_done 后同一终端绑到新 Task，
#559 ②）时工作区由终端决定；新开工人位仍建议显式给 --worktree。
换人（乒乓两轮仍红）走 worker-start --task <同单> --retry-of <旧 dispatch id>，不重开一单（#559 ⑦）。
续活/审官场景的 merge-policy 约束：新开派工语义；flow.mjs 内部与 reviewer-create 不归本动词管，见 dispatch skill。
给了 --issue 时卡名走 assembleCardName（#589：格式只认那一处，本页不复制；号对不上也不拿名字当钥匙）。
并把 --issue 透传给 orca worktree create 把卡链到 GitHub issue（派工那一刻 PR 不存在，卡名先带 ISSUE-）。
dispatch / worker-start 带 --issue 时走消歧门（#565）：目标 issue 缺「已消歧」label 拒派（fail-close）——
去该 issue 补消歧记录再打「已消歧」label（dao-project skill 第二节）；gh 查失败单独报「没查成」，不许当有 label 放行。
dispatch 的消歧门在后台执行体里（async-launch）：被拦 = <id>.out.json 落 ok:false，热路退出码只管「受没受理」。
dispatch --dry-run 不走门控（不实际派工，disambiguation 只作报告，不影响退出码；#565 返工）。无 --issue 的派工不受门控（辅助终端不经 dispatch）。
`;
