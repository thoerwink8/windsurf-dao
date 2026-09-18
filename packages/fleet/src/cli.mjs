#!/usr/bin/env node
// fleet —— 持久任务会话的命令入口。
//
//   node src/cli.mjs worker  [--queue dao-fleet] [--address 127.0.0.1:7233]
//   node src/cli.mjs start   --repo owner/name --issue N [--generation G] [--wait]
//                            --lead-profile P --executor-profile E --reviewer-profile R
//                            [--checks a,b] [--rounds 3] [--deploy]
//                            档可以不给：--selection auto（默认，按腿表选）| ask（只打印候选）
//   node src/cli.mjs status  --repo owner/name --issue N [--generation G]
//   node src/cli.mjs signal  --repo owner/name --issue N [--generation G] --name resume|cancel
//
// 任务身份、契约与验收判据在 src/contract.mjs；执行顺序在 src/runner.mjs；
// 持久化与恢复在 src/workflows.mjs；与真实系统（统一执行目录 / gh-as / git）的接缝在 src/activities.mjs。
// 本文件只做参数解析与装配，不写判定。

import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client, Connection } from '@temporalio/client';
import { NativeConnection, Worker } from '@temporalio/worker';
import { normalizeTask, taskIdOf } from './contract.mjs';
import { createActivities } from './activities.mjs';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..');
const QUEUE = process.env.DAO_FLEET_QUEUE || 'dao-fleet';
const ADDRESS = process.env.DAO_FLEET_TEMPORAL || '127.0.0.1:7233';
const NAMESPACE = process.env.DAO_FLEET_NAMESPACE || 'default';
const PROJECTS = JSON.parse(process.env.DAO_FLEET_PROJECTS || '{}');

function argsOf(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[key] = true;
      else { out[key] = next; i += 1; }
    } else out._.push(token);
  }
  return out;
}

function run(cmd, argv, { cwd, env, input } = {}) {
  return new Promise((resolveRun) => {
    let child;
    try { child = spawn(cmd, argv, { cwd, env: env ? { ...process.env, ...env } : process.env, windowsHide: true }); }
    catch (error) { resolveRun({ ok: false, error: String(error.message || error) }); return; }
    let out = '';
    let err = '';
    child.stdout.on('data', chunk => { out += chunk; });
    child.stderr.on('data', chunk => { err += chunk; });
    child.on('error', error => resolveRun({ ok: false, error: String(error.message || error) }));
    child.on('close', code => resolveRun(code === 0 ? { ok: true, out } : { ok: false, status: code, error: (err || out).trim().slice(0, 400), out }));
    if (input != null) child.stdin.end(input);
  });
}

async function ghAs(argv, { cwd, role } = {}) {
  if (!role) return { ok: false, error: 'gh call without role' };
  return run(process.execPath, [join(REPO_ROOT, 'scripts', 'gh-as.mjs'), role, '--', ...argv], { cwd });
}

/** 判定层读 git 的退出码（status===0）；run() 只给 ok。适配在这一层做，不改判定语义。 */
async function gitRun(argv, { cwd, env } = {}) {
  const result = await run('git', argv, { cwd, env });
  return result.ok ? { status: 0, out: result.out || '', err: '' } : { status: result.status ?? 1, out: result.out || '', err: result.error || '' };
}

function profileFamily(profileId) {
  const profile = profileEntry(profileId);
  const family = profile.modelFamily || profile.provider;
  if (!family) throw new Error(`profile ${profileId} has no model family`);
  return String(family).toLowerCase();
}

function profileEntry(profileId) {
  const doc = JSON.parse(readFileSync(join(REPO_ROOT, 'docs', 'execution-profiles.json'), 'utf8'));
  const profile = (doc.profiles || []).find(item => item.id === profileId);
  if (!profile) throw new Error(`unknown execution profile: ${profileId}`);
  return profile;
}

function specFromArgs(args, roles) {
  const repo = String(args.repo || '');
  const issue = Number(args.issue);
  if (!repo || !Number.isSafeInteger(issue) || issue <= 0) throw new Error('需要 --repo owner/name 与 --issue N');
  return normalizeTask({
    repository: repo,
    issue,
    generation: Number(args.generation || 1),
    contract: { requiredChecks: String(args.checks || 'check').split(',').map(x => x.trim()).filter(Boolean), deploymentRequired: args.deploy === true, targetBranch: String(args.base || 'master') },
    limits: { reviewRounds: Number(args.rounds || 3), stepTimeoutSeconds: Number(args.timeout || 1800) },
    roles: {
      lead: { profile: roles.lead, family: profileFamily(roles.lead), accountPool: 'default' },
      executor: { profile: roles.executor, family: profileFamily(roles.executor), accountPool: 'default' },
      reviewer: { profile: roles.reviewer, family: profileFamily(roles.reviewer), accountPool: 'default' },
    },
  });
}

/** 选腿（#816 用户拍板）：显式档优先；没给档时按 --selection 走腿表。
 *  auto = 用 leg-choice 直接选（跨厂约束在候选阶段淘汰）；
 *  ask  = 只打印候选列表就退出，让人挑完带 --*-profile 重来（无人值守链路里由指挥官转飞书卡片）。 */
