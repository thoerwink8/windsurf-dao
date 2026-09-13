// scripts/lib/launch-binary.mjs —— 启动模板闸：`launch` / `cli` 里的命令词本机解析得了吗
//
// 来历（2026-09-13 用户「对不上的要修」实咬）：
// `docs/model-routing.toml` 的 `[providers.commandcode]` 从 2026-08-16 起写着
// `cli = "command-code"` / `launch = "command-code -m {model} --skip-onboarding --yolo"`。
// npm 包 `command-code` 的 `bin` 里确实声明了 `cmd`/`cmdc`/`command-code`/`commandcode`
// 四个入口，但 npm **只建出三个符号链接**，`command-code` 这个不带缩写的名字本机没有。
// 于是一个月的窗口里，这条腿的启动串是一跑就 `command not found` 的死命令。
//
// 为什么没人发现：① `commandcode` 不在 `docs/model-routing.json` 任何职责顺位里，
// 从没被派到；② `launch.mjs` 把 `launch` 原样当命令执行，不做解析检查；
// ③ dao-check 的 provider 模板项只验「launch 非空 + start 合法」——**从不验命令能不能解析**。
// 三条合起来：写错的命令词没有第二个地方会发现（判例 hand-typed-constant-will-be-wrong 的又一例）。
//
// 判据轴：**不改写被检查对象自己的解析逻辑**（项目规矩），也不真去 spawn——
// 只看命令的第一个词、按本机 PATH 与显式路径判断「有没有这个可执行文件」。
// 这是**宿主局部的**检查：放在别的机器上跑，PATH 不同结论就不同，所以判定结果里必须
// 带上「在哪个 PATH 下判的」，并且查不出二进制时要能跟「根本没扫到样本」分开。

import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

/** `bin = "..."` 显式落点：明知它不在 PATH 上、但机器上有这个文件。
 *  这是**允许表**不是忽略表——每条都必须给出真实存在、可执行的那个路径，
 *  路径不存在照样红（否则它就变成了「写错名字的免死金牌」）。 */
export const OFF_PATH_BIN = Object.freeze({
  // cursor-agent 官方装法是把版本目录放 ~/.local/share，靠 `current` 符号链接暴露；
  // 本机没有 current，且 acp-runtime.mjs 自己按版本目录挑（不看 PATH）。
  'cursor-agent': '~/.local/share/cursor-agent/versions/2026.08.31-4057e58/cursor-agent',
});

/**
 * 判定该按哪条 PATH。
 *
 * **这条判据的锚点是「部署环境」，不是「跑检查的那个 shell」**（2026-09-13 实咬）。
 * 第一版直接吃 `process.env.PATH`，于是同一个仓在两处给相反结论：
 *   · 手动 `node scripts/dao-check.mjs`（sudo/裸 shell）→ PATH 是 `/usr/local/sbin:…:/bin`，
 *     **不含 `~/.local/bin`** → reclaude / devin 判「本机解析不到」→ 红；
 *   · 真实服务 `commander-act.service` → PATH 显式写着 `/home/orca/.local/bin:…` → 解析得到。
 * 也就是那条红是**探针自己的 PATH 造成的假失败**，与模板对不对无关
 * （判例 memory `verify-systemd-via-systemctl`：手搓 shell 复现会因 PATH/生命周期不同而假失败）。
 *
 * 所以按这个顺序取，取到哪条就把哪条写进 detail：
 *   ① 调用方显式给的 `DAO_DEPLOY_PATH`（测试与特殊现场用）；
 *   ② **仓内部署单元** `host/machine/systemd/*.service` 里 `Environment=PATH=…` 的众数
 *      —— 真相源在仓里，不硬编码进本模块，换机时它跟着单元文件一起改；
 *   ③ 退回本进程的 PATH（并标明来源，让红项一眼可辨「是模板错还是我这条 PATH 不对」）。
 *
 * **但「目标部署 PATH」不等于「本机能验证的文件系统」**（2026-09-13 审官在 PR #1213 上抓的红 1）。
 * 取到 ② 之后要在**本机**的 fs 上找那些二进制；CI runner 上 `/home/orca/.local/bin` 根本不存在，
 * 于是 24 处命令词齐刷刷判「解析不到」、`dao-check --all-tests` 稳定退出 1——
 * 那不是模板的 24 个错误，是**检查环境被混用了**。所以 `classifyLaunchBinaries` 必须能分辨：
 *
 *   · 部署 PATH 的**目录本机一个都不存在** → `unknown`（没查成，不是「都对得上」也不是「都错了」）
 *   · 目录在、命令词解析不到 → `red`（这才是真的模板错）
 *   · 目录在、命令词都在 → `ok`
 *
 * 这条区分正是项目规矩里那句「输出必须能区分『扫完查出 0 条』和『这次没扫到任何样本』」。
 *
 * @param {object} [env]  取 ① 用
 * @param {object} [io]   { readdir, readFile } 注入点，测试用
 * @param {string} [unitDir] ② 的扫描目录
 */
