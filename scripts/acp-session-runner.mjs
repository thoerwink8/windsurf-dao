#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { AcpClient, AcpRpcError } from './lib/acp-client.mjs';
import {
  acpAtomicJson, acpReadJson, acpRedactor, acpProcessIdentity, acpProcessTree,
  acpCleanupTree, acpReleaseWorkdir, acpConcreteModel, AcpRuntimeError,
} from './lib/acp-runtime.mjs';

const iso = () => new Date().toISOString();
const SELF = fileURLToPath(import.meta.url);
const MCP = fileURLToPath(new URL('./acp-interaction-mcp.mjs', import.meta.url));
const QUESTION_TOOL_TITLE = 'dao-interactions-dao_ask_user_question: dao_ask_user_question';
const supported = new Set(['session/request_permission', 'cursor/ask_question', 'cursor/create_plan', 'mcp/dao_ask_user_question']);

function optionValues(options = []) {
  return options.flatMap(option => Array.isArray(option.options) ? optionValues(option.options) : [option.value ?? option.modelId]);
}

/** Strictly encode an explicit answer. There is intentionally no "pick first" fallback. */
export function encodeAcpAnswer(method, params, answer) {
  if (method === 'mcp/dao_ask_user_question') method = 'cursor/ask_question';
  if (!answer || typeof answer !== 'object') throw new AcpRuntimeError('invalid_answer', 'An explicit structured answer is required');
  let outcome = answer.result?.outcome ?? answer.outcome;
  if (typeof outcome === 'string') outcome = { outcome, ...(answer.reason === undefined ? {} : { reason: answer.reason }), ...(answer.planUri === undefined ? {} : { planUri: answer.planUri }) };
  if (!outcome && method === 'session/request_permission' && typeof answer.optionId === 'string') outcome = { outcome: 'selected', optionId: answer.optionId };
  if (!outcome && method === 'cursor/ask_question' && Array.isArray(answer.answers)) outcome = { outcome: 'answered', answers: answer.answers };
  const bad = () => { throw new AcpRuntimeError('invalid_answer', 'Answer does not match the ACP interaction'); };
  if (!outcome || typeof outcome !== 'object') return bad();
  if (outcome.outcome === 'cancelled') return { outcome: { outcome: 'cancelled' } };
  if (method === 'session/request_permission') {
    if (outcome.outcome !== 'selected' || !params.options?.some(option => option.optionId === outcome.optionId)) return bad();
    return { outcome: { outcome: 'selected', optionId: outcome.optionId } };
  }
  if (method === 'cursor/create_plan') {
    if (!['accepted', 'rejected'].includes(outcome.outcome)) return bad();
    if (outcome.reason !== undefined && typeof outcome.reason !== 'string') return bad();
    if (outcome.planUri !== undefined && typeof outcome.planUri !== 'string') return bad();
    return { outcome: { outcome: outcome.outcome, ...(outcome.reason === undefined ? {} : { reason: outcome.reason }), ...(outcome.planUri === undefined ? {} : { planUri: outcome.planUri }) } };
  }
  if (method === 'cursor/ask_question') {
    if (outcome.outcome === 'skipped') return { outcome: { outcome: 'skipped', ...(typeof outcome.reason === 'string' ? { reason: outcome.reason } : {}) } };
    if (outcome.outcome !== 'answered' || !Array.isArray(outcome.answers) || !Array.isArray(params.questions) || !params.questions.length || outcome.answers.length !== params.questions.length) return bad();
    const seen = new Set();
    const answers = outcome.answers.map(answer => {
      const question = params.questions.find(question => question.id === answer?.questionId);
      const selected = answer?.selectedOptionIds;
      if (!question || seen.has(question.id) || !Array.isArray(selected) || !selected.length || (!question.allowMultiple && selected.length !== 1) || new Set(selected).size !== selected.length || selected.some(id => !question.options?.some(option => option.id === id))) return bad();
      seen.add(question.id);
      return { questionId: question.id, selectedOptionIds: selected };
    });
    return { outcome: { outcome: 'answered', answers } };
  }
  return bad();
}

function canonicalPath(value, cwd) {
  if (typeof value !== 'string' || !value || value.includes('\0')) return null;
  const absolute = path.resolve(cwd, value);
  let existing = absolute;
  const suffix = [];
  for (;;) {
    try { return path.join(fs.realpathSync(existing), ...suffix); }
    catch (error) {
      if (error.code !== 'ENOENT' || existing === path.dirname(existing)) return null;
      suffix.unshift(path.basename(existing));
      existing = path.dirname(existing);
    }
  }
}

