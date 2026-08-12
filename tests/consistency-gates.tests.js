// consistency-gates.tests.js —— 两道一致性闸（scripts/lib/consistency-gates.mjs）的自测。
//
// 守的对象：
//   ㈠ checkCommandTableImplemented —— ccswitch/dao.md 命令表列的 /命令 是否都有实现。
//   ㈡ checkSkillsDeployed —— ccswitch/skills 每个应部署的 skill 在 ~/.claude/skills 是否有活链。
// 两个都是静默失效型部件：挂了的样子和放行的样子一样（都 exit 0）。所以每道闸配自测。
//
// 判别力自问：把闸的判据改坏，下面是否至少有一条断言变红？末尾三条 mutation 钉住这一问——
// 没有 mutation 的正控只证明「今天是绿的」，证明不了「它明天变坏时会红」。
//
// 纪律：fixture 一律建在 <repo>/_tmp/ 下带 pid 的临时目录里，跑完 rmSync 清掉；
// 不许碰真 ~/.claude、不许写仓内其他路径。锚点断言用的串 = 喂给 replace() 的同一个表达式。

const fs = require("fs");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");

const REPO = path.resolve(__dirname, "..");
const LIB = path.join(REPO, "scripts", "lib", "consistency-gates.mjs");
const HOME = process.env.USERPROFILE || process.env.HOME || os.homedir();
const TMP = path.join(REPO, "_tmp");

let pass = 0, failN = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { failN++; console.log(`  FAIL  ${name}${detail ? "  →  " + detail : ""}`); }
}

const created = [];
function fixtureDir(tag) {
  const d = path.join(TMP, `gate3-fixture-${tag}-${process.pid}`);
  fs.rmSync(d, { recursive: true, force: true });
  fs.mkdirSync(d, { recursive: true });
  created.push(d);
  return d;
}

/** 假仓：ccswitch/dao.md（可含命令表节）+ 空 commands/skills 目录。 */
function writeFakeDaoMd(fixtureRepo, daoMdBody) {
  const cc = path.join(fixtureRepo, "ccswitch");
  fs.mkdirSync(path.join(cc, "commands"), { recursive: true });
  fs.mkdirSync(path.join(cc, "skills"), { recursive: true });
  fs.writeFileSync(path.join(cc, "dao.md"), daoMdBody, "utf8");
}

/** 假仓：ccswitch/skills/<n>/SKILL.md 若干 + 指定 dao.ps1。 */
function writeFakeSkillRepo(fixtureRepo, skillNames, daoPs1Body) {
  const skills = path.join(fixtureRepo, "ccswitch", "skills");
  for (const n of skillNames) {
    fs.mkdirSync(path.join(skills, n), { recursive: true });
    fs.writeFileSync(path.join(skills, n, "SKILL.md"), `---\nname: ${n}\n---\n`, "utf8");
  }
  fs.writeFileSync(path.join(fixtureRepo, "dao.ps1"), daoPs1Body, "utf8");
}

const FAKE_PS1_WITH_BETA = 'function Get-InternalOnlySkills {\n    return @(\n        "beta"\n    )\n}\n';
const FAKE_PS1_NO_FUNCTION = "# 没有 Get-InternalOnlySkills 的 dao.ps1\nfunction Other { return 1 }\n";

