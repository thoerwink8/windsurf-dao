// dao-worktree-create.tests.js — 建树备注硬闸（issue #360 拍板 5-A/B）的自测
//
// 两层：① validateComment 纯函数——合法串过 + 每一种违规各有一例红（断 code 不 grep 散文）；
//       ② CLI 真实跑（spawnSync 真脚本、真退出码）——缺备注 exit 2 / 格式错 exit 3 /
//          合法 + --dry-run exit 0 且不真建树（全程不碰 orca 实况）。
// 零样本闸：结尾断言「实际跑过的用例数 == 预期数」——数到 0 和没看到样本输出一样，
// 用例被静默跳过时这里红。
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateComment, FORMS, BATONS, MAX_LEN, EXIT } from "../scripts/dao-worktree-create.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(REPO, "scripts", "dao-worktree-create.mjs");
let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? "  →  " + detail : ""}`); }
}

console.log("\n=== ① 纯函数：合法串（设计稿 5.2 真实举例 + 边界）===");
const LEGAL = [
  "树帅制 · 对抗官在跑 · 等 mutation 红集归因",
  "轻装单兵 · 实现官在写 · 无阻",
  "多树并行 · 待终审 · 等 #360 拍板",
  // 边界：恰好 40 字符（码点数）必须过
  "多树并行 · 实现官在写 · 等" + "x".repeat(24),
];
for (const c of LEGAL) {
  const len = [...c].length;
  check(`合法过（${len} 字符）：${c.slice(0, 24)}…`, validateComment(c).ok === true,
    JSON.stringify(validateComment(c)));
}
check("边界样本确实是 40 字符", [...LEGAL[3]].length === MAX_LEN, String([...LEGAL[3]].length));

console.log("\n=== ① 纯函数：每一种违规各有一例红 ===");
const ILLEGAL = [
  ["empty", ""],
  ["empty", "   "],
  ["too-long", "多树并行 · 实现官在写 · 等" + "x".repeat(25)], // 41 字符
  ["separator", "树帅制·派单中·无阻"],                         // 无空格的「·」⇒ 1 格
  ["separator", "树帅制 · 派单中"],                             // 只有两格
  ["separator", "树帅制 - 派单中 - 无阻"],                      // 分隔符用了 -
  ["form", "重装旅 · 派单中 · 无阻"],                           // 形态不在三值枚举
  ["baton", "树帅制 · 摸鱼中 · 无阻"],                          // 棒次不在五值枚举
  ["wait-empty", "树帅制 · 派单中 ·  "],                        // 第三格空白
];
for (const [code, c] of ILLEGAL) {
  const v = validateComment(c);
  check(`违规红（${code}）：「${c.slice(0, 20)}」`, v.ok === false && v.code === code,
    JSON.stringify(v));
}
// 超长样本地面真相：确实是 41 字符
check("超长样本确实是 41 字符", [...ILLEGAL[2][1]].length === MAX_LEN + 1, String([...ILLEGAL[2][1]].length));
// 枚举面完整性：每个枚举值本身都能过（枚举表改动时这里红，防「表改了校验没跟」）
for (const f of FORMS) {
  check(`枚举形态可用：${f}`, validateComment(`${f} · 派单中 · 无阻`).ok === true);
}
for (const b of BATONS) {
  check(`枚举棒次可用：${b}`, validateComment(`树帅制 · ${b} · 无阻`).ok === true);
}

console.log("\n=== ② CLI 真实跑（真脚本 · 真退出码 · --dry-run 不碰 orca 实况）===");
function runCli(args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", cwd: REPO, windowsHide: true });
  return { status: r.status, out: String(r.stdout || "") + String(r.stderr || "") };
}
// 缺 --comment ⇒ exit 2，不建树
{
  const r = runCli(["--dry-run", "--name", "fake-tree"]);
  check("缺备注 exit 2", r.status === EXIT.NO_COMMENT, `exit=${r.status}`);
  check("缺备注摘要 stage=validate code=empty", r.out.includes("WORKTREE_CREATE_SUMMARY exit=2 stage=validate code=empty"),
    r.out.split(/\r?\n/).filter(Boolean).slice(-1)[0]);
  check("缺备注不走到建树", !r.out.includes("DRY-RUN") && !r.out.includes("将执行"));
}
// 格式不合 ⇒ exit 3，不建树
{
  const r = runCli(["--dry-run", "--comment", "重装旅 · 派单中 · 无阻"]);
  check("形态违规 exit 3", r.status === EXIT.BAD_FORMAT, `exit=${r.status}`);
  check("形态违规摘要 code=form", r.out.includes("stage=validate code=form"),
    r.out.split(/\r?\n/).filter(Boolean).slice(-1)[0]);
  check("形态违规不走到建树", !r.out.includes("DRY-RUN"));
}
{
  const r = runCli(["--dry-run", "--comment", "树帅制·派单中·无阻"]);
  check("分隔符违规 exit 3 code=separator", r.status === EXIT.BAD_FORMAT && r.out.includes("code=separator"), `exit=${r.status}`);
}
// 合法 + --dry-run ⇒ exit 0，打印将执行命令，不真建树
{
  const r = runCli(["--dry-run", "--comment", "轻装单兵 · 实现官在写 · 无阻", "--name", "fake-tree"]);
  check("合法备注 dry-run exit 0", r.status === EXIT.OK, `exit=${r.status}\n${r.out}`);
  check("合法备注摘要 stage=dry-run", r.out.includes("WORKTREE_CREATE_SUMMARY exit=0 stage=dry-run"));
  check("dry-run 打印将执行的完整命令（含透传参数与 --comment）",
    r.out.includes("orca worktree create") && r.out.includes("--name fake-tree") && r.out.includes("--comment"));
}

// ── 零样本闸：用例必须真的被跑了 ─────────────────────────────────────
// 上面每一块的用例数是静态可数的；跑出来的总数对不上 ⇒ 有用例被静默跳过 ⇒ 判红。
const EXPECTED = LEGAL.length + 1 + ILLEGAL.length + 1 + FORMS.length + BATONS.length + 10;
check(`用例总数 == 预期 ${EXPECTED}`, pass + fail === EXPECTED, `actual=${pass + fail}`);

console.log(`\ndao-worktree-create.tests  pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
