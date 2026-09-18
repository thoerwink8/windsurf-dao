import { ApplicationFailure } from '@temporalio/activity';

const SHA = /^[a-f0-9]{40}$/;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const branchOf = task => `dao/issue-${task.issue}-g${task.generation}`;
const fail = (code, message) => ApplicationFailure.nonRetryable(message, code);

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

export function createActivities({ runtime, gh, git, gitIdentity, installDeps, projects, profileOf, reviewerPrompt, leadPrompt, executorPrompt, closeIssue, deploy, pushEnv = {}, unknownWaitMs = 120000, unknownWaitRounds = 3, now = () => new Date().toISOString() }) {
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
  const runSession = async (task, workdir, prompt, role) => {
    const profile = task.roles[role];
    let started;
    // 起会话前先收本树：上一次失败的启动/未终态的会话会让租约闸判「已有活跃或未知会话」而拒绝，
    // 于是可重试的瞬时故障变成死循环（真跑实咬两轮）。同一任务同一棵树里同时只有一个会话，先收是安全的。
    await reapWorkdirSessions(workdir).catch(() => {});
    try {
      started = await runtime.startSession({ profileId: profile.profile, agent: profileMeta(profile.profile)?.agent, model: profile.profile, workdir, prompt, taskId: task.id, title: `${task.id} ${role}` });
    } catch (error) {
      // 启动失败会在树里留下「未定」会话记录，重试会被租约闸判「已有活跃或未知会话」而拒绝——
      // 于是瞬时故障变成死循环（真跑实咬：回环 ws 抖动 → 重试 → 撞租约闸）。
      // 先收掉本树自己的会话再抛；收不干净也要抛，让上层按可重试处理。
      await reapWorkdirSessions(workdir).catch(() => {});
      throw error;
    }
    const key = started?.sessionKey || started?.key;
    if (!key) throw fail('SERVICE_UNAVAILABLE', 'session launch returned no key');
    let settled = await runtime.waitForCompletion(key, { timeoutMs: task.limits.stepTimeoutSeconds * 1000 });
    let view = await runtime.readSession(key);
    if (settled?.status === 'waiting_user' || view?.phase === 'waiting_user') {
      // 会话在等人回答（权限/问题）：重试只会再问一次，也不是传输故障——单独一态，交上层停手。
      throw fail('WAITING_USER', `${role} session is waiting for an answer`);
    }
    // unknown 是「这次没读到终态」，不是「会话失败」——多等几轮再判，
    // 不许把还在干活的会话当失败处理（g6 实咬：判 unknown 后立刻收尾 = 取消在跑的会话）。
    for (let attempt = 0; attempt < unknownWaitRounds && settled?.status === 'unknown'; attempt += 1) {
      await sleep(unknownWaitMs);
      settled = await runtime.waitForCompletion(key, { timeoutMs: unknownWaitMs });
      view = await runtime.readSession(key);
    }
    // 只有终态才收尾：租约闸是「一棵树同时只许一个会话」，会话不释放下一轮起不来；
    // 但非终态时收尾＝取消仍在跑的会话，宁可把未定抛给上层重试，也不杀活人。
    if (settled?.status === 'done' || settled?.status === 'failed') {
      const released = await runtime.stopSession(key).catch(error => ({ ok: false, why: String(error?.message || error) }));
      if (released?.ok !== true) throw fail('SERVICE_UNAVAILABLE', `session release unverified: ${String(released?.why || '').slice(0, 120)}`);
    }
    return { key, status: settled?.status, view };
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
      const tree = await runtime.ensureWorkspace(repo, branch);
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
      try {
        ({ key, status } = await runSession(task, prepared.checkpoint, executorPrompt({ task, plan, feedback, round, issue: await issueBrief(task) }), "executor"));
      } catch (error) {
        if (error?.type !== 'WAITING_USER') throw error;
        // 边界画在「交卷」上：工人在等人回答权限，但它可能**已经交卷**（提交就是交卷）。
        // 有提交就按完成接手；没有提交才真的是卡住——不追着它发明的每条命令去放宽白名单。
        const committed = await headOf(prepared.checkpoint);
        if (committed === (feedback?.head || prepared.head)) throw error;
        await reapWorkdirSessions(prepared.checkpoint).catch(() => {});
        status = 'waiting_user-with-commit';
      }
      if (status !== 'done' && status !== 'waiting_user-with-commit') throw fail(status === 'unknown' ? 'DEADLINE_EXCEEDED' : 'TRANSPORT_CLOSED', `executor session ${status}`);
      const head = await headOf(prepared.checkpoint);
      const expectedNew = feedback?.head || prepared.head;
      if (head === expectedNew) throw fail('UNSUPPORTED_CAPABILITY', 'executor produced no new commit');
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
      return { repository: task.repository, head, pr: number, checkpoint: prepared.checkpoint, sessionKey: key };
    },
    async verify(task, artifact, { waitMs } = {}) {
      const budget = Number.isFinite(waitMs) ? Math.max(0, waitMs) : Math.min(task.limits.stepTimeoutSeconds * 600, 20 * 60 * 1000);
      const deadline = Date.now() + budget;
      for (;;) {
        const view = await prView(artifact.pr, 'headRefOid,baseRefName,statusCheckRollup', { cwd: artifact.checkpoint });
        const head = String(view?.headRefOid || '');
        const rollup = Array.isArray(view?.statusCheckRollup) ? view.statusCheckRollup : null;
        if (!rollup) return { scanned: false, head, checks: [] };
        const checks = rollup.map(check => ({ name: check.name || check.context, status: check.status, conclusion: check.conclusion ?? null }));
        const settled = head === artifact.head && checks.length > 0 && checks.every(check => check.status === 'COMPLETED');
        if (settled || Date.now() >= deadline) return { scanned: true, head, checks };
        await sleep(15000);
      }
    },
    async review(task, artifact, { checks }) {
      const executorFamily = profileMeta(task.roles.executor.profile)?.family || null;
      const reviewerFamily = profileMeta(task.roles.reviewer.profile)?.family || null;
      const repo = projectPath(task.repository);
      const reviewBranch = `dao/review-${task.issue}-g${task.generation}-${artifact.head.slice(0, 12)}`;
      const tree = await runtime.ensureWorkspace(repo, reviewBranch);
      const fetched = await git(['fetch', 'origin', `refs/heads/${branchOf(task)}`], { cwd: tree.path });
      if (!gitOk(fetched)) throw fail('SERVICE_UNAVAILABLE', 'review fetch failed');
      const checkedOut = await git(['checkout', '--detach', artifact.head], { cwd: tree.path });
      if (!gitOk(checkedOut)) throw fail('SERVICE_UNAVAILABLE', 'review checkout failed');
      const { key, status, view } = await runSession(task, tree.path, reviewerPrompt({ task, artifact, checks }), 'reviewer');
      if (status !== 'done') return { completed: false, head: artifact.head, sessionKey: key, identityVerified: false };
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
      await runGh(['pr', 'ready', String(artifact.pr)], { cwd: artifact.checkpoint });
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
      return closeIssue({ task, delivery });
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
