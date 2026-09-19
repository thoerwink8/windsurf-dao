#!/usr/bin/env node
// scripts/bootstrap-server.mjs —— 新服务器「一条命令装好编排面」（幂等；每步都读回验收）。
//
//   sudo node scripts/bootstrap-server.mjs                 # 装 + 验
//   sudo node scripts/bootstrap-server.mjs --dry-run       # 只看要做什么，不动手
//   sudo node scripts/bootstrap-server.mjs --prune-legacy  # 顺带停用旧链路单元（stop + disable，不删数据）
//
// 分工与归属（见 NEW-MACHINE.md「编排面迁移清单」与 host/machine/INDEX.md）：
//   本脚本只管**编排面**——本仓的常驻单元 + onboard 接线。
//   Mirasim / key / Clash / ssh 接线 / 代理归 **ai-gateway-stack**（deploy/mirasim-bootstrap.mjs）。
//   不要再新开第三个「装机仓」。
//
// 规矩：每一步都要**读回**（is-active / is-enabled / NEXT 是时间 / 启动行），
// 读不到算「没查成」——不许当绿（这个仓被「装上了但没跑」咬过很多次）。

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DRY = process.argv.includes('--dry-run');
const PRUNE = process.argv.includes('--prune-legacy');
/** 服务用户的家：单元里 User=orca / HOME=/home/orca；清单要读它名下的 shim / versions / 凭据。 */
const SERVICE_HOME = process.env.DAO_SERVICE_HOME || '/home/orca';

/** 编排面：新链路要装的单元族（每个 install-<name>.sh 幂等，头部写清装什么/怎么验）。 */
const ORCHESTRATION = [
  { name: 'fleet', why: '编排面本体：dao-fleet-temporal + dao-fleet-worker' },
  { name: 'dao-sync', why: '服务器主树跟 origin/master' },
  { name: 'land', why: '收工推主分支 + 清已合并派生物' },
  { name: 'skills-heal', why: 'skills 装载面自愈（含 root 侧那只）' },
  { name: 'execution-usage', why: '用量账本（选型的历史成功率读它）' },
  { name: 'gw-remote-probe', why: '健康表（选型的可用性读它）' },
];

/** 旧链路：本仓历史上装过、新链路不再需要的单元（拆干净 = 停 + 禁，不删数据）。 */
const LEGACY_UNITS = [
  'dao-patrol.timer', 'dao-patrol.service', 'dao-patrol-failure.service',
  'dao-refiner.timer', 'dao-refiner.service',
  'dao-board-gc.timer', 'dao-board-gc.service', 'dao-board-watch.timer', 'dao-board-watch.service',
  'dao-close-issues.timer', 'dao-close-issues.service',
  'dao-gh-events.service',
];

/** 装完要读回的单元（族 → 单元名）。读回三态：green / red / unscanned（没查成）。 */
const READBACK = [
  { unit: 'dao-fleet-temporal.service', kind: 'service' },
  { unit: 'dao-fleet-worker.service', kind: 'service', expectLog: 'worker 已启动' },
  { unit: 'dao-sync.timer', kind: 'timer' },
  { unit: 'dao-land.timer', kind: 'timer' },
  { unit: 'dao-skills-heal.timer', kind: 'timer' },
  { unit: 'dao-execution-usage.timer', kind: 'timer' },
  { unit: 'gw-remote-probe.timer', kind: 'timer' },
];

const run = (cmd, argv, opts = {}) => spawnSync(cmd, argv, { encoding: 'utf8', windowsHide: true, ...opts });
const say = line => process.stdout.write(`${line}\n`);
const sh = (argv, opts = {}) => run('bash', argv, opts);

function preconditions() {
  const problems = [];
  if (process.platform !== 'linux') problems.push(`本脚本只跑 Linux（现在 ${process.platform}）`);
  if (typeof process.getuid === 'function' && process.getuid() !== 0) problems.push('要 root：装单元与 enable 都要（sudo node scripts/bootstrap-server.mjs）');
  if (!existsSync(join(ROOT, 'host', 'machine', 'systemd'))) problems.push(`仓内单元目录不在：${join(ROOT, 'host/machine/systemd')}`);
  if (!existsSync(join(ROOT, 'scripts', 'onboard.mjs'))) problems.push('scripts/onboard.mjs 不在——仓库不完整？');
  return problems;
}

/** 读回一只单元：active/enabled + （timer 时）NEXT 必须是时间。读不到 = unscanned，不是绿。 */
function readbackUnit({ unit, kind, expectLog }) {
  const active = run('systemctl', ['is-active', unit]).stdout?.trim() || '';
  const enabled = run('systemctl', ['is-enabled', unit]).stdout?.trim() || '';
  if (kind === 'timer') {
    const listed = run('systemctl', ['list-timers', unit, '--no-pager']).stdout || '';
    const nextIsTime = /\b\d{4}-\d{2}-\d{2}\b/.test(listed);
    if (!listed.trim()) return { state: 'unscanned', why: `${unit} 没在 list-timers 里（没查成）` };
    return nextIsTime && active === 'active'
      ? { state: 'green', why: `active/${enabled}，NEXT 是时间` }
      : { state: 'red', why: `active=${active} enabled=${enabled} NEXT 不是时间` };
  }
  if (expectLog) {
    const log = run('journalctl', ['-u', unit, '-n', '80', '--no-pager', '-o', 'cat']).stdout || '';
    if (!log.trim()) return { state: 'unscanned', why: `${unit} 的 journal 读不到（没查成）` };
    if (!log.includes(expectLog)) return { state: 'red', why: `${unit} 起来了但日志里没有「${expectLog}」` };
  }
  return active === 'active' && enabled !== 'disabled'
    ? { state: 'green', why: `active/${enabled}` }
    : { state: 'red', why: `active=${active} enabled=${enabled}` };
}

