// dao-pre-dispatch.tests.js — 派单前置闸（issue #349）的自测
//
// 负控三态（同步 / 落后 / 领先 / 分叉）+ fetch 失败 + 环境错：用假 runner 打剧本，
// 断言只认退出码与 PRE_DISPATCH_SUMMARY 摘要行，不 grep 散文。
// 另有一条**真实跑**：在本仓用真 git 跑真脚本（--no-fetch，不碰网络），
// 核脚本退出码与「独立 rev-parse 重算的地面真相」一致——当前仓同步 ⇒ 真 exit 0。
// 地面真相用与脚本同一通道（rev-parse / merge-base）独立算，不读脚本输出做判定。
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCheck, EXIT, STATE } from "../scripts/dao-pre-dispatch.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? "  →  " + detail : ""}`); }
}

// ── 假 runner：按 git 子命令 / 参数形态返回剧本 ────────────────────────────────
const HASH_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HASH_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const ok = (stdout = "") => ({ status: 0, stdout });

function scripted(scenes) {
  const calls = [];
  const runner = (cmd, args) => {
    calls.push(args.join(" "));
    const scene = scenes.find((s) => s.match(args));
    return scene ? { ...scene.result } : { status: 1, stdout: "", stderr: "unexpected: " + args.join(" ") };
  };
  return { runner, calls };
}
const match = {
  inside: (a) => a[0] === "rev-parse" && a.includes("--is-inside-work-tree"),
  fetch: (a) => a[0] === "fetch",
  local: (a) => a[0] === "rev-parse" && a.includes("refs/heads/master"),
  remote: (a) => a[0] === "rev-parse" && a.includes("refs/remotes/origin/master"),
  behindQ: (a) => a[0] === "merge-base" && a[2] === "refs/heads/master" && a[3] === "refs/remotes/origin/master",
  aheadQ: (a) => a[0] === "merge-base" && a[2] === "refs/remotes/origin/master" && a[3] === "refs/heads/master",
};
const baseScenes = (localHash, remoteHash) => [
  { match: match.inside, result: ok() },
  { match: match.fetch, result: ok() },
  { match: match.local, result: ok(localHash + "\n") },
  { match: match.remote, result: ok(remoteHash + "\n") },
];

console.log("\n=== 三态：同步 / 落后 / 领先 / 分叉 ===");
// 同步：master == origin/master ⇒ exit 0，摘要 state=sync。
{
  const { runner } = scripted(baseScenes(HASH_A, HASH_A));
  const r = runCheck({ repo: "/fake", fetch: true, runner });
  check("同步态 exit 0", r.exit === EXIT.OK);
  check("同步态摘要 state=sync", r.state === STATE.SYNC);
  check("同步态不打印 pull", !r.lines.some((l) => l.includes("pull --ff-only")));
}
// 落后：master 是 origin/master 的祖先 ⇒ exit 1 + 可复制的 git pull --ff-only。
{
  const { runner } = scripted([
    ...baseScenes(HASH_A, HASH_B),
    { match: match.behindQ, result: ok() },
    { match: match.aheadQ, result: { status: 1, stdout: "" } },
  ]);
  const r = runCheck({ repo: "/fake", fetch: true, runner });
  check("落后态 exit 1", r.exit === EXIT.BEHIND);
  check("落后态摘要 state=behind", r.state === STATE.BEHIND);
  check("落后态打印可复制 pull --ff-only", r.lines.some((l) => l.includes("git -C") && l.includes("pull --ff-only")));
}
// 领先：origin/master 是 master 的祖先 ⇒ exit 2，显式报，**不打印 pull**。
{
  const { runner } = scripted([
    ...baseScenes(HASH_A, HASH_B),
    { match: match.behindQ, result: { status: 1, stdout: "" } },
    { match: match.aheadQ, result: ok() },
  ]);
  const r = runCheck({ repo: "/fake", fetch: true, runner });
  check("领先态 exit 2", r.exit === EXIT.AHEAD_DIVERGED);
  check("领先态摘要 state=ahead", r.state === STATE.AHEAD);
  check("领先态不打印 pull（禁静默 pull 掩盖）", !r.lines.some((l) => l.includes("pull --ff-only")));
  check("领先态显式说明", r.lines.some((l) => l.includes("领先")));
}
// 分叉：双向都不是祖先 ⇒ exit 2，显式报，**不打印 pull**。
{
  const { runner } = scripted([
    ...baseScenes(HASH_A, HASH_B),
    { match: match.behindQ, result: { status: 1, stdout: "" } },
    { match: match.aheadQ, result: { status: 1, stdout: "" } },
  ]);
  const r = runCheck({ repo: "/fake", fetch: true, runner });
  check("分叉态 exit 2", r.exit === EXIT.AHEAD_DIVERGED);
  check("分叉态摘要 state=diverged", r.state === STATE.DIVERGED);
  check("分叉态不打印 pull（禁静默 pull 掩盖）", !r.lines.some((l) => l.includes("pull --ff-only")));
  check("分叉态显式说明", r.lines.some((l) => l.includes("分叉")));
}

