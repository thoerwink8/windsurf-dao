import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

export const ACP_PROFILES = Object.freeze({
  cursor: { command: 'cursor-agent', args: ['--trust', 'acp'] },
  devin: { command: 'devin', args: ['--respect-workspace-trust', 'false', 'acp'] },
  grok: { command: 'grok', args: ['agent', '--no-leader', 'stdio'], env: { GROK_DISABLE_AUTOUPDATER: '1' } },
});
const RUNNER = fileURLToPath(new URL('../acp-session-runner.mjs', import.meta.url));
const KEY = /^acp:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
export const ACP_TERMINAL = new Set(['done', 'cancelled', 'error', 'auth_required', 'unsupported_interaction']);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const iso = () => new Date().toISOString();

export class AcpRuntimeError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'AcpRuntimeError';
    this.code = code;
    this.detail = detail;
  }
}

/** Secret values are never copied into status, usage, receipts, or exception logs.
 * Protocol usage structure is retained; counts such as inputTokens are not secrets.
 */
export function acpRedactor(env = process.env) {
  const secretKey = /(?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|secret|password|cookie|credential|private[_-]?key|email|account[_-]?id|user[_-]?id|team[_-]?id)$/i;
  const secrets = Object.entries(env).filter(([key, value]) =>
    /(?:token|secret|password|api[_-]?key|credential)/i.test(key) && typeof value === 'string' && value.length >= 6,
  ).map(([, value]) => value).sort((a, b) => b.length - a.length);
  const string = value => {
    for (const secret of secrets) value = value.split(secret).join('[redacted]');
    return value.replace(/\bBearer\s+[^\s"'<>]+/gi, 'Bearer [redacted]')
      .replace(/\b(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{10,}\b/g, '[redacted]')
      .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[redacted]')
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
      .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)\s*[=:]\s*)[^\s,;"'}]+/gi, '$1[redacted]');
  };
  const clean = value => {
    if (typeof value === 'string') return string(value);
    if (Array.isArray(value)) return value.map(clean);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) =>
      [key, secretKey.test(key) || (/^token$/i.test(key) && typeof item === 'string') ? '[redacted]' : clean(item)],
    ));
    return value;
  };
  return clean;
}

export function acpReadJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }

/** Single-writer snapshots + atomic rename; inbox files each have unique names.
 * fsync both file and directory so the rename survives a host restart on Linux.
 */
export function acpAtomicJson(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify(value) + '\n');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporary, file);
    const directory = fs.openSync(path.dirname(file), 'r');
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

let bootId;
export function acpProcessIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1 || process.platform !== 'linux') return null;
  try {
    bootId ??= fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
    return { pid, startTicks: fields[19], bootId, ppid: Number(fields[1]), pgid: Number(fields[2]), state: fields[0] };
  } catch (error) {
    if (['ENOENT', 'ESRCH'].includes(error.code)) return null;
    throw new AcpRuntimeError('process_unverifiable', 'Cannot verify ACP process identity');
  }
}

export function acpProcessAlive(identity) {
  if (!identity?.startTicks || !identity?.bootId) return false;
  const actual = acpProcessIdentity(identity.pid);
  return Boolean(actual && actual.startTicks === identity.startTicks && actual.bootId === identity.bootId && !['Z', 'X'].includes(actual.state));
}

/** Discover ordinary process-group members AND children that create their own group.
 * Track identities, not numeric PIDs. Unknown/reused PIDs are never signalled.
 */
export function acpProcessTree(root, previous = []) {
  const seeds = [root, ...previous].filter(identity => identity && acpProcessAlive(identity));
  if (!seeds.length) return [];
  const rows = fs.readdirSync('/proc').filter(name => /^\d+$/.test(name))
    .map(name => acpProcessIdentity(Number(name))).filter(row => row && !['Z', 'X'].includes(row.state));
  const members = new Map(seeds.map(row => [row.pid, row]));
  // Group membership is trusted only while its original leader's identity matches.
  const group = root && acpProcessAlive(root) && root.pgid === root.pid ? root.pid : null;
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (!members.has(row.pid) && (members.has(row.ppid) || (group !== null && row.pgid === group))) {
        members.set(row.pid, row);
        changed = true;
      }
    }
  }
  return [...members.values()];
}

