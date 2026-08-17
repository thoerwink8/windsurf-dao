#!/usr/bin/env node
// 以 GitHub App 身份执行 gh。用法见 scripts/lib/gh.mjs。
//
//   node scripts/gh-as.mjs <reviewer|worker|marshal> -- <gh 参数...>
//   node scripts/gh-as.mjs <role> --whoami
//   node scripts/gh-as.mjs <role> --set-git-identity   给当前工作区写 worktree 级 user.name/email

import { pathToFileURL } from 'node:url';
import {
  ROLES,
  applyGitIdentity,
  formatWhoami,
  ghAs,
  loadRoleCreds,
  unknownRoleError,
  whoami,
} from './lib/gh.mjs';

function usage(msg) {
  if (msg) console.error(msg);
  console.error(`用法: node scripts/gh-as.mjs <${ROLES.join('|')}> -- <gh 参数...>`);
  console.error('      node scripts/gh-as.mjs <role> --whoami');
  console.error('      node scripts/gh-as.mjs <role> --set-git-identity');
  process.exit(2);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (!isMain) {
  // 被 import 时不跑 CLI（测试只走 lib）。
} else {
  const [role, ...rest] = process.argv.slice(2);
  if (!role || !ROLES.includes(role)) usage(unknownRoleError(role));

  if (rest[0] === '--whoami') {
    const info = whoami(role);
    if (!info.ok) {
      console.error(info.error);
      process.exit(info.code === 'not_installed' || info.code === 'bad_role' ? 2 : 1);
    }
    console.log(formatWhoami(info));
    process.exit(0);
  }

  if (rest[0] === '--set-git-identity') {
    const ident = applyGitIdentity(role, { cwd: process.cwd() });
    if (!ident.ok) {
      console.error(ident.error);
      process.exit(1);
    }
    console.log(`${role}  git ${ident.name} <${ident.email}>`);
    process.exit(0);
  }

  const args = rest[0] === '--' ? rest.slice(1) : rest;
  if (!args.length) usage('缺 gh 参数（形如：node scripts/gh-as.mjs marshal -- pr comment 571 --body "…"）');

  // 先证凭据在，缺了直接 fail-loud，别等到 spawn 才报含糊的 401。
  const creds = loadRoleCreds(role);
  if (!creds.ok) {
    console.error(creds.error);
    process.exit(creds.code === 'not_installed' || creds.code === 'bad_role' ? 2 : 1);
  }

  const r = ghAs(role, args, { inherit: true });
  if (!r.ok && r.error && !r.status) {
    console.error(r.error);
    process.exit(1);
  }
  process.exit(r.status ?? (r.ok ? 0 : 1));
}