console.log("\n=== fetch 失败与环境错 ===");
// fetch 失败：看 fetch 自己的退出码，硬停，不判三态（rev-parse 都不许走到）。
{
  const { runner, calls } = scripted([
    { match: match.inside, result: ok() },
    { match: match.fetch, result: { status: 128, stdout: "", stderr: "fatal: unable to access" } },
  ]);
  const r = runCheck({ repo: "/fake", fetch: true, runner });
  check("fetch 失败 exit 3", r.exit === EXIT.FETCH_FAIL);
  check("fetch 失败摘要 state=fetch-failed", r.state === STATE.FETCH_FAIL);
  check("fetch 失败不判三态（rev-parse 没被调）", !calls.some((c) => c.startsWith("rev-parse --verify")));
  check("fetch 失败显式报退出码", r.lines.some((l) => l.includes("exit 128")));
}
// 不是 git 工作树 ⇒ exit 4（目录守卫）。
{
  const { runner } = scripted([{ match: match.inside, result: { status: 128, stdout: "" } }]);
  const r = runCheck({ repo: "/fake", fetch: true, runner });
  check("非 git 工作树 exit 4", r.exit === EXIT.ENV);
}
// 本地引用不存在 ⇒ exit 4。
{
  const { runner } = scripted([
    { match: match.inside, result: ok() },
    { match: match.fetch, result: ok() },
    { match: match.local, result: { status: 1, stdout: "" } },
  ]);
  const r = runCheck({ repo: "/fake", fetch: true, runner });
  check("本地 master 引用缺失 exit 4", r.exit === EXIT.ENV);
}
// 远端引用不存在（fetch 过了还没有）⇒ exit 4。
{
  const { runner } = scripted([
    { match: match.inside, result: ok() },
    { match: match.fetch, result: ok() },
    { match: match.local, result: ok(HASH_A + "\n") },
    { match: match.remote, result: { status: 1, stdout: "" } },
  ]);
  const r = runCheck({ repo: "/fake", fetch: true, runner });
  check("origin/master 引用缺失 exit 4", r.exit === EXIT.ENV);
}

console.log("\n=== 真实跑（本仓 · --no-fetch · 不碰网络）===");
// 真脚本 + 真 git + 真退出码。地面真相独立重算（同一通道 rev-parse / merge-base），
// 不读脚本输出做判定——脚本退出码必须与地面真相一致，摘要 state 必须与退出码一致。
{
  const script = path.join(REPO, "scripts", "dao-pre-dispatch.mjs");
  const real = spawnSync(process.execPath, [script, "--repo", REPO, "--no-fetch"], {
    encoding: "utf8", cwd: REPO, windowsHide: true,
  });
  const out = String(real.stdout || "") + String(real.stderr || "");
  const m = out.match(/PRE_DISPATCH_SUMMARY exit=(\d+) state=(\S+)/);

  const gt = (args) => spawnSync("git", args, { cwd: REPO, encoding: "utf8", windowsHide: true });
  const gtl = gt(["rev-parse", "--verify", "--quiet", "refs/heads/master"]);
  const gtr = gt(["rev-parse", "--verify", "--quiet", "refs/remotes/origin/master"]);
  let ground;
  if (gtl.status !== 0 || gtr.status !== 0) ground = EXIT.ENV;
  else if (gtl.stdout.trim() === gtr.stdout.trim()) ground = EXIT.OK;
  else if (gt(["merge-base", "--is-ancestor", "refs/heads/master", "refs/remotes/origin/master"]).status === 0) ground = EXIT.BEHIND;
  else ground = EXIT.AHEAD_DIVERGED;

  check("真实跑：脚本退出码 == 地面真相", real.status === ground, `script=${real.status} ground=${ground}`);
  check("真实跑：摘要行可解析", !!m, out.split(/\r?\n/).slice(0, 3).join(" | "));
  if (m) {
    const stateConsistent = (m[2] === "sync") === (ground === EXIT.OK) &&
      (m[2] === "behind") === (ground === EXIT.BEHIND) &&
      (m[2] === "ahead" || m[2] === "diverged") === (ground === EXIT.AHEAD_DIVERGED) &&
      (m[2] === "env-error") === (ground === EXIT.ENV);
    check("真实跑：摘要 state 与退出码一致", stateConsistent, m[2]);
  }
  console.log(`  真机输出：${out.split(/\r?\n/).filter(Boolean).join(" | ")}`);
}

console.log(`\ndao-pre-dispatch.tests  pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
