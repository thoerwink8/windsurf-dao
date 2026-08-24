// scripts/lib/dispatch/args.mjs —— orca 命令构造/结果解析域（#768 从 dao-cmd.mjs 拆出，对外 API 不变）
import { orcaErrorText } from '../orca-error.mjs';

export function argsTerminalCreate({ worktree, title, command } = {}) {
  const a = ['terminal', 'create'];
  if (worktree) a.push('--worktree', worktree);
  if (title) a.push('--title', title);
  if (command) a.push('--command', command);
  a.push('--json');
  return a;
}

export function argsTerminalRead({ terminal, limit, cursor } = {}) {
  const a = ['terminal', 'read'];
  if (terminal) a.push('--terminal', terminal);
  if (limit != null) a.push('--limit', String(limit));
  if (cursor != null) a.push('--cursor', String(cursor));
  a.push('--json');
  return a;
}
/** #602 四家对照：只有 grok 要把 LF 转成 Alt+Enter（ESC+CR）。claude/pi 原样；codex 换行留不住，不打补丁。 */

export function newlineCodec(agentOrProvider) {
  const a = String(agentOrProvider || '').toLowerCase();
  if (/grok|xai/.test(a)) return 'esc-cr';
  if (/gpt|codex/.test(a)) return 'passthrough-lost';
  return 'passthrough';
}

export function encodeSendText(text, agentOrProvider) {
  const s = String(text ?? '');
  if (newlineCodec(agentOrProvider) === 'esc-cr') {
    return s.replace(/\r\n|\n|\r/g, '\x1b\r');
  }
  return s;
}

export function argsTerminalSend({ terminal, text, enter, agent } = {}) {
  const a = ['terminal', 'send'];
  if (terminal) a.push('--terminal', terminal);
  if (text != null) a.push('--text', encodeSendText(text, agent));
  if (enter) a.push('--enter');
  a.push('--json');
  return a;
}
/**
 * worker-start 送字结果三分类（2026-08-23 fire-and-forget 拍板）：
 *   confirmed        —— orca 报 ready（exit 0）。认账到了，最好的情形。
 *   sent-unconfirmed —— 认账类假阴性（agent_prompt_stalled / outcome_unknown /
 *                       dispatch_input 阶段 stall）：字已进终端，orca 没等到 agent 认账。
 *                       763 实证：报 stalled 的工人其实在跑。派工路当成功，确认交 watchdog。
 *   transport-failed —— 明确的传输错误（终端死 / agent 未配置 / task 不存在 / Run 问题
 *                       / 调用本身没查成）：同步报错，调用方回滚。
 * 保守方向：不认识的错误一律 transport-failed（同步显形），只有实测认得的假阴性码
 * 才进 sent-unconfirmed——新错误码不许静默吞进「已派未确认」。
 */
export function classifyWorkerStartSend({ ok, error, json } = {}) {
  if (ok) return { kind: 'confirmed' };
  const text = [
    orcaErrorText(error),
    json?.result?.lastError, json?.result?.failedStage,
    json?.lastError, json?.failedStage,
  ].filter(Boolean).join(' | ');
  if (/agent_prompt_stalled|outcome_unknown|dispatch_input/i.test(text)) {
    return { kind: 'sent-unconfirmed', reason: text };
  }
  return { kind: 'transport-failed', reason: text || 'worker-start 失败' };
}
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

export function argsWorktreeCreate({
  name, noParent, setup, parentWorktree, baseBranch, comment, issue,
} = {}) {
  const a = ['worktree', 'create'];
  if (name) a.push('--name', name);
  if (noParent) a.push('--no-parent');
  if (setup) a.push('--setup', setup);
  if (parentWorktree) a.push('--parent-worktree', parentWorktree);
  if (baseBranch) a.push('--base-branch', baseBranch);
  if (issue != null && String(issue).trim() !== '') a.push('--issue', String(issue).trim());
  if (comment) a.push('--comment', comment);
  a.push('--json');
  return a;
}

export function argsWorktreeSet({ worktree, displayName, comment, workspaceStatus } = {}) {
  const a = ['worktree', 'set'];
  if (worktree) a.push('--worktree', worktree);
  if (displayName) a.push('--display-name', displayName);
  if (comment != null) a.push('--comment', comment);
  if (workspaceStatus) a.push('--workspace-status', workspaceStatus);
  a.push('--json');
  return a;
}