function pruneLegacy() {
  const results = [];
  for (const unit of LEGACY_UNITS) {
    const shown = run('systemctl', ['show', unit, '-p', 'LoadState', '--value']).stdout?.trim();
    if (shown === '' || shown === 'not-found') { results.push({ unit, state: 'skipped', why: '没装过' }); continue; }
    if (DRY) { results.push({ unit, state: 'would-stop', why: '停 + disable' }); continue; }
    run('systemctl', ['stop', unit]);
    const disabled = run('systemctl', ['disable', unit]);
    results.push({ unit, state: disabled.status === 0 ? 'stopped' : 'red', why: disabled.status === 0 ? '已停 + disable（数据不删）' : String(disabled.stderr || '').slice(0, 120) });
  }
  return results;
}

function main() {
  const problems = preconditions();
  if (problems.length) {
    say('前提不满足，停手（fail-closed）：');
    for (const p of problems) say(`  · ${p}`);
    return 2;
  }
  say(`[bootstrap] ${DRY ? '（dry-run，不动手）' : ''}仓库：${ROOT}`);

  say('\n① onboard（全局约定 / skills / memory / pi 扩展；幂等）');
  if (DRY) say('  [拟] sudo -u orca node scripts/onboard.mjs');
  else {
    const r = run('sudo', ['-u', 'orca', 'node', join(ROOT, 'scripts', 'onboard.mjs')]);
    say(`  onboard exit=${r.status}`);
    if (r.status !== 0) say(`  （onboard 还有剩项，逐条看它自己的报告；不挡下面的单元安装）`);
  }

  say('\n② 编排面单元');
  for (const { name, why } of ORCHESTRATION) {
    const script = join(ROOT, 'scripts', `install-${name}.sh`);
    if (!existsSync(script)) { say(`  ✗ ${name}：装机脚本不在（${script}）——清单与仓库不一致，停手`); return 2; }
    if (DRY) { say(`  [拟] bash scripts/install-${name}.sh   # ${why}`); continue; }
    const r = sh([script]);
    const tail = String(r.stdout || '').trim().split('\n').slice(-2).join(' / ');
    say(`  ${r.status === 0 ? '✓' : '✗'} ${name}（exit=${r.status}）${tail ? ` — ${tail}` : ''}`);
  }

  if (PRUNE) {
    say('\n③ 旧链路拆干净（stop + disable，不删数据）');
    for (const { unit, state, why } of pruneLegacy()) say(`  ${state === 'red' ? '✗' : '·'} ${unit}：${state}（${why}）`);
  }

  say('\n④ 读回验收（读不到算「没查成」，不算绿）');
  let red = 0; let unscanned = 0;
  for (const spec of READBACK) {
    if (DRY) { say(`  [拟] 读回 ${spec.unit}`); continue; }
    const verdict = readbackUnit(spec);
    if (verdict.state === 'red') red += 1;
    if (verdict.state === 'unscanned') unscanned += 1;
    say(`  ${verdict.state === 'green' ? '✓' : verdict.state === 'red' ? '✗' : '?'} ${spec.unit}：${verdict.why}`);
  }

  say('\n⑤ 机器级清单（OS / Node / 执行体 / 工具 / 凭据落点；读不到算「没查成」）');
  if (DRY) say('  [拟] DAO_INVENTORY_HOME=<服务用户家> node scripts/machine-inventory.mjs');
  else {
    // 以 root 跑（才读得到 /etc/sudoers.d），但家目录指向**服务用户**（凭据/shim/versions 都在它名下）。
    const inv = run('node', [join(ROOT, 'scripts', 'machine-inventory.mjs')], { env: { ...process.env, DAO_INVENTORY_HOME: SERVICE_HOME } });
    say(String(inv.stdout || '').split('\n').slice(-3).join('\n'));
    if (inv.status !== 0) say('  （清单有红或没查成——逐条看上面的报告，别当装好了）');
  }

  say('\n⑥ 归属提醒：Mirasim / key / Clash / ssh 接线归 ai-gateway-stack（deploy/mirasim-bootstrap.mjs）；本脚本只管编排面。');
  if (DRY) return 0;
  say(`\n[bootstrap] 结论：红 ${red}，没查成 ${unscanned}${red || unscanned ? '——逐条看上面，别当装好了' : '——全绿'}`);
  return red || unscanned ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}

export { ORCHESTRATION, LEGACY_UNITS, READBACK, preconditions, readbackUnit, pruneLegacy };
