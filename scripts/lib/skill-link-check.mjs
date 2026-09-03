// skill 发现面符号链接检查（dao-check 第 ㉘ 项的实现，issue #793）。
//
// 单独成文件只为一件事：让 tests/skill-link.test.js 能拿假 root + 假 HOME 造违规样本来验它
// 自己的判别力，而不必去跑整个 dao-check（那会递归——dao-check 会跑 tests/，tests 再跑
// dao-check）。
//
// 被检查的是什么（NEW-MACHINE §11 定义的正确状态）：仓内 `host/skills/<名>/` 每个 skill，
// 在本机宿主发现面 `~/.claude/skills/<名>` 必须是指向仓内 `host/skills/<名>` 的**符号链接**。
// 建链是**本机手动动作**（无自愈脚本，#565 拍板 symlink 归帅建），所以本检查只报警、
// **不自动建链**——报警本身就是这个机制的全部价值。
//
// 2026-08-27 实咬（PR #789 合并后）：`/dao-commit` 在终端不可见，根因之一是
// `~/.claude/skills/dao-commit` 符号链接缺失。仓内新增 skill 与宿主发现面之间零报警，
// 新增 skill 忘了建链，dao-check 照样全绿——本项堵的就是这个洞。
//
// 判据（两道门，缺一不可）：
//   门 1 后缀：realpath 落点必须以 `host/skills/<名>` 结尾（任何 checkout 的布局都长这样）。
//             指错 skill（name=dispatch 却指向 host/skills/dao-commit）、指到 host/skills
//             布局之外，在这一门就红。
//   门 2 归属：落点必须属于**本仓**（主 worktree 或同仓合法 checkout）——用 git common-dir
//             身份校验：从落点向上找到最近的 .git（目录或文件，文件要能解出 gitdir +
//             commondir），解出 common dir，必须等于本仓 root 的 common dir。无关仓库
//             即使目录布局一模一样（/别的仓/host/skills/<名>）也在这一门红。
//             解析全手工（读 .git 文件/commondir，不 shell git），PATH 里没有 git 也照样跑。
//
//   SKIP —— CI 环境（GITHUB_ACTIONS/CI 置真）：仓库现有 CI（.github/workflows/check.yml）
//            跑 dao-check 前固定 `mkdir -p ~/.claude/skills` 并只为带 hooks.json 的 skill
//            建链（给 ⑧ 态注入 hook 检查用），发现面从来不是全量——本项在 CI 上无法验证，
//            不是绿（SKIP 与绿分不开，CI 就会永远绿而本机永远没人查）。
//            或者：本机没有 `~/.claude/skills` 目录（新机未建链）。
//   RED  —— 链接缺失（缺链）/ 存在但不是链接（普通目录或普通文件）/ 链接悬空（目标不存在）/
//            门 1 不过（指错 skill / 指到 host/skills 布局之外）/ 门 2 不过（落点不在任何
//            git 仓内，或 common-dir ≠ 本仓——指到别的仓）。
//   GREEN—— 每个 skill 的链接都在，门 1 门 2 都过。
//   没查成 —— host/skills 不在 / 扫到 0 个 skill（数到 0 和没看到样本输出一样 ⇒ 必须报红）/
//             HOME 探测不了 / 本仓 root 的 common-dir 解不出来（不在 git 仓里跑 =
//             归属校验没依据，不许退回纯后缀放行）。
//
// 为什么必须 local-only：检查对象是本机文件系统，CI 机器上没有操作者的完整发现面。
// 状态必须分得开（不然「没查成」「没接」「接错」会被压成一团）。
//
// 为什么 lstat 不用 stat：符号链接本身要能跟普通目录分开——普通目录是「装错了」，
// 不是「装好了」。