// Only a single simple command can qualify for a prefix. Shell control operators,
// expansions and substitutions cannot be smuggled through an allowed executable.
// Metacharacters are refused where the shell would ACT on them: bare in an
// unquoted word, or expansion-capable ($ ` \) inside double quotes. Inside quotes
// the rest are literal text, so a commit trailer such as "Name <a@b.c>" is data,
// not an operator, and rejecting it would block ordinary git usage.
const UNQUOTED_UNSAFE = /[$`\\;&|<>(){}*?\[\]~!]/;
const DOUBLE_QUOTED_UNSAFE = /[$`\\]/;

/** Cursor writes every non-trivial commit message as `"$(cat <<'EOF' … EOF)"`.
 * A SINGLE-QUOTED heredoc delimiter tells the shell to expand nothing, so the body
 * is literal text, not a substitution. Lifting exactly that form out to a literal
 * (and nothing else: an unquoted <<EOF still expands, and stays refused) is what
 * lets an allowlisted `git commit` carry a real message. The placeholder uses NUL,
 * which cannot occur in a command line, so it can never collide with real text.
 */
const HEREDOC_LITERAL = /\$\(\s*cat\s*<<'([A-Za-z_][A-Za-z0-9_]*)'\n([\s\S]*?)\n\1[ \t]*\n?[ \t]*\)/g;
export function liftLiteralHeredocs(line) {
  const literals = [];
  const lifted = line.replace(HEREDOC_LITERAL, (_match, _delim, body) => {
    literals.push(body);
    return `\u0000H${literals.length - 1}\u0000`;
  });
  return { lifted, literals };
}
const restoreHeredocs = (word, literals) =>
  word.replace(/\u0000H(\d+)\u0000/g, (match, index) => literals[Number(index)] ?? match);
function commandWords(input) {
  if (Array.isArray(input)) return input.length && input.every(word => typeof word === 'string') ? input : null;
  if (typeof input !== 'string' || /[\r\n]/.test(input)) return null;
  const words = [];
  // A shell word is a run of adjacent quoted and unquoted parts with no whitespace
  // between them, so `--format="%H %s"` is ONE word. Treating that as a parse error
  // (as an earlier version did) refuses ordinary git invocations. Concatenating is
  // also the safe reading: `--test"joined"` becomes the single word `--testjoined`,
  // which then simply fails to match the `['node','--test']` prefix.
  const part = /(?:"([^"\n]*)"|'([^'\n]*)'|([^\s"']+))/gy;
  const space = /\s*/y;
  let offset = 0;
  while (offset < input.length) {
    space.lastIndex = offset;
    space.exec(input);
    offset = space.lastIndex;
    if (offset >= input.length) break;
    let word = '';
    let matched = false;
    for (;;) {
      part.lastIndex = offset;
      const piece = part.exec(input);
      if (!piece) break;
      if (piece[1] !== undefined) { if (DOUBLE_QUOTED_UNSAFE.test(piece[1])) return null; word += piece[1]; }
      else if (piece[2] !== undefined) word += piece[2]; // single quotes are fully literal
      else { if (UNQUOTED_UNSAFE.test(piece[3])) return null; word += piece[3]; }
      matched = true;
      offset = part.lastIndex;
      if (offset >= input.length || /\s/.test(input[offset])) break;
    }
    if (!matched) return null; // an unterminated quote reaches here
    words.push(word);
  }
  return words.length ? words : null;
}

const DEVIN_COMMAND_META = 'cognition.ai/editableCommand';

/** Devin's permission request carries only a toolCallId: no kind, title or rawInput.
 * The kind arrives earlier, on the session/update that announced the same tool call,
 * so the already-tracked tool call is the authority for what is being asked about.
 * Returning undefined (rather than guessing) keeps an unknown shape failing closed.
 */
export function acpPermissionKind(params, toolCalls = []) {
  const call = params?.toolCall;
  if (!call) return undefined;
  if (typeof call.kind === 'string') return call.kind;
  const id = call.toolCallId;
  if (id === undefined) return undefined;
  const tracked = toolCalls.find(tool => tool?.id === id || tool?.toolCallId === id);
  return typeof tracked?.kind === 'string' ? tracked.kind : undefined;
}

/** Permission policy is a decision boundary, not a filesystem/command sandbox.
 * Unknown tool input shapes fail closed. Native CLI permission requests can be
 * answered manually using the same durable promptId if their scope is unverifiable.
 */