async function resolveRoles(args) {
  const explicit = {
    lead: String(args['lead-profile'] || ''),
    executor: String(args['executor-profile'] || ''),
    reviewer: String(args['reviewer-profile'] || ''),
  };
  if (explicit.lead && explicit.executor && explicit.reviewer) return explicit;
  const selection = String(args.selection || 'auto');
  if (selection !== 'auto' && selection !== 'ask') throw new Error('--selection 只能是 auto 或 ask');
  const { chooseLeg, renderLegTable, loadLegChoiceData } = await import('../../../scripts/lib/leg-choice.mjs');
  const data = loadLegChoiceData({});
  const pick = (role, excludeFamilies = []) => {
    const result = chooseLeg({ profiles: data.profiles, role, excludeFamilies, health: data.health, breaker: data.breaker, headroom: data.headroom, history: data.history, now: Date.now() });
    result.notes = [...data.notes, ...result.notes];
    if (!result.recommended) throw new Error(`${role} 没有可用候选：\n${renderLegTable(result)}`);
    return result;
  };
  const lead = explicit.lead || pick('lead').recommended;
  const executor = explicit.executor || pick('executor').recommended;
  const executorFamily = profileFamily(executor);
  const reviewer = explicit.reviewer || pick('reviewer', executorFamily ? [executorFamily] : []).recommended;
  if (selection === 'ask' && !(explicit.lead && explicit.executor && explicit.reviewer)) {
    const tables = ['lead', 'executor', 'reviewer'].map(role => renderLegTable(chooseLeg({ profiles: data.profiles, role, excludeFamilies: role === 'reviewer' && executorFamily ? [executorFamily] : [], health: data.health, breaker: data.breaker, headroom: data.headroom, history: data.history, now: Date.now() })));
    process.stdout.write(`${tables.join('\n\n')}\n\n候选如上（ask 模式不自动开工）。选定后带 --lead-profile/--executor-profile/--reviewer-profile 重新 start。\n`);
    process.exitCode = 3;
    return null;
  }
  process.stdout.write(`[fleet] 选腿：lead=${lead} executor=${executor} reviewer=${reviewer}\n`);
  return { lead, executor, reviewer };
}

const reviewerPrompt = ({ task, artifact, checks }) => `你是本任务的独立审查者，只审 ${task.repository} 的 PR #${artifact.pr}，绑定 HEAD ${artifact.head}。工作目录已检出该 HEAD，不要改代码、不要提交、不要推送。
必查项：契约要求的检查在 ${artifact.head} 上全绿（当前证据：${JSON.stringify(checks)}，由系统取回，不必自己再查）。不要跑 gh 或联网——需要的外部事实系统已经给你了。
请给出你的发现，只输出一个 JSON 对象，不要输出其它文字：
{"findings":[{"id":"<短横线小写短名>","severity":"P1|P2|P3","detail":"<文件:行号 + 现象 + 期望改法>"}]}
没有任何问题时输出 {"findings":[]}。P1 只用于会导致错误结果、数据丢失、安全或协议破坏的问题；风格与建议用 P3。`;

const leadPrompt = ({ task, prepared, artifact, feedback, round, issue }) => `你是本任务的主脑（lead）。任务：${task.repository} 的 issue #${task.issue}（第 ${round + 1} 轮）。工作目录 ${prepared.checkpoint}（该 issue 的专用分支）。
${issue}
${feedback ? `上一轮审查阻塞项：${JSON.stringify(feedback.blocking)}\n本轮必须只针对这些阻塞项收敛。` : '这是第一轮：先读清 issue 与相关代码，给出最小、可验证的实施计划。'}
${artifact ? `当前已有实现提交 ${artifact.head}。` : ''}
只输出一个 JSON 对象：{"plan":"<分步计划：改哪些文件、跑哪些命令、成功判据是什么>"}。`;

const executorPrompt = ({ task, plan, feedback, round, issue }) => `你是本任务的执行者。任务：${task.repository} 的 issue #${task.issue}（第 ${round + 1} 轮）。工作目录就是任务分支，直接在这里改代码。
${issue}
计划：${plan.plan}
${feedback ? `上一轮审查阻塞项（必须逐条解决）：${JSON.stringify(feedback.blocking)}` : ''}
要求：改动尽量小（能改 1 个文件就别动 3 个）；提交作者身份系统已经设好，不用管；完成后必须 git add + git commit。**提交完就停手**：不要再跑任何命令、不要推送、不要开 PR——推送、开 PR、跑检查、合并、关单全由系统接手。若确实要先验证，只用 npm test（依赖系统已按 lock 装好），不要 npm ci / npm install，不要跑全量自检。**不要推送、不要开 PR、不要合并**——推送与开 PR 由系统做。最后用一句话说明你改了什么、跑了什么。`;

