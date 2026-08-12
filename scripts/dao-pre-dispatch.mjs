#!/usr/bin/env node
// dao-pre-dispatch.mjs — 派单前置闸：建树开工前核「本地 master 追平 origin/master」（issue #349）
//
// 问题：派工兵建树用 `orca worktree create --base-branch master`，基于**本地** master ref。
//   本地落后 origin 时（另一台机 / 另一会话推过 master），新树从旧代码开工，干完合并才发现
//   冲突或白改。合并链有 fetch + 核对（dao-pr-merge.ps1 1-2 步），建树前什么都没有——本脚本补上。
//
// 用法：node scripts/dao-pre-dispatch.mjs [--repo <路径>] [--no-fetch] [--help]
//   --repo     要核的仓（默认当前目录）。必须是一个 git 工作树（目录守卫：不是就退出）。
//   --no-fetch 跳过 `git fetch origin`（只读核验；测试用——真实跑不碰网络）。
//
// 退出码（协调者只认这一个机器通道）：
//   0 = 同步（master == origin/master）——可以建树。
//   1 = 本地落后（master 是 origin/master 的祖先）——打印一行**可复制**的 `git pull --ff-only`。
//   2 = 本地领先或分叉（origin/master 是 master 的祖先 / 双方各有对方没有的提交）——
//       显式报出来（那是另一种病），**禁静默 pull 掩盖分叉**。
//   3 = `git fetch origin` 失败——看 fetch 自己的退出码（fetch 静默失败是本仓实咬病，
//       ccswitch/dao.md「#反-fetch静默」同族）；fetch 没真跑成就不判三态，硬停。
//   4 = 环境 / 用法错（不是 git 工作树 / 引用不存在 / 参数错）。
//
// 判定铁律（2026-08-13）：三态判定只用 rev-parse 拿哈希比对（相等 / 不等），
//   方向用 `git merge-base --is-ancestor` 的干净退出码判（祖先关系，零输出）；
//   **禁解析任何 git 文案输出**（status 的 "behind by N commits" 之类一行都不读）。
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const EXIT = { OK: 0, BEHIND: 1, AHEAD_DIVERGED: 2, FETCH_FAIL: 3, ENV: 4 };
export const STATE = {
  SYNC: "sync", BEHIND: "behind", AHEAD: "ahead", DIVERGED: "diverged",
  FETCH_FAIL: "fetch-failed", ENV: "env-error",
};

const LOCAL_REF = "refs/heads/master";
const REMOTE_REF = "refs/remotes/origin/master";

export function git(cwd, args, runner = spawnSync) {
  const r = runner("git", args, { cwd, encoding: "utf8", windowsHide: true });
  return { code: r.status, out: String(r.stdout || ""), err: String(r.stderr || "") };
}

export function runCheck({ repo, fetch = true, runner = spawnSync }) {
  const lines = [];
  const say = (l) => lines.push(l);
  const finish = (state, exit) => {
    lines.push(`PRE_DISPATCH_SUMMARY exit=${exit} state=${state}`);
    return { exit, state, lines };
  };
  const g = (args) => git(repo, args, runner);

  // 目录守卫（dao-officer-clauses 第 9 条）：不在 git 工作树里就退出，不许在错仓上静默跑。
  if (g(["rev-parse", "--is-inside-work-tree"]).code !== 0) {
    say(`✗ 不是 git 工作树：${repo}（git rev-parse --is-inside-work-tree 非 0）`);
    return finish(STATE.ENV, EXIT.ENV);
  }

  if (fetch) {
    const f = g(["fetch", "origin"]);
    if (f.code !== 0) {
      say(`✗ git fetch origin 失败（exit ${f.code}）——fetch 静默失败是本仓实咬病，此闸硬停；`);
      say(`  修好网络 / 远程再跑，不许带着过期 origin/master 往下走`);
      return finish(STATE.FETCH_FAIL, EXIT.FETCH_FAIL);
    }
  }

  const local = g(["rev-parse", "--verify", "--quiet", LOCAL_REF]);
  const remote = g(["rev-parse", "--verify", "--quiet", REMOTE_REF]);
  if (local.code !== 0 || !local.out.trim()) {
    say(`✗ 本地引用不存在：${LOCAL_REF}（git rev-parse 非 0）`);
    return finish(STATE.ENV, EXIT.ENV);
  }
  if (remote.code !== 0 || !remote.out.trim()) {
    say(`✗ 远端引用不存在：${REMOTE_REF}（fetch 过了还没有？核 remote 名与远端主干名）`);
    return finish(STATE.ENV, EXIT.ENV);
  }

  const lh = local.out.trim();
  const rh = remote.out.trim();
  if (lh === rh) {
    say(`✓ 同步：master == origin/master（${lh}）`);
    return finish(STATE.SYNC, EXIT.OK);
  }

  // 方向判定：merge-base --is-ancestor 的退出码（0=祖先），不读任何文案。
  const behind = g(["merge-base", "--is-ancestor", LOCAL_REF, REMOTE_REF]);
  const ahead = g(["merge-base", "--is-ancestor", REMOTE_REF, LOCAL_REF]);
  if (behind.code === 0) {
    say(`✗ 本地落后：master=${lh}  origin/master=${rh}`);
    say(`  追平（须在 master 被检出的那棵主仓跑；本闸核的是 refs/heads/master）：git -C "${repo}" pull --ff-only`);
    say(`  追平后重跑本脚本核验`);
    return finish(STATE.BEHIND, EXIT.BEHIND);
  }
  if (ahead.code === 0) {
    say(`✗ 本地领先：master=${lh}  origin/master=${rh}`);
    say(`  领先是另一种病——先核这批领先提交该不该推、有没有别人依赖旧 master；`);
    say(`  **不打印 pull：领先态静默 pull 是掩盖，不是处置**`);
    return finish(STATE.AHEAD, EXIT.AHEAD_DIVERGED);
  }
  say(`✗ 分叉：master=${lh}  origin/master=${rh}——双方各有对方没有的提交`);
  say(`  先核分叉原因（rebase / force-push 前先确认没人依赖旧 master），手动处置后重跑；`);
  say(`  **不打印 pull：分叉态静默 pull 是掩盖，不是处置**`);
  return finish(STATE.DIVERGED, EXIT.AHEAD_DIVERGED);
}

function usage() {
  process.stderr.write(
    "用法：node scripts/dao-pre-dispatch.mjs [--repo <路径>] [--no-fetch]\n" +
    "退出码：0 同步 / 1 本地落后（带可复制 pull --ff-only）/ 2 领先或分叉 / 3 fetch 失败 / 4 环境或用法错\n",
  );
}

function main(argv) {
  let repo = process.cwd();
  let fetch = true;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--repo") { repo = argv[++i] || ""; }
    else if (argv[i] === "--no-fetch") { fetch = false; }
    else if (argv[i] === "--help" || argv[i] === "-h") { usage(); return EXIT.ENV; }
    else { process.stderr.write(`未知参数：${argv[i]}\n`); usage(); return EXIT.ENV; }
  }
  if (!repo) { process.stderr.write("--repo 缺路径\n"); usage(); return EXIT.ENV; }
  const abs = path.resolve(repo);
  process.stdout.write(`dao-pre-dispatch · repo=${abs} fetch=${fetch}\n`);
  const { exit, lines } = runCheck({ repo: abs, fetch, runner: spawnSync });
  for (const l of lines) process.stdout.write(l + "\n");
  return exit;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  process.exit(main(process.argv.slice(2)));
}
