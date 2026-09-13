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
import { isAbsolute, join, dirname } from 'node:path';

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

/**
 * 「这里是不是部署宿主」——决定宿主局部的检查该不该跑。
 *
 * **这不是「PATH 像不像本机」的问题**（2026-09-13 连试两种阈值都被 CI 咬回来：
 * 「一个目录都不存在」和「过半数不存在」——`/usr/bin`、`/usr/local/bin`、`/bin`
 * 在 CI runner 上**都在**，于是两种阈值都判成「是本机」，然后在这台上问
 * 「有没有装 grok CLI」，答案当然是没有 → 24 处红、`--all-tests` 退出 1。
 * 判例 memory `patch-stacking-is-two-strikes`：同一方案连错两次就换路。
 *
 * 换成**直接问身份**：部署宿主有几个只属于它的落点，拿它们当判据。
 * 这里选 `~/.mirasim/run`（mirasim 服务端的回环令牌目录）——
 * 它由 mirasim 服务在部署宿主上建，CI runner 上不存在，也不必依赖任何外部命令。
 *
 * 三态：`true` 是宿主 / `false` 不是 / `null` 判不了（无 home）。调用方按 null 走没查成。
 *
 * 为什么不用主机名：换机就失效，而「换机要改的东西越少越好」是本仓的既有口径。
 * 为什么不用「有没有装 pi」：那就是被检查的量本身，拿它当准入是自指。
 */
