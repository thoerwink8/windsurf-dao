// 换机接线自检（onboard.mjs 与 SessionStart 哨兵共用的判据层，2026-08-31）。
//
// 查的是「git pull 带不来的三处家目录接线」（NEW-MACHINE §3/§10/§11）：
//   ① ~/.claude/CLAUDE.md 与真相源 docs/global-CLAUDE.md 的漂移（全局约定没有下发机制）
//   ② ~/.claude/skills 的链接可用性。现行部署形态是**真目录 + 逐个 skill 链接**
//      （NEW-MACHINE §11 / memory dao-claude-migration），整目录链接也认——判据以「dispatch
//      这一课解析得到 SKILL.md」为探针，不钉死形态；指向别的 checkout 只要是活的 skills 树
//      也算绿（多 clone 常态，worktree 会话不许每轮报噪音）。
//   ③ 本项目 memory 链接（复用 dao-memory-link-check 的判据，不重写）。linked worktree
//      （.git 是文件）没有自己的 memory 目录是常态，不报；主 clone 上缺才是「换机没接」。
//   ④ ~/.claude.json 里 `npx ...@latest` 型 MCP 服务器——每开一个会话都现场查 registry，
//      2026-09-01 实测三个这样的服务器让冷启动多花约 19 秒（钉到本地后全部握手 3.5 秒）。
//      只报不修：那是用户自己的文件，改法走 `claude mcp add/remove`（宿主 CLI），
//      手改会被运行实例的内存态覆写（memory evolution-live-settings-volatile）。
//      项目级 mcpServers 一并看（claude mcp add 默认落项目域）；uvx 型再看本机有没有
//      uv 托管 Python——没有就不是慢而是握手必失败，两种话术要分开。
// 凭据（~/.dao/apps 等 C 类）只报缺失，永远不碰——修复动作不进任何自动化。
//
// 与 2026-08-31 守卫归零的关系（docs/decisions/2026-08-31-local-guards-retire-with-server.md）：
// 删掉的是「拉常驻进程守派工闭环」；本检查是纯本地 stat/hash、不起进程、不打网络、
// 绿则零输出——守的是配置完整性，这是全局约定「察觉不到违反的规则要配自动检查」点名的那类。
// 单独成文件是为了 tests/onboard.test.js 能拿假 HOME 造违规样本验判别力。
//
// 状态形（沿用仓里检查器的铁律）：
//   problems  —— 查成了且有问题（每条带 id，onboard.mjs 按 id 决定修法）
//   unscanned —— 没查成（读不了/真相源不在），与「查过没事」不同形

import { lstatSync, realpathSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkMemoryLink, defaultHome } from './dao-memory-link-check.mjs';

