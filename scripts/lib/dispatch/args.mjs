// scripts/lib/dispatch/args.mjs —— orca 参数构造域（#762 拆分）
//
// 改这段前必须知道：这里只造 argv 数组，不执行。命令清单由
// dao-cmd.mjs 的 catalogUsedFlags 用「全开」builder 扫出来，不另抄。
// 换行转码（grok 的 ESC+CR）只在这一个文件里，禁止在别处复制。

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

export function argsWorktreeCreate({
  name, noParent, setup, parentWorktree, baseBranch, comment, issue, repo,
} = {}) {
  const a = ['worktree', 'create'];
  if (name) a.push('--name', name);
  if (noParent) a.push('--no-parent');
  if (setup) a.push('--setup', setup);
  if (parentWorktree) a.push('--parent-worktree', parentWorktree);
  if (baseBranch) a.push('--base-branch', baseBranch);
  if (issue != null && String(issue).trim() !== '') a.push('--issue', String(issue).trim());
  if (comment) a.push('--comment', comment);
  if (repo) a.push('--repo', repo);
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

/** #762/#753：等 command 型 TUI 就绪（devin 起法：create → wait tui-idle → worker-start）。
 * wait 就绪即返回（不是固定睡满），timeoutMs 只是上限兜底。 */
export function argsTerminalWait({ terminal, for: forWhat, timeoutMs } = {}) {
  const a = ['terminal', 'wait'];
  if (terminal) a.push('--terminal', terminal);
  const target = forWhat === 'exit' ? 'exit' : 'tui-idle';
  a.push('--for', target);
  if (timeoutMs != null && Number(timeoutMs) > 0) a.push('--timeout-ms', String(Number(timeoutMs)));
  a.push('--json');
  return a;
}

export function flagsOf(args) {
  return args.filter(x => typeof x === 'string' && x.startsWith('--'));
}

export function commandKey(args) {
  if (!args || !args.length) return '';
  if (args[0] === 'orchestration' || args[0] === 'worktree' || args[0] === 'terminal') {
    return `${args[0]} ${args[1] || ''}`.trim();
  }
  return args[0];
}

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

/** run-create 必须带 --from 一个活终端（信箱台 / 派工协调哑终端），不许把帅窗绑成 coordinator（#667 #762）。 */
export function argsRunCreate({ objective, from } = {}) {
  if (!from) throw new Error('run-create 必须 --from 活终端（信箱台或派工协调哑终端），不许从帅窗当 coordinator（#667 #762）');
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
