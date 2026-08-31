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

import { lstatSync, realpathSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkMemoryLink, defaultHome } from './dao-memory-link-check.mjs';

export function repoRootOfThisFile() {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

const norm = (s) => String(s ?? '').replace(/\r\n/g, '\n');

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

/** 哨兵那一行。绿 = 空串（零输出）；有问题 = 一行指路；没查成 = 一行不同形。 */
export function onboardNoticeLine({ problems, unscanned } = { problems: [], unscanned: [] }) {
  if (unscanned && unscanned.length) return `[链] 换机自检没查成：${unscanned[0]}（≠ 查过没事）`;
  if (!problems || !problems.length) return '';
  const ids = problems.map(p => p.id).join(' ');
  return `[链] 换机接线 ${problems.length} 处未就绪（${ids}）——先问用户，同意后跑 node scripts/onboard.mjs（--dry-run 只看不动）`;
}
