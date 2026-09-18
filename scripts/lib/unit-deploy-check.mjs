// dao-check ㊳：仓内 systemd 单元必须已经上机，撞点看活日历（issue #1408）。
//
// 病：#1226 把 dao-skills-heal-root.timer 从 *:06/5 改成 *:00/5，测试只读
// host/machine/systemd/，仓内文件一改就绿。合进 master 23 小时后机器上还是
// *:06/5，跟 dao-sync 的 *:1/5 展开成同一串分钟。server-check ⑳ 比的是
// 有效单元全文（含故意 drop-in），挂在没人跑的检查上，且被钉成永红。
//
// 本闸两问，都不含 drop-in 全文：
//   1. 仓内 fragment 的契约字段 vs /etc 那份 fragment（没装 / 装了旧的 → 红）
//   2. 活 heal-root 与活 dao-sync 的 OnCalendar 展开相交是否为空
// 读不到（没 systemd、权限、单元不在这台机器上）= 没查成，不得与「一致」同形。
//
// 上机不走「root 解释仓内可写脚本」（2026-09-05 堵过的提权路）：
// dao-sync 只 sudo -n /usr/local/sbin/dao-install-units，那份是 root 自己的副本，
// 并且只装与内钉 manifest 对得上的特权行（User/ExecStart 等）。

import { calendarOverlap } from './on-calendar.mjs';

export const HEAL_ROOT_TIMER = 'dao-skills-heal-root.timer';
export const SYNC_TIMER = 'dao-sync.timer';
export const UNIT_DIR_REL = 'host/machine/systemd';
export const LIVE_UNIT_DIR = '/etc/systemd/system';
export const INSTALL_HINT = 'sudo bash scripts/install-dao-sync.sh';

const CONTRACT_KEYS = ['OnCalendar', 'User', 'ExecStart', 'ReadWritePaths'];

function normNl(text) {
  return String(text ?? '').replace(/\r\n/g, '\n');
}

function contentLines(text) {
  return normNl(text).split('\n').filter((raw) => {
    const s = raw.trim();
    return s !== '' && !s.startsWith('#') && !s.startsWith(';');
  }).map((raw) => raw.replace(/\r$/, ''));
}

/** 从 Environment= 行抽出 KEY=VAL。一行多个赋值按空白切开，引号内空白保留。 */
export function parseEnvAssignments(rest) {
  const out = {};
  const s = String(rest ?? '');
  const parts = [];
  let cur = '';
  let q = null;
  for (const ch of s) {
    if (q) {
      if (ch === q) q = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      q = ch;
    } else if (/\s/.test(ch)) {
      if (cur) {
        parts.push(cur);
        cur = '';
      }
    } else {
      cur += ch;
    }
  }
  if (cur) parts.push(cur);
  for (const p of parts) {
    const i = p.indexOf('=');
    if (i <= 0) continue;
    out[p.slice(0, i)] = p.slice(i + 1);
  }
  return out;
}

/**
 * 契约字段：OnCalendar / User / ExecStart / ReadWritePaths 取最后一次；
 * Environment 按 key 合并（后写覆盖）。注释行不算。
 */
export function parseContract(text) {
  const env = {};
  const last = {
    OnCalendar: null,
    User: null,
    ExecStart: null,
    ReadWritePaths: null,
  };
  for (const line of contentLines(text)) {
    const kv = line.match(/^\s*([A-Za-z][A-Za-z0-9]*)=(.*)$/);
    if (!kv) continue;
    const key = kv[1];
    const val = kv[2].trim();
    if (key === 'Environment') {
      Object.assign(env, parseEnvAssignments(val));
    } else if (CONTRACT_KEYS.includes(key)) {
      last[key] = val;
    }
  }
  return { ...last, env };
}

/** 最后一次非注释 OnCalendar=。没有则 null。 */
export function parseOnCalendar(text) {
  return parseContract(text).OnCalendar;
}

function showVal(v) {
  return v == null || v === '' ? '(无)' : String(v);
}

/** 仓内 fragment vs 活 fragment 的契约差。空数组 = 契约一致（注释/TimeoutStartSec 不算）。 */
export function contractDiff(repoText, liveText) {
  const r = parseContract(repoText);
  const l = parseContract(liveText);
  const diffs = [];
  for (const key of CONTRACT_KEYS) {
    const rv = r[key];
    const lv = l[key];
    if (rv == null && lv == null) continue;
    if (rv !== lv) diffs.push({ key, repo: rv, live: lv });
  }
  const names = [...new Set([...Object.keys(r.env), ...Object.keys(l.env)])].sort();
  for (const name of names) {
    if (r.env[name] !== l.env[name]) {
      diffs.push({
        key: `Environment=${name}`,
        repo: r.env[name] ?? null,
        live: l.env[name] ?? null,
      });
    }
  }
  return diffs;
}