export function deploymentHostPresence({ homeDir = '', exists = existsSync, markers = null } = {}) {
  if (!homeDir) return { host: null, why: '拿不到 homeDir，判不了' };
  const MARKERS = Array.isArray(markers) ? markers : [
    join(homeDir, '.mirasim', 'run'),        // mirasim 服务端的回环令牌目录
    join(homeDir, '.dao', 'commander'),      // 指挥官落盘目录（部署宿主上由 commander 建）
  ];
  const hits = MARKERS.filter(p => { try { return exists(p); } catch { return false; } });
  if (hits.length > 0) return { host: true, markers: hits };
  return {
    host: false, markers: [], checked: MARKERS,
    why: `部署宿主的落点一个都不在（${MARKERS.slice(0, 2).join('、')}）——这台不是部署宿主`,
  };
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

/** 本机有没有这个可执行文件。absolute = 命令词本身带路径（/usr/bin/foo 或 ./foo）。
 *
 *  `searched` 回报「我在哪些目录里找过、这些目录本机在不在」——调用方要靠它分辨
 *  「模板写错了」（目录在、文件不在）和「这条 PATH 不是本机的」（目录就不在）。
 *  不认识这两种的调用方会像 2026-09-13 的 CI 那样，把后者说成前者。 */
export function resolvesOnPath(word, { pathValue, exists = existsSync, access = accessSync, stat = statSync } = {}) {
  const dirs = String(pathValue || '').split(':').filter(Boolean);
  const executable = (p) => {
    try { access(p, constants.X_OK); return stat(p).isFile(); } catch { return false; }
  };
  const dirExists = (d) => { try { return exists(d); } catch { return false; } };
  if (isAbsolute(word) || word.includes('/')) {
    const ok = executable(word);
    // 带路径的命令词：所在的**目录**在不在，决定这是「模板错」还是「这台机器没有」
    const dir = dirname(word);
    return { ok, where: ok ? word : null, searched: [{ dir, exists: dirExists(dir) }], anyDirExists: dirExists(dir) };
  }
  const searched = [];
  for (const dir of dirs) {
    const candidate = join(dir, word);
    if (executable(candidate)) return { ok: true, where: candidate, searched, anyDirExists: true };
    searched.push({ dir, exists: dirExists(dir) });
  }
  return { ok: false, where: null, searched, anyDirExists: searched.some(s => s.exists) };
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

  // 红 1：解析失败分两种，必须分开（2026-09-13 CI 实咬，run 34744690601）。
  //
  //   · **目录不在本机** → 这条 PATH 是别的机器的部署 PATH，我们没法在这台上验它 ⇒ `unknown`（没查成）
  //   · **目录在、文件不在** → 模板真写错了 ⇒ `red`
  //
  // 为什么不按「整条 PATH 属不属于本机」判（第一版就是这么写的，连改两次都没抓住 CI）：
  // `PATH` 里混着通用目录（`/usr/bin`、`/usr/local/bin`、`/bin`）和生产专属目录
  // （`/home/orca/.local/bin`）。CI runner 上通用目录**都在**，于是
  // 「一个都不存在」和「过半数不存在」两种阈值都命不中（实测 existing=3/5），照旧判红。
  // 逐目录判就没有这个问题：命令词解析失败时，先看**它该在的那个目录**在不在。
  //
  // 判据归属：目录在不在，是「这台机器有什么」；文件在不在，是「模板写对没有」。
  // 混在一起就会把前者说成后者——那正是这次 CI 红 24 处的成因。
  const broken = [];
  const excused = [];
  const unverifiable = [];   // 目录就不在本机 ⇒ 不是「模板错了」，是「本机验不了」
  const probe = (word) => resolvesOnPath(word, { pathValue, ...fs });
  for (const p of withLaunch) {
    // 两个字段都看：cli 是给人看的声明，launch 是真正执行的命令。两者指同一个二进制才算自洽，
    // 但这里只判「能不能解析」——不一致是另一条判据（本模块不越界）。
    for (const [field, value] of [['launch', p.launch], ['cli', p.cli]]) {
      const word = commandWord(value);
      if (!word) continue;
      const res = probe(word);
      if (res.ok) continue;
      const declared = OFF_PATH_BIN[bareName(word)];
      if (declared) {
        const abs = declared.startsWith('~') ? join(homeDir || '', declared.slice(1)) : declared;
        if (probe(abs).ok) {
          if (!excused.some(e => e.provider === p.name && e.field === field && e.word === word)) {
            excused.push({ provider: p.name, field, word, at: declared });
          }
          continue;
        }
        // 允许表的落点是**本模块自己维护的**绝对路径（OFF_PATH_BIN）。它不存在就是
        // 这张表写错了或落点被挪走了——红。**不许按「目录不在本机」放过**：
        // 那会让允许表变成「写错名字的免死金牌」，正是 ⑤ 号测试守着的东西。
        // 与裸名的区别：裸名问的是「这台机器有没有」，允许表问的是「我写的落点对不对」。
        broken.push({ provider: p.name, field, word, why: `在允许表里但落点不存在或不可执行：${declared}` });
        continue;
      }
      // 关键分流：**解析失败时，它该在的目录本机在不在**。
      //
      // 只对**裸名**分流。带路径的命令词（`/opt/bin/agent`）不走这条路——那是作者对
      // 「这条命令长什么样」的断言，写错了就是错，本模块照原样判（见 ⑦）。
      // 裸名则是在问「这台机器上有没有这个可执行文件」：目录根本不在 ⇒ 这条 PATH 属于别的机器
      // （CI runner 上取到仓内单元写的 /home/orca/... 就是这形状），没查成；
      // 目录在、文件不在 ⇒ 模板真写错了，红。
      const isBare = !(isAbsolute(word) || word.includes('/'));
      const missingDirs = (res.searched || []).filter(s => !s.exists).map(s => s.dir);
      if (isBare && !res.anyDirExists && missingDirs.length) {
        unverifiable.push({ provider: p.name, field, word, dirs: missingDirs });
        continue;
      }
      broken.push({ provider: p.name, field, word, why: '本机 PATH 上解析不到' });
    }
  }

  // detail 里必须说清「在哪个 PATH 下判的、这条 PATH 从哪来」——宿主局部判据的结论
  // 脱离它的 PATH 就没有意义，而红项要能一眼看出「是模板错了还是我这条 PATH 不对」。
  const where = `PATH=${pathValue.slice(0, 60)}…${pathSource ? `（来源：${pathSource}）` : ''}`;

  // 命中的命令词所在目录本机一个都不在 ⇒ 本机验不了这条模板（没查成）。
  // 与「扫完 0 条违规」分开：那是 ok，这是 unknown。
  if (broken.length === 0 && unverifiable.length > 0) {
    const dirsShown = [...new Set(unverifiable.flatMap(u => u.dirs))].slice(0, 3).join('、');
    return {
      state: 'unknown', checked: withLaunch.length, broken, excused, unverifiable,
      detail: `${unverifiable.length} 处命令词解析不到，但它们该在的目录本机就不存在（${dirsShown}）`
        + `——这条 PATH 是别的机器的部署 PATH，本机没法验`
        + `（没查成，不是「都对得上」也不是「都错了」）。${where}`,
    };
  }

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
