// scripts/lib/commander-inventory.mjs —— 指挥官「盘点体检 + 自检 + 装机」（#800）
//
// 盘点体检（眼睛的第二只）：扫孤儿进程/终端登记/timer/探针连红/超龄PR/落地清单空列。
// **它不自己修，只开单**——修要过用户放行（「盘点」与「自愈」的边界）。异常 → gh search 查重
// （带 [commander-inventory] 标记）→ 开「待拍板」单；正常 → 静默。第二轮同一异常不重复开。
//
// 每项三态：ok / red / unknown。unknown（探不到，如 Windows 无 /proc、无 journalctl）绝不开单，
// 也绝不当 ok——「没查成」经 status 三态可见，不刷屏、不埋根因。

import { existsSync, readFileSync, readdirSync, readlinkSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { dispatchQueueDir, reapStaleDispatchRunning } from './dispatch-queue.mjs';
import { ensurePlain, threeLines } from './plain-words.mjs';
import {
  PENDING_LABEL, parseTimingRef, collectSurfacing, buildSurfacingHubText, surfacingDedupKey,
} from './pending-disambiguation.mjs';

const INV_MARKER = '[commander-inventory]';
// 每项 red 带两份话：detail 给 issue/日志（技术细节），plain 给总控群（说人话，三行体）。
const STALE_PR_DAYS = 14;

function sh(cmd, args, timeout = 20000) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout });
  if (r.error) return { ok: false, error: r.error.code || r.error.message };
  return { ok: true, code: r.status, out: String(r.stdout || ''), err: String(r.stderr || '') };
}
const isLinux = () => process.platform === 'linux';

// ── 盘点各项（每项回 {state, detail, key}）──

// 1. 孤儿进程 cwd 已删（#835 实咬）：/proc/<pid>/cwd symlink 指向 (deleted)。
function checkOrphanDeletedCwd() {
  if (!isLinux() || !existsSync('/proc')) return { state: 'unknown', detail: '本平台无 /proc，探不到孤儿 cwd', key: 'orphan-cwd' };
  const hits = [];
  let pids;
  try { pids = readdirSync('/proc').filter((n) => /^\d+$/.test(n)); }
  catch (e) { return { state: 'unknown', detail: `/proc 读不了：${e.message}`, key: 'orphan-cwd' }; }
  for (const pid of pids) {
    let target, comm;
    try { target = readlinkSync(`/proc/${pid}/cwd`); } catch { continue; }
    if (!/\(deleted\)/.test(target)) continue;
    try { comm = readFileSync(`/proc/${pid}/comm`, 'utf8').trim(); } catch { comm = '?'; }
    // 只报 agent 类进程（node/pi/codex/grok/python），系统进程的 deleted cwd 不关我们事
    if (!/^(node|pi|codex|grok|python|cursor|devin)/i.test(comm)) continue;
    hits.push(`pid=${pid} comm=${comm} cwd=${target}`);
  }
  if (hits.length) {
    const posts = [...new Set(hits.map((h) => (h.match(/(ISSUE|PR)-(\d+)/) || [])[2]).filter(Boolean))].map((n) => '#' + n);
    return {
      state: 'red', key: 'orphan-cwd',
      detail: `孤儿进程 cwd 已删 ${hits.length} 个：${hits.slice(0, 5).join('；')}`,
      plain: {
        what: `有 ${hits.length} 个干活的程序还在跑，但它们的工位已经拆了${posts.length ? `（${posts.join('、')} 的旧工位）` : ''}`,
        impact: '白占服务器资源，可能反复报错',
        plan: '开一张待拍板单，你放行后我把它们关掉',
      },
    };
  }
  return { state: 'ok', detail: '无 cwd 已删的 agent 进程', key: 'orphan-cwd' };
}

