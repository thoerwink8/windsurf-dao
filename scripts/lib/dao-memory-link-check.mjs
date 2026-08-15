// 本机 memory 断链检查（dao-check 第 ⑨ 项的实现，issue #503）。
//
// 单独成文件只为一件事：让 tests/memory-link.tests.js 能拿假 HOME 造违规样本来验它自己的
// 判别力，而不必去跑整个 dao-check（那会递归——dao-check 会跑 tests/，tests 再跑 dao-check）。
//
// 被检查的是什么：NEW-MACHINE §10 定义的正确状态——本机
// `~/.claude/projects/<编码后的仓库路径>/memory` 必须是**指向本仓 `host/memory/` 的 Junction**。
// 接上之后 Claude 每写一条 memory，主仓 `git status` 就多一条未提交变更，记忆才真正活着。
//
// #503 的病：本机 memory 是**普通目录**，与仓内 `host/memory/` 完全漂移——今天写的每条教训
// 只在本机，换机即丢；而 dao-check 只查仓内副本（CI 里没有本机 ~/.claude），全绿却没人读。
//
// 为什么必须 local-only：检查对象是本机文件系统，CI 机器上没有本机项目的 ~/.claude 目录。
// 三态必须分得开（不然 CI 永远绿、本机永远没人查）：
//   SKIP —— 本机没有该项目 memory 目录（CI / 新机 / worktree 的 projects 目录从未建过）。
//            与绿不同形：SKIP 在输出里打印出来，且不计入「绿」。
//   RED  —— 目录在，但：不是链接（普通目录）、指向别处、或链接悬空（目标不存在）。
//   GREEN—— 链接存在且目标解析后 == 本仓 host/memory。
//
// 编码规则与 NEW-MACHINE §10 完全一致：仓库路径里所有非 [a-zA-Z0-9] 字符一律换 `-`
// （点、下划线、中文、盘符冒号、反斜杠都算）。这条规则是部署事实，不是 memory 自己的解析。
// 链接探测用 node:fs lstat/realpath 自己读文件系统，不复用任何 memory 侧的解析逻辑。

import { lstatSync, realpathSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** NEW-MACHINE §10 的项目目录编码：非 [a-zA-Z0-9] 一律换 -。 */
export function encodeProjectDir(root) {
  return String(root).replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * @param {{root: string, home: string}} opts root=仓库根，home=放 .claude/ 的那个目录
 * @returns {{green?: string, skip?: string, fail?: [string, string, string]}} 三态与 dao-check 的
 *          green()/skip()/fail() 对齐；skip 与 green 必须能被输出格式分开（SKIP 前缀 + 不计绿）。
 */
export function checkMemoryLink({ root, home }) {
  const want = resolve(root, 'host', 'memory');
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

  // 是链接（Junction 在 Windows 上 lstat 也报 isSymbolicLink）→ 验目标
  if (st.isSymbolicLink()) {
    let got;
    try {
      got = realpathSync(local);
    } catch (e) {
      return { fail: ['本机 memory 链接已悬空（目标不存在）', '删掉这个链接后重跑 NEW-MACHINE §10 的脚本', local] };
    }
    const gotNorm = got.toLowerCase();
    let wantNorm;
    try {
      wantNorm = realpathSync(want).toLowerCase();
    } catch (e) {
      return { fail: ['仓内 host/memory 不在', '本次没查成：确认 memory 真相源目录是否被移动', want] };
    }
    if (gotNorm === wantNorm) {
      return { green: `本机 memory 已接：${local} → ${want}（Junction 健康，新写的 memory 会出现在 git status）` };
    }
    return { fail: ['本机 memory 指向别处', '删掉这个链接后重跑 NEW-MACHINE §10 的脚本（目标应为仓内 host/memory）', `${local} → ${got}`] };
  }

  if (st.isDirectory()) {
    return { fail: ['本机 memory 是普通目录，不是指向 host/memory 的 Junction', '先关掉所有 Claude Code 窗口，再在**主仓根**跑 NEW-MACHINE §10 的脚本（会把本机目录改名备份并建 Junction）', local] };
  }

  return { fail: ['本机 memory 既不是链接也不是目录', '重跑 NEW-MACHINE §10 的脚本重建', `${local}（mode=${st.mode}）`] };
}

/** dao-check 侧拿到的宿主目录：USERPROFILE（Windows）或 HOME（POSIX）。 */
export function defaultHome(env = process.env) {
  return env.USERPROFILE || env.HOME || '';
}
