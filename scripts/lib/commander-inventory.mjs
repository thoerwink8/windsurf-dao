// scripts/lib/commander-inventory.mjs —— 指挥官「盘点体检 + 自检 + 装机」（#800）
//
// 盘点体检（眼睛的第二只）：扫孤儿进程/终端登记/timer/探针连红/落地清单空列。
// **它不自己修，只开单**——修要过用户放行（「盘点」与「自愈」的边界）。异常 → gh search 查重
// （带 [commander-inventory] 标记）→ 开「待拍板」单；正常 → 静默。第二轮同一异常不重复开。
//
// #1004 发现层换成推进量后，原 8 项逐项裁定（删 vs 留）：
//   stale-pr        覆盖→删。N 轮 head/合上/草稿/判定不变已含「N 天没人动」；日历阈值发现不了 #909 几小时卡死。
//   orphan-cwd      留。/proc cwd(deleted) 是机器层，situation 快照里没有。
//   term-vs-agent   留。terminal list vs worker-list，快照的 worktrees 对不上幽灵 agent。
//   timers          留。指挥官 timer 关着是执行器死，不是盘面对象停滞。
//   probe-red       留。网关探活 journal，快照不采。
//   landing-empty   留。落地清单空状态列是文档债，不是 PR/单/树/票。
//   stale-running   留。派工队列僵尸 .running，situation 不写这份队列。
//   pending-surface 留。待消歧到时机是日历事件，不是「连续 N 轮同一状态」。
//
// 每项三态：ok / red / unknown。unknown（探不到，如 Windows 无 /proc、无 journalctl）绝不开单，
// 也绝不当 ok——「没查成」经 status 三态可见，不刷屏、不埋根因。

