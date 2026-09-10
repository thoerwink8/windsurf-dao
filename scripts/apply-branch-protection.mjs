#!/usr/bin/env node
// 幂等装/查一个仓的 master 合并闸（issue #999）。
//
// 不是分发器——一次只动 --repo 指定的那一个。人跑或检查器红了再跑。
// 实测：照搬本仓配置会把 CI 不在 PR 上跑的仓永久锁死（miraquota-win 的
// build.yml 只 on.push，required=["check"] = 所有 PR 合不进去）。
// 装之前先确认：该仓 check workflow 在 pull_request 上跑、且当前是绿的。
//
//   node scripts/apply-branch-protection.mjs --repo OWNER/REPO --check
//   node scripts/apply-branch-protection.mjs --repo OWNER/REPO --dry-run
//   node scripts/apply-branch-protection.mjs --repo OWNER/REPO
//
// 形状与 scripts/lib/branch-protection-check.mjs 的 judge 同一份常量：
// required=["check"]、enforce_admins=false、strict=false。
// PUT 要 admin；用你自己的 gh，不要走 gh-as worker（工人 App 没有 Administration）。

import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  classifyProtectionProbe,
  judgeProtection,
  protectionPutPayload,
  repoSlugFromRemote,
} from './lib/branch-protection-check.mjs';

function argOf(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function usage(msg) {
  if (msg) console.error(msg);
  console.error('用法: node scripts/apply-branch-protection.mjs --repo OWNER/REPO [--check|--dry-run]');
  process.exit(2);
}

function gh(args, { input } = {}) {
  const r = spawnSync('gh', args, {
    windowsHide: true,
    encoding: 'utf8',
    input: input == null ? undefined : input,
  });
  return {
    error: r.error || null,
    status: r.status,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
  };
}

function say(s) {
  process.stdout.write(s + '\n');
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (!isMain) {
  // 被 import 时不跑 CLI。
} else {
  const CHECK = process.argv.includes('--check');
  const DRY = process.argv.includes('--dry-run');
  let repo = argOf('repo');
  if (!repo) usage('缺 --repo OWNER/REPO');
  repo = repoSlugFromRemote(`https://github.com/${repo}`) || repo;
  if (!/^[^/]+\/[^/]+$/.test(repo)) usage(`--repo 不是 OWNER/REPO：${repo}`);

  const payload = protectionPutPayload();
  const get = gh(['api', `repos/${repo}/branches/master/protection`]);
  const probe = classifyProtectionProbe(get);

  if (probe.kind === 'skip') {
    console.error(`SKIP ${repo}：${probe.why}（没查成，不是绿）`);
    process.exit(2);
  }
  if (probe.kind === 'unscanned') {
    console.error(`没查成 ${repo}：${probe.why}`);
    process.exit(2);
  }

  const judged = probe.kind === 'missing'
    ? { kind: 'red', why: '缺保护' }
    : judgeProtection(probe.protection);

  if (judged.kind === 'unscanned') {
    console.error(`没查成 ${repo}：${judged.why}`);
    process.exit(2);
  }

  if (judged.kind === 'ok') {
    say(`${repo} master 闸形状已对（required=[${payload.required_status_checks.contexts.join(',')}] enforce_admins=${payload.enforce_admins} strict=${payload.required_status_checks.strict}）`);
    process.exit(0);
  }

  if (CHECK) {
    console.error(`红 ${repo}：${judged.why}`);
    console.error(`修：node scripts/apply-branch-protection.mjs --repo ${repo}`);
    process.exit(1);
  }

  if (DRY) {
    say(`dry-run ${repo}：将 PUT ${JSON.stringify(payload)}`);
    say(`当前：${judged.why}`);
    process.exit(0);
  }

  const put = gh(
    ['api', '-X', 'PUT', `repos/${repo}/branches/master/protection`, '--input', '-'],
    { input: JSON.stringify(payload) },
  );
  if (put.error && put.error.code === 'ENOENT') {
    console.error('gh 不可用（ENOENT）');
    process.exit(2);
  }
  if (put.status !== 0) {
    console.error(`装闸失败 ${repo} exit=${put.status}：${(put.stderr || put.stdout).trim().slice(0, 400)}`);
    process.exit(1);
  }
  const after = classifyProtectionProbe(put);
  const afterJudge = after.kind === 'ok' ? judgeProtection(after.protection) : { kind: after.kind, why: after.why };
  if (afterJudge.kind !== 'ok') {
    console.error(`PUT 完形状仍不对 ${repo}：${afterJudge.why || after.why}`);
    process.exit(1);
  }
  say(`已装 ${repo} master 闸（幂等，形状对）`);
  process.exit(0);
}
