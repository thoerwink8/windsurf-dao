// 「改 UI 必动 design/」git 提交闸 回归网 — 正负控 + 真 git 仓集成 + 双向 mutation
//
// 跑法：node tests/design-sync-precommit.tests.js   （全绿 exit 0，任一红 exit 1）
//       node scripts/run-tests.mjs                  （扫目录自动发现，无需登记）
//
// ── 被测对象 ────────────────────────────────────────────────────────────────
// ccswitch/templates/githooks/pre-commit（canonical；项目侧是派生副本，清单条目
// design-sync-precommit）。**在真 git 仓里、经 `core.hooksPath` 真接线之后跑真 `git commit`** ——
// 不直接 `sh pre-commit` 了事：这道闸最贵的失效形态恰恰是「文件在盘上但 git 从来不调它」，
// 而那一面只有走完整条接线才验得到（同 dao 三例「55 天零生效」事故的共同误判：只看文件在不在）。
//
// ── 环境依赖照直说 ──────────────────────────────────────────────────────────
// 需要 `sh`（Windows 上由 Git for Windows 提供）。**探不到 sh 时本文件 exit 1 而不是静默跳过** ——
// 「没跑」与「跑过且全过」在退出码上必须分得开，那正是本仓反复在治的病。

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const REPO = path.resolve(__dirname, "..");
const HOOK = path.join(REPO, "ccswitch", "templates", "githooks", "pre-commit");
const TMP = path.join(REPO, "_tmp", "design-sync-precommit-tests");

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail ? "  ->  " + detail : "")); }
}
function rmrf(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }
function mkdirp(p) { fs.mkdirSync(p, { recursive: true }); }