function signalIdentity(identity, signal) {
  if (!acpProcessAlive(identity)) return;
  try { process.kill(identity.pid, signal); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
}

export async function acpCleanupTree(root, previous = [], { graceMs = 300, killMs = 1500, onTrack } = {}) {
  let tracked = acpProcessTree(root, previous);
  onTrack?.(tracked);
  if (root && acpProcessAlive(root) && root.pgid === root.pid) {
    try { process.kill(-root.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  for (const identity of tracked) signalIdentity(identity, 'SIGTERM');
  const graceEnd = Date.now() + graceMs;
  while (tracked.some(acpProcessAlive) && Date.now() < graceEnd) {
    await sleep(25);
    tracked = acpProcessTree(root, tracked);
    onTrack?.(tracked);
  }
  const killEnd = Date.now() + killMs;
  do {
    tracked = acpProcessTree(root, tracked);
    onTrack?.(tracked);
    for (const identity of [...tracked].reverse()) signalIdentity(identity, 'SIGKILL');
    if (!tracked.some(acpProcessAlive)) return { verified: true, survivors: [] };
    await sleep(25);
  } while (Date.now() < killEnd);
  const survivors = tracked.filter(acpProcessAlive);
  return { verified: survivors.length === 0, survivors };
}

function acquireWorkdir(stateDir, cwd, key) {
  const locks = path.join(stateDir, 'locks');
  fs.mkdirSync(locks, { recursive: true, mode: 0o700 });
  const lockDir = path.join(locks, createHash('sha256').update(cwd).digest('hex'));
  const marker = key.slice(4) + '.json';
  const staged = `${lockDir}.${randomUUID()}.pending`;
  fs.mkdirSync(staged, { mode: 0o700 });
  try {
    acpAtomicJson(path.join(staged, marker), { sessionKey: key, cwd, creator: acpProcessIdentity(process.pid), createdAt: iso() });
    // Both source and destination are nonempty: competing rename cannot overwrite a lock.
    fs.renameSync(staged, lockDir);
  } catch (error) {
    fs.rmSync(staged, { recursive: true, force: true });
    if (['EEXIST', 'ENOTEMPTY'].includes(error.code)) {
      let owner;
      try {
        const name = fs.readdirSync(lockDir).find(name => /^[0-9a-f-]+\.json$/.test(name));
        if (name) owner = acpReadJson(path.join(lockDir, name));
      } catch {}
      // Never steal a stale lease during admission. stopSession reconciles dead runners.
      throw new AcpRuntimeError('workdir_locked', 'ACP workdir is reserved; reconcile its session before starting another', { sessionKey: owner?.sessionKey, cwd });
    }
    throw error;
  }
  return { directory: lockDir, marker };
}

export function acpReleaseWorkdir(lock) {
  if (!lock) return;
  try { fs.unlinkSync(path.join(lock.directory, lock.marker)); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  // Another admission may already have replaced the now-empty directory. Never remove its contents.
  try { fs.rmdirSync(lock.directory); }
  catch (error) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error; }
}

function acquireCleanupGuard(directory) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const marker = `${randomUUID()}.json`;
    const staged = `${directory}.${randomUUID()}.pending`;
    fs.mkdirSync(staged, { mode: 0o700 });
    try {
      acpAtomicJson(path.join(staged, marker), { creator: acpProcessIdentity(process.pid) });
      fs.renameSync(staged, directory);
      return { directory, marker };
    } catch (error) {
      fs.rmSync(staged, { recursive: true, force: true });
      if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error;
      try {
        const previous = fs.readdirSync(directory).find(name => /^[0-9a-f-]+\.json$/.test(name));
        if (!previous) return null;
        const owner = acpReadJson(path.join(directory, previous));
        if (!owner.creator || acpProcessAlive(owner.creator)) return null;
        // Unique marker unlink ensures concurrent recovery cannot remove a replacement.
        acpReleaseWorkdir({ directory, marker: previous });
      } catch (readError) { if (readError.code !== 'ENOENT') throw readError; }
    }
  }
  return null;
}

export function acpConcreteModel(model) {
  return typeof model === 'string' && model.length > 0 &&
    !/^(?:auto|default|pool|best|recommended)(?:$|\[|:|\/|-)/i.test(model);
}

function defaultBinary(agent, homeDir, env) {
  const override = env[`DAO_ACP_${agent.toUpperCase()}_BIN`];
  if (override) return override;
  const command = ACP_PROFILES[agent].command;
  const candidates = (env.PATH || '').split(path.delimiter).filter(Boolean).map(dir => path.join(dir, command));
  candidates.push(path.join(homeDir, '.local', 'bin', command));
  if (agent === 'devin') candidates.push(path.join(homeDir, '.local/share/devin/cli/_versions/current/bin/devin'));
  if (agent === 'grok') candidates.push(path.join(homeDir, '.grok/bin/grok'));
  if (agent === 'cursor') {
    const versions = path.join(homeDir, '.local/share/cursor-agent/versions');
    candidates.push(path.join(versions, 'current/cursor-agent'));
    try {
      for (const version of fs.readdirSync(versions).filter(name => /^\d/.test(name)).sort().reverse()) candidates.push(path.join(versions, version, 'cursor-agent'));
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  for (const candidate of candidates) {
    try { fs.accessSync(candidate, fs.constants.X_OK); if (fs.statSync(candidate).isFile()) return fs.realpathSync(candidate); } catch {}
  }
  return command;
}

/** API contract:
 * - An explicit, existing absolute workdir is the caller's managed-workspace assertion.
 *   managedWorkdirs may additionally restrict it to exact realpaths (no descendant inference).
 * - profiles[agent]: {command, args, env}; no shell interpolation. Defaults use native accounts.
 * - interactionPolicy: {rules:[{method, toolCallId?, questionIds?, answer}]}; JSON only.
 *   Answers are validated against the actual request; absent/ambiguous rules wait for a user.
 *   Permission allow additionally requires toolKinds + exact absolute workdir, then exact
 *   paths for file tools or commandPrefixes (arrays of argv words) for execute tools.
 *   Example: {method:'session/request_permission',toolKinds:['execute'],workdir:'/managed',
 *     commandPrefixes:[['node','--test']],answer:{optionId:'allow-once-id-from-server'}}.
 * - interact(key, {promptId, optionId|answers|outcome}) waits for a durable receipt.
 * - startSession accepts an optional sessionKey='acp:<uuid>'; an existing directory
 *   is never overwritten. resumeSession accepts {sessionKey} as its third argument.
 * - Launch errors expose detail.sessionKey and detail.launchUncertain. false means
 *   this attempt never spawned or its recorded processes were verified cleaned up;
 *   true requires reconciliation of the key, including an already-existing key.
 * - done means ACP end_turn only; snapshot.taskCompleted is always false.
 * - resumeSession(key,prompt) loads the advertised backend session in a new attempt.
 *   It preserves task/account/model/workdir and the private original agent environment;
 *   an active source is refused, and an interrupted source is reconciled before launch.
 * - Linux /proc identity checks are required; unsupported platforms fail before spawning.
 */
export function createAcpRuntime(opts = {}) {
  const homeDir = path.resolve(opts.homeDir || os.homedir());
  const stateDir = path.resolve(opts.stateDir || path.join(homeDir, '.dao', 'execution', 'acp'));
  // Unified executor passes its model catalog as profiles[]. Binary launch profiles are
  // a separate map; never interpret model/account entries as commands or environments.
  const profiles = opts.acpProfiles || (!Array.isArray(opts.profiles) ? opts.profiles : null) || {};
  const startupTimeoutMs = opts.startupTimeoutMs ?? 30_000;
  const controlTimeoutMs = opts.controlTimeoutMs ?? 6000;
  const pollMs = opts.pollMs ?? 50;
  const redact = acpRedactor({ ...process.env, ...opts.env });
  function directory(key) {
    const uuid = typeof key === 'string' && KEY.exec(key)?.[1];
    if (!uuid) throw new AcpRuntimeError('invalid_session_key', 'Expected acp:<uuid>');
    return path.join(stateDir, 'sessions', uuid);
  }
  function launchError(error, sessionKey, launchUncertain) {
    const detail = redact(error.detail || {});
    if (detail.sessionKey && detail.sessionKey !== sessionKey) detail.ownerSessionKey = detail.sessionKey;
    delete detail.sessionKey;
    if (typeof sessionKey === 'string' && KEY.test(sessionKey)) detail.sessionKey = sessionKey;
    return new AcpRuntimeError(error.code || 'startup_failed', redact(error.message || 'ACP launch failed'), { ...detail, launchUncertain });
  }
  function assertUnusedKey(sessionKey) {
    try {
      fs.lstatSync(directory(sessionKey)); // Dangling symlinks also reserve a key.
      throw launchError(new AcpRuntimeError('session_exists', 'ACP session directory already exists', { alreadyExists: true }), sessionKey, true);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  async function withLaunchKey(requestedKey, operation) {
    const sessionKey = requestedKey === undefined ? `acp:${randomUUID()}` : requestedKey;
    try {
      directory(sessionKey);
      assertUnusedKey(sessionKey);
      return await operation(sessionKey);
    } catch (error) {
      if (error.detail?.sessionKey === sessionKey && typeof error.detail?.launchUncertain === 'boolean') throw error;
      throw launchError(error, sessionKey, false);
    }
  }
  const raw = key => {
    const dir = directory(key);
    const status = acpReadJson(path.join(dir, 'status.json'));
    if (!status.runner) {
      try {
        const launch = acpReadJson(path.join(dir, 'launch.json'));
        status.runner = launch.runner;
        status.launchRecorded = true;
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return status;
  };

  async function readSession(key) {
    let status;
    try { status = raw(key); }
    catch (error) {
      if (error.code === 'invalid_session_key') throw error;
      return { phase: null, text: '', toolCalls: [], error: error.code === 'ENOENT' ? null : 'status_unreadable', interactions: [], via: 'acp', snapshot: null, missing: error.code === 'ENOENT' };
    }
    const terminal = ACP_TERMINAL.has(status.phase) && status.cleanup?.verified === true;
    const alive = acpProcessAlive(status.runner);
    const starting = !status.runner && !status.launchRecorded && status.phase === 'starting' && acpProcessAlive(status.creator);
    const interrupted = !terminal && !alive && !starting;
    const snapshot = redact({ ...status, ...(interrupted ? { phase: 'interrupted', error: { code: 'runner_lost', message: 'ACP runner is no longer alive; reconcile with stopSession' } } : {}), runnerAlive: alive });
    return { phase: snapshot.phase, text: snapshot.text || '', toolCalls: snapshot.toolCalls || [], error: snapshot.error || null,
      interactions: snapshot.interactions || [], via: 'acp', snapshot, missing: false };
  }

  async function listSessions() {
    let names;
    try { names = fs.readdirSync(path.join(stateDir, 'sessions')); }
    catch (error) {
      return error.code === 'ENOENT' ? { ok: true, sessions: [] } : { ok: false, sessions: null, error: 'state_unreadable' };
    }
    const sessions = [];
    for (const name of names.sort()) {
      if (!KEY.test(`acp:${name}`)) continue;
      const view = await readSession(`acp:${name}`);
      if (!view.snapshot) return { ok: false, sessions: null, error: 'status_unreadable' };
      const s = view.snapshot;
      sessions.push({ key: s.sessionKey, sessionKey: s.sessionKey, state: s.phase, phase: s.phase, cwd: s.cwd, workdir: s.cwd,
        agent: s.agent, taskId: s.taskId, clientRef: s.clientRef, startedAt: s.startedAt, model: s.model, route: s.route,
        resumeFrom: s.resumeFrom, backendSessionId: s.backendSessionId,
        runner: s.runner, pid: s.runner?.pid, startTicks: s.runner?.startTicks, via: 'acp' });
    }
    return { ok: true, sessions };
  }

  async function control(key, type, answer) {
    const status = raw(key);
    if (!acpProcessAlive(status.runner)) return { ok: false, error: 'runner_lost' };
    if (ACP_TERMINAL.has(status.phase)) return { ok: false, error: 'session_ended' };
    const id = randomUUID();
    const dir = directory(key);
    acpAtomicJson(path.join(dir, 'inbox', `${Date.now()}-${id}.json`), { id, type, answer, createdAt: iso() });
    const deadline = Date.now() + controlTimeoutMs;
    while (Date.now() < deadline) {
      try { return acpReadJson(path.join(dir, 'receipts', `${id}.json`)); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (!acpProcessAlive(status.runner)) break;
      await sleep(pollMs);
    }
    // The command is not silently resent: caller can inspect the durable receipt by commandId.
    return { ok: false, error: 'control_unconfirmed', commandId: id };
  }

  async function stopSession(key) {
    let status;
    try { status = raw(key); }
    catch (error) { if (error.code === 'ENOENT') return { ok: false, missing: true, verified: false }; throw error; }
    if (ACP_TERMINAL.has(status.phase) && status.cleanup?.verified) return { ok: true, verified: true, alreadyStopped: true };
    if (acpProcessAlive(status.runner)) {
      const result = await control(key, 'stop');
      if (result.ok) return result;
    }
    const dir = directory(key);
    const guard = acquireCleanupGuard(path.join(dir, 'cleanup.guard'));
    if (!guard) return { ok: false, verified: false, error: 'cleanup_in_progress' };
    try {
      status = raw(key);
      if (ACP_TERMINAL.has(status.phase) && status.cleanup?.verified) return { ok: true, verified: true, alreadyStopped: true };
      if (!status.runner && !status.launchRecorded && acpProcessAlive(status.creator)) return { ok: false, verified: false, error: 'session_starting' };
      if (acpProcessAlive(status.runner)) {
        signalIdentity(status.runner, 'SIGTERM');
        const deadline = Date.now() + 2000;
        while (acpProcessAlive(status.runner) && Date.now() < deadline) await sleep(25);
        if (acpProcessAlive(status.runner)) signalIdentity(status.runner, 'SIGKILL');
        const killed = Date.now() + 1500;
        while (acpProcessAlive(status.runner) && Date.now() < killed) await sleep(25);
        if (acpProcessAlive(status.runner)) return { ok: false, verified: false, error: 'runner_cleanup_failed' };
      }
      status = raw(key); // The runner may have recorded additional child identities during TERM.
      const cleanup = await acpCleanupTree(status.agentProcess, status.descendants, { graceMs: opts.killGraceMs ?? 300 });
      status.cleanup = cleanup;
      status.phase = cleanup.verified ? 'cancelled' : 'error';
      status.error = cleanup.verified ? null : { code: 'cleanup_failed', message: 'ACP process cleanup is incomplete' };
      status.updatedAt = status.endedAt = iso();
      status.interactions = (status.interactions || []).map(item => item.status === 'pending' ? { ...item, status: 'cancelled' } : item);
      acpAtomicJson(path.join(dir, 'status.json'), redact(status));
      if (cleanup.verified) acpReleaseWorkdir(status.lock);
      return { ok: cleanup.verified, ...cleanup };
    } finally { acpReleaseWorkdir(guard); }
  }

  async function launchSession(input, continuation = null) {
    const sessionKey = input.sessionKey;
    const dir = directory(sessionKey);
    assertUnusedKey(sessionKey); // Recheck after asynchronous resume reconciliation.
    if (process.platform !== 'linux') throw new AcpRuntimeError('unsupported_platform', 'Durable ACP requires Linux process identity checks');
    const { agent, workdir, prompt, model, effort, clientRef, interactionPolicy, ...contextInput } = input || {};
    if (!Object.hasOwn(ACP_PROFILES, agent)) throw new AcpRuntimeError('unsupported_agent', 'ACP agent has no profile');
    const profile = profiles[agent] || {};
    if (typeof workdir !== 'string' || !path.isAbsolute(workdir)) throw new AcpRuntimeError('managed_workdir_required', 'An explicit absolute managed workdir is required');
    const cwd = fs.realpathSync(workdir);
    if (!fs.statSync(cwd).isDirectory()) throw new AcpRuntimeError('managed_workdir_required', 'Managed workdir must be an existing directory');
    if (opts.managedWorkdirs && !opts.managedWorkdirs.map(value => fs.realpathSync(value)).includes(cwd)) throw new AcpRuntimeError('unmanaged_workdir', 'Workdir is outside the managed-workspace allowlist');
    if (typeof prompt !== 'string' || !prompt.trim()) throw new AcpRuntimeError('invalid_prompt', 'ACP prompt must be a nonempty string');
    if (model != null && !acpConcreteModel(model)) throw new AcpRuntimeError('invalid_model', 'ACP requires a concrete model ID, not an automatic pool alias');
    const route = input.route ?? 'local';
    if (!['local', 'native', 'direct'].includes(route)) throw new AcpRuntimeError('unsupported_route', 'Native ACP only supports a direct local route');
    const agentHome = continuation?.request.homeDir || homeDir;
    const resolvedProfile = continuation?.request.profile || { ...ACP_PROFILES[agent], ...profile, command: profile.command || profile.bin || defaultBinary(agent, homeDir, { ...process.env, ...opts.env }) };
    // This is private execution state (0700 directory / 0600 file), never a public
    // context or usage record. Restoring it prevents a new caller's environment from
    // silently selecting different credentials, endpoints, or config directories.
    const agentEnv = continuation?.request.agentEnv || { ...process.env, HOME: agentHome, ...opts.env, ...resolvedProfile.env };
    if (typeof resolvedProfile.command !== 'string' || !Array.isArray(resolvedProfile.args) || !resolvedProfile.args.every(value => typeof value === 'string')) throw new AcpRuntimeError('invalid_profile', 'ACP profile requires command and string args');
    // A detached process cannot inherit function callbacks. Fail instead of dropping policy silently.
    const configFields = { resolvedProfile, interactionPolicy, contextInput, env: opts.env };
    JSON.stringify(configFields, (_key, value) => {
      if (['function', 'symbol', 'bigint'].includes(typeof value)) throw new AcpRuntimeError('invalid_config', 'ACP profiles, context and interactionPolicy must be JSON serializable');
      return value;
    });
    const taskId = input.taskId ?? randomUUID();
    const startedAt = iso();
    fs.mkdirSync(path.join(stateDir, 'sessions'), { recursive: true, mode: 0o700 });
    let lock;
    try { lock = acquireWorkdir(stateDir, cwd, sessionKey); }
    catch (error) {
      // Another caller may have reserved this exact key but not made its directory yet.
      if (error.detail?.sessionKey === sessionKey) throw launchError(error, sessionKey, true);
      throw error;
    }
    let child, runnerIdentity, directoryCreated = false;
    try {
      try { fs.mkdirSync(dir, { mode: 0o700 }); }
      catch (error) {
        if (error.code === 'EEXIST') throw launchError(new AcpRuntimeError('session_exists', 'ACP session directory already exists', { alreadyExists: true }), sessionKey, true);
        throw error;
      }
      directoryCreated = true;
      fs.mkdirSync(path.join(dir, 'inbox'), { mode: 0o700 });
      fs.mkdirSync(path.join(dir, 'receipts'), { mode: 0o700 });
      const context = redact({ ...Object.fromEntries(['profileId', 'provider', 'accountPoolId', 'issue', 'pr', 'context'].filter(key => input[key] !== undefined).map(key => [key, input[key]])),
        ...(continuation ? { resumeFrom: continuation.key, backendSessionId: continuation.backendSessionId } : {}),
        agent, taskId, clientRef, sessionKey, cwd, route: 'local', startedAt });
      acpAtomicJson(path.join(dir, 'context.json'), context);
      acpAtomicJson(path.join(dir, 'request.json'), { agent, cwd, prompt, model, effort, interactionPolicy,
        ...(continuation ? { resumeFrom: continuation.key, backendSessionId: continuation.backendSessionId } : {}),
        profile: resolvedProfile, homeDir: agentHome, env: continuation?.request.env || opts.env || {}, agentEnv,
        handshakeTimeoutMs: opts.handshakeTimeoutMs ?? 20_000,
        pollMs, killGraceMs: opts.killGraceMs ?? 300, maxTextBytes: opts.maxTextBytes ?? 4 * 1024 * 1024,
        interactionMcp: continuation ? continuation.request.interactionMcp : opts.interactionMcp !== false });
      acpAtomicJson(path.join(dir, 'status.json'), { ...context, context, phase: 'starting', taskCompleted: false,
        completionScope: 'acp_prompt', creator: acpProcessIdentity(process.pid), runner: null, lock,
        requestedModel: model ?? null, model: null, effort: effort ?? null, text: '', toolCalls: [], interactions: [],
        error: null, updatedAt: startedAt, via: 'acp', descendants: [] });
      child = spawn(process.execPath, [RUNNER, '--session-dir', dir], { cwd, detached: true, windowsHide: true, stdio: 'ignore', env: process.env });
      const spawned = new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', () => reject(new AcpRuntimeError('runner_spawn_failed', 'Cannot spawn durable ACP runner'))); });
      await spawned;
      runnerIdentity = acpProcessIdentity(child.pid);
      // Separate ownership file: never race the runner's single-writer status.json.
      // This covers a bootstrap failure before the runner publishes its first snapshot.
      acpAtomicJson(path.join(dir, 'launch.json'), { runner: runnerIdentity, launchedAt: iso() });
      child.unref();
      const deadline = Date.now() + startupTimeoutMs;
      while (Date.now() < deadline) {
        const status = raw(sessionKey);
        if (status.acceptedAt) return { sessionKey, taskId, startedAt, ...(continuation ? { resumeFrom: continuation.key, backendSessionId: continuation.backendSessionId } : {}) };
        if (ACP_TERMINAL.has(status.phase) && status.cleanup?.verified) throw new AcpRuntimeError(status.error?.code || 'startup_failed', status.error?.message || 'ACP startup failed');
        if ((status.runner || status.launchRecorded) && !acpProcessAlive(status.runner)) break;
        await sleep(pollMs);
      }
      throw new AcpRuntimeError('startup_timeout', 'ACP runner did not accept the session in time');
    } catch (error) {
      child?.unref();
      if (!child?.pid) {
        if (directoryCreated) {
          // No process was created: preserve a terminal record for reconciliation.
          try {
            const status = raw(sessionKey);
            acpAtomicJson(path.join(dir, 'status.json'), { ...status, phase: 'error', endedAt: iso(),
              error: { code: error.code || 'startup_failed', message: redact(error.message) }, cleanup: { verified: true, survivors: [] } });
          } catch {}
        }
        acpReleaseWorkdir(lock);
        throw launchError(error, sessionKey, error.detail?.launchUncertain === true);
      }
      let verified = false;
      try {
        const stopped = await stopSession(sessionKey);
        if (stopped.verified) {
          const status = raw(sessionKey);
          const identity = runnerIdentity || status.runner;
          const deadline = Date.now() + controlTimeoutMs;
          while (identity && acpProcessAlive(identity) && Date.now() < deadline) await sleep(pollMs);
          const runnerGone = identity ? !acpProcessAlive(identity) : child.exitCode !== null || child.signalCode !== null;
          verified = runnerGone && status.cleanup?.verified === true && acpProcessTree(status.agentProcess, status.descendants).length === 0;
        }
      } catch {} // Missing/unreadable evidence is uncertainty; retain the durable key.
      throw launchError(error, sessionKey, !verified);
    }
  }

  async function startSession(input) {
    return withLaunchKey(input?.sessionKey, sessionKey => launchSession({ ...input, sessionKey }));
  }

  async function resumeSession(key, prompt, options = {}) {
    return withLaunchKey(options?.sessionKey, sessionKey => resumeInto(key, prompt, sessionKey));
  }

  async function resumeInto(key, prompt, sessionKey) {
    if (typeof prompt !== 'string' || !prompt.trim()) throw new AcpRuntimeError('invalid_prompt', 'Resume requires a nonempty continuation prompt');
    const view = await readSession(key);
    if (!view.snapshot) throw new AcpRuntimeError('resume_unavailable', 'The source ACP session is unavailable');
    const previous = view.snapshot;
    if (!ACP_TERMINAL.has(previous.phase) && previous.phase !== 'interrupted') throw new AcpRuntimeError('session_active', 'Stop the active ACP session before resuming it');
    if (previous.capabilities?.loadSession !== true) throw new AcpRuntimeError('resume_unsupported', 'The source ACP agent did not advertise session/load');
    if (typeof previous.backendSessionId !== 'string' || !previous.backendSessionId) throw new AcpRuntimeError('resume_unavailable', 'The source ACP backend session ID is unavailable');
    if (!acpConcreteModel(previous.validatedModel)) throw new AcpRuntimeError('resume_model_unverified', 'The source ACP model was never verified');
    const request = acpReadJson(path.join(directory(key), 'request.json'));
    if (!request.agentEnv || typeof request.agentEnv !== 'object') throw new AcpRuntimeError('resume_environment_unavailable', 'This older session did not persist its agent environment; start a new session before testing recovery');
    const stopped = await stopSession(key);
    if (!stopped.verified) throw new AcpRuntimeError('resume_cleanup_unverified', 'The source ACP processes could not be verified stopped');
    // A terminal snapshot precedes the supervisor's exit by a few instructions. Wait
    // for its exact identity to disappear, not for an arbitrary grace-period sleep.
    const deadline = Date.now() + controlTimeoutMs;
    while (acpProcessAlive(previous.runner) && Date.now() < deadline) await sleep(pollMs);
    if (acpProcessAlive(previous.runner)) throw new AcpRuntimeError('resume_cleanup_unverified', 'The source ACP supervisor has not exited');
    if (acpProcessTree(previous.agentProcess, previous.descendants).length) throw new AcpRuntimeError('resume_cleanup_unverified', 'The source ACP tools have not exited');
    return launchSession({ ...previous.context, sessionKey, agent: previous.agent, workdir: previous.cwd, taskId: previous.taskId,
      clientRef: previous.clientRef, prompt, model: previous.validatedModel, effort: request.effort,
      route: previous.route, interactionPolicy: request.interactionPolicy }, { key, request, backendSessionId: previous.backendSessionId });
  }

  async function interact(key, answer) {
    if (!answer || typeof answer !== 'object' || typeof answer.promptId !== 'string') return { ok: false, error: 'prompt_id_required' };
    try { return await control(key, 'answer', answer); }
    catch (error) { if (error.code === 'ENOENT') return { ok: false, missing: true }; throw error; }
  }

  return { startSession, readSession, listSessions, interact, stopSession, resumeSession, stateDir };
}
