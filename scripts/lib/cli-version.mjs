// scripts/lib/cli-version.mjs —— 载体（agent CLI）版本漂移检测
//
// 用户 2026-09-13 拍板：**只做「版本变了要说」，不钉死版本**。
//
// 为什么是可见性而不是钉版本（调研结论，见 PR 正文）：这套系统的失败模式不是「不可复现」，
// 是「坏了没人知道」。同一天里撞到三个同族实例：command-code 名字写错一个月没人发现、
// cursor 升级装一半没人发现、执行目录过期没人刷。钉版本要付的代价（多一个会过期的常量、
// 多一个能把整条链拒死的地方）在 2026-09-10 已经付过一次——`PINNED_VERSION = '0.0.282'`
// 手打值跟不上升级，96 条派工被拒、11 张单卡死、且告警同时哑掉。
//
// 而升级引起的回归**用常规测试看不见**：一项纵向研究固定底层 LLM 只换脚手架版本，
// 跑 35 个连续发版，解决率 23–39% 无统计显著上升趋势，token 消耗近乎翻倍，
// 且这些回归全部通过了常规单测与集成测试（它们测代码正确性，不测 agent 行为）。
// 所以本模块的唯一产出是「**哪个载体从什么变成了什么，什么时候**」——留着当下次
// 「某条腿突然不好使」时的第一条线索，不进任何拦截路径。
//
// 判据轴：**不做语义化版本比较**。AI CLI 的 minor 升级能改输出行为、延迟、token 成本，
// 行业口径是「当 major 对待」。所以只判「字符串变没变」，不判「升还是降」——
// 降级同样要报（可能是回滚，也可能装坏了）。

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import os from 'node:os';
import { OFF_PATH_BIN, resolvesOnPath } from './launch-binary.mjs';

/** 载体的版本读法。key = 二进制名（与 launch-binary.mjs 的口径一致：解析得到什么名字就记什么）。
 *  `args` 是拿版本的参数——**devin 这类子命令形态与 `--version` 不同，必须分开配**，
 *  不是每个 CLI 都认 `--version`（写之前实测过五个，结论见 PR 正文那张耗时表）。 */
export const VERSION_PROBES = Object.freeze({
  pi: { args: ['--version'] },
  grok: { args: ['--version'] },
  codex: { args: ['--version'] },
  devin: { args: ['version'] },
  cmdc: { args: ['--version'] },
  'cursor-agent': { args: ['--version'] },
});

/** 读版本要用哪个可执行文件——**复用 launch-binary.mjs 的解析，不另立一份**。
 *  两处各写各的解析就是「同一规则两个实现」，改一处漏一处是这类系统的老坑；
 *  而且 cursor-agent 本来就不在 PATH（走版本目录），拿裸名去 spawn 会 ENOENT——
 *  这正是第一次写的版本犯的错（2026-09-13 实测：六个载体里它是唯一读不成的）。 */
export function resolveProbeBinary(bin, { pathValue = process.env.PATH || '', homeDir = os.homedir(), fs = {} } = {}) {
  const onPath = resolvesOnPath(bin, { pathValue, ...fs });
  if (onPath.ok) return { command: onPath.where, via: 'path' };
  const declared = OFF_PATH_BIN[bin];
  if (declared) {
    const abs = declared.startsWith('~') ? join(homeDir, declared.slice(1)) : declared;
    if (resolvesOnPath(abs, { pathValue, ...fs }).ok) return { command: abs, via: 'off-path' };
  }
  return { command: null, via: 'unresolved' };
}

/** 从一条 `--version` 输出里抠出版本串。取第一行第一个像版本号的 token；
 *  认不出就返回整行（宁可报个毛坯也不许静默丢——「没读出版本」和「版本没变」是两回事）。 */
export function parseVersionLine(raw) {
  const first = String(raw || '').split(/\r?\n/).map(s => s.trim()).find(Boolean);
  if (!first) return null;
  // 尾部的 `-4057e58` / `+build.7` 要一起收：那是构建标识，两个不同构建的版本号可能相同，
  // 光比 `2026.08.31` 会把「换了构建」当成「没变」（cursor-agent 的版本串就是这个形态）。
  const m = first.match(/\bv?(\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z][0-9A-Za-z.]*)*)/);
  return m ? m[1] : first.slice(0, 80);
}