export function formatContractDiffs(diffs) {
  return (diffs || []).map((d) =>
    `仓内 ${d.key}=${showVal(d.repo)} ≠ 活单元 ${d.key}=${showVal(d.live)}`).join('；');
}

/**
 * pairs: {name, repo, live, unreadable}[]
 * live=null + unreadable=false → 这份没装。
 * 这台机器一个活单元都看不见 → unknown（没查成），不是「都一致」。
 */
export function classifyFragmentDrift(pairs) {
  if (!Array.isArray(pairs)) {
    return { state: 'unknown', detail: '单元清单不是数组——没查成，不是「一致」', diffs: [], missing: [], scanned: 0 };
  }
  if (pairs.length === 0) {
    return { state: 'unknown', detail: '一个单元都没扫到——没查成，不是「一致」', diffs: [], missing: [], scanned: 0 };
  }

  const unread = [];
  const missing = [];
  const drifted = [];
  let livePresent = 0;
  for (const p of pairs) {
    const name = p && p.name != null ? String(p.name) : '(无名)';
    if (!p || p.unreadable || p.repo == null) {
      unread.push(name);
      continue;
    }
    if (p.live == null) {
      missing.push(name);
      continue;
    }
    livePresent += 1;
    const diffs = contractDiff(p.repo, p.live);
    if (diffs.length) drifted.push({ name, diffs });
  }

  if (livePresent === 0 && drifted.length === 0) {
    const why = unread.length === pairs.length
      ? '活单元读不到——没查成，不是「一致」'
      : '机器上一个仓内单元都没有——没查成，不是「一致」';
    return { state: 'unknown', detail: why, diffs: drifted, missing, scanned: pairs.length, unread };
  }

  if (drifted.length || missing.length) {
    const bits = drifted.map((d) => `${d.name}：${formatContractDiffs(d.diffs)}`);
    if (missing.length) bits.push(`仓里有机器上没有：${missing.join('、')}`);
    return {
      state: 'red',
      detail: `${bits.join('。')}。改了仓不等于装了机器。修：${INSTALL_HINT}`,
      diffs: drifted,
      missing,
      scanned: pairs.length,
    };
  }
  if (unread.length) {
    return {
      state: 'unknown',
      detail: `${unread.length} 个单元没读成：${unread.join('、')}——没查成，不是「一致」`,
      diffs: [],
      missing: [],
      scanned: pairs.length,
      unread,
    };
  }
  return {
    state: 'ok',
    detail: `${livePresent} 个单元契约字段仓里和机器上一致`,
    diffs: [],
    missing: [],
    scanned: livePresent,
  };
}

export function collectFragmentPairs({ repoDir, liveDir, readdir, readFile } = {}) {
  if (typeof readdir !== 'function' || typeof readFile !== 'function') {
    const err = new Error('没给 readdir/readFile 探头（没查成）');
    err.code = 'NO_PROBE';
    throw err;
  }
  const names = readdir(repoDir);
  if (!Array.isArray(names)) {
    const err = new Error('列仓内单元目录没给出名单（没查成）');
    err.code = 'NO_LIST';
    throw err;
  }
  const units = names.filter((n) => typeof n === 'string' && (n.endsWith('.timer') || n.endsWith('.service'))).sort();
  const slash = (dir, name) => `${String(dir).replace(/\/+$/, '')}/${name}`;
  return units.map((name) => {
    let repo = null;
    try {
      const t = readFile(slash(repoDir, name));
      repo = typeof t === 'string' ? t : null;
    } catch {
      repo = null;
    }
    let live = null;
    let unreadable = false;
    try {
      const t = readFile(slash(liveDir, name));
      live = typeof t === 'string' ? t : null;
      if (live == null) unreadable = true;
    } catch (e) {
      const code = e && e.code;
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        live = null;
        unreadable = false;
      } else {
        live = null;
        unreadable = true;
      }
    }
    return { name, repo, live, unreadable };
  });
}

