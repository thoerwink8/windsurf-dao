import { ApplicationFailure } from '@temporalio/activity';
import { DEFAULT_UNKNOWN_WAIT_MS, DEFAULT_UNKNOWN_WAIT_ROUNDS } from './limits.mjs';

const SHA = /^[a-f0-9]{40}$/;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const branchOf = task => `dao/issue-${task.issue}-g${task.generation}`;
// details 是可变参数（nonRetryable(message, type, ...details)），不是数组——传数组会变成 [[…]]，
// 上层读 error.details[0].sessionKey 会拿到 undefined（实咬过一次）。
const fail = (code, message, ...details) => ApplicationFailure.nonRetryable(message, code, ...details);

/** 执行体抛的瞬时故障要**带着类型**过 Temporal 边界：普通 Error 过界后 type 变成 'Error'、
//  reason 丢掉，判定层只能按 unscanned 停手等人（g4 实咬：`session is waiting for user` 本该
//  可重试，却停成 unscanned）。已经是 ApplicationFailure 的原样放行。 */
const TRANSIENT_REASONS = new Set(['lease-held', 'channel-full', 'maintenance', 'launch-uncertain']);const asTransientFailure = (error, role) => {
  if (!error || typeof error.type === 'string') return null; // 已是 ApplicationFailure：分类信息在
  const reason = error.reason || error.detail?.reason || null;
  const code = error.code || null;
  if (code !== 'busy' && code !== 'MirasimUnavailableError' && !TRANSIENT_REASONS.has(reason)) return null;
  return fail(code === 'MirasimUnavailableError' ? 'MirasimUnavailableError' : 'busy',
    `${role} runtime transient（${reason || code}）：${String(error.message || error).slice(0, 160)}`, { reason, code });
};

/** 审查输出解析：只认**恰好一份**含 findings 数组的 JSON。模型先给结论、再回显空模板时，
 *  取「最后一块」会把有阻塞的审查读成通过——宁可 unscanned，不猜。 */
/** 扫出文本里**所有**能解析的平衡 JSON 对象（含围栏内外、含嵌套）。
 *  只取「围栏内容 ∪ 全文首尾大括号」是不够的：模型常把真结论写成裸对象、再用围栏回显一份空模板，
 *  那样「唯一进得了候选集的那块」就是空结论——有 P1 的审查被读成通过。
 *  命中的对象按 JSON.stringify 去重；谓词命中数 ≠ 1 一律 null（宁可 unscanned，不猜哪份是真的）。 */
export function jsonObjects(text) {
  const source = String(text || '');
  const out = [];
  for (let i = 0; i < source.length; i += 1) {
    if (source[i] !== '{') continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let j = i; j < source.length; j += 1) {
      const ch = source[j];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') { inString = true; continue; }
      if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          try { out.push(JSON.parse(source.slice(i, j + 1))); } catch { /* 不是 JSON */ }
          break;
        }
      }
    }
  }
  return out;
}

export function parseSingle(text, predicate) {
  const hits = jsonObjects(text).filter(value => value && predicate(value)).map(value => JSON.stringify(value));
  const unique = [...new Set(hits)];
  if (unique.length !== 1) return null;
  return JSON.parse(unique[0]);
}

export const parseFindings = text => parseSingle(text, value => Array.isArray(value.findings));
export const parsePlan = text => parseSingle(text, value => typeof value.plan === 'string' && value.plan.trim().length > 0);

/** 上游瞬时中断（容量/限流/断流/超时）：这些**续跑**比重开划算——上下文还在（用户拍板：
 *  Mirasim 支持 continue；形态与实测见 scripts/lib/mirasim-runtime.mjs 的 resumeSession）。 */
const TRANSIENT_UPSTREAM = /503|capacity|rate.?limit|429|service unavailable|timed?\s*out|超时|容量|stream closed|ECONNRESET|EPIPE/i;

/** 提交前缀**由执行档的 agent 推出来**（单一真相源 = docs/execution-profiles.json）：
 *  cursor→[cursor]、codex→[codex]、grok→[grok]、devin→[devin]…。旧表按宿主写死（[cc]/[pi]），
 *  会随执行体换代而失真（用户 2026-09-19 拍板「用逻辑做」）。 */
export const commitPrefixFor = agent => (typeof agent === 'string' && /^[a-z][a-z0-9-]*$/.test(agent) ? `[${agent}]` : null);