// 2. 终端登记数 vs live agent 数不符（#633）。
function checkTerminalVsAgents({ runOrca, ROOT }) {
  const tl = runOrca(['terminal', 'list', '--json'], { cwd: ROOT });
  if (!tl.ok) return { state: 'unknown', detail: `terminal list 没查成：${fmt(tl.error)}`, key: 'term-vs-agent' };
  const terminals = tl.json?.result?.terminals;
  if (!Array.isArray(terminals)) return { state: 'unknown', detail: 'terminal list 契约变了', key: 'term-vs-agent' };
  const wl = runOrca(['orchestration', 'worker-list', '--json'], { cwd: ROOT });
  if (!wl.ok) return { state: 'unknown', detail: `worker-list 没查成：${fmt(wl.error)}`, key: 'term-vs-agent' };
  const workers = wl.json?.result?.workers;
  if (!Array.isArray(workers)) return { state: 'unknown', detail: 'worker-list 契约变了', key: 'term-vs-agent' };
  const liveAgents = workers.filter((w) => w && ['ready', 'working', 'waiting'].includes(String(w.state || '').toLowerCase())).length;
  // 只在 agent 数明显超过终端数时报（agent 无所依附的终端 = 幽灵）；反向（空终端多）是常态不报。
  if (liveAgents > terminals.length) {
    return {
      state: 'red', key: 'term-vs-agent',
      detail: `live agent ${liveAgents} 个 > 终端 ${terminals.length} 个（登记对不上，#633）`,
      plain: {
        what: `登记在册的工人有 ${liveAgents} 个，但真正开着的工作窗口只有 ${terminals.length} 个`,
        impact: '多出来的是「幽灵工人」，占名额不干活',
        plan: '开一张待拍板单，你放行后我清掉',
      },
    };
  }
  return { state: 'ok', detail: `终端 ${terminals.length} / live agent ${liveAgents}（对得上）`, key: 'term-vs-agent' };
}

// 3. timer 失效：指挥官两个 timer + 探针 timer 应 enabled。
function checkTimers() {
  if (!isLinux()) return { state: 'unknown', detail: '本平台无 systemd，探不到 timer', key: 'timers' };
  const want = ['commander-act.timer', 'commander-inventory.timer'];
  const bad = [];
  for (const t of want) {
    const r = sh('systemctl', ['is-enabled', t]);
    if (!r.ok) return { state: 'unknown', detail: `systemctl 探不到：${r.error}`, key: 'timers' };
    const st = r.out.trim();
    if (st !== 'enabled') bad.push(`${t}=${st || 'unknown'}`);
  }
  if (bad.length) {
    return {
      state: 'red', key: 'timers',
      detail: `指挥官 timer 未 enabled：${bad.join('、')}——node scripts/commander.mjs install`,
      plain: {
        what: `指挥官的定时任务有 ${bad.length} 个是关着的${bad.some((b) => b.startsWith('commander-act')) ? '（含自动派单）' : ''}`,
        impact: '关着期间新单不会自动派出去，只能人手动派',
        plan: '如果是我们故意关的（修东西期间）就不用管；不是的话我开单请你放行重开',
      },
    };
  }
  return { state: 'ok', detail: `指挥官 timer 齐（${want.join('、')} enabled）`, key: 'timers' };
}

// 4. 探针 journal 连红：gw-remote-probe 最近若干次全失败。
function checkProbeJournal() {
  if (!isLinux()) return { state: 'unknown', detail: '本平台无 journalctl', key: 'probe-red' };
  const r = sh('journalctl', ['-u', 'gw-remote-probe.service', '-n', '20', '--no-pager', '-o', 'cat'], 20000);
  if (!r.ok) return { state: 'unknown', detail: `journalctl 探不到：${r.error}`, key: 'probe-red' };
  if (r.code !== 0) return { state: 'unknown', detail: `journalctl 退出 ${r.code}（可能没这个单元）`, key: 'probe-red' };
  const lines = r.out.split(/\r?\n/).filter(Boolean);
  if (!lines.length) return { state: 'unknown', detail: '探针 journal 空，探不到', key: 'probe-red' };
  // 数「结尾连续」的失败标记（探针脚本自己的红行约定：含「红」或「FAIL」或「探活失败」）
  let streak = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/(红|FAIL|失败|error|exceeded)/i.test(lines[i])) streak++;
    else if (/(通|绿|OK|ok:true|成功)/i.test(lines[i])) break;
  }
  if (streak >= 3) {
    return {
      state: 'red', key: 'probe-red',
      detail: `探针 journal 结尾连红 ${streak} 行`,
      plain: {
        what: `网关探活最近连续 ${streak} 次报红`,
        impact: '走网关的模型可能不通，工人和审官会卡住',
        plan: '具体哪条线路不通看探活自己发的那条消息；我先开单记着',
      },
    };
  }
  return { state: 'ok', detail: `探针 journal 无连红（结尾红 ${streak} 行）`, key: 'probe-red' };
}