export function repoRootOfThisFile() {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

const norm = (s) => String(s ?? '').replace(/\r\n/g, '\n');

/** onboard.mjs 修不了、只能报的 id。一张表两处用（哨兵那行 + onboard 的退出判定），
 *  别各写各的：一边算修不了、另一边还让它把退出码染红，就成了永远红的报警。 */
export const ONBOARD_REPORT_ONLY = new Set(['creds-missing', 'mcp-slow-boot', 'statusline-dangling', 'pi-wrong-package']);

/** ① 全局约定漂移。真相源读不到 = 没查成（不是绿）。 */
export function checkGlobalClaude({ root, home }) {
  const truthPath = join(root, 'docs', 'global-CLAUDE.md');
  let truth;
  try { truth = readFileSync(truthPath, 'utf8'); }
  catch { return { unscanned: `真相源读不到：${truthPath}` }; }
  const livePath = join(home, '.claude', 'CLAUDE.md');
  if (!existsSync(livePath)) return { problem: { id: 'global-missing', msg: '~/.claude/CLAUDE.md 不在（全局约定没放）' } };
  let live;
  try { live = readFileSync(livePath, 'utf8'); }
  catch (e) { return { unscanned: `本机全局约定读不了：${e.code || e.message}` }; }
  if (norm(truth) !== norm(live)) return { problem: { id: 'global-drift', msg: '~/.claude/CLAUDE.md 与 docs/global-CLAUDE.md 漂移' } };
  return {};
}

/** ② skills 可用性。探针 = dispatch/SKILL.md 能解析到（不钉死整目录/逐个两种形态）。
 *  可修 id：skills-missing（目录不在）/ skills-partial（目录在但缺链接）/ skills-dangling（链接悬空）。
 *  只报不修：skills-not-link（dispatch 是拷贝的真目录，会过期，需人工并回）、
 *            skills-elsewhere（整目录链接指到的地方不是 skills 树）。 */
export function checkSkillsLink({ root, home, dir = '.claude' }) {
  const linkPath = join(home, dir, 'skills');
  let st;
  try { st = lstatSync(linkPath); }
  catch { return { problem: { id: 'skills-missing', msg: `~/${dir}/skills 不在（skill 全不可用）` } }; }

  if (st.isSymbolicLink()) {
    let real;
    try { real = realpathSync(linkPath); }
    catch { return { problem: { id: 'skills-dangling', msg: `~/${dir}/skills 整目录链接悬空` } }; }
    if (existsSync(join(real, 'dispatch', 'SKILL.md'))) return {};
    return { problem: { id: 'skills-elsewhere', msg: `~/${dir}/skills 指向 ${real}，那里不是 skills 树——手动重链` } };
  }

  // 真目录 = 逐个链接形态（现行部署）
  let ds;
  try { ds = lstatSync(join(linkPath, 'dispatch')); }
  catch { return { problem: { id: 'skills-partial', msg: `~/${dir}/skills 目录在但缺 dispatch 等链接（逐个链接不全）` } }; }
  if (ds.isSymbolicLink()) {
    if (existsSync(join(linkPath, 'dispatch', 'SKILL.md'))) return {};
    return { problem: { id: 'skills-dangling', msg: `~/${dir}/skills/dispatch 链接悬空` } };
  }
  return { problem: { id: 'skills-not-link', msg: `~/${dir}/skills/dispatch 是拷贝的真目录——会过期，人工并回后重链` } };
}

/** 三项合一。home 可注入（测试造假 HOME）。 */
export function checkOnboard({ root = repoRootOfThisFile(), home = defaultHome() } = {}) {
  const problems = [];
  const unscanned = [];
  const take = (r) => { if (r.problem) problems.push(r.problem); if (r.unscanned) unscanned.push(r.unscanned); };

  take(checkGlobalClaude({ root, home }));
  take(checkSkillsLink({ root, home }));
  take(checkMcpBootCost({ home }));
  take(checkStatusLine({ home }));
  take(checkPiExtensions({ root, home }));
  take(checkPiPackage({}));

  const mem = checkMemoryLink({ root, home });
  if (mem.fail) problems.push({ id: 'memory-broken', msg: `memory 断链：${mem.fail[0]}` });
  else if (mem.skip) {
    // linked worktree 的 .git 是文件——worktree 会话没有自己的 memory 目录是常态，不报；
    // 主 clone（.git 是目录）上 skip 才是「换机没接」。
    let gitIsDir = false;
    try { gitIsDir = lstatSync(join(root, '.git')).isDirectory(); } catch { /* 没有 .git 也不报 */ }
    if (gitIsDir) problems.push({ id: 'memory-unlinked', msg: 'memory 未接（本项目还没有 memory 目录）' });
  }

  // 凭据：只报，不列进可修项
  if (!existsSync(join(home, '.dao', 'apps'))) {
    problems.push({ id: 'creds-missing', msg: '~/.dao/apps 凭据不在（手动带，git 不带、onboard 不碰）' });
  }
  return { problems, unscanned };
}

/** ⑤ 状态栏脚本路径。~/.claude/settings.json 的 statusLine.command 是这个 D 类文件里唯一指向本仓的
 *  本机绝对路径（形如 `node C:/…/windsurf-dao/host/statusline.js`）。仓搬家 / 换机克隆到别的盘，
 *  状态栏静默消失——Claude Code 不报错，人只会觉得「状态栏怎么没了」（2026-09-02 两仓审计点名的
 *  「每台机器目录不一样」漂移，剩下的最后一处）。只报不修：settings.json 是红线文件
 *  （NEW-MACHINE §8：整文件覆写可能 401），修法是手改那一行。
 *  没有 settings.json / 没配 statusLine / 命令里认不出脚本路径 → 不算问题（不猜）；解析不了 → 没查成。 */
export function checkStatusLine({ home }) {
  const p = join(home, '.claude', 'settings.json');
  if (!existsSync(p)) return {};
  let cfg;
  try { cfg = JSON.parse(readFileSync(p, 'utf8')); }
  catch (e) { return { unscanned: `~/.claude/settings.json 解析不了：${e.message.slice(0, 60)}` }; }
  const cmd = cfg?.statusLine?.command;
  if (typeof cmd !== 'string') return {};
  // 命令行里第一个像脚本文件的绝对路径（盘符 / ~ / posix 根），扩展名限脚本类；认不出就不猜
  const m = cmd.match(/"?((?:[A-Za-z]:[\\/]|~[\\/]|\/)[^"\s]*?\.(?:mjs|cjs|js|cmd|ps1|sh))"?(?=\s|$)/i);
  if (!m) return {};
  const file = m[1].startsWith('~') ? join(home, m[1].slice(2)) : m[1];
  if (existsSync(file)) return {};
  return { problem: { id: 'statusline-dangling',
    msg: `~/.claude/settings.json 的 statusLine.command 指向不存在的 ${m[1]}——仓搬了家或换机没改；手改那一行（别整文件覆写）` } };
}