export const DEPLOY_PATH_ENV = 'DAO_DEPLOY_PATH';
export const DEPLOY_UNIT_DIR = 'host/machine/systemd';

/** 一条 PATH 里的目录，本机存在几个。用来判「这条 PATH 是不是属于这台机器」。 */
export function countExistingDirs(pathValue, { exists = existsSync } = {}) {
  const dirs = String(pathValue || '').split(':').filter(Boolean);
  let n = 0;
  for (const d of dirs) { try { if (exists(d)) n++; } catch { /* 判不了当成不在 */ } }
  return { total: dirs.length, existing: n };
}

/** 从一份 systemd 单元文本里取 `Environment=PATH=…` 的值。取不到返回 null（不猜）。 */
export function pathFromUnitText(text) {
  const m = /^\s*Environment\s*=\s*"?PATH=([^"\n]+)"?\s*$/m.exec(String(text || ''));
  return m ? m[1].trim() : null;
}

/** 仓内单元文件里的 PATH 众数（多份单元写同一条是常态；众数比「第一份」稳，不靠目录序）。 */
export function deployPathFromUnits(unitDir, { readdir, readFile } = {}) {
  if (!unitDir || typeof readdir !== 'function' || typeof readFile !== 'function') return null;
  let names;
  try { names = readdir(unitDir).filter(n => String(n).endsWith('.service')); } catch { return null; }
  const tally = new Map();
  for (const n of names) {
    let text;
    try { text = readFile(join(unitDir, n)); } catch { continue; }
    const p = pathFromUnitText(text);
    if (p) tally.set(p, (tally.get(p) || 0) + 1);
  }
  let best = null;
  for (const [p, n] of tally) if (!best || n > best[1] || (n === best[1] && p < best[0])) best = [p, n];
  return best ? best[0] : null;
}

export function resolveProbePath(env = process.env, { unitDir = null, io = {} } = {}) {
  const deploy = String(env?.[DEPLOY_PATH_ENV] || '').trim();
  if (deploy) return { pathValue: deploy, source: `env ${DEPLOY_PATH_ENV}` };
  const fromUnits = deployPathFromUnits(unitDir, io);
  if (fromUnits) return { pathValue: fromUnits, source: '仓内部署单元' };
  return { pathValue: String(env?.PATH || ''), source: '本进程 PATH（仓内部署单元没读到）' };
}

/** 从一条 launch 命令里取「命令词」。取第一个非 `VAR=value` 的 token，去掉引号。
 *  与 dispatch/launch.mjs 的 `materializeLaunch` 同口径：先剥环境变量赋值前缀。
 *  **路径要留着**（`/opt/bin/agent` / `./x`）——剥成裸名会把它当 PATH 上的名字去找，
 *  于是带路径的写错也判成对（写这条时实测撞到）。裸名才该走 PATH。 */
export function commandWord(command) {
  const src = String(command || '').trim();
  if (!src) return null;
  for (const raw of src.split(/\s+/)) {
    const tok = raw.replace(/^["']|["']$/g, '');
    if (!tok) continue;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tok)) continue;   // DAO_TASK=… 这类前缀
    return tok;
  }
  return null;
}

/** 命令词在 PATH 上找时的裸名（带路径的原样返回，调用方按绝对路径判）。 */
const bareName = (word) => (word.includes('/') ? word : word.split('/').pop());

/** 本机有没有这个可执行文件。absolute = 命令词本身带路径（/usr/bin/foo 或 ./foo）。 */
export function resolvesOnPath(word, { pathValue, exists = existsSync, access = accessSync, stat = statSync } = {}) {
  const dirs = String(pathValue || '').split(':').filter(Boolean);
  const executable = (p) => {
    try { access(p, constants.X_OK); return stat(p).isFile(); } catch { return false; }
  };
  if (isAbsolute(word) || word.includes('/')) {
    return { ok: executable(word), where: word };
  }
  for (const dir of dirs) {
    const candidate = join(dir, word);
    if (executable(candidate)) return { ok: true, where: candidate };
  }
  return { ok: false, where: null };
}