import { existsSync, readFileSync, readdirSync, readlinkSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { dispatchQueueDir, reapStaleDispatchRunning } from './dispatch-queue.mjs';
import { probeVersionDrift } from './mirasim-runtime.mjs';
import { loadHealthTable } from './provider-health.mjs';
import { classifyTimerArmed } from './timer-armed.mjs';
import { ensurePlain, threeLines } from './plain-words.mjs';
import {
  PENDING_LABEL, parseTimingRef, collectSurfacing, buildSurfacingHubText, surfacingDedupKey,
} from './pending-disambiguation.mjs';
import { fieldsFromInventory } from './hub-ask.mjs';

const INV_MARKER = '[commander-inventory]';
// 每项 red 带两份话：detail 给 issue/日志（技术细节），plain 给总控群（说人话，三行体）。

function sh(cmd, args, timeout = 20000) {
  const r = spawnSync(cmd, args, { windowsHide: true, encoding: 'utf8', timeout });
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

// 2. 终端登记 vs live agent（#633）。orca 终端/worker-list 已退役；在途改由租约闸看。
function checkTerminalVsAgents() {
  return {
    state: 'ok',
    detail: 'orca 终端登记已退役，在途改由 mirasim 租约闸看',
    key: 'term-vs-agent',
  };
}

// 3. timer 失效：指挥官两个 timer 应在册、enabled，且**真的还会响**。
//
// 只看 `is-enabled` 是不够的（收件箱 2026-09-10「指挥官 timer 停了自检仍绿」实咬）：
// commander-act.timer 从 09-09 22:58 起 enabled + inactive(dead)、NEXT=-，
// 而这里回「✓ 齐（…enabled）」——自动派单实际停了 7 小时，眼睛报平安。enabled 说的是
// 「开机时会拉起」，和「此刻会不会响」是两件事。补两个观测：ActiveState/SubState 与 NEXT。
// 判 active 的 timer：NextElapse 为空是**正常**的（前一响的服务还在跑，systemd 等它结束
// 才排下一次）——那种情形 SubState=running；空 Next + dead 才是真停。
// 纯判据在 lib/timer-armed.mjs，这里只取数。
function checkTimers() {
  if (!isLinux()) return { state: 'unknown', detail: '本平台无 systemd，探不到 timer', key: 'timers' };
  const want = ['commander-act.timer', 'commander-inventory.timer'];
  const samples = [];
  for (const t of want) {
    const r = sh('systemctl', ['show', t, '-p', 'ActiveState', '-p', 'SubState', '-p', 'UnitFileState',
      '-p', 'NextElapseUSecRealtime', '-p', 'LastTriggerUSec']);
    // `systemctl show` 按它自己的属性顺序输出（不是命令行顺序）——按键取，不按下标。
    if (!r.ok) return { state: 'unknown', detail: `systemctl 探不到：${r.error}`, key: 'timers' };
    const kv = new Map(String(r.out || '').split(/\r?\n/).map((l) => {
      const i = l.indexOf('=');
      return i === -1 ? null : [l.slice(0, i), l.slice(i + 1).trim()];
    }).filter(Boolean));
    samples.push({
      unit: t,
      isEnabled: kv.get('UnitFileState') || '',
      activeState: kv.get('ActiveState') || '',
      subState: kv.get('SubState') || '',
      next: kv.get('NextElapseUSecRealtime') ?? '',
      last: kv.get('LastTriggerUSec') || '',
    });
  }
  const verdict = classifyTimerArmed({ probed: true, timers: samples });
  if (verdict.state === 'ok') return { state: 'ok', detail: verdict.detail, key: 'timers' };
  return {
    state: verdict.state, key: 'timers', detail: verdict.detail,
    ...(verdict.state === 'red' ? {
      plain: {
        what: `指挥官的定时任务有问题：${verdict.bad.map((b) => b.why).join('、')}`,
        impact: '定时那 20 分钟一轮的自动派单/合并不会自己跑，只能人手动触发',
        plan: '如果是我们故意停的（修东西期间）就不用管；不是的话我重开一次再验一遍',
      },
    } : {}),
  };
}

// 3.5 升级换没换干净：升级器 promote 出来的版本 vs 在役进程自报的版本。
// 契约断言两边都读服务端，天生看不见「盘上换了、进程没换」这层错位（2026-09-10 的镜像面）。
// 判官与只读探测都在 lib/mirasim-runtime.mjs，这里只管取数与翻译成巡检三态。
async function checkVersionDrift({ homeDir } = {}) {
  const key = 'mirasim-version';
  if (!isLinux()) return { state: 'unknown', key, detail: '本平台无 systemd/回环服务端，探不到在役版本' };
  try {
    // 只读：读 current/VERSION + 连上问一句 state 就关，绝不建树、不写盘（眼睛不许有副作用）。
    return await probeVersionDrift({ homeDir: homeDir || homedir(), service: 'mirasim-server.service' });
  } catch (e) {
    return { state: 'unknown', key, detail: `升级版本探不到：${fmt((e && e.message) || e)}——没查成，不是一致` };
  }
}

// 4. 探针连红：读探活自己写的健康表。
//
// 原来读 `journalctl -u gw-remote-probe`，跑它的身份是 orca——orca 不在
// systemd-journal / adm 里，journalctl 退出 1、stdout 空，闸就把这次失败
// 归成「不知道」，标 unknown 不开单（#1166）。这台机器上「探针连红」
// 这一格因此**从来没有真查过**，而探活自己写的健康表 orca 读得到。
//
// 判据换成读健康表：真相源从「别人单元的日志」改成「探活自己落的盘」——
// 少一层权限依赖，也少一层「日志格式变了判据就瞎」。
export function judgeProbeRed(health) {
  const key = 'probe-red';
  if (!health || health.unknown) {
    return { state: 'unknown', key, detail: `健康表没查成：${(health && health.reason) || '没读到'}` };
  }
  const targets = health.table && typeof health.table === 'object' ? health.table : {};
  const names = Object.keys(targets);
  if (!names.length) {
    // 表在但没有目标 = 探活没采到东西，跟「全绿」是两回事。
    return { state: 'unknown', key, detail: `${health.path} 里一个目标都没有——没采到，不是全绿` };
  }
  const red = names.filter((n) => String(targets[n] && targets[n].state || '').toLowerCase() === 'red');
  const unknownT = names.filter((n) => String(targets[n] && targets[n].state || '').toLowerCase() === 'unknown');
  if (red.length) {
    return {
      state: 'red', key,
      detail: `健康表 ${red.length}/${names.length} 个目标红：${red.slice(0, 6).join('、')}`,
      plain: {
        what: `网关探活有 ${red.length} 条线路报红：${red.slice(0, 4).join('、')}`,
        impact: '走这几条的工人和审官会卡住或被降级',
        plan: '具体失败码看健康表那几个目标的 code/why；编排层已按此避让，我先开单记着',
      },
    };
  }
  return {
    state: 'ok', key,
    detail: `健康表 ${names.length} 个目标无一红（unknown ${unknownT.length} 个）`,
  };
}

function checkProbeJournal() {
  if (!isLinux()) return { state: 'unknown', detail: '本平台无 systemd，探不到探针', key: 'probe-red' };
  return judgeProbeRed(loadHealthTable({ home: homedir() }));
}

// 5. 超龄 open PR（stale-pr）——#1004 裁定被推进量覆盖：N 轮 head/合上/草稿/判定都不变
//    已经包含「14 天没人动」。日历阈值发现不了 #909 那种几小时卡死，留着是两条腿。已删。

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
  const blind = (detail) => ({ state: 'unknown', key, detail, scanned: false, due: [], notYet: [], unknown: [] });
  if (!r.ok) return blind(`待消歧单列不出来：${fmt(r.error)}`);
  let arr;
  try { arr = JSON.parse(r.out || '[]'); }
  catch (e) { return blind(`待消歧单列表不是 JSON：${e.message}`); }
  if (!Array.isArray(arr)) return blind('待消歧单列表契约变了');
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
  return { state: surfaceState(got), key, detail, ...got };
}

function fmt(err) { return typeof err === 'string' ? err.slice(0, 120) : (err?.message || err?.code || JSON.stringify(err) || '').slice(0, 120); }

/** 总控群一轮只发一条（不刷屏）：N 处不对，每处三行体。纯函数，测试盯它不说黑话。 */
export function buildInventoryHubText(reds, { everyHours = 6 } = {}) {
  const items = reds.map((c) => threeLines(c.plain || { what: c.detail }));
  const head = `指挥官盘点（每 ${everyHours} 小时一次）发现 ${reds.length} 处不对：`;
  if (reds.length === 1) return `${head}\n${items[0]}`;
  return [head, ...items.map((t, i) => `${i + 1}）${t.replace(/\n/g, '\n   ')}`)].join('\n');
}

/** 待消歧扫描的整项状态。有一张没查成就得说出来：
 *  报 quiet 会被打成 ✓，等于把「瞎了」显示成「查过没事」。 */
export function surfaceState(got = {}) {
  const due = Array.isArray(got.due) ? got.due : [];
  const unknown = Array.isArray(got.unknown) ? got.unknown : [];
  if (got.scanned === false) return 'unknown';
  if (due.length) return 'due';
  if (unknown.length) return 'unknown';
  return 'quiet';
}

/** 检查项四态计数：ok + red + unknown + due 恒等于检查项总数。
 *  没见过的状态一律算「没查成」——并进「查过没事」就是把瞎了当好了。 */
export function tallyChecks(checks = []) {
  const list = Array.isArray(checks) ? checks.filter(Boolean) : [];
  const red = [], due = [], ok = [], unknown = [];
  for (const c of list) {
    if (c.state === 'red') red.push(c);
    else if (c.state === 'due') due.push(c);
    else if (c.state === 'ok' || c.state === 'quiet') ok.push(c);
    else unknown.push(c);
  }
  return { total: list.length, red, due, ok, unknown,
    counts: { total: list.length, red: red.length, due: due.length, ok: ok.length, unknown: unknown.length } };
}

export const CHECK_SYM = { ok: '✓', quiet: '✓', red: 'X', due: '!', unknown: '?' };

// ── inventory 子命令 ──
export function runInventory({ rest, ROOT, REPO, STATE_DIR, runGh, hubOnce, hubAskOnce, openEscalationIssue, loadState, saveState, versionDrift = checkVersionDrift }) {
  return runInventoryAsync({ rest, ROOT, REPO, STATE_DIR, runGh, hubOnce, hubAskOnce, openEscalationIssue, loadState, saveState, versionDrift });
}

async function runInventoryAsync({ rest, ROOT, REPO, STATE_DIR, runGh, hubOnce, hubAskOnce, openEscalationIssue, loadState, saveState, versionDrift }) {
  const dryRun = rest.includes('--dry-run');
  const state = loadState();
  const checks = [
    checkOrphanDeletedCwd(),
    checkTerminalVsAgents(),
    checkTimers(),
    // 升级换没换干净要看回环服务端自报，是异步的——单独 await，不塞进上面的同步数组。
    await versionDrift(),
    checkProbeJournal(),
    checkLandingChecklist({ ROOT }),
    checkStaleDispatchRunning({ ROOT, dryRun }),
    // 待消歧到时机（#876 ③）：跟前几项同列，一起进计数——挂在数组外面会让 ok 数与实际项数对不上。
    // #1004 删掉 stale-pr 后这里一共 8 项（2026-09-10 加「升级换没换干净」）。
    scanPendingSurfacing({ runGh, REPO }),
  ];
  const surface = checks[checks.length - 1];
  const tally = tallyChecks(checks);
  const reds = tally.red;
  const unknowns = tally.unknown;
  const log = [];
  for (const c of checks) log.push(`  ${CHECK_SYM[c.state] || '?'} ${c.key} —— ${c.detail}`);

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
    const askInv = (n) => {
      if (typeof hubAskOnce !== 'function' || !n) return;
      const planned = fieldsFromInventory({
        repo: REPO, number: n, key: c.key, detail: c.detail,
        url: `https://github.com/${REPO}/issues/${n}`,
      });
      if (!planned.ok) { log.push(`  待拍板卡拒发：${planned.error}`); return; }
      const r = hubAskOnce({ state, key: `invcard:${c.key}`, fields: planned.fields, dryRun });
      log.push(`  ${r.sent ? (r.dryRun ? '[dry] ' : '') + '待拍板卡 #' + n : '待拍板卡略：' + (r.reason || r.error)}`);
    };
    if (existing) {
      log.push(`  报帅（待拍板 #${existing} 已在，不重开）：${c.key}`);
      askInv(existing);
      continue;
    }
    if (dryRun) { log.push(`  [dry] 开待拍板单：${c.key}（marker=${marker}）`); continue; }
    const body = [`指挥官盘点体检发现异常（#800，只开单不自修）：`, ``, `- 项：${c.key}`, `- 详情：${c.detail}`, ``,
      `修要过你放行。查重标记（勿删）：${marker}`].join('\n');
    const opened = openEscalationIssue({ title: `[待拍板] 盘点：${c.key}`, body });
    log.push(`  ${opened.ok ? '开单 #' + opened.number : '开单失败：' + opened.error}：${c.key}`);
    if (opened.ok && opened.number) askInv(opened.number);
  }
  // 到时机只提醒不开单——它不是「有东西坏了」，是「有件事该找你聊了」（上面开单的循环只走 red）。
  if (surface.state === 'due') {
    const text = ensurePlain(buildSurfacingHubText(surface.due), 'commander-inventory/待消歧');
    const r = hubOnce({ state, key: surfacingDedupKey(surface.due), text, dryRun });
    log.push(`  群：${r.sent ? (r.dryRun ? '[dry] ' : '') + '到时机提醒一条' : '略（' + (r.reason || r.error) + '）'}`);
  }
  if (!dryRun) saveState(state);
  console.log(JSON.stringify({ dryRun, ...tally.counts,
    checks: checks.map((c) => ({ key: c.key, state: c.state })),
    surfacing: { state: surface.state,
      due: (surface.due || []).map((d) => d.issue),
      unknown: (surface.unknown || []).map((u) => (u && u.issue) ?? u) } }, null, 2));
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

// 单元里的 PATH 必须显式写死。systemd 不读服务用户的 shell profile，oneshot 拿到的 PATH 只有
// /usr/bin:/bin，于是指挥官调 hub-say 全是 ENOENT——2026-09-03 实咬 #848：首轮 act
// 找不到命令被 unscanned fail-closed 拦下（当时还调 orca CLI，#1150 已删）。
// 群通知整轮静默，靠手糊的 drop-in 垫片才跑起来。同一坑 agent-stall-watch 已经踩过一次。
// 值与 host/machine/systemd/*.service 里手写的那几个必须一致（tests/commander-install.test.js 盯着）。
export const UNIT_PATH = '/home/orca/.local/bin:/home/orca/bin:/usr/local/bin:/usr/bin:/bin';
// 指挥官真正要在 PATH 里找到的外部命令住在哪。改 UNIT_PATH 前先确认这几条还在里面。
export const UNIT_TOOL_DIRS = { 'local-bin': '/home/orca/.local/bin', 'hub-say': '/home/orca/bin' };

// 2026-09-03 那两份 drop-in 垫片。正式模板带上 PATH 之后它们该退役——留着不会坏事，
// 但它是影子制度：下次有人改 UNIT_PATH 会发现改了不生效。装机时看一眼，在就报一句。
const PATH_SHIMS = [
  '/etc/systemd/system/commander-act.service.d/path.conf',
  '/etc/systemd/system/commander-inventory.service.d/path.conf',
];
/** 垫片还在不在（exists 可注入，供测试）。回空数组 = 查过没有，不是没查。 */
export function findPathShims(exists = existsSync) {
  return PATH_SHIMS.filter((p) => exists(p));
}

function unit(desc, execArgs) {
  return `[Unit]\nDescription=${desc}\n\n[Service]\nType=oneshot\nUser=orca\nWorkingDirectory=/srv/projects/windsurf-dao\nEnvironment=PATH=${UNIT_PATH}\nExecStart=/usr/bin/node ${execArgs}\n`;
}
/**
 * timer 模板。**`OnCalendar` 是必需的，不是冗余。**
 *
 * 2026-09-05 实咬两次：只写 `OnBootSec`/`OnUnitActiveSec` 这种单调时钟的 timer，
 * 停掉再起之后会进 `active (elapsed)` 死态——`systemctl` 仍显示 active + enabled，
 * `NEXT` 却是 `n/a`，永不再触发，而且没有任何东西报警。`dao-agent-stall` 就是这么
 * 从 12:37 起无声停摆几小时的。挂一个墙钟点位，永远有下一次，这个死态就不存在。
 *
 * 这两个单元是**代码生成的**，不在 `host/machine/systemd/` 目录下，所以
 * `tests/timer-armed.test.js` 和 `tests/unit-privilege.test.js` 两道静态闸都扫不到它们——
 * 它们是这条判据的盲区，靠本函数自己守。改这里前先读那两个测试。
 *
 * @param calendar 墙钟点位。各单元错开分钟数，别都挂整点（整点是所有 timer 的默认落点）。
 */
function timer(desc, activeSec, calendar) {
  return `[Unit]\nDescription=${desc}\n\n[Timer]\nOnCalendar=${calendar}\nOnBootSec=3min\nOnUnitActiveSec=${activeSec}\nPersistent=true\n\n[Install]\nWantedBy=timers.target\n`;
}
export const INSTALL_FILES = () => ({
  '/etc/systemd/system/commander-act.service': unit('指挥官 act：scan→decide→执行（#800）', '/srv/projects/windsurf-dao/scripts/commander.mjs act'),
  // :11/20 —— 错开 dao-sync(:1/5)、dao-board-gc(:07)、dao-patrol(:23)
  '/etc/systemd/system/commander-act.timer': timer('指挥官 act 每 20 分钟', '20min', '*:11/20'),
  '/etc/systemd/system/commander-inventory.service': unit('指挥官盘点体检（#800）', '/srv/projects/windsurf-dao/scripts/commander.mjs inventory'),
  '/etc/systemd/system/commander-inventory.timer': timer('指挥官盘点每 6 小时', '6h', '*-*-* 00,06,12,18:41:00'),
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
  const shims = findPathShims();
  const retire = shims.length ? [`sudo rm -f ${shims.join(' ')}`, 'sudo systemctl daemon-reload'] : [];
  console.log(JSON.stringify({ dryRun, changed, plan: plan.map((p) => p.trim()), enable: enableCmds, shims, retire }, null, 2));
  console.error(plan.join('\n'));
  if (shims.length) {
    console.error(`  PATH 垫片还在 ${shims.length} 份（模板已自带 PATH，它可以退役了）：\n    ${retire.join('\n    ')}`);
  }
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