export function acpPermissionScope(rule, params, { cwd, toolCalls = [] }) {
  const call = params.toolCall;
  const kind = acpPermissionKind(params, toolCalls);
  if (!call || kind === undefined || !Array.isArray(rule.toolKinds) || !rule.toolKinds.includes(kind) ||
    typeof rule.workdir !== 'string' || !path.isAbsolute(rule.workdir) || canonicalPath(rule.workdir, cwd) !== cwd) return null;
  const raw = call.rawInput && typeof call.rawInput === 'object' && !Array.isArray(call.rawInput) ? call.rawInput : {};
  const actualCwd = raw.cwd ?? raw.workdir ?? raw.workingDirectory ?? raw.working_directory ?? params.cwd;
  if (actualCwd !== undefined && canonicalPath(actualCwd, cwd) !== cwd) return null;
  const scope = { toolKind: kind, cwd };
  // A worktree-scoped rule pre-authorizes any file tool that stays inside the
  // managed workdir, and any command that matches one of the allowed prefixes.
  // This is a decision boundary, not a security boundary: the managed workdir is
  // already an isolated git worktree, so the agent is trusted to write anywhere
  // within it but never outside it.
  const worktree = rule.worktreeScope === true;
  if (['read', 'edit', 'delete', 'move'].includes(kind)) {
    if (worktree) {
      const observed = [raw.path, raw.filePath, raw.file_path, raw.oldPath, raw.newPath,
        ...(Array.isArray(raw.paths) ? raw.paths : []), ...(Array.isArray(raw.files) ? raw.files : []),
        ...(Array.isArray(call.locations) ? call.locations.map(location => location.path) : [])].filter(value => value !== undefined);
      const paths = observed.map(value => canonicalPath(value, cwd));
      if (!paths.length || paths.some(value => !value)) return null;
      if (paths.some(value => value !== cwd && !value.startsWith(cwd + path.sep))) return null;
      const descriptors = rule.paths ?? rule.pathPatterns ?? null;
      if (descriptors !== null) {
        if (!Array.isArray(descriptors) || !descriptors.length) return null;
        const allowed = descriptors.map(value => canonicalPath(value, cwd));
        if (allowed.some(value => !value) || paths.some(value => value !== cwd && !allowed.includes(value))) return null;
      }
      return { ...scope, paths: [...new Set(paths)], permission: 'worktree_scoped' };
    }
    if (!Array.isArray(rule.paths) || !rule.paths.length) return null;
    const allowed = rule.paths.map(value => canonicalPath(value, cwd));
    const observed = [raw.path, raw.filePath, raw.file_path, raw.oldPath, raw.newPath,
      ...(Array.isArray(raw.paths) ? raw.paths : []), ...(Array.isArray(raw.files) ? raw.files : []),
      ...(Array.isArray(call.locations) ? call.locations.map(location => location.path) : [])].filter(value => value !== undefined);
    const paths = observed.map(value => canonicalPath(value, cwd));
    if (!paths.length || allowed.some(value => !value) || paths.some(value => !value || !allowed.includes(value))) return null;
    return { ...scope, paths: [...new Set(paths)] };
  }
  if (kind === 'execute') {
    if (!Array.isArray(rule.commandPrefixes) || !rule.commandPrefixes.length) return null;
    const allowed = words => rule.commandPrefixes.some(prefix =>
      Array.isArray(prefix) && prefix.length && prefix.every((word, index) => typeof word === 'string' && word === words[index]));
    if (!worktree) {
      if (actualCwd === undefined) return null;
      const words = commandWords(raw.argv ?? raw.command);
      if (!words || !allowed(words)) return null;
      return { ...scope, command: words, permission: 'prefix_scoped' };
    }
    // Cursor's ACP execute tool sends no rawInput: the shell line is the tool title,
    // wrapped in backticks, sometimes prefixed with `cd <workdir> &&`. The title is
    // what the CLI itself displays and runs, so it is the decision's subject.
    // The command already starts in the managed workdir, because that is the cwd the
    // agent process was spawned with and the cwd the ACP session was created for. So
    // a command with no `cd` is bounded by construction; a `cd` is only allowed when
    // it names that same workdir. Every other segment must match an allowed prefix,
    // and any relocating operator (pipe, redirect, background, substitution) is
    // refused by commandWords below.
    // Devin instead puts the shell line in the tool call's _meta, and pins the
    // directory per invocation with `git -C <dir>` rather than a leading cd.
    let line = raw.argv ?? raw.command ?? null;
    if (line === null && typeof call._meta?.[DEVIN_COMMAND_META] === 'string') line = call._meta[DEVIN_COMMAND_META];
    if (line === null && typeof call.title === 'string') line = call.title.trim().replace(/^`(.*)`$/s, '$1');
    if (Array.isArray(line)) {
      const words = commandWords(line);
      return words && allowed(words) && actualCwd !== undefined ? { ...scope, command: words, permission: 'worktree_scoped' } : null;
    }
    if (typeof line !== 'string' || !line.trim()) return null;
    // Only `&&` may join segments. Every other operator (| < > & ; and any
    // substitution) is refused by commandWords below, because it rejects an
    // unquoted metacharacter in any word of a segment.
    const { lifted, literals } = liftLiteralHeredocs(line);
    const segments = lifted.split(/\s*&&\s*/).filter(part => part.trim());
    if (!segments.length) return null;
    const parsed = [];
    for (const segment of segments) {
      const words = commandWords(segment);
      if (!words) return null;
      if (words[0] === 'cd') {
        if (words.length !== 2 || canonicalPath(words[1], cwd) !== cwd) return null;
      } else {
        // `git -C <dir> <subcommand>` names its own directory; that directory must be
        // the managed workdir, and the prefix is matched against the command without
        // the -C pair, so an allowlist entry stays written as ['git','commit'].
        let effective = words;
        if (words[0] === 'git' && words[1] === '-C') {
          if (words.length < 4 || canonicalPath(words[2], cwd) !== cwd) return null;
          effective = [words[0], ...words.slice(3)];
        }
        if (!allowed(effective)) return null;
      }
      parsed.push(words.map(word => restoreHeredocs(word, literals)));
    }
    return { ...scope, command: parsed.flat(), segments: parsed, permission: 'worktree_scoped' };
  }
  return null;
}