export function argsWorktreeRm({ worktree, force } = {}) {
  const a = ['worktree', 'rm'];
  if (worktree) a.push('--worktree', worktree);
  if (force) a.push('--force');
  a.push('--json');
  return a;
}

export function argsWorktreePs({ limit } = {}) {
  const a = ['worktree', 'ps'];
  if (limit != null) a.push('--limit', String(limit));
  a.push('--json');
  return a;
}

export function argsTaskCreate({ spec, run, from } = {}) {
  const a = ['orchestration', 'task-create'];
  if (spec != null) a.push('--spec', spec);
  if (run) a.push('--run', run);
  if (from) a.push('--from', from);
  a.push('--json');
  return a;
}

export function argsTaskUpdate({ id, status, result, run, from } = {}) {
  const a = ['orchestration', 'task-update'];
  if (id) a.push('--id', id);
  if (status) a.push('--status', status);
  if (result != null) a.push('--result', typeof result === 'string' ? result : JSON.stringify(result));
  if (run) a.push('--run', run);
  if (from) a.push('--from', from);
  a.push('--json');
  return a;
}

export function argsWorkerStart({ task, worktree, terminal, retryOf, agent, model, from, run, timeoutMs } = {}) {
  const a = ['orchestration', 'worker-start'];
  if (task) a.push('--task', task);
  if (worktree) a.push('--worktree', worktree);
  if (terminal) a.push('--terminal', terminal);
  if (agent) a.push('--agent', agent);
  if (model) a.push('--model', model);
  if (retryOf) a.push('--retry-of', retryOf);
  if (run) a.push('--run', run);
  if (from) a.push('--from', from);
  if (timeoutMs != null && Number(timeoutMs) > 0) a.push('--timeout-ms', String(Number(timeoutMs)));
  a.push('--json');
  return a;
}

export function argsWorkerList() {
  return ['orchestration', 'worker-list', '--json'];
}

export function argsWorkerShow({ dispatch } = {}) {
  const a = ['orchestration', 'worker-show'];
  if (dispatch) a.push('--dispatch', dispatch);
  a.push('--json');
  return a;
}

export function argsWorkerRelease({ dispatch, retryRequest } = {}) {
  const a = ['orchestration', 'worker-release'];
  if (dispatch) a.push('--dispatch', dispatch);
  if (retryRequest) a.push('--retry-request', retryRequest);
  a.push('--json');
  return a;
}

export function argsWorkerStop({ dispatch, retryRequest } = {}) {
  const a = ['orchestration', 'worker-stop'];
  if (dispatch) a.push('--dispatch', dispatch);
  if (retryRequest) a.push('--retry-request', retryRequest);
  a.push('--json');
  return a;
}

export function argsWorkerRead({ dispatch, source, cursor, limit } = {}) {
  const a = ['orchestration', 'worker-read'];
  if (dispatch) a.push('--dispatch', dispatch);
  if (source) a.push('--source', source);
  if (cursor != null) a.push('--cursor', String(cursor));
  if (limit != null) a.push('--limit', String(limit));
  a.push('--json');
  return a;
}

export function argsOrchestrationReply({ id, body, from, run } = {}) {
  const a = ['orchestration', 'reply'];
  if (id) a.push('--id', id);
  if (body != null) a.push('--body', body);
  if (run) a.push('--run', run);
  if (from) a.push('--from', from);
  a.push('--json');
  return a;
}

export function argsOrchestrationCheck({ run, terminal, peek, ack, wait, timeoutMs } = {}) {
  const a = ['orchestration', 'check'];
  if (run) a.push('--run', run);
  if (terminal) a.push('--terminal', terminal);
  if (peek) a.push('--peek');
  if (ack) a.push('--ack', ack);
  if (wait) a.push('--wait');
  if (timeoutMs != null) a.push('--timeout-ms', String(timeoutMs));
  a.push('--json');
  return a;
}

export function argsRunList() {
  return ['orchestration', 'run-list', '--json'];
}

export function argsGateCreate({ task, question, options, from } = {}) {
  const a = ['orchestration', 'gate-create'];
  if (task) a.push('--task', task);
  if (question != null) a.push('--question', question);
  if (options != null) a.push('--options', options);
  if (from) a.push('--from', from);
  a.push('--json');
  return a;
}