/**
 * 比对「这轮读到的版本」与「上次记的版本」。
 *
 * @param {object} input
 * @param {object} input.current  { <bin>: { version, readAt, error? } } 本轮实测
 * @param {object} input.previous { <bin>: { version, firstSeenAt, lastChangedAt } } 上次记录
 * @returns {{changed:object[], appeared:object[], gone:object[], unreadable:object[], unchanged:number}}
 */
export function classifyVersionDrift({ current = {}, previous = {} } = {}) {
  const changed = [], appeared = [], gone = [], unreadable = [];
  for (const [bin, now] of Object.entries(current || {})) {
    const version = now && now.version ? String(now.version) : null;
    if (!version) { unreadable.push({ bin, error: (now && now.error) || '读不出' }); continue; }
    const was = previous && previous[bin] ? previous[bin].version : null;
    if (!was) { appeared.push({ bin, version }); continue; }
    if (String(was) !== version) changed.push({ bin, was: String(was), now: version });
  }
  // 上次记着、这次没读到：可能是卸载了，也可能这次探测失败——两种都不许静默吞掉。
  for (const bin of Object.keys(previous || {})) {
    if (!current || !(bin in current)) gone.push({ bin, was: previous[bin].version });
  }
  const total = Object.keys(current || {}).length;
  return { changed, appeared, gone, unreadable, unchanged: total - changed.length - appeared.length - unreadable.length };
}

/** 落盘前的状态合并：变了才更新 lastChangedAt，没变保留原值。
 *  这样「这个版本是什么时候上的」永远答得出来，而不用去翻日志。 */
export function mergeVersionState({ current = {}, previous = {}, now = new Date().toISOString() } = {}) {
  const out = {};
  for (const [bin, rec] of Object.entries(current || {})) {
    if (!rec || !rec.version) continue;
    const was = previous && previous[bin];
    const same = was && String(was.version) === String(rec.version);
    out[bin] = {
      version: String(rec.version),
      firstSeenAt: (was && was.firstSeenAt) || now,
      lastChangedAt: same ? (was.lastChangedAt || now) : now,
      lastCheckedAt: now,
    };
  }
  return out;
}

/** 漂移的一行人类可读摘要。空数组 → 空串（调用方据此闭嘴，不要吐空标题）。 */
export function renderDrift(drift) {
  if (!drift) return '';
  const parts = [];
  const fmt = (x) => `${x.bin} ${x.was} → ${x.now}`;
  if (drift.changed.length) parts.push(`变了：${drift.changed.map(fmt).join('；')}`);
  if (drift.appeared.length) parts.push(`新出现：${drift.appeared.map(x => x.bin).join('、')}`);
  if (drift.gone.length) parts.push(`不见了：${drift.gone.map(x => x.bin).join('、')}`);
  if (drift.unreadable.length) parts.push(`没读成：${drift.unreadable.map(x => `${x.bin}(${x.error})`).join('、')}`);
  return parts.join('｜');
}

export function statePath({ home = os.homedir(), env = process.env } = {}) {
  return env.DAO_CLI_VERSIONS || join(home, '.dao', 'cli-versions.json');
}

/** 读上次记的版本表。文件不在 / 坏了 → {}（当「还没记过」处理，别当「都没变」）。 */
export function loadVersionState({ home = os.homedir(), env = process.env, read = readFileSync, exists = existsSync } = {}) {
  const path = statePath({ home, env });
  if (!exists(path)) return { present: false, versions: {}, path };
  try {
    const doc = JSON.parse(read(path, 'utf8'));
    return { present: true, versions: doc.versions || {}, updatedAt: doc.updatedAt || null, path };
  } catch {
    // 坏文件按「没记过」处理：静默吞掉会让人以为版本一直没变（本模块最要避免的失败模式）。
    return { present: false, corrupt: true, versions: {}, path };
  }
}

export function saveVersionState({ versions, home = os.homedir(), env = process.env, now = new Date().toISOString(), write = writeFileSync, mkdir = mkdirSync, rename = renameSync } = {}) {
  const path = statePath({ home, env });
  mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  write(tmp, JSON.stringify({ schemaVersion: 1, updatedAt: now, versions }, null, 2) + '\n');
  rename(tmp, path);   // 原子：读侧与写侧并发时不看到半截文件
  return path;
}