function matchingRules(policy, method, params, toolCalls = []) {
  // The kind is resolved the same way the scope check resolves it, so an agent that
  // omits it on the permission request (Devin) still selects the same rule.
  const kind = acpPermissionKind(params, toolCalls);
  return (Array.isArray(policy?.rules) ? policy.rules : []).filter(rule =>
    rule.method === method && (rule.toolCallId === undefined || rule.toolCallId === (params.toolCallId ?? params.toolCall?.toolCallId)) &&
    (rule.toolTitle === undefined || rule.toolTitle === params.toolCall?.title) &&
    (rule.toolKinds === undefined || (Array.isArray(rule.toolKinds) && rule.toolKinds.includes(kind))) &&
    (rule.questionIds === undefined || (Array.isArray(rule.questionIds) && JSON.stringify([...rule.questionIds].sort()) === JSON.stringify((params.questions || []).map(question => question.id).sort()))),
  );
}

function policyAnswer(policy, method, params, context) {
  const matches = matchingRules(policy, method, params, context.toolCalls);
  if (matches.length !== 1 || !Object.hasOwn(matches[0], 'answer')) return null;
  const rule = matches[0];
  // A worktree-scoped grant does not bind to a server-chosen optionId; it selects
  // the server's allow_ONCE option directly, exactly once, without a human answer.
  // The scope is verified (inside the managed workdir) before the choice is returned.
  let answer, answerSource;
  if (method === 'session/request_permission' && rule.worktreeScope === true && rule.answer?.grant === 'once') {
    const options = params.options?.filter(option => option.kind === 'allow_once') || [];
    if (options.length !== 1) return null;
    answer = encodeAcpAnswer(method, params, { optionId: options[0].optionId });
    answerSource = 'worktree_scope';
  } else {
    answer = encodeAcpAnswer(method, params, rule.answer);
  }
  let scope;
  if (method === 'session/request_permission' && answer.outcome.outcome === 'selected') {
    const selected = params.options?.find(option => option.optionId === answer.outcome.optionId);
    if (selected?.kind === 'allow_once') {
      scope = acpPermissionScope(rule, params, context);
      if (!scope) return null;
    } else if (!['reject_once', 'reject_always'].includes(selected?.kind)) return null;
  }
  return { answer, scope, ...(answerSource ? { answerSource } : {}) };
}

export function injectedQuestionPermission(config, method, params) {
  if (!config.interactionMcp || config.agent !== 'cursor' || method !== 'session/request_permission' ||
    params.toolCall?.kind !== 'other' || params.toolCall?.title !== QUESTION_TOOL_TITLE) return null;
  const options = params.options?.filter(option => option.kind === 'allow_once') || [];
  if (options.length !== 1) return null;
  return { answer: encodeAcpAnswer(method, params, { optionId: options[0].optionId }),
    scope: { injectedTool: 'dao_ask_user_question', toolTitle: QUESTION_TOOL_TITLE }, answerSource: 'injected_question_tool' };
}

function hasUsage(value) {
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, item]) =>
    (/usage|metrics|(?:input|output|prompt|completion|cached|total|reasoning)[_]?tokens|token[_]?usage/i.test(key) && item != null) ||
    ((key === 'method' || key === 'sessionUpdate') && typeof item === 'string' && /usage|metrics/i.test(item)) || hasUsage(item),
  );
}

/** The group keeper remains alive after the CLI exits, preserving the group's identity
 * until the supervisor has enumerated and reaped its remaining tools. It does not parse ACP.
 */
