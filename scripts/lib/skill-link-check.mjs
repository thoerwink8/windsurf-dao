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
// 判据：
//   SKIP —— 本机没有 `~/.claude/skills` 目录（CI / 新机）。与绿不同形：SKIP 在输出里打印，
//           且不计入绿——SKIP 与绿分不开，CI 就会永远绿而本机永远没人查。
//   RED  —— 链接缺失（缺链）/ 存在但不是链接（普通目录或普通文件）/ 链接悬空（目标不存在）/
//            指错（realpath 落点不以 `host/skills/<名>` 结尾——含指到别的 skill、指到别的仓）。
//   GREEN—— 每个 skill 的链接都在，且 realpath 落点以 `host/skills/<名>` 结尾。
//   没查成 —— host/skills 不在 / 扫到 0 个 skill（数到 0 和没看到样本输出一样 ⇒ 必须报红）/
//             HOME 探测不了。
//
// 为什么落点用「以 host/skills/<名> 结尾」而不是「等于当前 checkout 的 host/skills/<名>」：
// 部署事实是本机只给**主仓 checkout** 建链（NEW-MACHINE §11），worktree 里的 dao-check
// 也必须能绿——链接指向主仓 `host/skills/<名>`，落点以 `host/skills/<名>` 结尾即认。
// 指错 skill（如 name=dispatch 却指向 host/skills/dao-commit）落点不以 host/skills/dispatch
// 结尾 ⇒ 报红；指到别的仓同样报红。
//
// 为什么必须 local-only：检查对象是本机文件系统，CI 机器上没有 ~/.claude/skills。
// 状态必须分得开（不然「没查成」「没接」「接错」会被压成一团）。
//
// 为什么 lstat 不用 stat：符号链接本身要能跟普通目录分开——普通目录是「装错了」，
// 不是「装好了」。

import { readdirSync, lstatSync, realpathSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/** 比较用的归一化：反斜杠换正斜杠、去尾斜杠、小写（Windows/macOS 文件系统大小写不敏感）。 */
function norm(p) {
  return String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/** 落点判据：realpath 之后必须落在 `.../host/skills/<名>` 上（任何 checkout 都认）。 */
function suffixOk(target, name) {
  return norm(target).endsWith(`/host/skills/${name.toLowerCase()}`);
}

/**
 * @param {{root: string, home: string}} opts root=仓库根（host/skills 真相源），
 *        home=放 .claude/ 的那个目录（USERPROFILE 或 HOME）
 * @returns {{green?: string, skip?: string, fail?: [string, string, string]}} 状态与 dao-check 的
 *          green()/skip()/fail() 对齐；skip 与 green 必须能被输出格式分开（SKIP 前缀 + 不计绿）。
 */
export function checkSkillLinks({ root, home }) {
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