/** 把 HEAD 的提交主题对齐到 `<前缀> <主题>`：只改信息、不动内容，正文原样保留。
 *  系统在 push 前做这件事——模型写错/没写都不算数（g4 的 composer 工人写成 [codex] 就是这么漏的）。 */
const alignCommitPrefix = async (workdir, prefix, gitFn) => {
  if (!prefix) return { aligned: false, why: 'no-prefix' };
  if (typeof gitFn !== 'function') return { aligned: false, why: 'no-git' };
  const full = String((await gitFn(['log', '-1', '--format=%B'], { cwd: workdir }))?.out || '');
  const subject = full.split('\n')[0].trim();
  if (!subject) return { aligned: false, why: 'no-subject' };
  if (subject.startsWith(prefix)) return { aligned: true, changed: false };
  const rest = subject.replace(/^\[[a-z0-9-]+\]\s*/i, '');
  const lines = full.replace(/\n+$/, '').split('\n');
  lines[0] = `${prefix} ${rest}`;
  const amended = await gitFn(['commit', '--amend', '-F', '-'], { cwd: workdir, input: `${lines.join('\n')}\n` });
  return amended?.status === 0 ? { aligned: true, changed: true, from: subject } : { aligned: false, why: String(amended?.err || 'amend failed').slice(0, 120) };
};

/** T33：lead 自审的默认提示词（在异厂独立审查**之前**跑）。产出与 review 同形，但**不参与判定**——
 *  只当返工输入：便宜的（命名/边界/漏测/取巧）在这一层捞掉，异厂审查者看到更干净的产物。 */
const DEFAULT_SELF_REVIEW_PROMPT = ({ task, artifact, checks, plan }) => `你是本任务的主脑（lead），现在做**自审**（在异厂独立审查之前）。只审 ${task.repository} 的 PR #${artifact.pr}，绑定 HEAD ${artifact.head}。工作目录已检出该 HEAD：不要改代码、不要提交、不要推送，也不要跑 gh 或联网——需要的外部事实系统已经给你了。
你的计划：${String((plan && plan.plan) || '').slice(0, 1200)}
检查证据（系统取回，不必自己再查）：${JSON.stringify(checks)}
只输出一个 JSON 对象，不要输出其它文字：
{"findings":[{"id":"<短横线小写短名>","severity":"P1|P2|P3","type":"security|data|contract|correctness|perf|maintainability|ui","effort":"small|medium|large","file":"<文件>","line":<行号>,"detail":"<现象 + 期望改法>"}]}
没有任何问题就输出 {"findings":[]}。这一层是**自审**：只报你有把握的（命名/边界/漏测/取巧），不确定的别报成 P1。`;