export function argsGateResolve({ id, resolution, from } = {}) {
  const a = ['orchestration', 'gate-resolve'];
  if (id) a.push('--id', id);
  if (resolution != null) a.push('--resolution', resolution);
  if (from) a.push('--from', from);
  a.push('--json');
  return a;
}

export function argsGateList({ task, status, run } = {}) {
  const a = ['orchestration', 'gate-list'];
  if (task) a.push('--task', task);
  if (status) a.push('--status', status);
  if (run) a.push('--run', run);
  a.push('--json');
  return a;
}

export function argsTerminalList({ worktree } = {}) {
  const a = ['terminal', 'list'];
  if (worktree) a.push('--worktree', worktree);
  a.push('--json');
  return a;
}

export function argsTerminalClose({ terminal, tab } = {}) {
  const a = ['terminal', 'close'];
  if (terminal) a.push('--terminal', terminal);
  if (tab) a.push('--tab');
  a.push('--json');
  return a;
}


export function commandKey(args) {
  if (!args || !args.length) return '';
  if (args[0] === 'orchestration' || args[0] === 'worktree' || args[0] === 'terminal') {
    return `${args[0]} ${args[1] || ''}`.trim();
  }
  return args[0];
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

export function extractHandleFromWorkerStart(json) {
  return json?.result?.worker?.agent_terminal_handle
    || json?.result?.dispatch?.assignee_handle
    || json?.result?.handle
    || json?.result?.terminal?.handle
    || extractHandleFromCreate(json);
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

export function argsOrchestrationSend({
  to, subject, body, type, outcome,
  from, taskId, dispatchId, dispatchCapability,
  filesModified, reportPath, phase, run,
} = {}) {
  const a = ['orchestration', 'send'];
  if (to) a.push('--to', to);
  if (from) a.push('--from', from);
  if (run) a.push('--run', run);
  if (subject != null) a.push('--subject', subject);
  if (body != null) a.push('--body', body);
  if (type) a.push('--type', type);
  if (outcome) a.push('--outcome', outcome);
  if (taskId) a.push('--task-id', taskId);
  if (dispatchId) a.push('--dispatch-id', dispatchId);
  if (dispatchCapability) a.push('--dispatch-capability', dispatchCapability);
  if (filesModified) a.push('--files-modified', filesModified);
  if (reportPath) a.push('--report-path', reportPath);
  if (phase) a.push('--phase', phase);
  a.push('--json');
  return a;
}

export function argsOrchestrationInbox({ terminal, limit, full } = {}) {
  const a = ['orchestration', 'inbox'];
  if (terminal) a.push('--terminal', terminal);
  if (limit != null) a.push('--limit', String(limit));
  if (full) a.push('--full');
  a.push('--json');
  return a;
}

export function argsRunShow({ id } = {}) {
  const a = ['orchestration', 'run-show'];
  if (id) a.push('--id', id);
  a.push('--json');
  return a;
}

export function argsRunCurrent({ from } = {}) {
  const a = ['orchestration', 'run-current'];
  if (from) a.push('--from', from);
  a.push('--json');
  return a;
}
/**
 * run-use：`--from` 冒充其它终端会 consumer_fenced（orca 校验证书）。
 * 省略 --from = 绑调用窗自己。#667 帅窗派工不许走这条；
 * 工人起审官本终端已解绑时允许 self:true 绑自己。
 */
export function argsRunUse({ id, from, self } = {}) {
  if (!from && !self) {
    throw new Error('run-use 要 --from（冒充会 fenced）或 self:true 绑调用窗（#667 帅窗派工不许）');
  }
  const a = ['orchestration', 'run-use'];
  if (id) a.push('--id', id);
  if (from) a.push('--from', from);
  a.push('--json');
  return a;
}
/** run-create 必须带 --from 信箱台，否则新建 Run 会把帅窗绑成 coordinator。 */

export function argsRunCreate({ objective, from } = {}) {
  if (!from) throw new Error('run-create 必须 --from 信箱台，不许从帅窗当 coordinator（#667）');
  const a = ['orchestration', 'run-create'];
  if (objective != null) a.push('--objective', objective);
  a.push('--from', from, '--json');
  return a;
}
/** #675：工人 TUI 自己开 Run（不 --from 信箱台，会 consumer_fenced）。帅窗不许走这条。 */

export function argsRunCreateSelf({ objective } = {}) {
  const a = ['orchestration', 'run-create'];
  if (objective != null) a.push('--objective', objective);
  a.push('--json');
  return a;
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