// 5. 超龄 open PR：> STALE_PR_DAYS 天没更新。
function checkStalePrs({ runGh, REPO }) {
  const r = runGh(['pr', 'list', '--repo', REPO, '--state', 'open', '--json', 'number,title,updatedAt', '--limit', '100'], 30000);
  if (!r.ok) return { state: 'unknown', detail: `pr list 没查成：${r.error}`, key: 'stale-pr' };
  let arr;
  try { arr = JSON.parse(r.out || '[]'); } catch (e) { return { state: 'unknown', detail: `pr list 输出不是 JSON：${e.message}`, key: 'stale-pr' }; }
  const cutoff = Date.now() - STALE_PR_DAYS * 86400000;
  const stale = arr.filter((p) => (Date.parse(p.updatedAt || '') || Date.now()) < cutoff);
  if (stale.length) {
    const list = stale.slice(0, 5).map((p) => '#' + p.number).join(' ');
    return {
      state: 'red', key: 'stale-pr',
      detail: `超龄 PR ${stale.length} 张（>${STALE_PR_DAYS}天未动）：${list}`,
      plain: {
        what: `有 ${stale.length} 张 PR 超过 ${STALE_PR_DAYS} 天没人动：${list}`,
        impact: '越拖越难合，还占着分支',
        plan: '开单请你拍：继续做还是关掉',
      },
    };
  }
  return { state: 'ok', detail: `无超龄 PR（阈值 ${STALE_PR_DAYS} 天）`, key: 'stale-pr' };
}

// 6. 落地清单状态列空着的步（读，不改——那是另两单的文件）。
function checkLandingChecklist({ ROOT }) {
  const file = join(ROOT, 'docs', 'decisions', 'SERVER-LANDING-CHECKLIST.md');
  if (!existsSync(file)) return { state: 'unknown', detail: '落地清单不在，探不到', key: 'landing-empty' };
  let text;
  try { text = readFileSync(file, 'utf8'); } catch (e) { return { state: 'unknown', detail: `清单读不了：${e.message}`, key: 'landing-empty' }; }
  // 找 markdown 表格里「状态」列空着的行（| ... |  |）。只认表体行，跳表头与分隔行。
  const empties = [];
  for (const line of text.split(/\r?\n/)) {
    if (!/^\s*\|/.test(line)) continue;
    if (/^\s*\|[\s:|-]+\|\s*$/.test(line)) continue; // 分隔行
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    if (cells.length < 2) continue;
    if (/状态|status/i.test(cells.join(''))) continue; // 表头
    // 末列当状态列：空 = 未填
    if (cells[cells.length - 1] === '') empties.push(cells[0] || '(空首列)');
  }
  if (empties.length) {
    const list = empties.slice(0, 5).join('、');
    return {
      state: 'red', key: 'landing-empty',
      detail: `落地清单状态列空 ${empties.length} 行：${list}`,
      plain: {
        what: `服务器落地清单有 ${empties.length} 步的状态栏还空着（第 ${list} 步）`,
        impact: '进度看不清',
        plan: '开单记着，等做的人回填',
      },
    };
  }
  return { state: 'ok', detail: '落地清单无空状态行', key: 'landing-empty' };
}