export function createActivities({ runtime, gh, git, gitIdentity, installDeps, projects, profileOf, reviewerPrompt, leadPrompt, executorPrompt, selfReviewPrompt = DEFAULT_SELF_REVIEW_PROMPT, closeIssue, deploy, pushEnv = {}, unknownWaitMs = DEFAULT_UNKNOWN_WAIT_MS, unknownWaitRounds = DEFAULT_UNKNOWN_WAIT_ROUNDS, resumeAttempts = 2, sleepFn = sleep, now = () => new Date().toISOString() }) {
  const projectPath = repository => {
    const path = projects[repository];
    if (!path) throw fail('UNSUPPORTED_CAPABILITY', `no local checkout mapped for ${repository}`);
    return path;
  };
  const runGh = async (args, { cwd, role } = {}) => {
    const result = await gh(args, { cwd, role });
    if (!result?.ok) throw fail('SERVICE_UNAVAILABLE', String(result?.error || 'gh failed').slice(0, 300));
    try { return JSON.parse(result.out || '{}'); }
    catch { throw fail('SERVICE_UNAVAILABLE', 'gh returned non-JSON'); }
  };
  const gitOk = result => Boolean(result) && result.status === 0;
  const headOf = async (workdir, ref = 'HEAD') => {
    const result = await git(['rev-parse', ref], { cwd: workdir });
    const head = String(result?.out || '').trim();
    if (!gitOk(result) || !SHA.test(head)) throw fail('SERVICE_UNAVAILABLE', 'cannot resolve head');
    return head;
  };
  const sessionsIn = async workdir => {
    const listed = await runtime.listSessions();
    if (!listed?.ok) return null;
    return (listed.sessions || []).filter(session => session.cwd === workdir || String(session.cwd || '').startsWith(`${workdir}/`));
  };
  // 正在干活的会话不许被「收尾/收树」误杀：ACP 读取会返回 unknown（未定），
  // 那时会话其实还在跑（g6 实咬：4 个会话都在干到一半被自己的收尾取消）。
  const ACTIVE_STATES = new Set(['running', 'streaming', 'pending', 'active']);
  const reapWorkdirSessions = async (workdir, { keepActive = true } = {}) => {
    const sessions = await sessionsIn(workdir);
    if (sessions === null) return { ok: false, why: 'session list unscanned' };
    const stopped = [];
    for (const session of sessions) {
      const key = session.sessionKey || session.key;
      if (!key) continue;
      if (keepActive && ACTIVE_STATES.has(String(session.state || '').toLowerCase())) continue;
      const result = await runtime.stopSession(key).catch(error => ({ ok: false, why: String(error?.message || error) }));
      stopped.push({ key, ok: result?.ok === true });
    }
    return { ok: stopped.every(item => item.ok), stopped };
  };
  /** 起会话前先收本树（T4）：**不靠会话名单**——名单会抖（`listSessions ok:false` 时旧写法整段
   *  空操作，2026-09-19 实咬多次），而租约文件本身写着占用者。等待中/未定的会话在这里被**显式停掉**：
   *  `stopSession` 不带 automatic——带 automatic 会以「会话在等人」拒绝，而无人值守链路上没人会来答。
   *  三态：收到 / 没租约 / 没查成（没查成不许当「树是干净的」，fail-closed 交上层重试）。 */
  const releaseStuckTree = async workdir => {
    if (typeof runtime.leaseOf !== 'function') return { ok: true, skipped: 'runtime has no leaseOf' };
    const lease = runtime.leaseOf(workdir);
    if (lease?.ok !== true) return { ok: false, why: lease?.why || 'lease unreadable' };
    const key = lease.lease?.sessionKey;
    if (!key) return { ok: true, none: true };
    const stopped = await runtime.stopSession(key).catch(error => ({ ok: false, why: String(error?.message || error) }));
    return stopped?.ok === true ? { ok: true, stopped: key } : { ok: false, why: `stop ${key}: ${String(stopped?.why || '').slice(0, 100)}` };
  };

  /** 有界树复位（T4）：`ensureWorkspace` 撞上「未注册占位」时，只有在**能证明没有产出**时才允许
   *  把树拆掉重建——审查树是派生物（无产出）；任务树只在「master 之上没有提交」时才允许。
   *  有产出一律停手报人：删产出比卡住更糟。 */
  const ensureTree = async (repo, branch, { derived = false } = {}) => {
    try {
      return await runtime.ensureWorkspace(repo, branch);
    } catch (error) {
      const why = String(error?.message || error);
      if (!/unregistered worktree path already exists/.test(why)) throw error;
      const stale = why.split('already exists:').pop().trim();
      if (!derived) {
        const ahead = await git(['log', 'origin/master..HEAD', '--oneline'], { cwd: stale }).catch(() => ({ status: 1, out: '' }));
        if (gitOk(ahead) && String(ahead.out || '').trim()) throw fail('UNSUPPORTED_CAPABILITY', `workspace reset refused: stale tree has commits beyond master（${stale}）`);
      }
      const removed = await git(['worktree', 'remove', '--force', stale], { cwd: repo });
      if (!gitOk(removed)) throw fail('SERVICE_UNAVAILABLE', `stale worktree remove failed: ${String(removed?.err || '').slice(0, 120)}`);
      await git(['worktree', 'prune'], { cwd: repo });
      return await runtime.ensureWorkspace(repo, branch);
    }
  };

  /** 执行体抛的瞬时故障（租约/渠道背压、维护窗、启动未定）在这一层统一转成带类型的可重试失败，
   *  否则过界后类型丢失、被判定层按 unscanned 停手等人（g4 实咬）。 */
  const runSession = async (task, workdir, prompt, role, options = {}) => {
    try {
      return await runSessionOnce(task, workdir, prompt, role, options);
    } catch (error) {
      throw asTransientFailure(error, role) || error;
    }
  };
  const runSessionOnce = async (task, workdir, prompt, role, options = {}) => {
    const profile = task.roles[role];
    const meta = profileMeta(profile.profile);
    let started;
    let resumed = false;
    // T7：**返工续跑同一会话**——上下文还热，修起来便宜（Devin「REJECT 当场修」就是这个）。
    // 续不上（后端不支持 / 回了别的 key）就回落新会话，不硬来（T19 同口径）。
    if (options.resumeFrom) {
      const prior = await runtime.resumeSession(options.resumeFrom, prompt, { agent: meta?.agent, workdir, model: profile.profile })
        .catch(error => ({ sessionKey: null, why: String(error?.message || error) }));
      if (prior?.sessionKey === options.resumeFrom) {
        started = { sessionKey: options.resumeFrom };
        resumed = true;
      }
    }
    // 起会话前先收本树：上一次失败的启动/未终态的会话会让租约闸判「已有活跃或未知会话」而拒绝，
    // 于是可重试的瞬时故障变成死循环（真跑实咬两轮）。同一任务同一棵树里同时只有一个会话，先收是安全的。
    // 先按**租约**收树（确定性）：等待中/未定的占用者在这里被显式停掉——名单会抖，租约不会。
    if (!started) {
      const freed = await releaseStuckTree(workdir).catch(error => ({ ok: false, why: String(error?.message || error) }));
      if (freed?.ok !== true) throw fail("SERVICE_UNAVAILABLE", `worktree lease release unverified: ${String(freed?.why || "").slice(0, 120)}`);
      await reapWorkdirSessions(workdir).catch(() => {});
      try {
        started = await runtime.startSession({ profileId: profile.profile, agent: meta?.agent, model: profile.profile, workdir, prompt, taskId: task.id, title: `${task.id} ${role}` });
      } catch (error) {
        // 启动失败会在树里留下「未定」会话记录，重试会被租约闸判「已有活跃或未知会话」而拒绝——
        // 于是瞬时故障变成死循环（真跑实咬：回环 ws 抖动 → 重试 → 撞租约闸）。
        // 先收掉本树自己的会话再抛；收不干净也要抛，让上层按可重试处理。
        await reapWorkdirSessions(workdir).catch(() => {});
        throw error;
      }
    }
    const key = started?.sessionKey || started?.key;
    if (!key) throw fail('SERVICE_UNAVAILABLE', 'session launch returned no key');
    const isWaiting = (settledState, viewState) => settledState?.status === 'waiting_user' || viewState?.phase === 'waiting_user';
    let settled = await runtime.waitForCompletion(key, { timeoutMs: task.limits.stepTimeoutSeconds * 1000 });
    let view = await runtime.readSession(key);
    if (isWaiting(settled, view)) {
      // 会话在等人回答（权限/问题）：重试只会再问一次，也不是传输故障——单独一态，交上层停手。
      // 带上 sessionKey：接手路径要能**直接核实释放**它占着的树（复核实咬：只 reap 会跳过活跃会话）。
      throw fail('WAITING_USER', `${role} session is waiting for an answer`, { sessionKey: key, role });
    }
    // unknown 是「这次没读到终态」，不是「会话失败」——多等几轮再判，
    // 不许把还在干活的会话当失败处理（g6 实咬：判 unknown 后立刻收尾 = 取消在跑的会话）。
    // 每轮只等一次 waitForCompletion：它自己就会轮询到 timeoutMs 才返回（execution-runtime
    // 对未定态睡满），这里再 sleep 一次会把墙钟变成 2×，活动预算就盖不住（复核实咬 P1）。
    for (let attempt = 0; attempt < unknownWaitRounds && settled?.status === 'unknown'; attempt += 1) {
      settled = await runtime.waitForCompletion(key, { timeoutMs: unknownWaitMs });
      view = await runtime.readSession(key);
      // 宽限里变成等人也要立刻上报：晚到的 waiting_user 若漏过这里会被折成可重试，
      // 重试再问一遍同一句——#1442 掐掉的死循环会回来（复核实咬）。
      if (isWaiting(settled, view)) throw fail('WAITING_USER', `${role} session is waiting for an answer`, { sessionKey: key, role });
    }
    // 只有终态才收尾；未知态先等满宽限（不许把还在干活的会话当失败），
    // 宽限用尽仍未知才停掉让树——两件事分开写，别再合成「非终态一律不动」。
    if (settled?.status === 'done' || settled?.status === 'failed') {
      const released = await runtime.stopSession(key).catch(error => ({ ok: false, why: String(error?.message || error) }));
      if (released?.ok !== true) throw fail('SERVICE_UNAVAILABLE', `session release unverified: ${String(released?.why || '').slice(0, 120)}`);
    } else if (settled?.status === 'unknown') {
      // 宽限用尽仍未知：不能「既不起新的、也杀不掉」——会话占着树，上层重试撞租约成死循环（复核实咬）。
      // 到这里已经等满 unknownWaitRounds 轮（默认 6 分钟）；停掉让树，让重试从 checkpoint 重来。
      // 停不干净要如实抛（树仍被占着），不许装作已释放。
      const released = await runtime.stopSession(key).catch(error => ({ ok: false, why: String(error?.message || error) }));
      if (released?.ok !== true) throw fail('SERVICE_UNAVAILABLE', `unknown session could not be released: ${String(released?.why || '').slice(0, 120)}`);
      throw fail('DEADLINE_EXCEEDED', `${role} session unknown after grace; session stopped to free the tree`);
    }
    // 上游瞬时中断（容量/限流/断流/超时）：**先续跑同一会话**，不要重开——重开会把上下文全丢掉，
    // 而且重开还要再赌一次容量（用户拍板：Mirasim 支持 continue；ACP 走 session/load）。
    // 续不上（后端不支持 / 服务端回了别的 key）就原样交上层按可重试处理，不硬来。
    for (let attempt = 0; attempt < resumeAttempts && (settled?.status === 'done' || settled?.status === 'failed') && TRANSIENT_UPSTREAM.test(String(view?.error || '')); attempt += 1) {
      const resumedUpstream = await runtime.resumeSession(key, `继续：上一轮被上游中断（${String(view?.error || '').slice(0, 120)}）。接着原任务做完，不要从头重来。`, { agent: meta?.agent, workdir, model: profile.profile }).catch(error => ({ sessionKey: null, why: String(error?.message || error) }));
      if (resumedUpstream?.sessionKey !== key) break;
      settled = await runtime.waitForCompletion(key, { timeoutMs: task.limits.stepTimeoutSeconds * 1000 });
      view = await runtime.readSession(key);
      if (isWaiting(settled, view)) throw fail('WAITING_USER', `${role} session is waiting for an answer`, { sessionKey: key, role });
    }
    return { key, status: settled?.status, view, resumed };
  };
  /** 执行档的 agent 与 family 都从执行目录取：agent 决定起哪个执行体，family 决定跨厂判定。
   *  两者都不采信契约里的声明——契约能写「我是另一家」，执行目录不能。 */
  const profileMeta = profileId => {
    if (typeof profileOf !== 'function') return null;
    try {
      const meta = profileOf(profileId);
      if (!meta) return null;
      const family = typeof meta.family === 'string' && meta.family.trim() ? meta.family.trim().toLowerCase() : null;
      return { agent: typeof meta.agent === 'string' && meta.agent.trim() ? meta.agent.trim() : undefined, family };
    } catch { return null; }
  };
  const prView = async (number, fields, { cwd, role = 'marshal' }) => runGh(['pr', 'view', String(number), '--json', fields], { cwd, role });
  /** issue 标题+正文由活动取回后塞进提示词：会话里跑 gh 是白名单外的命令，会卡在权限提问（g7 实咬）。 */
  const issueBrief = async task => {
    try {
      const view = await runGh(['issue', 'view', String(task.issue), '--json', 'title,body'], { cwd: projectPath(task.repository), role: 'marshal' });
      return `issue #${task.issue} 标题：${String(view?.title || '').slice(0, 200)}\nissue 正文（截断）：\n${String(view?.body || '').slice(0, 6000)}`;
    } catch (error) {
      return `（issue #${task.issue} 正文取不到：${String(error?.message || error).slice(0, 120)}——按标题与仓库现状判断，不要自己联网取）`;
    }
  };

  return {
    async prepare(task) {
      const repo = projectPath(task.repository);
      const branch = branchOf(task);
      const tree = await ensureTree(repo, branch);
      if (!tree?.path) throw fail('SERVICE_UNAVAILABLE', 'workspace not created');
      // 提交身份由系统设：让会话自己跑 gh-as 是白名单外命令，会卡在权限提问（g9 实咬）。
      if (typeof gitIdentity === 'function') { try { await gitIdentity(tree.path); } catch { /* 设不上不挡开工：身份另有核对 */ } }
      // 依赖也由系统装：会话跑 npm ci 是白名单外（要联网），整句会被权限闸拒（g20 实咬）。
      if (typeof installDeps === 'function') { try { await installDeps(tree.path); } catch { /* 装不上不挡开工 */ } }
      return { repository: task.repository, head: await headOf(tree.path), checkpoint: tree.path, branch };
    },
    async lead(task, { prepared, artifact, feedback, round }) {
      const { key, status, view } = await runSession(task, prepared.checkpoint, leadPrompt({ task, prepared, artifact, feedback, round, issue: await issueBrief(task) }), "lead");
      if (status !== 'done') throw fail(status === 'unknown' ? 'DEADLINE_EXCEEDED' : 'TRANSPORT_CLOSED', `lead session ${status}`);
      const plan = parsePlan(view?.text);
      if (!plan) throw fail('UNSUPPORTED_CAPABILITY', 'lead output not parseable');
      return { plan: plan.plan, sessionKey: key, at: now() };
    },
    async execute(task, { plan, prepared, feedback, round }) {
      let key = null;
      let status = 'done';
      let resumed = false;
      const prefix = commitPrefixFor(profileMeta(task.roles.executor.profile)?.agent);
      try {
        // T7：返工轮带上一轮的 sessionKey → 续跑同一会话（上下文还热，修起来便宜）。
        ({ key, status, resumed } = await runSession(task, prepared.checkpoint, executorPrompt({ task, plan, feedback, round, issue: await issueBrief(task), prefix }), "executor", { resumeFrom: feedback?.sessionKey }));
      } catch (error) {
        if (error?.type !== 'WAITING_USER') throw error;
        // 边界画在「交卷」上：工人在等人回答权限，但它可能**已经交卷**（提交就是交卷）。
        // 有提交就按完成接手；没有提交才真的是卡住——不追着它发明的每条命令去放宽白名单。
        const committed = await headOf(prepared.checkpoint);
        if (committed === (feedback?.head || prepared.head)) throw error;
        // 接手前必须**核实释放**会话占着的树：reap 默认 keepActive，等人中的会话不是终态会被跳过，
        // 树仍被占着，下一轮 execute/lead 撞租约（复核实咬）。停不掉就不接手（宁可停手报人）。
        const sessionKey = error?.details?.[0]?.sessionKey || key;
        if (!sessionKey) throw fail('UNSUPPORTED_CAPABILITY', 'handoff without session key');
        const released = await runtime.stopSession(sessionKey).catch(stopError => ({ ok: false, why: String(stopError?.message || stopError) }));
        if (released?.ok !== true) throw fail('SERVICE_UNAVAILABLE', `handoff session release unverified: ${String(released?.why || '').slice(0, 120)}`);
        status = 'waiting_user-with-commit';
      }
      if (status !== 'done' && status !== 'waiting_user-with-commit') throw fail(status === 'unknown' ? 'DEADLINE_EXCEEDED' : 'TRANSPORT_CLOSED', `executor session ${status}`);
      const head = await headOf(prepared.checkpoint);
      const expectedNew = feedback?.head || prepared.head;
      if (head === expectedNew) throw fail('UNSUPPORTED_CAPABILITY', 'executor produced no new commit');
      // 提交前缀由系统按执行档对齐（单一真相源 = 执行档的 agent）：模型写错/没写都不算数。
      // amend 只改信息、不动内容；改了就要重读 HEAD（SHA 变了）。
      const prefixAligned = await alignCommitPrefix(prepared.checkpoint, prefix, git).catch(error => ({ aligned: false, why: String(error?.message || error).slice(0, 120) }));
      const finalHead = prefixAligned?.changed ? await headOf(prepared.checkpoint) : head;
      const pushed = await git(['push', '-u', 'origin', `HEAD:refs/heads/${prepared.branch}`], { cwd: prepared.checkpoint, env: typeof pushEnv === 'function' ? pushEnv() : pushEnv });
      if (!gitOk(pushed)) throw fail('SERVICE_UNAVAILABLE', `push failed: ${String(pushed?.err || '').slice(0, 200)}`);
      const listed = await runGh(['pr', 'list', '--head', prepared.branch, '--state', 'open', '--json', 'number,baseRefName', '--limit', '5'], { cwd: prepared.checkpoint, role: 'worker' });
      const open = Array.isArray(listed) ? listed : [];
      const foreign = open.filter(item => item.baseRefName !== task.contract.targetBranch);
      if (foreign.length) throw fail('UNSUPPORTED_CAPABILITY', `open PR targets ${foreign[0].baseRefName}, contract requires ${task.contract.targetBranch}`);
      let number = open[0]?.number;
      if (!number) {
        const created = await gh(['pr', 'create', '--draft', '--base', task.contract.targetBranch, '--head', prepared.branch, '--title', `[fleet] ${task.id}`, '--body', `Fleet task ${task.id}. Contract checks: ${task.contract.requiredChecks.join(', ')}.`], { cwd: prepared.checkpoint, role: 'worker' });
        if (!created?.ok) throw fail('SERVICE_UNAVAILABLE', `pr create failed: ${String(created?.error || '').slice(0, 200)}`);
        number = Number(String(created.out).trim().split('/').pop());
      }
      if (!Number.isSafeInteger(number) || number <= 0) throw fail('SERVICE_UNAVAILABLE', 'pr number unresolved');
      return { repository: task.repository, head: finalHead, pr: number, checkpoint: prepared.checkpoint, sessionKey: key, resumed, commitPrefix: { expected: prefix, ...prefixAligned } };
    },
    async verify(task, artifact, { waitMs } = {}) {      const budget = Number.isFinite(waitMs) ? Math.max(0, waitMs) : Math.min(task.limits.stepTimeoutSeconds * 600, 20 * 60 * 1000);
      const deadline = Date.now() + budget;
      for (;;) {
        const view = await prView(artifact.pr, 'headRefOid,baseRefName,statusCheckRollup', { cwd: artifact.checkpoint });
        const head = String(view?.headRefOid || '');
        const rollup = Array.isArray(view?.statusCheckRollup) ? view.statusCheckRollup : null;
        if (!rollup) return { scanned: false, head, checks: [] };
        const checks = rollup.map(check => ({ name: check.name || check.context, status: check.status, conclusion: check.conclusion ?? null }));
        const settled = head === artifact.head && checks.length > 0 && checks.every(check => check.status === 'COMPLETED');
        if (settled || Date.now() >= deadline) return { scanned: true, head, checks };
        await sleepFn(15000);
      }
    },
    /** T34：改动文件清单（风险分层用）。取不到/为空 → `scanned:false`，调用方按 T2 保守走全流程。 */
    async changedFiles(task, artifact) {
      const base = `origin/${task.contract.targetBranch}`;
      const r = await git(['diff', '--name-only', `${base}...${artifact.head}`], { cwd: artifact.checkpoint });
      if (!gitOk(r)) return { scanned: false, files: [] };
      const files = String(r.out || '').split('\n').map((s) => s.trim()).filter(Boolean);
      return { scanned: files.length > 0, files };
    },
    /** T33：两级审查的第一级——lead 自审。产出与 review 同形但**不参与判定**：
     *  解析不出来/会话没跑完都只当「这一层没捞到」，不挡任务（判定权在异厂审查与代码）。 */
    async selfReview(task, artifact, { checks, plan } = {}) {
      const { key, status, view } = await runSession(task, artifact.checkpoint, selfReviewPrompt({ task, artifact, checks, plan }), 'lead');
      if (status !== 'done' || view?.error) return { scanned: false, head: artifact.head, findings: [], sessionKey: key, why: `session ${status}` };
      const parsed = parseFindings(view?.text);
      if (!parsed || !Array.isArray(parsed.findings)) return { scanned: false, head: artifact.head, findings: [], sessionKey: key, why: 'unparseable' };
      return { scanned: true, head: artifact.head, findings: parsed.findings, sessionKey: key };
    },
    async review(task, artifact, { checks }) {
      const executorFamily = profileMeta(task.roles.executor.profile)?.family || null;
      const reviewerFamily = profileMeta(task.roles.reviewer.profile)?.family || null;
      const repo = projectPath(task.repository);
      const reviewBranch = `dao/review-${task.issue}-g${task.generation}-${artifact.head.slice(0, 12)}`;
      const tree = await ensureTree(repo, reviewBranch, { derived: true });
      const fetched = await git(['fetch', 'origin', `refs/heads/${branchOf(task)}`], { cwd: tree.path });
      if (!gitOk(fetched)) throw fail('SERVICE_UNAVAILABLE', 'review fetch failed');
      const checkedOut = await git(['checkout', '--detach', artifact.head], { cwd: tree.path });
      if (!gitOk(checkedOut)) throw fail('SERVICE_UNAVAILABLE', 'review checkout failed');
      const { key, status, view } = await runSession(task, tree.path, reviewerPrompt({ task, artifact, checks }), 'reviewer');
      if (status !== 'done' || view?.error) {
        // 分开两件事：**上游容量/断流**是瞬时故障（503、限流、超时），判可重试；
        // 会话正常结束但输出解析不了才是「审查没做完」，那要人看提示词，不该重试。
        const detail = String(view?.error || `reviewer session ${status}`).slice(0, 200);
        if (/503|capacity|rate.?limit|429|service unavailable|timed?\s*out|超时|容量/i.test(detail)) throw fail('SERVICE_UNAVAILABLE', `reviewer leg unavailable: ${detail}`);
        return { completed: false, head: artifact.head, sessionKey: key, identityVerified: false };
      }
      const parsed = parseFindings(view?.text);
      if (!parsed) return { completed: false, head: artifact.head, sessionKey: key, identityVerified: false };
      const reportedModel = view?.snapshot?.model || view?.model || null;
      return {
        completed: true,
        head: artifact.head,
        sessionKey: key,
        identityVerified: Boolean(executorFamily && reviewerFamily),
        executorFamily,
        reviewerFamily,
        reportedModel,
        findings: parsed.findings.map(finding => ({ id: String(finding.id || '').slice(0, 120), severity: finding.severity, detail: String(finding.detail || '').slice(0, 2000) })),
      };
    },
    async integrate(task, artifact) {
      const before = await prView(artifact.pr, 'headRefOid,baseRefName,state,number', { cwd: artifact.checkpoint });
      if (String(before?.state || '').toUpperCase() !== 'OPEN') throw fail('UNSUPPORTED_CAPABILITY', `pr state ${before?.state}`);
      if (String(before?.headRefOid || '') !== artifact.head) throw fail('UNSUPPORTED_CAPABILITY', 'pr head moved since review');
      if (String(before?.baseRefName || '') !== task.contract.targetBranch) throw fail('UNSUPPORTED_CAPABILITY', 'pr target branch mismatch');
      await runGh(['pr', 'ready', String(artifact.pr)], { cwd: artifact.checkpoint, role: 'marshal' });
      const merged = await gh(['pr', 'merge', String(artifact.pr), '--squash', '--match-head-commit', artifact.head], { cwd: artifact.checkpoint, role: 'marshal' });
      if (!merged?.ok) throw fail('SERVICE_UNAVAILABLE', `merge failed: ${String(merged?.error || '').slice(0, 200)}`);
      const view = await prView(artifact.pr, 'state,mergeCommit,headRefOid,baseRefName,number', { cwd: artifact.checkpoint });
      return {
        repository: task.repository,
        issue: task.issue,
        pr: Number(view?.number || artifact.pr),
        sourceHead: String(view?.headRefOid || ''),
        baseRefName: String(view?.baseRefName || ''),
        merged: String(view?.state || '').toUpperCase() === 'MERGED',
        mergeCommit: String(view?.mergeCommit?.oid || ''),
      };
    },
    async deploy(task, delivery) {
      if (typeof deploy !== 'function') return { checked: false, healthy: false, commit: delivery.mergeCommit, why: 'no deployer configured' };
      return deploy({ task, delivery });
    },
    async closeIssue(task, delivery) {
      if (typeof closeIssue !== 'function') throw fail('UNSUPPORTED_CAPABILITY', 'no issue closer configured');
      // 关单失败（含「回读 CLOSED 失败」）要判成**可重试**：网关是幂等的（同一 idempotency-key），
      // 重试不会重复关单。否则一次瞬时读失败就把闭环停在 closing（g4 实咬：issue 已 CLOSED，
      // 只是回读抖了一下，却被判 unscanned 停手）。
      return closeIssue({ task, delivery }).catch(error => {
        throw asTransientFailure(error, 'closeIssue') || fail('SERVICE_UNAVAILABLE', `close issue failed: ${String(error?.message || error).slice(0, 160)}`);
      });
    },
    async cleanup(task, { checkpoint }) {
      if (!checkpoint) return { verified: true, skipped: 'no workspace' };
      const sessions = await reapWorkdirSessions(checkpoint);
      if (sessions.why) return { verified: false, why: sessions.why };
      const stopped = sessions.stopped;
      const removed = await git(['worktree', 'remove', checkpoint], { cwd: projectPath(task.repository) });
      const stillThere = gitOk(await git(['status', '--porcelain'], { cwd: checkpoint }));
      const gone = gitOk(removed) || !stillThere;
      return { verified: stopped.every(item => item.ok) && gone, sessions: stopped, removed: gone };
    },
  };
}
