// 本机 memory 断链检查（dao-check 第 ⑨ 项的实现，issue #503；判据改写见 issue #529）。
//
// 单独成文件只为一件事：让 tests/memory-link.tests.js 能拿假 HOME 造违规样本来验它自己的
// 判别力，而不必去跑整个 dao-check（那会递归——dao-check 会跑 tests/，tests 再跑 dao-check）。
//
// 被检查的是什么（NEW-MACHINE §10 定义的正确状态）：本机
// `~/.claude/projects/<编码后的仓库路径>/memory` 必须是**指向 windsurf-dao-memory 这个独立仓
// 的 clone 的符号链接**（#807：Linux 服务器用 symlink，不再认 Windows Junction）。memory 已自 #518 从主仓搬进独立仓
// thoerwink8/windsurf-dao-memory（#529 把主仓那一半拆掉），接上之后 Claude 每写一条 memory，
// memory 仓 `git status` 就多一条未提交变更，记忆才真正活着。
//
// #529 的新判据（不硬编码任何本机路径，换机成立）：
//   链接目标必须是一个 git 仓库，且它的 `origin` remote 指向
//   `thoerwink8/windsurf-dao-memory`——从 URL 里抽 owner/repo 再比，SSH
//   （git@github.com:owner/repo.git）与 HTTPS（https://github.com/owner/repo.git）两种形式都认，
//   容忍结尾 .git 与尾斜杠（换机用 HTTPS clone 时不能假红）。
//
// 为什么必须 local-only：检查对象是本机文件系统，CI 机器上没有本机项目的 ~/.claude 目录。
// 状态必须分得开（不然「没查成」「没接」「接错」会被压成一团）：
//   SKIP —— 本机没有该项目 memory 目录（CI / 新机 / worktree 的 projects 目录从未建过）。
//            与绿不同形：SKIP 在输出里打印出来，且不计入「绿」。
//   RED  —— 目录在，但：不是链接（普通目录）、链接悬空（目标不存在）、目标不是 git 仓库、
//            目标仓没有 origin remote、或 origin 不是 windsurf-dao-memory。
//            「指向主仓旧 memory 目录」落在「目标不是 git 仓库」这一格——搬家前状态必须红。
//   GREEN—— 链接存在，目标是个 git 仓，且 origin == thoerwink8/windsurf-dao-memory。
//   没查成 —— ~/.claude 读不了 / 目标 .git 存在但 config 读不到（环境性故障，不是「查过没事」）。
//
// 编码规则与 NEW-MACHINE §10 完全一致：仓库路径里所有非 [a-zA-Z0-9] 字符一律换 `-`
// （点、下划线、中文、盘符冒号、反斜杠都算）。这条规则是部署事实，不是 memory 自己的解析。
// remote 用检查器自己的正则从 .git/config 里抽，不 shell 出 git——PATH 里没有 git 时检查
// 照样能跑，「git 命令起不来」这种歧义失败态在结构上不存在（issue #529 第二条 comment 的坑二
// 解法：直接探 .git 并存不存在 + 读配置文件，而不是读 git 的退出码去猜）。