// 7. 派工执行体僵尸 .running（#849）：kill -9 写不出 out.json，inventory 补写失败记录并清标记。
function checkStaleDispatchRunning({ ROOT, dryRun }) {
  let dir;
  try { dir = dispatchQueueDir({ root: ROOT }); }
  catch (e) { return { state: 'unknown', detail: `队列目录没定：${String(e.message || e)}`, key: 'stale-running' }; }
  const r = reapStaleDispatchRunning(dir, { dryRun });
  if (!r.ok) return { state: 'unknown', detail: r.error || '队列扫不了', key: 'stale-running' };
  if (r.reaped.length) {
    return {
      state: 'ok',
      detail: `清了 ${r.reaped.length} 个僵尸 .running：${r.reaped.map((x) => x.id + '/' + x.reason).slice(0, 5).join('、')}`,
      key: 'stale-running',
      reaped: r.reaped,
    };
  }
  return { state: 'ok', detail: '无僵尸 .running', key: 'stale-running' };
}

// 8. 待消歧单到时机浮出水面（#876 ③）：扫 open 的「待消歧」单，正文/评论里「时机：#N 关闭后」
//    引用的 #N 已关 → 提醒一条「到讨论时机了」。**只提醒不派工、不开单**（单本来就在，开新单是重复）。
//    时机行缺失或 #N 读不到 → 没查成：不提醒、不报错，只落一行日志。
//    判据是纯函数（pending-disambiguation.mjs），这里只负责取数。
function scanPendingSurfacing({ runGh, REPO }) {
  const key = 'pending-surface';
  const r = runGh(['issue', 'list', '--repo', REPO, '--state', 'open', '--label', PENDING_LABEL,
    '--json', 'number,title,body,comments', '--limit', '100'], 30000);
  if (!r.ok) return { state: 'unknown', key, detail: `待消歧单列不出来：${fmt(r.error)}`, due: [] };
  let arr;
  try { arr = JSON.parse(r.out || '[]'); }
  catch (e) { return { state: 'unknown', key, detail: `待消歧单列表不是 JSON：${e.message}`, due: [] }; }
  if (!Array.isArray(arr)) return { state: 'unknown', key, detail: '待消歧单列表契约变了', due: [] };
  const items = arr.map((it) => {
    const texts = [it?.body || '', ...(Array.isArray(it?.comments) ? it.comments.map((c) => (c && c.body) || '') : [])];
    const timing = parseTimingRef(texts);
    let blockerState = null;
    if (timing.issue != null) {
      const v = runGh(['issue', 'view', String(timing.issue), '--repo', REPO, '--json', 'state'], 20000);
      if (v.ok) { try { blockerState = JSON.parse(v.out || '{}').state || null; } catch { blockerState = null; } }
    }
    return { issue: it?.number, title: it?.title || '', timingRef: timing.issue, blockerState };
  });
  const got = collectSurfacing(items);
  const detail = `待消歧单 ${items.length} 张：到时机 ${got.due.length}、还没到 ${got.notYet.length}、没查成 ${got.unknown.length}`;
  return { state: got.due.length ? 'due' : 'quiet', key, detail, ...got };
}

function fmt(err) { return typeof err === 'string' ? err.slice(0, 120) : (err?.message || err?.code || JSON.stringify(err) || '').slice(0, 120); }

/** 总控群一轮只发一条（不刷屏）：N 处不对，每处三行体。纯函数，测试盯它不说黑话。 */
export function buildInventoryHubText(reds, { everyHours = 6 } = {}) {
  const items = reds.map((c) => threeLines(c.plain || { what: c.detail }));
  const head = `指挥官盘点（每 ${everyHours} 小时一次）发现 ${reds.length} 处不对：`;
  if (reds.length === 1) return `${head}\n${items[0]}`;
  return [head, ...items.map((t, i) => `${i + 1}）${t.replace(/\n/g, '\n   ')}`)].join('\n');
}

