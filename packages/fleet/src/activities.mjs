import { ApplicationFailure } from '@temporalio/activity';

const SHA = /^[a-f0-9]{40}$/;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const branchOf = task => `dao/issue-${task.issue}-g${task.generation}`;
const fail = (code, message) => ApplicationFailure.nonRetryable(message, code);

/** 审查输出解析：只认**恰好一份**含 findings 数组的 JSON。模型先给结论、再回显空模板时，
 *  取「最后一块」会把有阻塞的审查读成通过——宁可 unscanned，不猜。 */
export function parseSingle(text, predicate) {
  const source = String(text || '');
  const candidates = [];
  const fence = /```(?:json)?\s*([\s\S]*?)```/g;
  for (const match of source.matchAll(fence)) candidates.push(match[1]);
  candidates.push(source);
  const parsed = [];
  for (const candidate of candidates) {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start < 0 || end <= start) continue;
    try {
      const value = JSON.parse(candidate.slice(start, end + 1));
      if (value && predicate(value)) parsed.push(JSON.stringify(value));
    } catch { /* 这一块不是 JSON */ }
  }
  const unique = [...new Set(parsed)];
  if (unique.length !== 1) return null;
  return JSON.parse(unique[0]);
}

export const parseFindings = text => parseSingle(text, value => Array.isArray(value.findings));
export const parsePlan = text => parseSingle(text, value => typeof value.plan === 'string' && value.plan.trim().length > 0);

export function createActivities({ runtime, gh, git, projects, familiesOf, reviewerPrompt, leadPrompt, executorPrompt, closeIssue, deploy, pushEnv = {}, now = () => new Date().toISOString() }) {
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
  const runSession = async (task, workdir, prompt, role) => {
    const profile = task.roles[role];
    const started = await runtime.startSession({ profileId: profile.profile, agent: role === 'reviewer' ? 'codex' : 'grok', model: profile.profile, workdir, prompt, taskId: task.id, title: `${task.id} ${role}` });
    const key = started?.sessionKey || started?.key;
    if (!key) throw fail('SERVICE_UNAVAILABLE', 'session launch returned no key');
    const settled = await runtime.waitForCompletion(key, { timeoutMs: task.limits.stepTimeoutSeconds * 1000 });
    const view = await runtime.readSession(key);
    return { key, status: settled?.status, view };
  };
  const familyFromCatalog = profileId => {
    if (typeof familiesOf !== 'function') return null;
    try { const family = familiesOf(profileId); return typeof family === 'string' && family.trim() ? family.trim().toLowerCase() : null; }
    catch { return null; }
  };
  const prView = async (number, fields, { cwd, role = 'marshal' }) => runGh(['pr', 'view', String(number), '--json', fields], { cwd, role });

  return {
    async prepare(task) {
      const repo = projectPath(task.repository);
      const branch = branchOf(task);
      const tree = await runtime.ensureWorkspace(repo, branch);
      if (!tree?.path) throw fail('SERVICE_UNAVAILABLE', 'workspace not created');
      return { repository: task.repository, head: await headOf(tree.path), checkpoint: tree.path, branch };
    },
    async lead(task, { prepared, artifact, feedback, round }) {
      const { key, status, view } = await runSession(task, prepared.checkpoint, leadPrompt({ task, prepared, artifact, feedback, round }), 'lead');
      if (status !== 'done') throw fail(status === 'unknown' ? 'DEADLINE_EXCEEDED' : 'TRANSPORT_CLOSED', `lead session ${status}`);
      const plan = parsePlan(view?.text);
      if (!plan) throw fail('UNSUPPORTED_CAPABILITY', 'lead output not parseable');
      return { plan: plan.plan, sessionKey: key, at: now() };
    },
    async execute(task, { plan, prepared, feedback, round }) {
      const { key, status } = await runSession(task, prepared.checkpoint, executorPrompt({ task, plan, feedback, round }), 'executor');
      if (status !== 'done') throw fail(status === 'unknown' ? 'DEADLINE_EXCEEDED' : 'TRANSPORT_CLOSED', `executor session ${status}`);
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
      const executorFamily = familyFromCatalog(task.roles.executor.profile);
      const reviewerFamily = familyFromCatalog(task.roles.reviewer.profile);
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
      const sessions = await sessionsIn(checkpoint);
      if (sessions === null) return { verified: false, why: 'session list unscanned' };
      const stopped = [];
      for (const session of sessions) {
        const key = session.sessionKey || session.key;
        if (!key) continue;
        const result = await runtime.stopSession(key).catch(error => ({ ok: false, why: String(error?.message || error) }));
        stopped.push({ key, ok: result?.ok === true });
      }
      const removed = await git(['worktree', 'remove', checkpoint], { cwd: projectPath(task.repository) });
      const stillThere = gitOk(await git(['status', '--porcelain'], { cwd: checkpoint }));
      const gone = gitOk(removed) || !stillThere;
      return { verified: stopped.every(item => item.ok) && gone, sessions: stopped, removed: gone };
    },
  };
}
