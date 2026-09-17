const SHA = /^[a-f0-9]{40}$/;
const branchOf = task => `dao/issue-${task.issue}-g${task.generation}`;
const jsonBlock = text => {
  const fence = /```(?:json)?\s*([\s\S]*?)```/g;
  let last = null;
  for (const match of String(text || '').matchAll(fence)) last = match[1];
  const candidate = last ?? String(text || '');
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(candidate.slice(start, end + 1)); } catch { return null; }
};

export function createActivities({ runtime, gh, git, projects, reviewerPrompt, leadPrompt, executorPrompt, closeIssue, deploy, now = () => new Date().toISOString() }) {
  const projectPath = repository => {
    const path = projects[repository];
    if (!path) throw Object.assign(new Error(`no local checkout mapped for ${repository}`), { code: 'UNSUPPORTED_CAPABILITY' });
    return path;
  };
  const runGh = async (args, { cwd } = {}) => {
    const result = await gh(args, { cwd });
    if (!result?.ok) throw Object.assign(new Error(String(result?.error || 'gh failed').slice(0, 300)), { code: 'SERVICE_UNAVAILABLE' });
    try { return JSON.parse(result.out || '{}'); }
    catch { throw Object.assign(new Error('gh returned non-JSON'), { code: 'SERVICE_UNAVAILABLE' }); }
  };
  const headOf = async (workdir, ref = 'HEAD') => {
    const result = await git(['rev-parse', ref], { cwd: workdir });
    const head = String(result?.out || '').trim();
    if (!result || result.status !== 0 || !SHA.test(head)) throw Object.assign(new Error('cannot resolve head'), { code: 'SERVICE_UNAVAILABLE' });
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
    if (!key) throw Object.assign(new Error('session launch returned no key'), { code: 'SERVICE_UNAVAILABLE' });
    const settled = await runtime.waitForCompletion(key, { timeoutMs: task.limits.stepTimeoutSeconds * 1000 });
    const view = await runtime.readSession(key);
    return { key, status: settled?.status, view };
  };
  const cleanupSessions = async workdir => {
    const sessions = await sessionsIn(workdir);
    if (sessions === null) return { verified: false, why: 'session list unscanned' };
    const stopped = [];
    for (const session of sessions) {
      const key = session.sessionKey || session.key;
      if (!key) continue;
      const result = await runtime.stopSession(key).catch(error => ({ ok: false, why: String(error?.message || error) }));
      stopped.push({ key, ok: result?.ok === true });
    }
    return { verified: stopped.every(item => item.ok), stopped };
  };

  return {
    async prepare(task) {
      const repo = projectPath(task.repository);
      const branch = branchOf(task);
      const tree = await runtime.ensureWorkspace(repo, branch);
      if (!tree?.path) throw Object.assign(new Error('workspace not created'), { code: 'SERVICE_UNAVAILABLE' });
      return { repository: task.repository, head: await headOf(tree.path), checkpoint: tree.path, branch };
    },
    async lead(task, { prepared, artifact, feedback, round }) {
      const prompt = leadPrompt({ task, prepared, artifact, feedback, round });
      const { key, status, view } = await runSession(task, prepared.checkpoint, prompt, 'lead');
      if (status !== 'done') throw Object.assign(new Error(`lead session ${status}`), { code: status === 'unknown' ? 'DEADLINE_EXCEEDED' : 'TRANSPORT_CLOSED' });
      const parsed = jsonBlock(view?.text);
      if (!parsed || typeof parsed.plan !== 'string') throw Object.assign(new Error('lead output not parseable'), { code: 'UNSUPPORTED_CAPABILITY' });
      return { plan: parsed.plan, sessionKey: key, at: now() };
    },
    async execute(task, { plan, prepared, feedback, round }) {
      const prompt = executorPrompt({ task, plan, feedback, round });
      const { key, status } = await runSession(task, prepared.checkpoint, prompt, 'executor');
      if (status !== 'done') throw Object.assign(new Error(`executor session ${status}`), { code: status === 'unknown' ? 'DEADLINE_EXCEEDED' : 'TRANSPORT_CLOSED' });
      const head = await headOf(prepared.checkpoint);
      const pushed = await git(['push', '-u', 'origin', `HEAD:refs/heads/${prepared.branch}`], { cwd: prepared.checkpoint });
      if (pushed.status !== 0) throw Object.assign(new Error(`push failed: ${String(pushed.err || '').slice(0, 200)}`), { code: 'SERVICE_UNAVAILABLE' });
      const pr = await runGh(['pr', 'list', '--head', prepared.branch, '--state', 'open', '--json', 'number', '--limit', '1'], { cwd: prepared.checkpoint });
      let number = Array.isArray(pr) && pr[0]?.number;
      if (!number) {
        const created = await gh(['pr', 'create', '--draft', '--base', 'master', '--head', prepared.branch, '--title', `[fleet] ${task.id}`, '--body', `Fleet task ${task.id}. Contract checks: ${task.contract.requiredChecks.join(', ')}.`], { cwd: prepared.checkpoint });
        if (!created?.ok) throw Object.assign(new Error(`pr create failed: ${String(created?.error || '').slice(0, 200)}`), { code: 'SERVICE_UNAVAILABLE' });
        number = Number(String(created.out).trim().split('/').pop());
      }
      if (!Number.isSafeInteger(number) || number <= 0) throw Object.assign(new Error('pr number unresolved'), { code: 'SERVICE_UNAVAILABLE' });
      return { repository: task.repository, head, pr: number, checkpoint: prepared.checkpoint, sessionKey: key };
    },
    async verify(task, artifact) {
      const view = await runGh(['pr', 'view', String(artifact.pr), '--json', 'headRefOid,statusCheckRollup'], { cwd: artifact.checkpoint });
      const head = String(view?.headRefOid || '');
      const rollup = Array.isArray(view?.statusCheckRollup) ? view.statusCheckRollup : null;
      if (!rollup) return { scanned: false, head, checks: [] };
      return {
        scanned: true,
        head,
        checks: rollup.map(check => ({ name: check.name || check.context, status: check.status, conclusion: check.conclusion ?? null })),
      };
    },
    async review(task, artifact, { checks }) {
      const repo = projectPath(task.repository);
      const reviewBranch = `dao/review-${task.issue}-g${task.generation}-${artifact.head.slice(0, 12)}`;
      const tree = await runtime.ensureWorkspace(repo, reviewBranch);
      const checkout = await git(['fetch', 'origin', `refs/heads/${branchOf(task)}`], { cwd: tree.path });
      if (checkout.status !== 0) throw Object.assign(new Error('review fetch failed'), { code: 'SERVICE_UNAVAILABLE' });
      const reset = await git(['checkout', '--detach', artifact.head], { cwd: tree.path });
      if (reset.status !== 0) throw Object.assign(new Error('review checkout failed'), { code: 'SERVICE_UNAVAILABLE' });
      const { key, status, view } = await runSession(task, tree.path, reviewerPrompt({ task, artifact, checks }), 'reviewer');
      if (status !== 'done') return { completed: false, head: artifact.head, sessionKey: key };
      const parsed = jsonBlock(view?.text);
      if (!parsed || !Array.isArray(parsed.findings)) return { completed: false, head: artifact.head, sessionKey: key };
      const actual = view?.snapshot?.model || view?.model || null;
      return {
        completed: true,
        head: artifact.head,
        sessionKey: key,
        profile: task.roles.reviewer.profile,
        family: task.roles.reviewer.family,
        reportedModel: actual,
        findings: parsed.findings.map(finding => ({ id: String(finding.id || '').slice(0, 120), severity: finding.severity, detail: String(finding.detail || '').slice(0, 2000) })),
      };
    },
    async integrate(task, artifact) {
      await runGh(['pr', 'ready', String(artifact.pr)], { cwd: artifact.checkpoint });
      const merged = await gh(['pr', 'merge', String(artifact.pr), '--squash', '--match-head-commit', artifact.head], { cwd: artifact.checkpoint });
      if (!merged?.ok) throw Object.assign(new Error(`merge failed: ${String(merged?.error || '').slice(0, 200)}`), { code: 'SERVICE_UNAVAILABLE' });
      const view = await runGh(['pr', 'view', String(artifact.pr), '--json', 'state,mergeCommit,headRefOid,number'], { cwd: artifact.checkpoint });
      return {
        repository: task.repository,
        issue: task.issue,
        pr: Number(view?.number || artifact.pr),
        sourceHead: String(view?.headRefOid || ''),
        merged: String(view?.state || '').toUpperCase() === 'MERGED',
        mergeCommit: String(view?.mergeCommit?.oid || ''),
      };
    },
    async deploy(task, delivery) {
      if (typeof deploy !== 'function') return { checked: false, healthy: false, commit: delivery.mergeCommit, why: 'no deployer configured' };
      return deploy({ task, delivery });
    },
    async closeIssue(task, delivery) {
      if (typeof closeIssue !== 'function') throw Object.assign(new Error('no issue closer configured'), { code: 'UNSUPPORTED_CAPABILITY' });
      return closeIssue({ task, delivery });
    },
    async cleanup(task, { checkpoint }) {
      if (!checkpoint) return { verified: true, skipped: 'no workspace' };
      const sessions = await cleanupSessions(checkpoint);
      const removed = await git(['worktree', 'remove', checkpoint], { cwd: projectPath(task.repository) });
      const clean = await git(['status', '--porcelain'], { cwd: checkpoint }).catch(() => ({ status: 1 }));
      const gone = removed.status === 0 || clean.status !== 0;
      return { verified: sessions.verified && gone, sessions, removed: gone };
    },
  };
}