// ── sh 探测：先 PATH，PATH 上没有就从 git.exe 反推 Git for Windows 自带的那个 ──────
// 🔴 为什么不能只探 PATH：**同一台机器、同一份代码，换个 shell 跑就变色**——
//    Bash 工具环境里 `sh` 在 PATH（MSYS）⇒ 全绿；PowerShell 里不在（PATH 只有
//    `…\Git\cmd`，而 sh.exe 住在 `…\Git\usr\bin\`）⇒ 报「环境缺 sh」`PASS=0 FAIL=1`。
//    而合并链 `dao-pr-merge.ps1` 的合并态验证正是**从 PowerShell** 跑 run-tests ⇒ 这一条
//    会拦下每一个 PR，且拦的理由跟被测对象毫无关系。
//    这属「测试读共享环境却不把它钉住」，与今天另两起（payload 不带 cwd ⇒ 红绿取决于在哪个
//    目录敲命令）同族：**别人的环境变了，你的测试就变色，而变色的原因不在被测代码里。**
// 反推判据：`git` 必在 PATH（否则下面 makeRepo 也没法跑），而 Git for Windows 的 sh 就在
//    git.exe 之上的固定相对位置。**候选逐个实跑一次 `sh -c "echo ok"` 才算数**——「文件存在」
//    是弱判据（本仓「只看文件在不在」已经栽过三次 55 天零生效）。
// 下面那条「探不到就红」的行为**刻意不动**：把「没跑」报成「通过」正是本仓在治的病。
function resolveSh() {
  const probed = [];
  const works = (cmd) => {
    const r = spawnSync(cmd, ["-c", "echo ok"], { encoding: "utf8", windowsHide: true });
    const ok = !r.error && r.status === 0 && /ok/.test(String(r.stdout || ""));
    // 三种失败分开写：起不来 / 起来了但退出码非 0 / 退出码 0 但没吐出预期输出。
    // 混成一句「exit 0」会让第三种在诊断行里长得像成功——探测器的输出骗不了机器，
    // 但会骗到读它的人，而这行字存在的唯一理由就是给人读。
    const why = r.error ? String(r.error.code || r.error.message)
      : r.status !== 0 ? "exit " + r.status
      : "exit 0 但未吐出预期输出";
    probed.push(`${cmd} → ${ok ? "可用 ✓" : why}`);
    return ok;
  };
  if (works("sh")) return { sh: "sh", probed };

  let gitExe = "";
  for (const finder of process.platform === "win32" ? ["where", "which"] : ["which"]) {
    const w = spawnSync(finder, ["git"], { encoding: "utf8", windowsHide: true });
    gitExe = String(w.stdout || "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0] || "";
    if (gitExe) break;
  }
  if (!gitExe) { probed.push("where/which git → 没找到 git，无从反推 sh"); return { sh: null, probed }; }
  probed.push("git → " + gitExe);

  // git.exe 可能在 <root>/cmd、<root>/bin、<root>/mingw64/bin ⇒ 往上走三级各试一轮
  let dir = path.dirname(gitExe);
  for (let up = 0; up < 3; up++) {
    for (const rel of [["usr", "bin", "sh.exe"], ["bin", "sh.exe"], ["usr", "bin", "sh"], ["bin", "sh"]]) {
      const cand = path.join(dir, ...rel);
      if (!fs.existsSync(cand)) continue;      // 不存在的候选不进 probed，否则刷屏
      if (works(cand)) return { sh: cand, probed };
    }
    dir = path.resolve(dir, "..");
  }
  return { sh: null, probed };
}

const { sh: SH, probed: SH_PROBED } = resolveSh();
if (!SH) {
  console.log("  FAIL  环境缺 sh，本回归网一条都没跑（这不是「通过」）");
  console.log("        探过这些位置（顺序即优先级）：");
  for (const p of SH_PROBED) console.log("          · " + p);
  console.log("\n=== 汇总: PASS=0 FAIL=1 ===");
  process.exit(1);
}
// PATH 上没有、靠反推才找到时说一声：让操作者看得见「这一跑用的不是你以为的那个 sh」
if (SH !== "sh") console.log(`  ⓘ PATH 上没有 sh，反推到 Git for Windows 自带的：${SH}`);

function git(cwd, args) {
  return spawnSync("git", ["-C", cwd].concat(args), { encoding: "utf8", windowsHide: true });
}

let seq = 0;
// 造一个真 git 仓：接线 hooksPath、装钩子、给一个可提交的初始 commit。
function makeRepo(opts) {
  const root = path.join(TMP, "repo" + (++seq));
  rmrf(root);
  mkdirp(root);
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "test@example.invalid"]);
  git(root, ["config", "user.name", "dao-test"]);
  git(root, ["config", "commit.gpgsign", "false"]);
  mkdirp(path.join(root, ".githooks"));
  const body = opts && opts.hookBody !== undefined ? opts.hookBody : fs.readFileSync(HOOK, "utf8");
  fs.writeFileSync(path.join(root, ".githooks", "pre-commit"), body, "utf8");
  try { fs.chmodSync(path.join(root, ".githooks", "pre-commit"), 0o755); } catch (_) {}
  if (!opts || opts.wire !== false) git(root, ["config", "core.hooksPath", ".githooks"]);
  if (!opts || opts.design !== false) {
    mkdirp(path.join(root, "design"));
    fs.writeFileSync(path.join(root, "design", "CONTEXT.md"), "# 设计对齐\n\n## 待反向同步队列\n", "utf8");
  }
  fs.writeFileSync(path.join(root, "README.md"), "seed\n", "utf8");
  git(root, ["add", "-A"]);
  const seed = git(root, ["commit", "-q", "-m", "seed", "--no-verify"]);
  if (seed.status !== 0) throw new Error("夹具仓初始提交失败：" + seed.stderr);
  return root;
}

function writeFile(root, rel, content) {
  const full = path.join(root, rel);
  mkdirp(path.dirname(full));
  fs.writeFileSync(full, content, "utf8");
}

function commit(root, msg, extraArgs) {
  const r = git(root, ["commit", "-m", msg || "test"].concat(extraArgs || []));
  return { code: r.status, out: String(r.stdout || "") + String(r.stderr || "") };
}

const UI = 'export const Panel = () => <div className="p-2">hi</div>\n';

rmrf(TMP);
mkdirp(TMP);

// ── ① 正控：改 UI 不动 design/ ⇒ 提交被拦 ──────────────────────────────────
console.log("\n① 正控 — 改 UI 而 design/ 零改动，提交必须被拦");
{
  const root = makeRepo();
  writeFile(root, "src/components/panel.tsx", UI);
  git(root, ["add", "-A"]);
  const r = commit(root);
  check("git commit 被拦（非零退出）", r.code !== 0, "code=" + r.code);
  check("报文点名了那个组件文件", r.out.includes("src/components/panel.tsx"), r.out.slice(0, 400));
  check("给出两条出路而不是只说不行", r.out.includes("两条出路"), r.out.slice(0, 400));
  check("提交确实没落地（HEAD 还是 seed）",
    git(root, ["log", "-1", "--pretty=%s"]).stdout.trim() === "seed");
}