export function inspectFragmentDirs({ repoDir, liveDir, readdir, readFile } = {}) {
  try {
    const pairs = collectFragmentPairs({ repoDir, liveDir, readdir, readFile });
    return classifyFragmentDrift(pairs);
  } catch (e) {
    return {
      state: 'unknown',
      detail: `活单元目录读不了（${String(e && e.message ? e.message : e).slice(0, 160)}）——没查成，不是「一致」`,
      diffs: [],
      missing: [],
      scanned: 0,
    };
  }
}

/**
 * 活 heal-root 与活 dao-sync 的 OnCalendar 展开。
 * 任一条读不到 / 认不出 → unknown（没查成），不许当不撞。
 */
export function classifyHealSyncOverlap({ healCal, syncCal } = {}) {
  const heal = healCal == null ? '' : String(healCal).trim();
  const sync = syncCal == null ? '' : String(syncCal).trim();
  if (!heal || !sync) {
    return { state: 'unknown', detail: '活 OnCalendar 读不到——没查成，不是「不撞」', hits: [] };
  }
  const ov = calendarOverlap(heal, sync);
  if (!ov.ok) {
    return {
      state: 'unknown',
      detail: `活日历展开失败：${ov.reason}——没查成，不是「不撞」`,
      hits: [],
    };
  }
  if (ov.hits.length) {
    return {
      state: 'red',
      detail: `活单元 ${HEAL_ROOT_TIMER}（${heal}）撞上 ${SYNC_TIMER}（${sync}）：${ov.hits.slice(0, 8).join(',')}。判据取活单元，不是仓内字符串。`,
      hits: ov.hits,
    };
  }
  return {
    state: 'ok',
    detail: `活单元 ${HEAL_ROOT_TIMER} ${heal} 与 ${SYNC_TIMER} ${sync} 展开不相交`,
    hits: [],
  };
}

const FIX_KINDS = ['red', 'ok', 'empty'];

/**
 * 夹具判别力：red 必须点出「仓内 … ≠ 活单元 …」；ok 必须绿且扫到单元；
 * empty 必须没查成。缺探头 / 缺目录 / 种类不够 → unscanned。
 */
export function inspectUnitDeployFixtures({
  rootRel = 'tests/fixtures/unit-deploy',
  exists,
  readdir,
  readFile,
} = {}) {
  if (typeof exists !== 'function' || typeof readdir !== 'function' || typeof readFile !== 'function') {
    return { ok: false, unscanned: true, error: '没给 exists/readdir/readFile 探头（没查成）' };
  }
  if (!exists(rootRel)) {
    return { ok: false, unscanned: true, error: `样本目录不在：${rootRel}` };
  }
  const kinds = { red: 0, ok: 0, empty: 0 };
  const problems = [];
  for (const kind of FIX_KINDS) {
    const dir = `${rootRel}/${kind}`;
    if (!exists(dir)) {
      problems.push(`缺 ${kind}/`);
      continue;
    }
    const r = inspectFragmentDirs({
      repoDir: `${dir}/repo`,
      liveDir: `${dir}/live`,
      readdir,
      readFile,
    });
    if (kind === 'empty') {
      if (r.state !== 'unknown') {
        problems.push(`empty/ 应没查成但判成 state=${r.state}`);
      } else kinds.empty += 1;
    } else if (kind === 'red') {
      if (r.state !== 'red') {
        problems.push(`red/ 自称该红但判成 state=${r.state} ${r.detail || ''}`);
      } else if (!/仓内 .+=.+ ≠ 活单元 .+/.test(r.detail || '')) {
        problems.push(`red/ 没点出「仓内 X ≠ 活单元 Y」：${r.detail}`);
      } else kinds.red += 1;
    } else if (kind === 'ok') {
      if (r.state !== 'ok') {
        problems.push(`ok/ 自称该绿但判成 state=${r.state} ${r.detail || ''}`);
      } else if (!r.scanned) {
        problems.push('ok/ 扫了 0 个——和 empty 分不开');
      } else kinds.ok += 1;
    }
  }
  if (kinds.red === 0 || kinds.ok === 0 || kinds.empty === 0) {
    return {
      ok: false,
      unscanned: true,
      error: `样本种类不够 red=${kinds.red} ok=${kinds.ok} empty=${kinds.empty}`,
      kinds,
      problems,
    };
  }
  if (problems.length) return { ok: false, unscanned: false, error: problems[0], kinds, problems };
  return { ok: true, unscanned: false, kinds };
}
