#!/usr/bin/env node
// 幂等登记 land 的 orca automation（#829）。换机 / 重跑都走这一条，不产生第二条同名。
//
//   node scripts/install-land-automation.mjs
//   node scripts/install-land-automation.mjs --dry-run
//
// 装到哪：主树（git-common-dir 上一级）。workspace-mode=existing，禁止 new-per-run。
// 触发 hourly，precheck 是 `node scripts/land.mjs --has-work <主树>`，prompt 只下令跑同一条 land。
// 文档节：NEW-MACHINE.md「land automation（#829）」。

import { existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  LAND_AUTOMATION_NAME,
  LAND_AUTOMATION_PROVIDER,
  LAND_AUTOMATION_TRIGGER,
  landPrecheckCommand,
  landPrompt,
  planLandAutomationInstall,
} from './lib/land-automation.mjs';

const DRY = process.argv.includes('--dry-run');
const HERE = fileURLToPath(import.meta.url);
const SCRIPT_ROOT = resolve(dirname(HERE), '..');
const say = (s) => process.stdout.write(s + '\n');

function git(args, cwd) {
  const r = spawnSync('git', args, { windowsHide: true, cwd, encoding: 'utf8' });
  return { status: r.status ?? 1, out: String(r.stdout || '').trim(), err: String(r.stderr || '').trim() };
}

function orcaJson(args) {
  const r = spawnSync('orca', args, { windowsHide: true, encoding: 'utf8', timeout: 30000 });
  if (r.error) return { ok: false, error: `spawn 失败：${r.error.code || r.error.message}` };
  const text = String(r.stdout || '').trim();
  const start = text.indexOf('{');
  if (start < 0) {
    return { ok: false, error: `orca 没吐 JSON（exit=${r.status}）：${(r.stderr || text).slice(0, 200)}` };
  }
  try {
    return JSON.parse(text.slice(start));
  } catch (e) {
    return { ok: false, error: `JSON 解析失败：${e.message}` };
  }
}

function mainRoot() {
  const r = git(['rev-parse', '--path-format=absolute', '--git-common-dir'], SCRIPT_ROOT);
  if (r.status !== 0 || !r.out) {
    say(`[land-auto] 读 git-common-dir 失败：${r.err || r.out}`);
    process.exit(1);
  }
  const gitDir = r.out.replace(/[/\\]+$/, '');
  if (!/\.git$/i.test(gitDir)) {
    say(`[land-auto] git-common-dir 不是 .git：${gitDir}`);
    process.exit(1);
  }
  return resolve(gitDir, '..');
}

const repoPath = mainRoot();
const landJs = join(repoPath, 'scripts', 'land.mjs');
if (!existsSync(landJs)) {
  say(`[land-auto] 主树没有 land.mjs：${landJs}`);
  process.exit(1);
}

const precheck = landPrecheckCommand(landJs, repoPath);
const prompt = landPrompt(landJs, repoPath);
const workspace = `path:${repoPath}`;

const common = [
  '--name', LAND_AUTOMATION_NAME,
  '--trigger', LAND_AUTOMATION_TRIGGER,
  '--provider', LAND_AUTOMATION_PROVIDER,
  '--prompt', prompt,
  '--precheck', precheck,
  '--workspace', workspace,
  '--workspace-mode', 'existing',
  '--enabled',
  '--json',
];

say(`[land-auto] 主树 ${repoPath}`);
say(`[land-auto] precheck ${precheck}`);
say(`[land-auto] prompt ${prompt}`);
say(`[land-auto] workspace ${workspace}（existing，不新建树）`);

const listed = orcaJson(['automations', 'list', '--json']);
if (listed.ok !== true) {
  say(`[land-auto] automations list 没查成：${listed.error || JSON.stringify(listed).slice(0, 200)}`);
  process.exit(1);
}
const automations = listed.result?.automations;
if (!Array.isArray(automations)) {
  say(`[land-auto] list 契约变了：result.automations 不是数组`);
  process.exit(1);
}

const plan = planLandAutomationInstall(automations);
if (plan.action === 'error') {
  say(`[land-auto] ${plan.reason}`);
  process.exit(1);
}

if (plan.action === 'create') {
  say(`[land-auto] ${DRY ? '[拟] ' : ''}create 同名 0 条`);
  if (!DRY) {
    const created = orcaJson(['automations', 'create', ...common]);
    if (created.ok !== true) {
      say(`[land-auto] create 失败：${created.error?.message || created.error || JSON.stringify(created).slice(0, 240)}`);
      process.exit(1);
    }
    say(`[land-auto] 已登记 id=${created.result?.automation?.id || '?'}`);
  }
} else {
  say(`[land-auto] ${DRY ? '[拟] ' : ''}edit 已有 id=${plan.id}（不造第二条）`);
  if (!DRY) {
    const edited = orcaJson(['automations', 'edit', plan.id, ...common]);
    if (edited.ok !== true) {
      say(`[land-auto] edit 失败：${edited.error?.message || edited.error || JSON.stringify(edited).slice(0, 240)}`);
      process.exit(1);
    }
    say(`[land-auto] 已对齐 id=${edited.result?.automation?.id || plan.id}`);
  }
}

const again = orcaJson(['automations', 'list', '--json']);
const names = (again.result?.automations || []).filter((a) => a && a.name === LAND_AUTOMATION_NAME);
if (DRY && plan.action === 'create') {
  say(`[land-auto] dry-run 不查条数（还没真造）`);
  process.exit(0);
}
if (names.length !== 1) {
  say(`[land-auto] 幂等失败：名为 ${LAND_AUTOMATION_NAME} 的有 ${names.length} 条`);
  process.exit(1);
}
const hit = names[0];
if (hit.enabled !== true) {
  say(`[land-auto] 在册但 enabled=${hit.enabled}（应为 true）`);
  process.exit(1);
}
say(`[land-auto] 在册且启用 1 条 id=${hit.id}`);
process.exit(0);