/** 在 fixture home 的 .claude/skills 下建一条链（junction/目录链接）。 */
function mkLink(home, name, targetDir) {
  const p = path.join(home, ".claude", "skills", name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.symlinkSync(targetDir, p, process.platform === "win32" ? "junction" : "dir");
}

async function main() {
  const { checkCommandTableImplemented, checkSkillsDeployed } = await import(pathToFileURL(LIB).href);

  console.log("\n=== 正控（真仓真环境）===");
  const g1 = checkCommandTableImplemented({ repoRoot: REPO });
  check("闸㈠正控 真仓命令表无缺失", g1.fails.length === 0, JSON.stringify(g1.fails));
  const g2 = checkSkillsDeployed({ repoRoot: REPO, homeDir: HOME });
  // R5：不再断恒真式（fails+greens>=1 对所有 return 路径恒真，判别力≈0）。
  // 改为按两种合法终局分别断言：worktree/无 .claude 语境 ⇒ 显式跳过（greens 含「跳过」）；
  // 部署源仓语境 ⇒ 走了检查路径（fails≥1 或 greens 含「全部有活链」）。两形互斥且穷尽。
  const g2Skip = g2.fails.length === 0 && g2.greens.length === 1 && g2.greens[0].includes("跳过");
  const g2Checked = g2.fails.length >= 1 || g2.greens.some((l) => l.includes("全部有活链"));
  check("闸㈡正控 真环境终局合法（worktree⇒跳过 / 部署源仓⇒走检查），非恒真",
    g2Skip || g2Checked,
    `skip=${g2Skip} checked=${g2Checked} ${JSON.stringify({ fails: g2.fails, greens: g2.greens })}`);

  console.log("\n=== 闸㈠ · 负控（会红的证据）===");
  const ghost = fixtureDir("ghost");
  writeFakeDaoMd(ghost, "# fixture\n\n## 器 · 命令表\n\n`/ghost-cmd` 不存在于任何实现。\n");
  const g3 = checkCommandTableImplemented({ repoRoot: ghost });
  check("闸㈠负控 ghost-cmd ⇒ 红且 evidence 含名",
    g3.fails.length === 1 && String(g3.fails[0][2]).includes("ghost-cmd"), JSON.stringify(g3.fails));

  console.log("\n=== 闸㈠ · 零样本控（数到 0 = 没查成）===");
  const noSec = fixtureDir("no-section");
  writeFakeDaoMd(noSec, "# fixture\n\n没有命令表节。\n");
  const g4 = checkCommandTableImplemented({ repoRoot: noSec });
  check("闸㈠零样本 无「## 器」节 ⇒ 红", g4.fails.length === 1, JSON.stringify(g4.fails));
  const noCmd = fixtureDir("no-command");
  writeFakeDaoMd(noCmd, "# fixture\n\n## 器 · 命令表\n\n判据：**用户有没有理由亲手敲它**。\n");
  const g5 = checkCommandTableImplemented({ repoRoot: noCmd });
  check("闸㈠零样本 节内无反引号命令 ⇒ 红", g5.fails.length === 1, JSON.stringify(g5.fails));

  console.log("\n=== 闸㈡ · 负控（会红的证据）===");
  const neg2 = fixtureDir("deploy-neg");
  writeFakeSkillRepo(neg2, ["alpha", "beta"], FAKE_PS1_WITH_BETA);
  const neg2Home = fixtureDir("deploy-neg-home");
  // 部署源仓 = neg2 自己（beta 链指向 neg2），alpha 应部署却无链 ⇒ 真漂移必须红。
  const neg2Link = path.join(neg2Home, ".claude", "skills", "beta");
  fs.mkdirSync(path.dirname(neg2Link), { recursive: true });
  fs.symlinkSync(path.join(neg2, "ccswitch", "skills", "beta"), neg2Link,
    process.platform === "win32" ? "junction" : "dir");
  const g6 = checkSkillsDeployed({ repoRoot: neg2, homeDir: neg2Home });
  check("闸㈡负控 alpha 未部署 ⇒ 红且 evidence 含 alpha",
    g6.fails.length === 1 && String(g6.fails[0][2]).includes("alpha"), JSON.stringify(g6.fails));

  console.log("\n=== 闸㈡ · 跳过控（非部署环境不许装成通过）===");
  const skipHome = fixtureDir("skip-home");
  const g7 = checkSkillsDeployed({ repoRoot: neg2, homeDir: skipHome });
  check("闸㈡跳过控 无 .claude ⇒ 绿且含「跳过」",
    g7.fails.length === 0 && g7.greens.some((l) => l.includes("跳过")),
    JSON.stringify({ fails: g7.fails, greens: g7.greens }));

  console.log("\n=== 闸㈡ · 排除清单控（钉住清单真的被读进来了）===");
  const excl = fixtureDir("excl");
  writeFakeSkillRepo(excl, ["alpha", "beta"], FAKE_PS1_WITH_BETA);
  const exclHome = fixtureDir("excl-home");
  const linkPath = path.join(exclHome, ".claude", "skills", "alpha");
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  fs.symlinkSync(path.join(excl, "ccswitch", "skills", "alpha"), linkPath,
    process.platform === "win32" ? "junction" : "dir");
  const g8 = checkSkillsDeployed({ repoRoot: excl, homeDir: exclHome });
  check("闸㈡排除清单控 beta 被排除且 alpha 有活链 ⇒ 绿",
    g8.fails.length === 0 && g8.greens.some((l) => l.includes("全部有活链")),
    JSON.stringify({ fails: g8.fails, greens: g8.greens }));

  console.log("\n=== 闸㈡ · 漂移控（抽出 0 条不许当空清单放行）===");
  const drift = fixtureDir("drift");
  writeFakeSkillRepo(drift, ["alpha", "beta"], FAKE_PS1_NO_FUNCTION);
  const driftHome = fixtureDir("drift-home");
  // 部署源 = drift 自己（beta 链），排除清单抽 0 条 ⇒ 红的是「清单漂移」这一格。
  const driftLink = path.join(driftHome, ".claude", "skills", "beta");
  fs.mkdirSync(path.dirname(driftLink), { recursive: true });
  fs.symlinkSync(path.join(drift, "ccswitch", "skills", "beta"), driftLink,
    process.platform === "win32" ? "junction" : "dir");
  const g9 = checkSkillsDeployed({ repoRoot: drift, homeDir: driftHome });
  check("闸㈡漂移控 无 Get-InternalOnlySkills ⇒ 红",
    g9.fails.length === 1, JSON.stringify(g9.fails));

  console.log("\n=== 闸㈡ · 上下文判据（非部署源仓显式跳过）===");
  const repoA = fixtureDir("repoA");
  writeFakeSkillRepo(repoA, ["alpha"], FAKE_PS1_WITH_BETA);
  const repoB = fixtureDir("repoB");
  writeFakeSkillRepo(repoB, ["beta"], FAKE_PS1_WITH_BETA);
  const homeA = fixtureDir("ctx-skip-home");
  const linkA = path.join(homeA, ".claude", "skills", "beta");
  fs.mkdirSync(path.dirname(linkA), { recursive: true });
  fs.symlinkSync(path.join(repoB, "ccswitch", "skills", "beta"), linkA,
    process.platform === "win32" ? "junction" : "dir");
  const c1 = checkSkillsDeployed({ repoRoot: repoA, homeDir: homeA });
  check("闸㈡上下文跳过控 链指向另一仓 ⇒ 绿且含「跳过」「不是部署源仓」",
    c1.fails.length === 0 && c1.greens.some((l) => l.includes("跳过") && l.includes("不是部署源仓")),
    JSON.stringify({ fails: c1.fails, greens: c1.greens }));

  const zeroHome = fixtureDir("ctx-zero-home");
  // 有 .claude/skills 目录，但里面只有真实目录、一条链都没有 ⇒ 零样本，不许跳过。
  fs.mkdirSync(path.join(zeroHome, ".claude", "skills", "real-dir"), { recursive: true });
  const c2 = checkSkillsDeployed({ repoRoot: repoA, homeDir: zeroHome });
  check("闸㈡上下文零样本 有目录但一条链都没有 ⇒ 红（不许跳过）",
    c2.fails.length === 1 && String(c2.fails[0][0]).includes("一条 dao skill 链都没有"),
    JSON.stringify({ fails: c2.fails, greens: c2.greens }));

  const caseHome = fixtureDir("ctx-case-home");
  const linkC = path.join(caseHome, ".claude", "skills", "beta");
  fs.mkdirSync(path.dirname(linkC), { recursive: true });
  // 同一仓根，一边 C:\\x 一边 c:/x：target 用小写盘符 + 正斜杠写 repoA，必须判成同一仓。
  const repoACasual = repoA.replace(/^([A-Za-z]):/, (_, d) => d.toLowerCase() + ":").replace(/\\/g, "/");
  fs.symlinkSync(path.join(repoACasual, "ccswitch", "skills", "beta"), linkC,
    process.platform === "win32" ? "junction" : "dir");
  const c3 = checkSkillsDeployed({ repoRoot: repoA, homeDir: caseHome });
  check("闸㈡上下文大小写/分隔符控 C:\\x 与 c:/x 算同一仓 ⇒ 判红不跳过",
    c3.fails.length === 1 && String(c3.fails[0][2]).includes("alpha"),
    JSON.stringify({ fails: c3.fails, greens: c3.greens }));

  console.log("\n=== 修红轮 · 对抗审必修 ②③④⑤⑥（修前绿 ⇒ 修后必须红）===");
  // ② 排除清单解析被注释抢占：注释里 return @( "alpha" ) 不得计入排除清单。
  const fix2 = fixtureDir("fix2-comment");
  writeFakeSkillRepo(fix2, ["alpha", "gamma"],
    'function Get-InternalOnlySkills {\n  # docs: return @( "alpha" )\n  return @(\n    "beta"\n  )\n}\n');
  const fix2Home = fixtureDir("fix2-comment-home");
  mkLink(fix2Home, "gamma", path.join(fix2, "ccswitch", "skills", "gamma"));
  const r2 = checkSkillsDeployed({ repoRoot: fix2, homeDir: fix2Home });
  check("修② 注释抢占 return @( ⇒ 红且 evidence 含 alpha",
    r2.fails.length === 1 && String(r2.fails[0][2]).includes("alpha"), JSON.stringify(r2.fails));

  // ③ 废多数票改集合包含：外来链只能让 S 变大，不能把 repoRoot 挤出。
  const fix3 = fixtureDir("fix3-repo");
  writeFakeSkillRepo(fix3, ["alpha", "beta"],
    'function Get-InternalOnlySkills {\n  return @(\n    "zzz-nonexistent"\n  )\n}\n');
  const foreign1 = fixtureDir("fix3-foreign1");
  writeFakeSkillRepo(foreign1, ["beta"], FAKE_PS1_WITH_BETA);
  const foreign2 = fixtureDir("fix3-foreign2");
  writeFakeSkillRepo(foreign2, ["gamma"], FAKE_PS1_WITH_BETA);
  const fix3Tie = fixtureDir("fix3-tie-home");
  mkLink(fix3Tie, "aaa-foreign", path.join(foreign1, "ccswitch", "skills", "beta"));
  mkLink(fix3Tie, "alpha", path.join(fix3, "ccswitch", "skills", "alpha"));
  const r3a = checkSkillsDeployed({ repoRoot: fix3, homeDir: fix3Tie });
  check("修③ 1 外来 + 1 有效同票 ⇒ 红且 evidence 含 beta（集合包含不被污染）",
    r3a.fails.length === 1 && String(r3a.fails[0][2]).includes("beta"), JSON.stringify(r3a.fails));
  const fix3Maj = fixtureDir("fix3-majority-home");
  mkLink(fix3Maj, "aaa-foreign", path.join(foreign1, "ccswitch", "skills", "beta"));
  mkLink(fix3Maj, "bbb-foreign", path.join(foreign2, "ccswitch", "skills", "gamma"));
  mkLink(fix3Maj, "alpha", path.join(fix3, "ccswitch", "skills", "alpha"));
  const r3b = checkSkillsDeployed({ repoRoot: fix3, homeDir: fix3Maj });
  check("修③ 2 外来 + 1 有效多数 ⇒ 红且 evidence 含 beta",
    r3b.fails.length === 1 && String(r3b.fails[0][2]).includes("beta"), JSON.stringify(r3b.fails));

  // ④ 活链身份校验：alpha 链到同仓 gamma（错名）必须红。
  const fix4 = fixtureDir("fix4-name");
  writeFakeSkillRepo(fix4, ["alpha", "beta", "gamma"],
    'function Get-InternalOnlySkills {\n  return @(\n    "beta",\n    "gamma"\n  )\n}\n');
  const fix4Home = fixtureDir("fix4-name-home");
  mkLink(fix4Home, "beta", path.join(fix4, "ccswitch", "skills", "beta"));
  mkLink(fix4Home, "alpha", path.join(fix4, "ccswitch", "skills", "gamma"));
  const r4 = checkSkillsDeployed({ repoRoot: fix4, homeDir: fix4Home });
  check("修④ alpha→gamma 同仓错名 ⇒ 红且 evidence 含 alpha",
    r4.fails.length === 1 && String(r4.fails[0][2]).includes("alpha"), JSON.stringify(r4.fails));
  // ④b 目标存在但无 SKILL.md ⇒ 红。
  const fix4b = fixtureDir("fix4b-noskillmd");
  writeFakeSkillRepo(fix4b, ["beta"], FAKE_PS1_WITH_BETA);
  fs.mkdirSync(path.join(fix4b, "ccswitch", "skills", "alpha"), { recursive: true });
  const fix4bHome = fixtureDir("fix4b-noskillmd-home");
  mkLink(fix4bHome, "alpha", path.join(fix4b, "ccswitch", "skills", "alpha"));
  const r4b = checkSkillsDeployed({ repoRoot: fix4b, homeDir: fix4bHome });
  check("修④b 目标目录无 SKILL.md ⇒ 红且 evidence 含 alpha",
    r4b.fails.length === 1 && String(r4b.fails[0][2]).includes("alpha"), JSON.stringify(r4b.fails));

  // ⑤ 命令表混合格式：一条合法反引号命令维持非零样本 + 裸写 /ghost-bare ⇒ 红。
  const fix5 = fixtureDir("fix5-bare");
  fs.mkdirSync(path.join(fix5, "ccswitch", "commands"), { recursive: true });
  fs.mkdirSync(path.join(fix5, "ccswitch", "skills"), { recursive: true });
  fs.writeFileSync(path.join(fix5, "ccswitch", "commands", "known.md"), "", "utf8");
  fs.writeFileSync(path.join(fix5, "ccswitch", "dao.md"),
    "## 器 table\n\n`/known` implemented\n\n/ghost-bare missing\n", "utf8");
  const r5 = checkCommandTableImplemented({ repoRoot: fix5 });
  check("修⑤ 反引号 /known + 裸写 /ghost-bare ⇒ 红且 evidence 含 ghost-bare",
    r5.fails.length === 1 && String(r5.fails[0][2]).includes("ghost-bare"), JSON.stringify(r5.fails));

  // ⑥ 悬空链：先建目标再删目标，链在但目标没了 ⇒ 红。
  const fix6 = fixtureDir("fix6-dangling");
  writeFakeSkillRepo(fix6, ["alpha", "beta"], FAKE_PS1_WITH_BETA);
  const fix6Home = fixtureDir("fix6-dangling-home");
  mkLink(fix6Home, "beta", path.join(fix6, "ccswitch", "skills", "beta"));
  const fix6Target = path.join(fix6Home, ".claude", "skills", "alpha-target-dir");
  fs.mkdirSync(fix6Target, { recursive: true });
  mkLink(fix6Home, "alpha", fix6Target);
  fs.rmSync(fix6Target, { recursive: true, force: true });
  const r6 = checkSkillsDeployed({ repoRoot: fix6, homeDir: fix6Home });
  check("修⑥ 悬空链（目标已删）⇒ 红且 evidence 含 alpha",
    r6.fails.length === 1 && String(r6.fails[0][2]).includes("alpha"), JSON.stringify(r6.fails));

  console.log("\n=== 复审挂账 G1/G3/G4/G5/G6（射程缺口）===");
  const mkCmdRepo = (tag) => {
    const d = fixtureDir(tag);
    fs.mkdirSync(path.join(d, "ccswitch", "commands"), { recursive: true });
    fs.mkdirSync(path.join(d, "ccswitch", "skills"), { recursive: true });
    fs.writeFileSync(path.join(d, "ccswitch", "commands", "known.md"), "", "utf8");
    return d;
  };
  // G5-1 全角逗号「，」后接裸写命令 ⇒ 漏红（修前）。
  const g51 = mkCmdRepo("g51-fwcomma");
  fs.writeFileSync(path.join(g51, "ccswitch", "dao.md"),
    "## 器 table\n\n`/known` implemented\n\n正文，/ghost-bare missing\n", "utf8");
  const q51 = checkCommandTableImplemented({ repoRoot: g51 });
  check("修G5-1 全角逗号后裸写 /ghost-bare ⇒ 红且 evidence 含 ghost-bare",
    q51.fails.length === 1 && String(q51.fails[0][2]).includes("ghost-bare"), JSON.stringify(q51.fails));
  // G5-2 落单反引号（奇数个）不跨行吞正文 ⇒ 漏红（修前）。
  // 形状：合法反引号命令在前，落单反引号在中间，另一对反引号在后吸收它——
  // 跨行配对会把行间裸写 /ghost-bare 吞掉（修前绿），按行处理则红。
  const g52 = mkCmdRepo("g52-lone-tick");
  fs.writeFileSync(path.join(g52, "ccswitch", "dao.md"),
    "## 器 table\n\n`/known` implemented\n` lone\n/ghost-bare missing\n`code` more text\n", "utf8");
  const q52 = checkCommandTableImplemented({ repoRoot: g52 });
  check("修G5-2 落单反引号不跨行吞正文 ⇒ 红且 evidence 含 ghost-bare",
    q52.fails.length === 1 && String(q52.fails[0][2]).includes("ghost-bare"), JSON.stringify(q52.fails));
  // G5-3 空格后 /usr/bin/env 是路径不是命令 ⇒ 不误红。
  const g53 = mkCmdRepo("g53-path");
  fs.writeFileSync(path.join(g53, "ccswitch", "dao.md"),
    "## 器 table\n\n`/known` implemented\n\n/usr/bin/env is a path\n", "utf8");
  const q53 = checkCommandTableImplemented({ repoRoot: g53 });
  check("修G5-3 /usr/bin/env 不算命令 ⇒ 绿（无裸写误红）",
    q53.fails.length === 0, JSON.stringify(q53.fails));
  // G4 SKILL.md 是目录不算活链 ⇒ 假绿（修前）。
  const g4d = fixtureDir("g4-skillmd-dir");
  writeFakeSkillRepo(g4d, ["beta"], FAKE_PS1_WITH_BETA);
  fs.mkdirSync(path.join(g4d, "ccswitch", "skills", "alpha", "SKILL.md"), { recursive: true });
  const g4dHome = fixtureDir("g4-skillmd-dir-home");
  mkLink(g4dHome, "alpha", path.join(g4d, "ccswitch", "skills", "alpha"));
  const q4d = checkSkillsDeployed({ repoRoot: g4d, homeDir: g4dHome });
  check("修G4 SKILL.md 是目录不算活链 ⇒ 红且 evidence 含 alpha",
    q4d.fails.length === 1 && String(q4d.fails[0][2]).includes("alpha"), JSON.stringify(q4d.fails));
  // G6 嵌套括号配平：beta 必须正常入排除清单（配平坏了会翻红）。
  const g6n = fixtureDir("g6-nested");
  writeFakeSkillRepo(g6n, ["alpha", "beta"],
    'function Get-InternalOnlySkills {\n  return @(\n    ("x"),\n    "beta"\n  )\n}\n');
  const g6nHome = fixtureDir("g6-nested-home");
  mkLink(g6nHome, "alpha", path.join(g6n, "ccswitch", "skills", "alpha"));
  const q6n = checkSkillsDeployed({ repoRoot: g6n, homeDir: g6nHome });
  check("修G6 嵌套括号配平 beta 正常入排除清单 ⇒ 绿",
    q6n.fails.length === 0 && q6n.greens.some((l) => l.includes("全部有活链")),
    JSON.stringify({ fails: q6n.fails, greens: q6n.greens }));

  // N2 围栏回归（修前：围栏内命令被按行 toggle 暴露给裸写扫描 ⇒ 误红）：
  const mkCmdDao = (tag, daoBody) => {
    const d = mkCmdRepo(tag);
    fs.writeFileSync(path.join(d, "ccswitch", "dao.md"), daoBody, "utf8");
    return d;
  };
  // N2-1 围栏内已实现命令的用法示例 ⇒ 绿（修前误红 known）。
  const n2a = mkCmdDao("n2a-fence-known",
    "## 器 t\n\n`/known` ok\n\n```\n/known --verbose\n```\n");
  const qN2a = checkCommandTableImplemented({ repoRoot: n2a });
  check("修N2-1 围栏内已实现命令用法示例 ⇒ 绿",
    qN2a.fails.length === 0, JSON.stringify(qN2a.fails));
  // N2-2 围栏内未实现命令 ⇒ 也绿（在围栏里就不该被扫，与是否实现无关）。
  const n2b = mkCmdDao("n2b-fence-ghost",
    "## 器 t\n\n`/known` ok\n\n```\n/fake-in-fence --flag\n```\n");
  const qN2b = checkCommandTableImplemented({ repoRoot: n2b });
  check("修N2-2 围栏内未实现命令 ⇒ 也绿（围栏里不该被扫）",
    qN2b.fails.length === 0, JSON.stringify(qN2b.fails));
  // N2-3 未闭合围栏 ⇒ 视为开到节尾（方向漏检不是误红），确定行为并断言。
  const n2c = mkCmdDao("n2c-unclosed-fence",
    "## 器 t\n\n`/known` ok\n\n```\n/ghost-unclosed\n");
  const qN2c = checkCommandTableImplemented({ repoRoot: n2c });
  check("修N2-3 未闭合围栏视为开到节尾 ⇒ 绿（漏检方向）",
    qN2c.fails.length === 0, JSON.stringify(qN2c.fails));
  // N2-4 一行内多对反引号命令 ⇒ 绿不误伤（按行 toggle 处理多对）。
  const n2d = mkCmdRepo("n2d-multi-pairs");
  fs.writeFileSync(path.join(n2d, "ccswitch", "commands", "known2.md"), "", "utf8");
  fs.writeFileSync(path.join(n2d, "ccswitch", "dao.md"),
    "## 器 t\n\n`/known` and `/known2` both ok\n", "utf8");
  const qN2d = checkCommandTableImplemented({ repoRoot: n2d });
  check("修N2-4 一行内多对反引号命令 ⇒ 绿不误伤",
    qN2d.fails.length === 0, JSON.stringify(qN2d.fails));

  console.log("\n=== 判别力 · mutation（把闸改坏，负控必须跟着掉下来）===");
  const SRC = fs.readFileSync(LIB, "utf8");
  async function mutateAndFlip(name, find, replace, run) {
    if (!SRC.includes(find)) {
      // 判据搬了家而 mutation 静默变成空操作 ⇒ 这一条会「通过」而什么都没验。必须红。
      check(`mutation ${name}`, false, `锚点串在源码里找不到了：${find.slice(0, 80)}`);
      return;
    }
    const p = path.join(TMP, `gate3-mutant-${process.pid}-${Math.random().toString(36).slice(2)}.mjs`);
    fs.writeFileSync(p, SRC.replace(find, replace), "utf8");
    try {
      const m = await import(pathToFileURL(p).href);
      check(`mutation ${name} ⇒ 对应负控翻转`, run(m), "变异体上断言未翻转 ⇒ 判据没被改坏或没被这处代码管着");
    } finally {
      fs.rmSync(p, { force: true });
    }
  }
  await mutateAndFlip("闸㈠ 有实现判断恒真",
    "existsSync(join(repoRoot, 'ccswitch', 'commands', `${n}.md`))",
    "true",
    (m) => m.checkCommandTableImplemented({ repoRoot: ghost }).fails.length === 0);
  await mutateAndFlip("闸㈡ 缺失集合恒空",
    "shouldDeploy.filter((n) => !isAliveLink(join(claudeSkills, n), n))",
    "[]",
    (m) => m.checkSkillsDeployed({ repoRoot: neg2, homeDir: neg2Home }).fails.length === 0);
  await mutateAndFlip("闸㈡上下文 跳过分支恒真",
    "!deploySources.has(normalizePath(repoRoot))",
    "true",
    (m) => m.checkSkillsDeployed({ repoRoot: neg2, homeDir: neg2Home }).fails.length === 0);
  await mutateAndFlip("修② 注释剔除被废",
    "stripPs1Comments(ps1Src)",
    "ps1Src",
    (m) => m.checkSkillsDeployed({ repoRoot: fix2, homeDir: fix2Home }).fails.length === 0);
  await mutateAndFlip("修④ 身份校验恒真",
    "isSameName(target, name)",
    "true",
    (m) => m.checkSkillsDeployed({ repoRoot: fix4, homeDir: fix4Home }).fails.length === 0);
  await mutateAndFlip("修④b SKILL.md 存在恒真",
    "statSync(join(target, 'SKILL.md')).isFile()",
    "true",
    (m) => m.checkSkillsDeployed({ repoRoot: fix4b, homeDir: fix4bHome }).fails.length === 0);
  await mutateAndFlip("修⑤ 裸写扫描恒空",
    "/(?:^|[\\s　，。；：！？、（(、,])\\/([A-Za-z0-9][A-Za-z0-9._-]*)/g",
    "/(__NEVER_MATCHES__)/g",
    (m) => m.checkCommandTableImplemented({ repoRoot: fix5 }).fails.length === 0);
  await mutateAndFlip("修⑥ 悬空检查被删",
    "st.isSymbolicLink() && existsSync(p) && isSameName(target, name) && statSync(join(target, 'SKILL.md')).isFile()",
    "st.isSymbolicLink()",
    (m) => m.checkSkillsDeployed({ repoRoot: fix6, homeDir: fix6Home }).fails.length === 0);
  await mutateAndFlip("修G5-1 全角标点类被废",
    "[\\s　，。；：！？、（(、,]",
    "[\\s（(、,]",
    (m) => m.checkCommandTableImplemented({ repoRoot: g51 }).fails.length === 0);
  await mutateAndFlip("修G5-2 跨行配对回归",
    "section.split(/\\r?\\n/).map(stripLineBackticks).join('\\n')",
    "section.replace(/`[^`]*`/g, ' ')",
    (m) => m.checkCommandTableImplemented({ repoRoot: g52 }).fails.length === 0);
  await mutateAndFlip("修G5-3 路径守卫被废",
    "if (after === '/') continue;",
    "/* 守卫被废 */",
    (m) => m.checkCommandTableImplemented({ repoRoot: g53 }).fails.length >= 1);
  await mutateAndFlip("修G4 isFile 退回 existsSync",
    "statSync(join(target, 'SKILL.md')).isFile()",
    "existsSync(join(target, 'SKILL.md'))",
    (m) => m.checkSkillsDeployed({ repoRoot: g4d, homeDir: g4dHome }).fails.length === 0);
  await mutateAndFlip("修G6 配平退化为 indexOf",
    "findMatchingParen(body, open)",
    "body.indexOf(')')",
    (m) => m.checkSkillsDeployed({ repoRoot: g6n, homeDir: g6nHome }).fails.length >= 1);
  await mutateAndFlip("修N2 围栏挖除被废",
    "stripFencedBlocks(section)",
    "section",
    (m) => m.checkCommandTableImplemented({ repoRoot: n2a }).fails.length >= 1);

  console.log(`\n=== 汇总: PASS=${pass} FAIL=${failN} ===`);
  return failN > 0 ? 1 : 0;
}

const cleanup = () => { for (const d of created) fs.rmSync(d, { recursive: true, force: true }); };
main()
  .then((code) => { cleanup(); process.exit(code); })
  .catch((err) => { cleanup(); console.error("测试自身崩溃:", err); process.exit(1); });