import { lstatSync, realpathSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';

/** NEW-MACHINE §10 的项目目录编码：非 [a-zA-Z0-9] 一律换 -。 */
export function encodeProjectDir(root) {
  return String(root).replace(/[^a-zA-Z0-9]/g, '-');
}

/** 正确 remote 的 owner/repo：origin 必须指向它（私有仓）。 */
export const MEMORY_REPO_SLUG = 'thoerwink8/windsurf-dao-memory';

/** 从 remote URL 抽 owner/repo：SSH（git@host:owner/repo(.git)）与 HTTPS 都认，
 *  容忍结尾 .git 与尾斜杠；抽不出返回 null（此时判红——不是 memory 仓）。 */
export function repoSlugFromUrl(url) {
  const s = String(url || '').trim();
  if (!s) return null;
  const bare = s.replace(/\/+$/, '').replace(/\.git$/, '');
  const m = /([^/:]+)\/([^/:]+)\/?$/.exec(bare);
  return m ? `${m[1]}/${m[2]}` : null;
}

/** 从 .git/config 文本里抽 [remote "origin"] 段的 url=。用检查器自己的正则，
 *  不复用 git 自己的解析逻辑（自己查自己查不出错）。 */
export function originUrlFromConfig(cfg) {
  const sec = /\[remote\s+"?origin"?\][^[]*/i.exec(String(cfg || ''));
  if (!sec) return null;
  const u = sec[0].match(/^\s*url\s*=\s*(\S+)\s*$/m);
  return u ? u[1] : null;
}

/**
 * @param {{root: string, home: string}} opts root=仓库根（只用来算目录编码），
 *        home=放 .claude/ 的那个目录
 * @returns {{green?: string, skip?: string, fail?: [string, string, string]}} 状态与 dao-check 的
 *          green()/skip()/fail() 对齐；skip 与 green 必须能被输出格式分开（SKIP 前缀 + 不计绿）。
 */
export function checkMemoryLink({ root, home }) {
  const encoded = encodeProjectDir(resolve(root));
  const local = join(home, '.claude', 'projects', encoded, 'memory');

  let st;
  try {
    st = lstatSync(local);
  } catch (e) {
    if (e && e.code === 'ENOENT') {
      return { skip: `本机无该项目 memory 目录（${local}）⇒ CI/新机/worktree 未接，本项无法验证` };
    }
    return { fail: ['本机 memory 目录探测不了', '确认 ~/.claude/projects 可读，或重跑 NEW-MACHINE §10 的脚本', `${local}: ${String(e.message || e).slice(0, 120)}`] };
  }

  // 是符号链接 → 验目标（#807：POSIX symlink；旧 Junction 在 Windows 上 lstat 也报 isSymbolicLink）
  if (st.isSymbolicLink()) {
    let got;
    try {
      got = realpathSync(local);
    } catch (e) {
      return { fail: ['本机 memory 链接已悬空（目标不存在）', '删掉这个链接后重跑 NEW-MACHINE §10 的脚本', local] };
    }
    return checkMemoryTarget(got, local);
  }

  if (st.isDirectory()) {
    return { fail: ['本机 memory 是普通目录，不是指向 memory 仓的符号链接', '删掉这个目录后把 ~/.claude/projects/<编码>/memory 链到 windsurf-dao-memory 的 clone（NEW-MACHINE §10）', local] };
  }

  return { fail: ['本机 memory 既不是链接也不是目录', '重跑 NEW-MACHINE §10 的脚本重建', `${local}（mode=${st.mode}）`] };
}

/** 判据（#529）：目标是 git 仓，且 origin remote 指向 thoerwink8/windsurf-dao-memory。 */
function checkMemoryTarget(target, local) {
  // 必须有 .git：普通 clone 是 .git 目录；worktree/子模块是 .git 文件（gitdir: 指向 git 目录）。
  let gitDir;
  const dotGit = join(target, '.git');
  let st;
  try {
    st = lstatSync(dotGit);
  } catch (e) {
    return { fail: ['本机 memory 指向的不是 windsurf-dao-memory 仓', `重跑 NEW-MACHINE §10：先 clone thoerwink8/windsurf-dao-memory，再把符号链接指到那个 clone`, `${local} → ${target}（无 .git，不是 git 仓库——含搬家前指向主仓旧 memory 目录的形态）`] };
  }
  if (st.isDirectory()) {
    gitDir = dotGit;
  } else if (st.isFile()) {
    // worktree/子模块形态：.git 文件里 gitdir: <路径>；worktree 的 gitdir 里 commondir 指向
    // 主 git 目录，origin 的 config 住在主 git 目录。
    const m = readFileSync(dotGit, 'utf8').match(/^gitdir:\s*(.+)$/m);
    if (!m) {
      return { fail: ['本机 memory 指向的 .git 文件读不出 gitdir', '确认那个目录是 windsurf-dao-memory 的完整 clone', `${local} → ${target}（.git 是文件但无 gitdir 行）`] };
    }
    gitDir = resolve(dirname(dotGit), m[1].trim());
    const commondir = join(gitDir, 'commondir');
    if (existsSync(commondir)) {
      gitDir = resolve(gitDir, readFileSync(commondir, 'utf8').trim());
    }
  } else {
    return { fail: ['本机 memory 指向的 .git 形态不认识', '重跑 NEW-MACHINE §10：目标应是 windsurf-dao-memory 的完整 clone', `${local} → ${target}（.git 既不是目录也不是文件）`] };
  }

  const cfgPath = join(gitDir, 'config');
  let cfg;
  try {
    cfg = readFileSync(cfgPath, 'utf8');
  } catch (e) {
    return { fail: ['本机 memory 指向的 git 仓配置读不了', '本次没查成，不是接好了：确认那个目录真的是 windsurf-dao-memory 的 clone', `${cfgPath}: ${String(e.message || e).slice(0, 120)}`] };
  }

  const origin = originUrlFromConfig(cfg);
  if (!origin) {
    return { fail: ['本机 memory 指向的仓没有 origin remote', '重跑 NEW-MACHINE §10：目标应是 windsurf-dao-memory 的 clone（要带 origin）', `${local} → ${target}（.git/config 无 [remote "origin"] 的 url）`] };
  }
  const slug = repoSlugFromUrl(origin);
  if (!slug || slug.toLowerCase() !== MEMORY_REPO_SLUG.toLowerCase()) {
    return { fail: ['本机 memory 指向的仓 origin 不是 windsurf-dao-memory', '重跑 NEW-MACHINE §10：把符号链接指到 windsurf-dao-memory 的 clone', `${local} → ${target}（origin=${origin}）`] };
  }
  return { green: `本机 memory 已接：${local} → ${target}（origin=${MEMORY_REPO_SLUG}，新写的 memory 落在独立仓）` };
}

/** dao-check 侧拿到的宿主目录：HOME（POSIX / Linux 服务器）；USERPROFILE 只当别名。 */
export function defaultHome(env = process.env) {
  return env.HOME || env.USERPROFILE || '';
}