/** ⑥ pi 扩展 go-fallback：仓内 host/pi-extensions 是真相源，本机 ~/.pi/agent/extensions 是拷贝
 *  （pi 只扫那个目录，文件链接在 Windows 要管理员，所以是拷贝）。拷贝就会漂：仓更新了没装、
 *  或本机手改——2026-09-02 审计时这台机一份都没装，NEW-MACHINE 还只叫拷 .ts 漏了它 import 的 core。
 *  没装 pi（~/.pi/agent 不在）的机器不算问题。可修 id：pi-ext-missing / pi-ext-drift（onboard 重拷）。 */
export const PI_EXTENSIONS = ['go-fallback.ts', 'go-fallback-core.mjs'];
export function checkPiExtensions({ root, home }) {
  const agent = join(home, '.pi', 'agent');
  if (!existsSync(agent)) return {};
  const missing = [], drift = [];
  for (const f of PI_EXTENSIONS) {
    const truthPath = join(root, 'host', 'pi-extensions', f);
    let truth;
    try { truth = readFileSync(truthPath, 'utf8'); }
    catch { return { unscanned: `真相源读不到：${truthPath}` }; }
    const live = join(agent, 'extensions', f);
    if (!existsSync(live)) { missing.push(f); continue; }
    let got;
    try { got = readFileSync(live, 'utf8'); }
    catch (e) { return { unscanned: `${live} 读不了：${e.code || e.message}` }; }
    if (norm(truth) !== norm(got)) drift.push(f);
  }
  if (missing.length) return { problem: { id: 'pi-ext-missing',
    msg: `~/.pi/agent/extensions 缺 ${missing.join(' ')}（go-fallback：og 撞顶时明着报，不静默换通道）` } };
  if (drift.length) return { problem: { id: 'pi-ext-drift',
    msg: `~/.pi/agent/extensions/${drift.join(' ')} 与仓里 host/pi-extensions 不一致（仓更新了没装，或本机手改）` } };
  return {};
}

/** ⑦ PATH 上的 pi 是哪个包。要的是 Mirasim 认的分支 @earendil-works/pi-coding-agent；上游
 *  @mariozechner/pi-coding-agent 与它争同一个 `pi` 命令——装了上游，Mirasim 装分支必报 EEXIST，
 *  且上游版 `pi --version` 在 stdin 关闭时一个字不印，Mirasim 探测判「无法运行」，界面只剩一个
 *  永远失败的「重新安装」（2026-09-02 本机实咬，NEW-MACHINE 此前还叫人装上游）。
 *  判据零子进程：读 PATH 里第一个 pi 命令的 npm shim（pi.cmd / pi），看它 require 的包路径。
 *  PATH 上没 pi = 没装，不算问题；shim 读不了 = 没查成。只报不修（修要 npm 联网）。 */