import { readdirSync, lstatSync, realpathSync, existsSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';

/** 文件系统大小写语义：NTFS 约定大小写不敏感（junction/symlink 的目标大小写五花八门），
 *  POSIX（Linux/macOS）大小写敏感——RepoA 与 repoa 是不同目录，不许 lower 后相等。
 *  两侧都过 realpath（拿到盘上真实大小写）后，POSIX 直接比，win32 lower 再比。 */
const CASE_INSENSITIVE = process.platform === 'win32';

/** 比较用的归一化：反斜杠换正斜杠、去尾斜杠；仅 win32 小写（其余平台大小写敏感）。 */
function norm(p) {
  let s = String(p).replace(/\\/g, '/').replace(/\/+$/, '');
  if (CASE_INSENSITIVE) s = s.toLowerCase();
  return s;
}

/** 门 1：realpath 之后必须落在 `.../host/skills/<名>` 上（任何 checkout 都认）。
 *  后缀比较沿用 norm 的平台语义：POSIX 精确（Foo ≠ foo），win32 忽略大小写。 */
function suffixOk(target, name) {
  return norm(target).endsWith(norm(`/host/skills/${name}`));
}

/**
 * 门 2 的归属探测：从 start 向上找最近的 `.git`（目录或文件），解出该仓的 common dir。
 *   目录形态：普通 clone 的 .git 本身就是 common dir。
 *   文件形态：worktree/子模块的 .git 里 `gitdir: <路径>`，指向的 gitdir 若带 commondir 文件
 *             再解一层（worktree 的 common dir 住在主仓 .git）。
 * 全手工解析，不 shell git——PATH 里没有 git 时检查照样能跑。
 * 找不到 / 解不出返回 null（此时调用方按「不是本仓 checkout」判红或「没查成」判失败）。
 */
export function resolveGitCommonDir(start) {
  let cur = resolve(start);
  for (;;) {
    const dotGit = join(cur, '.git');
    let st = null;
    try { st = lstatSync(dotGit); } catch { st = null; }
    if (st && st.isDirectory()) return resolve(dotGit);
    if (st && st.isFile()) {
      const m = readFileSync(dotGit, 'utf8').match(/^gitdir:\s*(.+)$/m);
      if (!m) return null;
      const gitDir = resolve(dirname(dotGit), m[1].trim());
      const commondir = join(gitDir, 'commondir');
      if (existsSync(commondir)) {
        return resolve(gitDir, readFileSync(commondir, 'utf8').trim());
      }
      return gitDir;
    }
    const parent = dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

/**
 * @param {{root: string, home: string, isCi?: boolean}} opts root=仓库根（host/skills 真相源），
 *        home=放 .claude/ 的那个目录（USERPROFILE 或 HOME），isCi=CI 环境标记
 *        （GITHUB_ACTIONS/CI 置真；CI 只为 ⑧ 装带 hook 的 skill，发现面非全量 ⇒ SKIP 不是绿）
 * @returns {{green?: string, skip?: string, fail?: [string, string, string]}} 状态与 dao-check 的
 *          green()/skip()/fail() 对齐；skip 与 green 必须能被输出格式分开（SKIP 前缀 + 不计绿）。
 */
export function checkSkillLinks({ root, home, isCi = false }) {
  if (isCi) {
    return { skip: 'CI 环境：~/.claude/skills 发现面只在操作者机器上建链（CI 只为 ⑧ 装带 hook 的 skill），本项无法验证（SKIP 不是绿）' };
  }
  if (!home) {
    return { fail: ['本机 home 探测不了', 'USERPROFILE/HOME 没设，无法定位宿主发现面 ~/.claude/skills', `home=${home}`] };
  }

  const skillsDir = join(root, 'host', 'skills');
  if (!existsSync(skillsDir)) {
    return { fail: ['host/skills 不在', '本次没查成：确认部署源目录是否被移动', skillsDir] };
  }
  let names;
  try {
    names = readdirSync(skillsDir).filter(d => {
      try { return lstatSync(join(skillsDir, d)).isDirectory(); } catch { return false; }
    });
  } catch (e) {
    return { fail: ['host/skills 读不了', '本次没查成，不是没问题', `${skillsDir}: ${String(e.message || e).slice(0, 120)}`] };
  }
  if (names.length === 0) {
    return { fail: ['一个 skill 都没扫到', 'host/skills 空了 ⇒ 本次等于没查', skillsDir] };
  }

  // 门 2 的本仓侧依据：root 的 common-dir。先 realpath（拿盘上真实大小写——POSIX 大小写敏感
  // 比较的前提），解不出来 = 归属校验没依据，本次没查成（不许退回纯后缀放行——那会把无关仓库
  // 误认成仓内，见 #793 审官红 2）。
  let rootReal;
  try {
    rootReal = realpathSync(resolve(root));
  } catch (e) {
    return { fail: ['本仓 root 探测不了', '本次没查成：确认在 git 仓内跑 dao-check', `${resolve(root)}: ${String(e.message || e).slice(0, 120)}`] };
  }
  const rootCommon = resolveGitCommonDir(rootReal);
  if (!rootCommon) {
    return { fail: ['本仓 git 归属探测不了', '本次没查成：确认在 git 仓内跑 dao-check（链接归属校验需要 common-dir）', rootReal] };
  }

  const face = join(home, '.claude', 'skills');
  let faceSt;
  try {
    faceSt = lstatSync(face);
  } catch (e) {
    if (e && e.code === 'ENOENT') {
      return { skip: `本机无 ~/.claude/skills（${face}）⇒ CI/新机未建链，本项无法验证（SKIP 不是绿）` };
    }
    return { fail: ['~/.claude/skills 探测不了', '确认 ~/.claude 可读；读不了 = 本次没查成', `${face}: ${String(e.message || e).slice(0, 120)}`] };
  }
  if (!faceSt.isDirectory()) {
    return { fail: ['~/.claude/skills 不是目录', '宿主发现面坏了：删掉这个文件/链接，按 NEW-MACHINE §11 重建为目录', face] };
  }

  const bad = [];
  const good = [];
  for (const name of names) {
    const link = join(face, name);
    let st;
    try {
      st = lstatSync(link);
    } catch (e) {
      if (e && e.code === 'ENOENT') { bad.push(`${name}: 缺链`); continue; }
      bad.push(`${name}: 探测不了(${String(e.message || e).slice(0, 60)})`);
      continue;
    }
    if (!st.isSymbolicLink()) {
      bad.push(`${name}: 不是链接（${st.isDirectory() ? '普通目录' : '普通文件'}）`);
      continue;
    }
    let target;
    try {
      target = realpathSync(link);
    } catch (e) {
      bad.push(`${name}: 链接悬空（目标不存在）`);
      continue;
    }
    if (!suffixOk(target, name)) {
      bad.push(`${name}: 指错 → ${target}`);
      continue;
    }
    const targetCommon = resolveGitCommonDir(target);
    if (!targetCommon) {
      bad.push(`${name}: 指错 → ${target}（目标不在任何 git 仓内，不是本仓 checkout）`);
      continue;
    }
    if (norm(targetCommon) !== norm(rootCommon)) {
      bad.push(`${name}: 指错 → ${target}（目标仓 common-dir=${targetCommon} ≠ 本仓 ${rootCommon}）`);
      continue;
    }
    good.push(name);
  }

  if (bad.length > 0) {
    return { fail: [
      `skill 发现面缺链/指错 ${bad.length} 个（共 ${names.length} 个 skill）`,
      `按 NEW-MACHINE §11 把 host/skills/<名> 用 SymbolicLink 链到 ${face}\\<名>（#565：建链归帅，本检查只报警不自动建）`,
      bad.join('；'),
    ] };
  }
  return { green: `skill 发现面符号链接 ${good.length} 个已接（~/.claude/skills/<名> → host/skills/<名>）` };
}