// ── inventory 子命令 ──
export function runInventory({ rest, ROOT, REPO, STATE_DIR, runGh, runOrca, hubOnce, openEscalationIssue, loadState, saveState }) {
  const dryRun = rest.includes('--dry-run');
  const state = loadState();
  const checks = [
    checkOrphanDeletedCwd(),
    checkTerminalVsAgents({ runOrca, ROOT }),
    checkTimers(),
    checkProbeJournal(),
    checkStalePrs({ runGh, REPO }),
    checkLandingChecklist({ ROOT }),
    checkStaleDispatchRunning({ ROOT, dryRun }),
  ];
  const reds = checks.filter((c) => c.state === 'red');
  const unknowns = checks.filter((c) => c.state === 'unknown');
  const log = [];
  for (const c of checks) log.push(`  ${c.state === 'ok' ? '✓' : c.state === 'red' ? 'X' : '?'} ${c.key} —— ${c.detail}`);

  // 群里一轮一条（去重键 = 红项集合；集合变了才再说一次），issue 仍逐项开。
  if (reds.length) {
    const text = ensurePlain(buildInventoryHubText(reds), 'commander-inventory');
    const r = hubOnce({ state, key: `inv:${reds.map((c) => c.key).sort().join('+')}`, text, dryRun });
    log.push(`  群：${r.sent ? (r.dryRun ? '[dry] ' : '') + '一条合并消息' : '略（' + (r.reason || r.error) + '）'}`);
  }
  for (const c of reds) {
    const key = `inventory/${c.key}`;
    const marker = `${INV_MARKER} ${key}`;
    const found = runGh(['search', 'issues', '--repo', REPO, '--state', 'open', '--match', 'body', marker, '--json', 'number', '--limit', '3'], 30000);
    let existing = null;
    if (found.ok) { try { const a = JSON.parse(found.out || '[]'); if (a.length) existing = a[0].number; } catch { /* ignore */ } }
    if (existing) { log.push(`  报帅（待拍板 #${existing} 已在，不重开）：${c.key}`); continue; }
    if (dryRun) { log.push(`  [dry] 开待拍板单：${c.key}（marker=${marker}）`); continue; }
    const body = [`指挥官盘点体检发现异常（#800，只开单不自修）：`, ``, `- 项：${c.key}`, `- 详情：${c.detail}`, ``,
      `修要过你放行。查重标记（勿删）：${marker}`].join('\n');
    const opened = openEscalationIssue({ title: `[待拍板] 盘点：${c.key}`, body });
    log.push(`  ${opened.ok ? '开单 #' + opened.number : '开单失败：' + opened.error}：${c.key}`);
  }
  // 待消歧到时机（#876 ③）：不进 reds——它不是「有东西坏了要开单」，是「有件事该找你聊了」。
  const surface = scanPendingSurfacing({ runGh, REPO });
  log.push(`  ${surface.state === 'due' ? '!' : surface.state === 'unknown' ? '?' : '✓'} ${surface.key} —— ${surface.detail}`);
  if (surface.state === 'due') {
    const text = ensurePlain(buildSurfacingHubText(surface.due), 'commander-inventory/待消歧');
    const r = hubOnce({ state, key: surfacingDedupKey(surface.due), text, dryRun });
    log.push(`  群：${r.sent ? (r.dryRun ? '[dry] ' : '') + '到时机提醒一条' : '略（' + (r.reason || r.error) + '）'}`);
  }
  if (!dryRun) saveState(state);
  console.log(JSON.stringify({ dryRun, red: reds.length, unknown: unknowns.length, ok: checks.length - reds.length - unknowns.length,
    checks: checks.map((c) => ({ key: c.key, state: c.state })),
    surfacing: { state: surface.state, due: (surface.due || []).map((d) => d.issue) } }, null, 2));
  console.error(log.join('\n'));
  // 盘点本身不因异常非零（异常已开单）；探不到项不算失败——它只是提示 status 去看。
  process.exit(0);
}