export const PI_PACKAGE = '@earendil-works/pi-coding-agent';
export const PI_WRONG_PACKAGE = '@mariozechner/pi-coding-agent';
export function checkPiPackage({ pathDirs = String(process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':') } = {}) {
  for (const dir of pathDirs) {
    if (!dir) continue;
    for (const name of ['pi.cmd', 'pi']) {
      const shim = join(dir, name);
      if (!existsSync(shim)) continue;
      let text;
      try { text = readFileSync(shim, 'utf8'); }
      catch (e) { return { unscanned: `${shim} 读不了：${e.code || e.message}` }; }
      const pkg = text.match(/node_modules[\\/](@[^\\/\s"']+[\\/][^\\/\s"']+)/)?.[1]?.replace(/\\/g, '/');
      if (pkg === PI_WRONG_PACKAGE) return { problem: { id: 'pi-wrong-package',
        msg: `PATH 上的 pi 是上游 ${PI_WRONG_PACKAGE}（Mirasim 装不上、探测判无法运行）——\`npm uninstall -g ${PI_WRONG_PACKAGE}\` 再 \`npm install -g ${PI_PACKAGE}\`` } };
      return {};   // 第一个命中的 pi 说了算，后面的 PATH 项不看（和 shell 一样）
    }
  }
  return {};
}

/** ④ 慢启动的 MCP 服务器：命令是 npx/uvx 且带 @latest（或裸包名）——每次开会话现场解包。
 *  配置文件不在不算问题（没装过 Claude Code 的机器也跑这检查）；读得到但解析不了才是没查成。
 *  只报不修（id: mcp-slow-boot），修法在 msg 里指路。 */
export function checkMcpBootCost({ home }) {
  const path = join(home, '.claude.json');
  if (!existsSync(path)) return {};           // 没这文件 = 没配过 MCP，不是问题
  let cfg;
  try { cfg = JSON.parse(readFileSync(path, 'utf8')); }
  catch (e) { return { unscanned: `~/.claude.json 解析不了：${e.message.slice(0, 60)}` }; }
  // user 级 + 每个 project 级一起看：项目级条目一样在开会话时解包，
  // 而且 `claude mcp add` 默认就落 local(项目)域——漏掉它等于漏掉最容易配歪的那半。
  const entries = Object.entries(cfg.mcpServers || {});
  for (const [proj, pc] of Object.entries(cfg.projects || {}))
    for (const [name, v] of Object.entries((pc && pc.mcpServers) || {}))
      entries.push([name + '@' + proj.split(/[\\/]/).filter(Boolean).pop(), v]);
  if (!entries.length) return {};                          // 一个都没配，没得慢
  const slow = [], uvx = [];
  for (const [name, v] of entries) {
    const cmdline = [v?.command, ...(Array.isArray(v?.args) ? v.args : [])].filter(Boolean).join(' ');
    // npx/uvx 现场解包才慢；已经指到本地路径（.cmd/.js/绝对路径）的不算
    if (!/\b(npx|uvx)\b/.test(cmdline) || /[\\/](?:[\w.@-]+)\.(?:cmd|exe|js|mjs)\b/.test(cmdline)) continue;
    slow.push(name);
    if (/\buvx\b/.test(cmdline)) uvx.push(name);
  }
  if (!slow.length) return {};
  // uvx 还要看本机有没有 uv 托管的 Python：没有的话它不是「慢几秒」而是握手直接
  // CONNECTION_CLOSED，冷启动一路卡到超时（2026-09-01 另一台机实咬，被当成网络问题查了半天）。
  // 只 stat 目录，不起进程、不打网络。
  const noPy = uvx.length && ![join(home, 'AppData', 'Roaming', 'uv', 'python'),
                               join(home, '.local', 'share', 'uv', 'python')]
    .some(d => { try { return readdirSync(d).length > 0; } catch { return false; } });
  return { problem: {
    id: 'mcp-slow-boot',
    // 实测幅度：npx @latest 每个 5~7 秒，uvx 约 2 秒（2026-09-01 本机）
    msg: `${slow.length} 个 MCP 每次开会话现场解包（${slow.join(' ')}）——冷启动每个多花数秒；` +
         '装到本地后用 claude mcp remove/add 改指本地命令' +
         (noPy ? `。另：${uvx.join(' ')} 走 uvx 但本机没有 uv 托管 Python——`
               + '这几个不是慢，是握手必 CONNECTION_CLOSED，先 `uv python install 3.12`' : ''),
  } };
}

/** 哨兵那一行。绿 = 空串（零输出）；有问题 = 一行指路；没查成 = 一行不同形。 */
export function onboardNoticeLine({ problems, unscanned } = { problems: [], unscanned: [] }) {
  if (unscanned && unscanned.length) return `[链] 换机自检没查成：${unscanned[0]}（≠ 查过没事）`;
  if (!problems || !problems.length) return '';
  // onboard.mjs 修不了的那几类（要人在真 TTY，或只能走宿主自家 CLI）单独出一行：
  // 指向 onboard.mjs 会让人白跑一趟，报警指错路比不报还糟。
  const fixable = problems.filter(p => !ONBOARD_REPORT_ONLY.has(p.id));
  if (!fixable.length) {
    return `[链] ${problems.map(p => p.id).join(' ')}——onboard 修不了，`
         + '修法见 node scripts/onboard.mjs --dry-run 打印的那行';
  }
  const ids = fixable.map(p => p.id).join(' ');
  return `[链] 换机接线 ${fixable.length} 处未就绪（${ids}）——先问用户，同意后跑 node scripts/onboard.mjs（--dry-run 只看不动）`;
}