async function makeActivities() {
  const { createExecutionRuntime } = await import('../../../scripts/lib/execution-runtime.mjs');
  const { resolveToken } = await import('../../../scripts/lib/gh.mjs');
  const runtime = createExecutionRuntime();
  const closeIssue = async ({ task, delivery }) => {
    const comment = `fleet：任务 ${task.id} 完成——PR #${delivery.pr} 已合并（${delivery.mergeCommit}），检查全绿、独立审查通过。`;
    const closed = await run(process.execPath, [join(REPO_ROOT, 'scripts', 'issue-gateway.mjs'), 'close', '--repo', task.repository, '--issue', String(task.issue), '--reason', 'completed', '--comment', comment, '--host', 'fleet', '--idempotency-key', `${task.id}-close`]);
    if (!closed.ok) throw Object.assign(new Error(`issue close failed: ${String(closed.error || '').slice(0, 200)}`), { code: 'SERVICE_UNAVAILABLE' });
    const view = await ghAs('marshal', ['issue', 'view', String(task.issue), '--json', 'state']);
    if (!view.ok) throw Object.assign(new Error('issue close unverified'), { code: 'SERVICE_UNAVAILABLE' });
    const state = JSON.parse(view.out || '{}').state;
    return { repository: task.repository, issue: task.issue, closed: String(state).toUpperCase() === 'CLOSED' };
  };
  return createActivities({
    runtime,
    projects: PROJECTS,
    gh: ghAs,
    git: gitRun,
    installDeps: async workdir => { const target = join(workdir, 'packages', 'fleet'); const r = await run('npm', ['ci', '--no-audit', '--no-fund', '--prefix', target], { cwd: workdir }); if (!r.ok) throw new Error(String(r.error || 'npm ci failed').slice(0, 160)); },
    gitIdentity: async workdir => { const r = await run(process.execPath, [join(REPO_ROOT, 'scripts', 'gh-as.mjs'), 'worker', '--set-git-identity'], { cwd: workdir }); if (!r.ok) throw new Error(String(r.error||'set-git-identity failed').slice(0,120)); },
    profileOf: profileId => {
      const profile = profileEntry(profileId);
      return { agent: profile.agent, family: profile.modelFamily || profile.provider };
    },
    pushEnv: () => {
      const token = resolveToken('worker');
      if (!token.ok) throw new Error(`worker token unavailable: ${token.error}`);
      return { GH_TOKEN: token.token, GITHUB_TOKEN: token.token };
    },
    reviewerPrompt,
    leadPrompt,
    executorPrompt,
    closeIssue,
  });
}

async function main() {
  const args = argsOf(process.argv.slice(2));
  const command = args._[0];
  if (!['worker', 'start', 'status', 'signal'].includes(command)) {
    process.stderr.write('用法：worker | start | status | signal（见文件头）\n');
    return 2;
  }
  const connection = await Connection.connect({ address: ADDRESS, connectTimeout: '15s' });
  const client = new Client({ connection, namespace: NAMESPACE });
  try {
    if (command === 'worker') {
      // Worker 要的是 worker 包自己的 NativeConnection，不是 client 的 Connection：
      // 传错类型会在原生桥 downcast 失败（真跑实咬，单测的 mock 看不出来）。
      const native = await NativeConnection.connect({ address: ADDRESS });
      try {
        const activities = await makeActivities();
        const worker = await Worker.create({
          connection: native,
          namespace: NAMESPACE,
          taskQueue: String(args.queue || QUEUE),
          workflowsPath: join(import.meta.dirname, 'workflows.mjs'),
          activities,
        });
        process.stdout.write(`[fleet] worker 已启动：queue=${args.queue || QUEUE} address=${ADDRESS} projects=${Object.keys(PROJECTS).join(',') || '（无）'}\n`);
        await worker.run();
      } finally {
        await native.close();
      }
      return 0;
    }
    if (command === 'start') {
      const roles = await resolveRoles(args);
      if (!roles) return 3;
      const task = specFromArgs(args, roles);
      const handle = await client.workflow.start('fusionTaskWorkflow', {
        taskQueue: String(args.queue || QUEUE),
        workflowId: task.id,
        args: [task],
      });
      process.stdout.write(`${JSON.stringify({ started: true, workflowId: task.id, runId: handle.firstExecutionRunId })}\n`);
      if (args.wait === true) {
        const result = await handle.result();
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        return result.state === 'completed' ? 0 : 1;
      }
      return 0;
    }
    if (command === 'status' || command === 'signal') {
      const id = taskIdOf({ repository: String(args.repo || ''), issue: Number(args.issue), generation: Number(args.generation || 1) });
      const handle = client.workflow.getHandle(id);
      if (command === 'status') {
        const status = await handle.query('status');
        process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
        return 0;
      }
      const name = String(args.name || '');
      if (!['resume', 'cancel'].includes(name)) throw new Error('--name 只能是 resume 或 cancel');
      await handle.signal(name);
      process.stdout.write(`${JSON.stringify({ signaled: name, workflowId: id })}\n`);
      return 0;
    }
    process.stderr.write(`未知命令：${String(command)}\n`);
    return 2;
  } finally {
    await connection.close();
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().then(code => process.exit(code)).catch(error => {
    process.stderr.write(`[fleet] ${String(error?.message || error)}\n`);
    process.exit(1);
  });
}

export { main };