// ── status 子命令：自检三态，供 server-check 一行引用 ──
export function runStatus({ rest, ROOT }) {
  const asJson = rest.includes('--json');
  // 三态判据：timer 装好且 enabled = 通；未装/未 enabled = 红；无 systemd（Windows）= 没查成。
  const t = checkTimers();
  let state, detail, exit;
  if (t.state === 'unknown') { state = 'unknown'; detail = t.detail; exit = 2; }
  else if (t.state === 'red') { state = 'red'; detail = t.detail; exit = 1; }
  else { state = 'ok'; detail = t.detail; exit = 0; }
  if (asJson) console.log(JSON.stringify({ state, detail, exit }));
  else console.log(`指挥官自检：${state === 'ok' ? '通' : state === 'red' ? '真红' : '没查成'} —— ${detail}`);
  process.exit(exit);
}

// ── install 子命令：幂等写 systemd service+timer ──
function unit(desc, execArgs) {
  return `[Unit]\nDescription=${desc}\n\n[Service]\nType=oneshot\nUser=orca\nWorkingDirectory=/home/orca/windsurf-dao\nExecStart=/usr/bin/node ${execArgs}\n`;
}
function timer(desc, activeSec) {
  return `[Unit]\nDescription=${desc}\n\n[Timer]\nOnBootSec=3min\nOnUnitActiveSec=${activeSec}\nPersistent=true\n\n[Install]\nWantedBy=timers.target\n`;
}
const INSTALL_FILES = () => ({
  '/etc/systemd/system/commander-act.service': unit('指挥官 act：scan→decide→执行（#800）', '/home/orca/windsurf-dao/scripts/commander.mjs act'),
  '/etc/systemd/system/commander-act.timer': timer('指挥官 act 每 20 分钟', '20min'),
  '/etc/systemd/system/commander-inventory.service': unit('指挥官盘点体检（#800）', '/home/orca/windsurf-dao/scripts/commander.mjs inventory'),
  '/etc/systemd/system/commander-inventory.timer': timer('指挥官盘点每 6 小时', '6h'),
});

export function runInstall({ rest, ROOT }) {
  const dryRun = rest.includes('--dry-run');
  const files = INSTALL_FILES();
  const plan = [];
  let changed = false;
  for (const [path, content] of Object.entries(files)) {
    let cur = null;
    try { cur = readFileSync(path, 'utf8'); } catch { /* absent */ }
    if (cur === content) { plan.push(`  = ${path}（已是最新，不动）`); continue; }
    changed = true;
    plan.push(`  ${cur == null ? '+' : '~'} ${path}`);
    if (!dryRun) {
      try { writeFileSync(path, content, 'utf8'); }
      catch (e) {
        console.error(`写 ${path} 失败：${e.message}\n需要 root：sudo node scripts/commander.mjs install`);
        process.exit(1);
      }
    }
  }
  const enableCmds = ['sudo systemctl daemon-reload',
    'sudo systemctl enable --now commander-act.timer commander-inventory.timer'];
  console.log(JSON.stringify({ dryRun, changed, plan: plan.map((p) => p.trim()), enable: enableCmds }, null, 2));
  console.error(plan.join('\n'));
  if (changed && !dryRun) {
    // 连跑两遍不产生第二份：内容相同就不重写（上面已判）；enable 交给下面两条（幂等）。
    const dr = sh('systemctl', ['daemon-reload']);
    if (dr.ok && dr.code === 0) {
      sh('systemctl', ['enable', '--now', 'commander-act.timer', 'commander-inventory.timer']);
      console.error('  已 daemon-reload + enable --now（若非 root 上面写盘就已失败退出）');
    } else {
      console.error(`  daemon-reload 没跑成（可能非 root）：手动跑\n    ${enableCmds.join('\n    ')}`);
    }
  } else if (!changed) {
    console.error('  单元已是最新，无改动（幂等）');
  } else {
    console.error(`  dry-run：真装跑 sudo node scripts/commander.mjs install，然后\n    ${enableCmds.join('\n    ')}`);
  }
  process.exit(0);
}