/**
 * 判定一组 provider 的启动模板。
 *
 * @param {object} input
 * @param {Array}  input.providers  [{name, cli, launch}] —— 只取有 launch 的
 * @param {string} input.pathValue 判定用的 PATH（**必须显式传**，不许在函数里摸 process.env：
 *                                 否则测试只能测到跑测试那台机器的 PATH，判据跟着机器漂）。
 *                                 现场用 `resolveProbePath()` 取——它优先部署单元的 PATH。
 * @param {string} [input.homeDir] OFF_PATH_BIN 里 `~` 的展开点
 * @param {string} [input.pathSource] 这条 PATH 从哪来（'deploy' / 'process'），进 detail 好定位
 * @param {object} [input.fs]      注入点（exists/access/stat），测试用
 * @returns {{state:'ok'|'red'|'unknown', detail:string, checked:number, broken:object[], excused:object[]}}
 */
export function classifyLaunchBinaries({ providers, pathValue, homeDir = '', pathSource = '', fs = {} } = {}) {
  if (!Array.isArray(providers)) {
    return { state: 'unknown', detail: '拿不到 providers（没查成，不是「都对得上」）', checked: 0, broken: [], excused: [] };
  }
  const withLaunch = providers.filter((p) => p && String(p.launch || '').trim() !== '');
  if (withLaunch.length === 0) {
    return { state: 'unknown', detail: '没扫到任何带 launch 的 provider（没查成，不是「都对得上」）', checked: 0, broken: [], excused: [] };
  }
  if (!pathValue) {
    return { state: 'unknown', detail: 'PATH 为空（没查成，不是「都对得上」）', checked: 0, broken: [], excused: [] };
  }

  // 红 1：先问「这条 PATH 是不是属于这台机器」。一个目录都不存在 ⇒ 我们拿的是**别的机器**的
  // 部署 PATH（CI runner 上取到仓内单元写的 /home/orca/.local/bin 就是这种形状）。
  // 那时判红是把「检查环境不对」说成「模板有 24 个错」——按项目规矩，没扫到任何样本
  // 必须与「扫完查出 0 条」分得开，所以这里给 unknown。
  const dirs = countExistingDirs(pathValue, fs);
  if (dirs.total > 0 && dirs.existing === 0) {
    return {
      state: 'unknown', checked: 0, broken: [], excused: [],
      detail: `这条 PATH 里的 ${dirs.total} 个目录在本机一个都不存在——拿的是别的机器的部署 PATH，`
        + `本机没法验它（没查成，不是「都对得上」也不是「都错了」）。PATH=${pathValue.slice(0, 60)}…`
        + `${pathSource ? `（来源：${pathSource}）` : ''}`,
    };
  }

  const broken = [];
  const excused = [];
  const probe = (word) => resolvesOnPath(word, { pathValue, ...fs });
  for (const p of withLaunch) {
    // 两个字段都看：cli 是给人看的声明，launch 是真正执行的命令。两者指同一个二进制才算自洽，
    // 但这里只判「能不能解析」——不一致是另一条判据（本模块不越界）。
    for (const [field, value] of [['launch', p.launch], ['cli', p.cli]]) {
      const word = commandWord(value);
      if (!word) continue;
      if (probe(word).ok) continue;
      const declared = OFF_PATH_BIN[bareName(word)];
      if (declared) {
        const abs = declared.startsWith('~') ? join(homeDir || '', declared.slice(1)) : declared;
        if (probe(abs).ok) {
          if (!excused.some(e => e.provider === p.name && e.field === field && e.word === word)) {
            excused.push({ provider: p.name, field, word, at: declared });
          }
          continue;
        }
        broken.push({ provider: p.name, field, word, why: `在允许表里但落点不存在或不可执行：${declared}` });
        continue;
      }
      broken.push({ provider: p.name, field, word, why: '本机 PATH 上解析不到' });
    }
  }

  // detail 里必须说清「在哪个 PATH 下判的、这条 PATH 从哪来」——宿主局部判据的结论
  // 脱离它的 PATH 就没有意义，而红项要能一眼看出「是模板错了还是我这条 PATH 不对」。
  const where = `PATH=${pathValue.slice(0, 60)}…${pathSource ? `（来源：${pathSource}）` : ''}`;

  if (broken.length === 0) {
    const words = [...new Set(excused.map(e => e.word))];
    const note = words.length ? `；${words.join('、')} 走显式落点` : '';
    return { state: 'ok', checked: withLaunch.length, broken, excused, detail: `扫了 ${withLaunch.length} 个带 launch 的 provider，命令词本机都解析得出${note}（${where}）` };
  }
  const shown = broken.slice(0, 4).map(b => `${b.provider}.${b.field}=${b.word}（${b.why}）`).join('；');
  return {
    state: 'red', checked: withLaunch.length, broken, excused,
    detail: `${broken.length} 处命令词本机解析不到 —— ${shown}${broken.length > 4 ? ' …' : ''}（${where}）`,
  };
}