// ── ② 负控：同批动了 design/ ⇒ 放行 ────────────────────────────────────────
console.log("\n② 负控 — 同一批里动了 design/，必须放行");
{
  const root = makeRepo();
  writeFile(root, "src/components/panel.tsx", UI);
  writeFile(root, "design/pages/panel.html", "<html><body>proto</body></html>\n");
  git(root, ["add", "-A"]);
  const r = commit(root, "ui + design");
  check("提交通过", r.code === 0, r.out.slice(0, 400));

  // 「登记欠账」那条出路：只改 design/CONTEXT.md 也算动了 design/
  const root2 = makeRepo();
  writeFile(root2, "src/components/panel.tsx", UI);
  writeFile(root2, "design/CONTEXT.md", "# 设计对齐\n\n## 待反向同步队列\n- panel.tsx 待反向同步\n");
  git(root2, ["add", "-A"]);
  check("只登记欠账（改 CONTEXT.md）也放行 —— 登记本身即解锁", commit(root2, "debt").code === 0);
}

// ── ③ 不适用面：没有 design/ 的仓恒放行 ────────────────────────────────────
console.log("\n③ 不适用 — 没有 design/ 的仓不该被这道闸打扰");
{
  const root = makeRepo({ design: false });
  writeFile(root, "src/components/panel.tsx", UI);
  git(root, ["add", "-A"]);
  check("无 design/ ⇒ 放行", commit(root).code === 0);
}

// ── ④ 非 UI 改动不该被拦 ──────────────────────────────────────────────────
console.log("\n④ 负控 — 非 UI 改动零误伤");
{
  const root = makeRepo();
  writeFile(root, "src/lib/util.ts", "export const add = (a: number, b: number) => a + b\n");
  writeFile(root, "docs/note.md", "note\n");
  writeFile(root, "src/components/panel.spec.tsx", "it('x', () => {})\n"); // 测试文件排除
  git(root, ["add", "-A"]);
  check("纯逻辑/文档/测试文件 ⇒ 放行", commit(root).code === 0);
}

// ── ⑤ UI_RE 覆盖面：路径形态各一例 ────────────────────────────────────────
console.log("\n⑤ 覆盖面 — components/*.{tsx,vue,svelte} / App.tsx / index.css 各拦一次");
{
  const cases = [
    ["apps/desktop/src/components/a.tsx", UI],
    ["src/components/b.vue", "<template><div/></template>\n"],
    ["packages/ui/src/components/c.svelte", "<div/>\n"],
    ["src/App.tsx", UI],
    ["src/index.css", ":root { --a: 1 }\n"],
  ];
  for (const [rel, body] of cases) {
    const root = makeRepo();
    writeFile(root, rel, body);
    git(root, ["add", "-A"]);
    check("拦得住 " + rel, commit(root).code !== 0);
  }
  // 负控：components/ 下的非 UI 扩展名不该被拦（判据只认那几个扩展名）
  const root = makeRepo();
  writeFile(root, "src/components/README.md", "doc\n");
  git(root, ["add", "-A"]);
  check("负控：components/README.md 不拦（不是恒红）", commit(root).code === 0);
}

// ── ⑥ 未接线时它一个字节都做不了（这才是这道闸最贵的失效形态）──────────────
console.log("\n⑥ 接线 — 没设 core.hooksPath 时闸整条失效，且 selfcheck 要当场说出来");
{
  const root = makeRepo({ wire: false });
  writeFile(root, "src/components/panel.tsx", UI);
  git(root, ["add", "-A"]);
  check("没接线 ⇒ 提交照过（文件在盘上 ≠ 闸在跑）", commit(root).code === 0);

  const sc = spawnSync(SH, [path.join(root, ".githooks", "pre-commit"), "--selfcheck"],
    { cwd: root, encoding: "utf8" });
  const out = String(sc.stdout || "") + String(sc.stderr || "");
  check("--selfcheck 明说 core.hooksPath 没设", out.includes("core.hooksPath 没设"), out.slice(0, 400));

  const root2 = makeRepo();
  const sc2 = spawnSync(SH, [path.join(root2, ".githooks", "pre-commit"), "--selfcheck"],
    { cwd: root2, encoding: "utf8" });
  const out2 = String(sc2.stdout || "") + String(sc2.stderr || "");
  check("接了线 ⇒ selfcheck 报出 hooksPath（负控：不是恒红）",
    /core\.hooksPath = \.githooks/.test(out2), out2.slice(0, 400));
  check("selfcheck 报出版本号（对派生副本时用得上）", /version=\d+\.\d+\.\d+/.test(out2), out2.slice(0, 200));
}