async function runAgentGroup(dir) {
  const config = acpReadJson(path.join(dir, 'request.json'));
  const env = config.agentEnv || { ...process.env, HOME: config.homeDir, ...config.env, ...config.profile.env };
  const child = spawn(config.profile.command, config.profile.args, { cwd: config.cwd, env, windowsHide: true, stdio: ['inherit', 'inherit', 'inherit'] });
  const send = message => { if (process.connected) process.send?.(message, () => {}); };
  const keepAlive = setInterval(() => {}, 1000);
  process.on('SIGTERM', () => {}); // Keeper is killed last, after the group's other members.
  child.on('spawn', () => send({ type: 'agent_spawned', identity: acpProcessIdentity(child.pid) }));
  child.on('error', () => send({ type: 'agent_error', code: 'agent_spawn_failed' }));
  child.on('exit', (code, signal) => send({ type: 'agent_exit', code, signal }));
  process.on('disconnect', () => {
    // Supervisor died unexpectedly. Best effort reap now; persisted identities allow
    // stopSession to verify again and clean descendants that left this process group.
    clearInterval(keepAlive);
    acpCleanupTree(acpProcessIdentity(process.pid)).catch(() => process.exit(1));
  });
}

export async function runAcpSession(dir) {
  const config = acpReadJson(path.join(dir, 'request.json'));
  const statusFile = path.join(dir, 'status.json');
  const status = acpReadJson(statusFile);
  const redact = acpRedactor(config.agentEnv || { ...process.env, ...config.env, ...config.profile.env });
  let client, child, poller, finishing = null, stopping = false, polling = false, groupExitTimer;
  const pending = new Map();
  const mcpReceipts = new Set();
  let configOptions = [], models = null, actualModel = null, modelLocked = false;
  const save = () => {
    status.updatedAt = iso();
    acpAtomicJson(statusFile, redact(status));
  };
  status.runner = acpProcessIdentity(process.pid);
  status.pid = status.runner.pid;
  status.startTicks = status.runner.startTicks;
  save();

  const track = () => {
    if (!status.agentProcess) return;
    const descendants = acpProcessTree(status.agentProcess, status.descendants);
    if (JSON.stringify(descendants) !== JSON.stringify(status.descendants)) {
      status.descendants = descendants;
      save();
    }
  };

  function finish(phase, error = null) {
    if (finishing) return finishing;
    stopping = true;
    finishing = (async () => {
      clearInterval(poller);
      clearTimeout(groupExitTimer);
      status.phase = 'stopping';
      if (error) status.error = redact(error);
      for (const [promptId, request] of pending) {
        const interaction = status.interactions.find(item => item.promptId === promptId);
        interaction.status = 'cancelled';
        interaction.cancelledAt = iso();
        interaction.resolvedAt = interaction.cancelledAt;
        request.resolve({ outcome: { outcome: 'cancelled' } });
      }
      pending.clear();
      save();
      if (client && !client.closed && status.backendSessionId && phase !== 'done') await client.notify('session/cancel', { sessionId: status.backendSessionId }).catch(() => {});
      const cleanup = await acpCleanupTree(status.agentProcess, status.descendants, {
        graceMs: config.killGraceMs,
        onTrack: descendants => { status.descendants = descendants; save(); },
      });
      client?.close();
      child?.stdin?.destroy();
      status.cleanup = cleanup;
      status.phase = cleanup.verified ? phase : 'error';
      if (!cleanup.verified) status.error = { code: 'cleanup_failed', message: 'ACP process cleanup is incomplete' };
      status.endedAt = iso();
      save();
      if (cleanup.verified) acpReleaseWorkdir(status.lock);
      return { ok: cleanup.verified, verified: cleanup.verified, phase: status.phase };
    })();
    return finishing;
  }

  const fail = error => {
    const auth = /auth|unauthenticated|login required|not logged in/i.test(String(error.code) + ' ' + error.message);
    return finish(auth ? 'auth_required' : 'error', { code: auth ? 'auth_required' : (error.code || 'runner_error'), message: redact(error.message || 'ACP execution failed') });
  };

  function applyModels(data) {
    if (!data || typeof data !== 'object') return;
    if (Array.isArray(data.configOptions)) configOptions = data.configOptions;
    if (data.models) models = data.models;
    const modelOption = configOptions.find(option => option.category === 'model' || option.id === 'model');
    // Current values in this response win over older model/config catalogs.
    actualModel = data.models?.currentModelId ?? data.currentModelId ??
      (Array.isArray(data.configOptions) ? modelOption?.currentValue : null) ?? actualModel;
    if (actualModel) status.model = actualModel;
    if (modelLocked && actualModel !== status.validatedModel) throw new AcpRuntimeError('model_mismatch', 'ACP changed the validated model during execution');
  }

  function onMessage(event) {
    if (hasUsage(event)) {
      const row = redact({ receivedAt: iso(), sessionKey: status.sessionKey, taskId: status.taskId, agent: status.agent,
        model: status.model, route: status.route, backendSessionId: status.backendSessionId ?? null,
        replayed: status.loadingHistory === true, raw: event });
      fs.appendFileSync(path.join(dir, 'usage.ndjson'), JSON.stringify(row) + '\n', { mode: 0o600 });
      status.usageEvents = (status.usageEvents || 0) + 1;
      save();
    }
  }

  function onNotification(method, params) {
    if (stopping) return;
    if (params?.sessionId && status.backendSessionId && params.sessionId !== status.backendSessionId) throw new AcpRuntimeError('session_mismatch', 'ACP update belongs to another session');
    if (method === 'session/update') {
      const update = params?.update;
      if (!update) return;
      applyModels(update);
      if (status.loadingHistory) {
        status.replayedUpdates = (status.replayedUpdates || 0) + 1;
        save();
        return;
      }
      if (update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') {
        status.text += update.content.text || '';
        if (Buffer.byteLength(status.text) > config.maxTextBytes) {
          status.text = Buffer.from(status.text).subarray(-config.maxTextBytes).toString('utf8');
          status.textTruncated = true;
        }
      }
      if (['tool_call', 'tool_call_update'].includes(update.sessionUpdate)) {
        const id = update.toolCallId;
        const index = status.toolCalls.findIndex(tool => tool.id === id);
        const prior = index === -1 ? {} : status.toolCalls[index];
        const tool = { ...prior, ...update, id, name: update.title ?? prior.name ?? update.kind ?? null };
        if (index === -1) status.toolCalls.push(tool); else status.toolCalls[index] = tool;
      }
      save();
    } else if (/^_?cognition\.ai\//.test(method)) {
      status.unsupportedExtensions ??= [];
      if (!status.unsupportedExtensions.some(item => item.method === method)) status.unsupportedExtensions.push({ method, classification: 'unsupported_devin_notification', blocking: false });
      save();
    }
  }

  function onRequest(method, params = {}, rpcId) {
    if (stopping) throw new AcpRpcError(-32000, 'ACP session is stopping');
    if (params.sessionId && status.backendSessionId && params.sessionId !== status.backendSessionId) throw new AcpRpcError(-32602, 'ACP session mismatch');
    const promptId = randomUUID();
    const cursorMethod = method.startsWith('cursor/');
    const known = supported.has(method) && (!cursorMethod || status.agent === 'cursor');
    const interaction = {
      promptId, rpcId, method, source: method === 'mcp/dao_ask_user_question' ? 'mcp' : 'native', createdAt: iso(), status: known ? 'pending' : 'unsupported',
      questions: ['cursor/ask_question', 'mcp/dao_ask_user_question'].includes(method) ? params.questions || [] : method === 'session/request_permission' ?
        [{ id: params.toolCall?.toolCallId ?? promptId, prompt: params.toolCall?.title ?? 'Tool permission', options: params.options || [] }] :
        method === 'cursor/create_plan' ? [{ id: params.toolCallId ?? promptId, prompt: params.overview ?? params.name ?? 'Review plan', plan: params.plan, todos: params.todos }] : [],
      params,
    };
    status.interactions.push(interaction);
    if (!known) {
      interaction.classification = status.agent === 'devin' && /^_?cognition\.ai\//.test(method) ? 'unsupported_devin_extension' : 'unsupported_interaction';
      const error = { code: 'unsupported_interaction', message: 'ACP agent requested an unsupported blocking extension', method, classification: interaction.classification };
      status.error = error;
      save();
      // Let JSON-RPC's -32601 response flush before cancellation/cleanup.
      setImmediate(() => finish('unsupported_interaction', error).catch(() => {}));
      throw new AcpRpcError(-32601, 'Unsupported ACP interaction');
    }
    let decision;
    // status.toolCalls is how a permission request that names only a toolCallId is
    // resolved back to the kind announced on the earlier session/update.
    const context = { cwd: config.cwd, toolCalls: status.toolCalls };
    try { decision = policyAnswer(config.interactionPolicy, method, params, context); }
    catch { interaction.policyError = 'invalid_policy_answer'; }
    // Registering our question tool explicitly authorizes invoking that tool, but not
    // answering its question or granting permission to any unrelated MCP tool.
    if (!decision && !interaction.policyError && !matchingRules(config.interactionPolicy, method, params, status.toolCalls).length) decision = injectedQuestionPermission(config, method, params);
    if (decision) {
      const { answer, scope } = decision;
      interaction.status = 'answered';
      interaction.answeredAt = iso();
      interaction.resolvedAt = interaction.answeredAt;
      interaction.answered = true;
      interaction.answerSource = decision.answerSource || 'interactionPolicy';
      interaction.answer = answer;
      if (scope) interaction.policyScope = scope;
      save();
      return answer;
    }
    status.phase = 'waiting_user';
    save();
    return new Promise((resolve, reject) => pending.set(promptId, { resolve, reject, method, params }));
  }

  async function pollControls() {
    if (polling || stopping) return;
    polling = true;
    try {
      track();
      for (const name of fs.readdirSync(path.join(dir, 'inbox')).filter(name => /^\d+-[0-9a-f-]+\.json$/.test(name)).sort()) {
        const file = path.join(dir, 'inbox', name);
        const command = acpReadJson(file);
        if (!/^[0-9a-f-]{36}$/.test(command.id)) { fs.unlinkSync(file); continue; }
        const receipt = path.join(dir, 'receipts', `${command.id}.json`);
        if (fs.existsSync(receipt)) { fs.unlinkSync(file); continue; }
        let result;
        if (command.type === 'mcp_request' && command.method === 'mcp/dao_ask_user_question') {
          // The poller must remain available to process the eventual answer/cancel.
          const response = Promise.resolve().then(() => onRequest(command.method, command.params, command.id)).then(
            result => acpAtomicJson(receipt, redact({ ok: true, result, commandId: command.id, recordedAt: iso() })),
            () => acpAtomicJson(receipt, { ok: false, error: 'interaction_failed', commandId: command.id, recordedAt: iso() }),
          );
          mcpReceipts.add(response);
          response.finally(() => mcpReceipts.delete(response)).catch(error => fail(error));
          fs.unlinkSync(file);
          continue;
        }
        if (command.type === 'stop') result = await finish('cancelled');
        else if (command.type === 'answer') {
          const promptId = command.answer?.promptId;
          const request = pending.get(promptId);
          const interaction = status.interactions.find(item => item.promptId === promptId);
          if (!request) result = { ok: false, error: interaction ? 'already_answered' : 'unknown_prompt', promptId };
          else {
            try {
              const answer = encodeAcpAnswer(request.method, request.params, command.answer);
              interaction.status = 'answered';
              interaction.answeredAt = iso();
              interaction.resolvedAt = interaction.answeredAt;
              interaction.answered = true;
              interaction.answerSource = 'interact';
              interaction.answer = answer;
              pending.delete(promptId);
              status.phase = pending.size ? 'waiting_user' : 'running';
              save(); // Persist the decision before releasing the blocked JSON-RPC request.
              request.resolve(answer);
              result = { ok: true, promptId };
            } catch (error) { result = { ok: false, error: error.code || 'invalid_answer', promptId }; }
          }
        } else result = { ok: false, error: 'unsupported_control' };
        acpAtomicJson(receipt, redact({ ...result, commandId: command.id, recordedAt: iso() }));
        fs.unlinkSync(file);
        if (stopping) break;
      }
    } catch (error) { await fail(error); }
    finally { polling = false; }
  }

  const signalHandler = () => { finish('cancelled').catch(() => {}); };
  process.on('SIGTERM', signalHandler);
  process.on('SIGINT', signalHandler);
  try {
    child = spawn(process.execPath, [SELF, '--agent-dir', dir], { cwd: config.cwd, detached: true, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore', 'ipc'] });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', () => reject(new AcpRuntimeError('agent_spawn_failed', 'Cannot spawn ACP process group'))); });
    status.agentProcess = acpProcessIdentity(child.pid);
    status.descendants = [status.agentProcess];
    save();
    child.on('message', message => {
      if (message.type === 'agent_spawned') { status.cliProcess = message.identity; track(); }
      if (message.type === 'agent_error' && !stopping) fail(new AcpRuntimeError('agent_spawn_failed', 'ACP agent executable could not be started')).catch(() => {});
      if (message.type === 'agent_exit' && !stopping) {
        status.agentExit = { code: message.code, signal: message.signal };
        // IPC and stdout are separate pipes; permit an already-written prompt response to drain.
        groupExitTimer = setTimeout(() => { if (!stopping) fail(new AcpRuntimeError('agent_exited', 'ACP agent exited before a prompt result')).catch(() => {}); }, 50);
      }
    });
    client = new AcpClient({ readable: child.stdout, writable: child.stdin, onRequest, onNotification, onMessage });
    client.on('closed', error => { if (!stopping) fail(error).catch(() => {}); });
    poller = setInterval(() => { pollControls().catch(() => {}); }, config.pollMs);
    const rpc = (method, params) => client.request(method, params, { timeoutMs: config.handshakeTimeoutMs });
    const init = await rpc('initialize', { protocolVersion: 1, clientInfo: { name: 'dao-acp-runtime', version: '1' }, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
    if (init?.protocolVersion !== 1) throw new AcpRuntimeError('protocol_mismatch', 'ACP server did not negotiate protocol version 1');
    status.capabilities = init.agentCapabilities || {};
    const mcpServers = config.interactionMcp ? [{ name: 'dao-interactions', command: process.execPath, args: [MCP, '--session-dir', dir], env: [] }] : [];
    let session;
    if (config.resumeFrom) {
      if (init.agentCapabilities?.loadSession !== true) throw new AcpRuntimeError('resume_unsupported', 'The current ACP agent does not advertise session/load');
      status.backendSessionId = config.backendSessionId;
      status.loadingHistory = true;
      save();
      const loaded = await rpc('session/load', { sessionId: config.backendSessionId, cwd: config.cwd, mcpServers });
      status.loadingHistory = false;
      if (loaded?.sessionId !== undefined && loaded.sessionId !== config.backendSessionId) throw new AcpRuntimeError('session_mismatch', 'ACP loaded a different backend session');
      session = { ...loaded, sessionId: config.backendSessionId };
      status.loadedAt = iso();
    } else session = await rpc('session/new', { cwd: config.cwd, mcpServers });
    if (typeof session?.sessionId !== 'string' || !session.sessionId) throw new AcpRuntimeError('invalid_session', 'ACP server did not return a session ID');
    status.backendSessionId = session.sessionId;
    applyModels(session);
    const requested = config.model;
    if (requested && requested !== actualModel) {
      const option = configOptions.find(option => option.category === 'model' || option.id === 'model');
      const available = option ? optionValues(option.options) : models?.availableModels?.map(model => model.modelId) || [];
      if (!available.includes(requested)) throw new AcpRuntimeError('model_unavailable', 'Requested concrete model ID is absent from the ACP model catalog');
      const result = option ? await rpc('session/set_config_option', { sessionId: session.sessionId, configId: option.id, value: requested }) :
        await rpc('session/set_model', { sessionId: session.sessionId, modelId: requested });
      applyModels(result);
    }
    if (!acpConcreteModel(actualModel)) throw new AcpRuntimeError('model_unverified', 'ACP server did not return a concrete current model ID');
    if (requested && requested !== actualModel) throw new AcpRuntimeError('model_mismatch', 'ACP server did not confirm the requested model ID');
    if (config.effort != null) {
      const effort = configOptions.find(option => /^(?:effort|reasoning_effort|reasoning|thought_level)$/.test(option.category || '') || /^(?:effort|reasoning_effort|reasoning)$/.test(option.id));
      if (effort) {
        if (!optionValues(effort.options).includes(config.effort)) throw new AcpRuntimeError('unsupported_effort', 'Requested effort is absent from the ACP configuration');
        const result = await rpc('session/set_config_option', { sessionId: session.sessionId, configId: effort.id, value: config.effort });
        applyModels(result);
        if (configOptions.find(option => option.id === effort.id)?.currentValue !== config.effort) throw new AcpRuntimeError('effort_mismatch', 'ACP server did not confirm requested effort');
      } else if (!(actualModel.match(/\[([^\]]*)\]/)?.[1] || '').split(',').some(part => ['effort', 'reasoning', 'reasoning_effort'].some(key => part === `${key}=${config.effort}`))) {
        throw new AcpRuntimeError('unsupported_effort', 'ACP profile cannot verify the requested effort');
      }
    }
    if (requested && requested !== actualModel) throw new AcpRuntimeError('model_mismatch', 'ACP effort selection changed the requested model ID');
    if (stopping || status.error) throw new AcpRuntimeError('session_stopping', 'ACP session stopped during initialization');
    status.model = status.validatedModel = actualModel;
    modelLocked = true;
    status.acceptedAt = iso();
    status.phase = pending.size ? 'waiting_user' : 'running';
    save();
    const result = await client.request('session/prompt', { sessionId: session.sessionId, prompt: [{ type: 'text', text: config.prompt }] }, { timeoutMs: 0 });
    if (!stopping) {
      status.stopReason = result?.stopReason ?? null;
      if (status.error?.code === 'unsupported_interaction') { await finish('unsupported_interaction', status.error); return; }
      if (pending.size) throw new AcpRuntimeError('unresolved_interaction', 'ACP prompt ended while an interaction was still pending');
      if (result?.stopReason === 'end_turn') await finish('done');
      else if (result?.stopReason === 'cancelled') await finish('cancelled');
      else await finish('error', { code: 'prompt_incomplete', message: 'ACP prompt ended without end_turn', stopReason: result?.stopReason ?? null });
    }
  } catch (error) { await fail(error); }
  finally {
    if (finishing) await finishing;
    // A stop command's receipt is written by the poller after finish resolves.
    while (polling) await new Promise(resolve => setTimeout(resolve, 5));
    await Promise.allSettled([...mcpReceipts]);
    clearInterval(poller);
    clearTimeout(groupExitTimer);
    process.off('SIGTERM', signalHandler);
    process.off('SIGINT', signalHandler);
    child?.unref();
    if (child?.connected) child.disconnect();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  const mode = process.argv[2];
  const dir = process.argv[3];
  if (!['--session-dir', '--agent-dir'].includes(mode) || !dir || !path.isAbsolute(dir)) {
    process.stderr.write('Usage: acp-session-runner.mjs --session-dir <absolute session directory>\n');
    process.exitCode = 2;
  } else {
    try {
      if (mode === '--agent-dir') await runAgentGroup(dir);
      else { await runAcpSession(dir); process.exit(0); }
    } catch {
      // Do not print raw protocol exceptions, process environments, or account information.
      process.stderr.write('ACP runner failed; inspect its private session status.\n');
      process.exit(1);
    }
  }
}