// ── ⑦ 已知漏洞照测不误：--no-verify 绕得过 ────────────────────────────────
// 这一条不是「缺陷」，是本闸声明过的射程边界。**把边界写成断言**，
// 免得日后有人以为它防得住「要绕的人」，也免得有人「修好」它之后没人知道语义变了。
console.log("\n⑦ 射程边界 — --no-verify 绕得过（这是声明过的，不是缺陷）");
{
  const root = makeRepo();
  writeFile(root, "src/components/panel.tsx", UI);
  git(root, ["add", "-A"]);
  check("--no-verify 照样提交得上去", commit(root, "bypass", ["--no-verify"]).code === 0);
  check("头注里写着这条边界（红了说明边界被删或被改）",
    fs.readFileSync(HOOK, "utf8").includes("--no-verify"));
}

// ── ⑧ 双向 mutation：把判定摘掉，正控必须从红变绿 ─────────────────────────
console.log("\n⑧ mutation — 摘掉 design/ 判定后正控退化成放行 ⇒ 原断言不是恒真");
{
  const src = fs.readFileSync(HOOK, "utf8");
  const needle = "[ -z \"$ui_changed\" ] && exit 0";
  check("mutation 锚点仍在（锚失效则本组空转）", src.includes(needle), needle);
  const root = makeRepo({ hookBody: src.replace(needle, "exit 0 # mutated") });
  writeFile(root, "src/components/panel.tsx", UI);
  git(root, ["add", "-A"]);
  check("摘掉判定后同一场景变成放行", commit(root).code === 0);
}

// ── ⑧.5 行尾：CRLF 会让这个钩子在类 Unix 上整条报废 ───────────────────────
// `\r` 会被 sh 当成命令的一部分（`\r: command not found`），而**失败发生在派生它的那个项目里、
// 不在本仓** —— 本仓这边一切正常，故这道断言必须在本仓这边。
// `.gitattributes` 有对应条目（`*.sh` 盖不到无扩展名的 `pre-commit`）。
console.log("\n⑧.5 行尾 — 模板必须是 LF");
{
  const raw = fs.readFileSync(HOOK, "utf8");
  check("模板正文零 CRLF", !raw.includes("\r\n"), "含 " + (raw.split("\r\n").length - 1) + " 处 CRLF");
  const ga = fs.readFileSync(path.join(REPO, ".gitattributes"), "utf8");
  check(".gitattributes 有 githooks 的 eol=lf 条目（否则下次 clone 会重新 CRLF 化）",
    /ccswitch\/templates\/githooks\/\*\s+text\s+eol=lf/.test(ga), ga);
}

// ── ⑨ 三通道分工的真相源指针不能指向空气 ─────────────────────────────────
console.log("\n⑨ 指针 — 模板头注引的那个真相源必须真的存在且真的有那一节");
{
  const src = fs.readFileSync(HOOK, "utf8");
  check("模板头注只留指针、不复述分工（不含表格行）", !src.includes("| 通道 |"));
  check("指针指向 dao-design-sync-gate.js", src.includes("dao-design-sync-gate.js"));
  const gate = path.join(REPO, "ccswitch", "hooks", "dao-design-sync-gate.js");
  check("那个文件在盘上", fs.existsSync(gate));
  if (fs.existsSync(gate)) {
    const g = fs.readFileSync(gate, "utf8");
    check("且真的有「三通道分工」这一节（不是指向空气的指针）", g.includes("三通道分工"));
    check("那一节自陈是唯一真相源", /三通道分工[^\n]*唯一真相源|本节是这三者关系的唯一真相源/.test(g));
    // 同一份头注里不许同时躺着两个通道数 —— 「同一条规则多份措辞各自漂移」正是那一节要治的病，
    // 头注自己先犯一次就没法自圆。原文那句「现在是双通道并存」已在加第三条时改掉并留了订正行。
    check("头注里没有仍在生效的「双通道并存」旧说法", !g.includes("所以现在是**双通道并存**"),
      "旧说法还在 ⇒ 同一份文件里两个互相矛盾的通道数");
  }
}

rmrf(TMP);
console.log("\n=== 汇总: PASS=" + pass + " FAIL=" + fail + " ===");
process.exit(fail ? 1 : 0);
