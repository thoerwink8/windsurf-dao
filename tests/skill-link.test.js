// skill 发现面符号链接检查 · 判别力回归网（issue #793）
//
// 验 scripts/lib/skill-link-check.mjs（dao-check 第 ㉘ 项的实现）：
//   红样本 —— 缺链（#789 现场形态）/ 存在但不是链接（普通目录）/ 链接悬空（目标被删）/
//              指错 skill（name=dispatch 却指向 host/skills/dao-commit）/
//              指到别处（不是 host/skills/<名> 布局）/
//              指到无关 git 仓的同名 host/skills/<名>（common-dir ≠ 本仓，审官红 2 现场），
//              全部必须报红；
//   绿样本 —— 全部 skill 链齐（指向本 checkout）必须绿，证明检查器不是「恒红」；
//              指向**同仓另一 checkout**（部署事实：本机只给主仓 checkout 建链，worktree 里
//              dao-check 也必须绿；用 gitdir+commondir 的 worktree 形态证明同仓）同样必须绿；
//   SKIP  —— 本机没有 ~/.claude/skills（新机）必须 SKIP 而不是绿；
//             与 CI 预步骤（check.yml）同形的样本——~/.claude/skills 已建、只链带 hooks.json
//             的 skill——在 CI 语境（isCi=true）必须 SKIP，同一状态不标 CI 必须红；
//   没查成 —— host/skills 不在 / 一个 skill 都没扫到 / HOME 探测不了 / 本仓 root 不在 git
//             仓内（common-dir 解不出，不许退回纯后缀放行），全部单独报红。
//
// 全部在 _tmp/skilllink-sandbox 里造假 root（host/skills/<名>/SKILL.md + .git）+ 假 HOME
// （.claude/skills/<名> 符号链接）。Windows 上目录链接用 junction（lstat 也报 isSymbolicLink，
// 与 memory-link 同一判据；不需要管理员权限），POSIX 用普通 symlink。

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require("fs");
const path = require("path");

const REPO = path.resolve(__dirname, "..");
const SANDBOX = path.join(REPO, "_tmp", "skilllink-sandbox");
// 「目标/root 不在任何 git 仓内」样本必须放在仓外：_tmp 在仓内，向上探测会撞上本仓的 .git
// （common-dir 相同 → 误判成同仓）。放系统临时目录才能拿到真的「无 .git 可解」。
const OUTSIDE = path.join(require("os").tmpdir(), `skilllink-outside-${process.pid}`);

const SKILLS = ["dispatch", "dao-commit", "grill-ai"];
const HOOK_SKILL = "dispatch";   // 模拟 check.yml 里带 hooks.json 的 skill（⑧ 用）

function makeSkills(root) {
  fs.mkdirSync(path.join(root, "host", "skills"), { recursive: true });
  for (const s of SKILLS) {
    fs.mkdirSync(path.join(root, "host", "skills", s), { recursive: true });
    fs.writeFileSync(path.join(root, "host", "skills", s, "SKILL.md"), `---\nname: ${s}\n---\n# ${s}\n`, "utf8");
  }
  // 只有 HOOK_SKILL 带 hooks.json —— 与 .github/workflows/check.yml 的「只为带 hook 的 skill 建链」同形
  fs.mkdirSync(path.join(root, "host", "skills", HOOK_SKILL, "hooks"), { recursive: true });
  fs.writeFileSync(path.join(root, "host", "skills", HOOK_SKILL, "hooks", "hooks.json"),
    JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "node x.mjs" }] }] } }), "utf8");
}

/** 主仓形态：root/.git 是目录（普通 clone）。 */
function makeRoot(name) {
  const root = path.join(SANDBOX, "roots", name);
  fs.mkdirSync(path.join(root, ".git"), { recursive: true });
  makeSkills(root);
  return root;
}

/** worktree 形态：root/.git 是文件（gitdir: → 主仓 .git/worktrees/<名>），
 *  那个 gitdir 带 commondir 指向主仓 .git——与 memory-link 测试同一套手工 git 布局。 */
function makeWorktree(name, mainRoot, wtName) {
  const root = path.join(SANDBOX, "roots", name);
  fs.mkdirSync(root, { recursive: true });
  const gitDir = path.join(mainRoot, ".git", "worktrees", wtName);
  fs.mkdirSync(gitDir, { recursive: true });
  fs.writeFileSync(path.join(gitDir, "commondir"), path.relative(gitDir, path.join(mainRoot, ".git")), "utf8");
  fs.writeFileSync(path.join(root, ".git"), `gitdir: ${gitDir.replace(/\\/g, "/")}\n`, "utf8");
  makeSkills(root);
  return root;
}

function makeHome(name) {
  const home = path.join(SANDBOX, "homes", name);
  fs.mkdirSync(path.join(home, ".claude", "skills"), { recursive: true });
  return home;
}

function linkType() {
  return process.platform === 'win32' ? 'junction' : undefined;
}

function linkSkill(home, name, target) {
  const link = path.join(home, ".claude", "skills", name);
  fs.rmSync(link, { recursive: true, force: true });
  fs.symlinkSync(target, link, linkType());
  return link;
}

/** 与 check.yml 预步骤同形：mkdir -p ~/.claude/skills，只为带 hooks.json 的 skill 建链。 */
function ciPreStep(home, root) {
  for (const d of fs.readdirSync(path.join(root, "host", "skills"))) {
    const hooksJson = path.join(root, "host", "skills", d, "hooks", "hooks.json");
    if (fs.existsSync(hooksJson)) {
      linkSkill(home, d, path.join(root, "host", "skills", d));
    }
  }
}

describe('skill-link', () => {
  it('skill 发现面符号链接检查判别力', async (t) => {
    const { checkSkillLinks } = await import("../scripts/lib/skill-link-check.mjs");
    fs.rmSync(SANDBOX, { recursive: true, force: true });
    fs.mkdirSync(SANDBOX, { recursive: true });

    // ── ① 绿样本：全部链齐，指向本 checkout ⇒ 必须绿 ──
    {
      const root = makeRoot("proj");
      const home = makeHome("good");
      for (const s of SKILLS) linkSkill(home, s, path.join(root, "host", "skills", s));
      const r = checkSkillLinks({ root, home });
      await t.test('全部链齐 ⇒ 绿且点名数量', () => {
        assert.ok(!!r.green && r.green.includes(String(SKILLS.length)), '全部链齐 ⇒ 绿且点名数量  →  ' + JSON.stringify(r).slice(0, 200));
      });
      await t.test('全部链齐 ⇒ 不是 SKIP 也不是红', () => {
        assert.ok(!r.skip && !r.fail, '全部链齐 ⇒ 不是 SKIP 也不是红  →  ' + JSON.stringify(r).slice(0, 120));
      });
    }

    // ── ② 绿样本：指向**同仓另一 checkout**（worktree 形态：root 是 worktree、
    //    链接指向主仓 checkout，common-dir 相同）⇒ 绿（worktree 不假红）──
    {
      const main = makeRoot("main-checkout");
      const wt = makeWorktree("worktree-checkout", main, "wt-793");
      const home = makeHome("worktree-home");
      for (const s of SKILLS) linkSkill(home, s, path.join(main, "host", "skills", s));
      const r = checkSkillLinks({ root: wt, home });
      await t.test('链接指向同仓主 checkout 的 host/skills/<名> ⇒ 绿（worktree 不假红）', () => {
        assert.ok(!!r.green, '链接指向同仓主 checkout ⇒ 绿  →  ' + JSON.stringify(r).slice(0, 200));
      });
    }

    // ── ②b 绿样本：混合大小写 skill 名（host/skills/FooBar）正确链接。
    //    POSIX：suffixOk 必须按原大小写匹配——name.toLowerCase() 去对 FooBar 会假红「指错」。
    //    win32：norm 两侧都 lower，忽略大小写，同样绿。──
    {
      const root = path.join(SANDBOX, "roots", "mixed-case");
      fs.mkdirSync(path.join(root, ".git"), { recursive: true });
      const mixed = "FooBar";
      fs.mkdirSync(path.join(root, "host", "skills", mixed), { recursive: true });
      fs.writeFileSync(path.join(root, "host", "skills", mixed, "SKILL.md"), `---\nname: ${mixed}\n---\n# ${mixed}\n`, "utf8");
      const home = makeHome("mixed-case-home");
      linkSkill(home, mixed, path.join(root, "host", "skills", mixed));
      const r = checkSkillLinks({ root, home });
      await t.test('混合大小写 skill 名（FooBar）正确链接 ⇒ 绿（POSIX 精确 / win32 忽略大小写）', () => {
        assert.ok(!!r.green && !r.fail && !r.skip, '混合大小写 skill 名正确链接 ⇒ 绿  →  ' + JSON.stringify(r).slice(0, 200));
      });
    }

    // ── ③ 红样本：缺链（#789 现场形态：新增 skill 忘了建链）⇒ 必须报红 ──
    {
      const root = makeRoot("missing");
      const home = makeHome("missing-home");
      for (const s of SKILLS.slice(1)) linkSkill(home, s, path.join(root, "host", "skills", s));  // dispatch 不建链
      const r = checkSkillLinks({ root, home });
      await t.test('缺一条链 ⇒ 报红且点名缺的 skill', () => {
        assert.ok(!!r.fail && /dispatch/.test(r.fail[0] + r.fail[2]) && /缺链/.test(r.fail[2]), '缺一条链 ⇒ 报红且点名缺的 skill  →  ' + JSON.stringify(r).slice(0, 200));
      });
      await t.test('缺一条链 ⇒ 不是绿也不是 SKIP', () => {
        assert.ok(!r.green && !r.skip, '缺一条链 ⇒ 不是绿也不是 SKIP  →  ' + JSON.stringify(r).slice(0, 120));
      });
    }

    // ── ④ 红样本：存在但不是链接（普通目录）⇒ 报红 ──
    {
      const root = makeRoot("plain-dir");
      const home = makeHome("plain-dir-home");
      for (const s of SKILLS) linkSkill(home, s, path.join(root, "host", "skills", s));
      fs.rmSync(path.join(home, ".claude", "skills", "dispatch"), { recursive: true, force: true });
      fs.mkdirSync(path.join(home, ".claude", "skills", "dispatch"), { recursive: true });  // 普通目录
      const r = checkSkillLinks({ root, home });
      await t.test('普通目录冒充链接 ⇒ 报「不是链接」', () => {
        assert.ok(!!r.fail && /不是链接/.test(r.fail[2]), '普通目录冒充链接 ⇒ 报「不是链接」  →  ' + JSON.stringify(r).slice(0, 200));
      });
    }

    // ── ⑤ 红样本：链接悬空（目标被删）⇒ 报红 ──
    {
      const root = makeRoot("dangling");
      const ghost = makeRoot("dangling-ghost");   // 另一个 checkout：链接指这里，然后删掉目标
      const home = makeHome("dangling-home");
      for (const s of SKILLS) linkSkill(home, s, path.join(root, "host", "skills", s));
      linkSkill(home, "grill-ai", path.join(ghost, "host", "skills", "grill-ai"));
      fs.rmSync(path.join(ghost, "host", "skills", "grill-ai"), { recursive: true, force: true });  // 删掉链接目标
      const r = checkSkillLinks({ root, home });
      await t.test('目标被删 ⇒ 报「悬空」', () => {
        assert.ok(!!r.fail && /悬空/.test(r.fail[2]), '目标被删 ⇒ 报「悬空」  →  ' + JSON.stringify(r).slice(0, 200));
      });
    }

    // ── ⑥ 红样本：指错 skill（name=dispatch 却指向 host/skills/dao-commit）⇒ 报红 ──
    {
      const root = makeRoot("wrong-skill");
      const home = makeHome("wrong-skill-home");
      for (const s of SKILLS) linkSkill(home, s, path.join(root, "host", "skills", s));
      linkSkill(home, "dispatch", path.join(root, "host", "skills", "dao-commit"));  // 指到别的 skill
      const r = checkSkillLinks({ root, home });
      await t.test('指到别的 skill ⇒ 报「指错」且带真实落点', () => {
        assert.ok(!!r.fail && /指错/.test(r.fail[2]) && /dao-commit/.test(r.fail[2]), '指到别的 skill ⇒ 报「指错」且带真实落点  →  ' + JSON.stringify(r).slice(0, 200));
      });
    }

    // ── ⑦ 红样本：指到别处（不是 host/skills/<名> 布局）⇒ 报红 ──
    {
      const root = makeRoot("elsewhere");
      const home = makeHome("elsewhere-home");
      for (const s of SKILLS) linkSkill(home, s, path.join(root, "host", "skills", s));
      const stray = path.join(SANDBOX, "stray", "dispatch");
      fs.mkdirSync(stray, { recursive: true });
      linkSkill(home, "dispatch", stray);
      const r = checkSkillLinks({ root, home });
      await t.test('指到 host/skills 布局之外 ⇒ 报「指错」', () => {
        assert.ok(!!r.fail && /指错/.test(r.fail[2]) && /stray/.test(r.fail[2]), '指到 host/skills 布局之外 ⇒ 报「指错」  →  ' + JSON.stringify(r).slice(0, 200));
      });
    }

    // ── ⑧ 红样本：指到**无关 git 仓**的同名 host/skills/<名>（审官红 2 现场）
    //    布局一模一样，但 common-dir ≠ 本仓 ⇒ 必须报红 ──
    {
      const root = makeRoot("own-repo");
      const other = makeRoot("unrelated-repo");   // 自己的 .git，common-dir 不同
      const home = makeHome("unrelated-home");
      for (const s of SKILLS) linkSkill(home, s, path.join(root, "host", "skills", s));
      linkSkill(home, "dispatch", path.join(other, "host", "skills", "dispatch"));
      const r = checkSkillLinks({ root, home });
      await t.test('指向无关仓的同名 host/skills/<名> ⇒ 报「指错」且点名 common-dir 不同', () => {
        assert.ok(!!r.fail && /指错/.test(r.fail[2]) && /common-dir/.test(r.fail[2]), '指向无关仓 ⇒ 报「指错」且点名 common-dir 不同  →  ' + JSON.stringify(r).slice(0, 200));
      });
      await t.test('指向无关仓 ⇒ 不是绿', () => {
        assert.ok(!r.green, '指向无关仓 ⇒ 不是绿  →  ' + JSON.stringify(r).slice(0, 120));
      });
    }

    // ── ⑧c 红样本：POSIX 大小写敏感——RepoA 与 repoa 是两个不同目录（不同仓），
    //    链接指向 repoa 的 host/skills/<名>，root 是 RepoA ⇒ 必须红（不许 lower 后相等）。
    //    Windows 上文件系统本身大小写不敏感，两个路径是同一个目录，该样本无意义 ⇒ 跳过。──
    if (process.platform !== 'win32') {
      const RepoA = path.join(OUTSIDE, "case-RepoA");
      const repoa = path.join(OUTSIDE, "case-repoa");
      for (const r of [RepoA, repoa]) {
        fs.mkdirSync(path.join(r, ".git"), { recursive: true });
        fs.mkdirSync(path.join(r, "host", "skills", "dispatch"), { recursive: true });
      }
      const home = makeHome("case-home");
      linkSkill(home, "dispatch", path.join(repoa, "host", "skills", "dispatch"));
      const r = checkSkillLinks({ root: RepoA, home });
      await t.test('POSIX 大小写不同目录（RepoA vs repoa）⇒ 报红（大小写敏感比较）', () => {
        assert.ok(!!r.fail && /指错/.test(r.fail[2]), 'POSIX 大小写不同目录 ⇒ 报红  →  ' + JSON.stringify(r).slice(0, 200));
      });
    } else {
      await t.test('⑧c POSIX 大小写样本（跳过：Windows 文件系统大小写不敏感，无此区分）', { skip: true }, () => {});
    }

    // ── ⑧b 红样本：目标不在任何 git 仓内（普通拷贝，放仓外）⇒ 报「不是本仓 checkout」──
    {
      const root = makeRoot("no-git-target");
      const home = makeHome("no-git-target-home");
      for (const s of SKILLS) linkSkill(home, s, path.join(root, "host", "skills", s));
      const plain = path.join(OUTSIDE, "plain-copy", "host", "skills", "dispatch");  // 普通拷贝，无 .git
      fs.mkdirSync(plain, { recursive: true });
      linkSkill(home, "dispatch", plain);
      const r = checkSkillLinks({ root, home });
      await t.test('目标不是 git 仓 ⇒ 报「不是本仓 checkout」', () => {
        assert.ok(!!r.fail && /不是本仓 checkout/.test(r.fail[2]), '目标不是 git 仓 ⇒ 报「不是本仓 checkout」  →  ' + JSON.stringify(r).slice(0, 200));
      });
    }

    // ── ⑨ SKIP：本机没有 ~/.claude/skills（新机）⇒ SKIP 不是绿 ──
    {
      const root = makeRoot("new-machine");
      const bareHome = path.join(SANDBOX, "homes", "bare");   // 连 .claude 都没有
      fs.mkdirSync(bareHome, { recursive: true });
      const r = checkSkillLinks({ root, home: bareHome });
      await t.test('无 ~/.claude/skills ⇒ SKIP 且不是绿不是红', () => {
        assert.ok(r.skip, '无 ~/.claude/skills ⇒ SKIP  →  ' + JSON.stringify(r).slice(0, 200));
        assert.match(r.skip, /没装/, 'SKIP 必须点名没装，才能跟被劫红分形  →  ' + r.skip);
        assert.equal(r.green, undefined);
        assert.equal(r.fail, undefined);
      });
    }

    // ── ⑨b 红样本：整目录链接（#1146 mirasim 劫走）⇒ 报「被劫」，与「没装」分形 ──
    {
      const root = makeRoot("hijack");
      const home = path.join(SANDBOX, "homes", "hijack-home");
      const mira = path.join(home, ".mirasim", "skills");
      fs.mkdirSync(mira, { recursive: true });
      fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
      fs.symlinkSync(mira, path.join(home, ".claude", "skills"), linkType());
      const r = checkSkillLinks({ root, home });
      await t.test('整目录链到 ~/.mirasim/skills ⇒ 报「被劫」不是 SKIP', () => {
        assert.ok(r.fail, '被劫必须红  →  ' + JSON.stringify(r).slice(0, 240));
        assert.match(r.fail[0], /被劫/);
        assert.equal(r.skip, undefined, '被劫不许落 SKIP（那是没装）');
        assert.equal(r.green, undefined);
      });
    }

    // ── ⑩ SKIP：与 CI 预步骤（check.yml）同形的样本——~/.claude/skills 已建、
    //    只链带 hooks.json 的 skill——CI 语境必须 SKIP，同一状态不标 CI 必须红 ──
    {
      const root = makeRoot("ci-shape");
      const home = makeHome("ci-shape-home");
      ciPreStep(home, root);   // 只链了 HOOK_SKILL
      const rCi = checkSkillLinks({ root, home, isCi: true });
      await t.test('CI 预步骤同形（只链 hook skill）+ isCi ⇒ SKIP 不是红', () => {
        assert.ok(!!rCi.skip && !rCi.fail && !rCi.green, 'CI 预步骤同形 + isCi ⇒ SKIP 不是红  →  ' + JSON.stringify(rCi).slice(0, 200));
      });
      const rLocal = checkSkillLinks({ root, home });
      await t.test('同一状态不标 CI ⇒ 红（本机部分缺链必须报红）', () => {
        assert.ok(!!rLocal.fail && /缺链/.test(rLocal.fail[2]), '同一状态不标 CI ⇒ 红  →  ' + JSON.stringify(rLocal).slice(0, 200));
      });
    }

    // ── ⑪ 红样本：~/.claude/skills 存在但是文件（发现面坏了）⇒ 报红 ──
    {
      const root = makeRoot("face-file");
      const home = path.join(SANDBOX, "homes", "face-file-home");
      fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
      fs.writeFileSync(path.join(home, ".claude", "skills"), "不是目录", "utf8");
      const r = checkSkillLinks({ root, home });
      await t.test('~/.claude/skills 是文件 ⇒ 报「不是目录」', () => {
        assert.ok(!!r.fail && /不是目录/.test(r.fail[0]), '~/.claude/skills 是文件 ⇒ 报「不是目录」  →  ' + JSON.stringify(r).slice(0, 200));
      });
    }

    // ── ⑫ 没查成：host/skills 不在 / 0 个 skill / HOME 空 / root 不在 git 仓内 ⇒ 各报红 ──
    {
      const noSkills = path.join(SANDBOX, "roots", "no-skills");
      fs.mkdirSync(path.join(noSkills, "host"), { recursive: true });  // 有 host/ 但没 host/skills/
      const r12 = checkSkillLinks({ root: noSkills, home: makeHome("no-skills-home") });
      await t.test('host/skills 不在 ⇒ 报「没查成」', () => {
        assert.ok(!!r12.fail && /host\/skills 不在/.test(r12.fail[0]), 'host/skills 不在 ⇒ 报「没查成」  →  ' + JSON.stringify(r12).slice(0, 200));
      });
    }
    {
      const emptySkills = path.join(SANDBOX, "roots", "empty-skills");
      fs.mkdirSync(path.join(emptySkills, ".git"), { recursive: true });
      fs.mkdirSync(path.join(emptySkills, "host", "skills"), { recursive: true });  // host/skills 空
      const r12b = checkSkillLinks({ root: emptySkills, home: makeHome("empty-skills-home") });
      await t.test('host/skills 空 ⇒ 报「一个 skill 都没扫到」', () => {
        assert.ok(!!r12b.fail && /一个 skill 都没扫到/.test(r12b.fail[0]), 'host/skills 空 ⇒ 报「一个 skill 都没扫到」  →  ' + JSON.stringify(r12b).slice(0, 200));
      });
    }
    {
      const root = makeRoot("no-home");
      const r12c = checkSkillLinks({ root, home: "" });
      await t.test('HOME 空 ⇒ 报「探测不了」', () => {
        assert.ok(!!r12c.fail && /探测不了/.test(r12c.fail[0]), 'HOME 空 ⇒ 报「探测不了」  →  ' + JSON.stringify(r12c).slice(0, 200));
      });
    }
    {
      const noGitRoot = path.join(OUTSIDE, "no-git-root");   // 有 host/skills 但 root 不在 git 仓内（无 .git，放仓外）
      makeSkills(noGitRoot);
      const r12d = checkSkillLinks({ root: noGitRoot, home: makeHome("no-git-root-home") });
      await t.test('root 不在 git 仓内 ⇒ 报「归属探测不了」（不许纯后缀放行）', () => {
        assert.ok(!!r12d.fail && /归属探测不了/.test(r12d.fail[0]), 'root 不在 git 仓内 ⇒ 报「归属探测不了」  →  ' + JSON.stringify(r12d).slice(0, 200));
      });
    }

    fs.rmSync(OUTSIDE, { recursive: true, force: true });
    fs.rmSync(SANDBOX, { recursive: true, force: true });
  });

  // 「只看 $HOME 会漏掉另一个家的装载面」（#1146 洞，2026-09-13 实咬）。
  // 现场：单元 User=orca 只修得住 /home/orca，dao-check 是 root 跑、看的是 /root，
  // root 那份被 mirasim 劫走后自愈钟每 5 分钟说「无事可做」，红挂在那儿没人接。
  it('一个家目录绿、另一个被劫 ⇒ 必须报红（只看 $HOME 会漏）', async () => {
    const { checkSkillLinks } = await import('../scripts/lib/skill-link-check.mjs');
    const root = makeRoot('multi-home');
    const good = makeHome('multi-home-good');
    const bad = makeHome('multi-home-bad');
    for (const s of SKILLS) linkSkill(good, s, path.join(root, 'host', 'skills', s));
    // 第二个家：整目录链到别处（mirasim 劫法）
    fs.rmSync(path.join(bad, '.claude', 'skills'), { recursive: true, force: true });
    fs.mkdirSync(path.join(bad, '.mirasim', 'skills'), { recursive: true });
    fs.symlinkSync(path.join(bad, '.mirasim', 'skills'), path.join(bad, '.claude', 'skills'), linkType());

    const only = checkSkillLinks({ root, home: good });
    assert.equal(only.green !== undefined, true, '正向控制：只传好的那个家 ⇒ 绿（证明不是恒红）  →  ' + JSON.stringify(only).slice(0, 200));

    const both = checkSkillLinks({ root, home: good, homes: [good, bad] });
    assert.ok(!!both.fail, '坏的那个家必须进判据  →  ' + JSON.stringify(both).slice(0, 300));
    assert.match(both.fail[2], /multi-home-bad/, '证据行要点名是哪个家被劫  →  ' + both.fail[2]);
    assert.doesNotMatch(both.fail[2], /multi-home-good\/\.claude/, '绿的那个家不许进证据（否则看不出坏在哪）');

    fs.rmSync(path.join(SANDBOX, 'homes', 'multi-home-good'), { recursive: true, force: true });
    fs.rmSync(path.join(SANDBOX, 'homes', 'multi-home-bad'), { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('两个家都绿 ⇒ 绿，且报告里两个家都点到名', async () => {
    const { checkSkillLinks } = await import('../scripts/lib/skill-link-check.mjs');
    const root = makeRoot('multi-green');
    const a = makeHome('multi-green-a');
    const b = makeHome('multi-green-b');
    for (const s of SKILLS) {
      linkSkill(a, s, path.join(root, 'host', 'skills', s));
      linkSkill(b, s, path.join(root, 'host', 'skills', s));
    }
    const r = checkSkillLinks({ root, home: a, homes: [a, b] });
    assert.equal(r.fail, undefined, JSON.stringify(r).slice(0, 300));
    assert.match(r.green, /multi-green-a/);
    assert.match(r.green, /multi-green-b/);
    fs.rmSync(path.join(SANDBOX, 'homes', 'multi-green-a'), { recursive: true, force: true });
    fs.rmSync(path.join(SANDBOX, 'homes', 'multi-green-b'), { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('「哪个家要守」的判据：有 .claude/ 才算，只有 .mirasim/ 不算，且取不到清单时报没查成', async () => {
    const { agentHomes, homesFromPasswd, looksLikeAgentHome } = await import('../scripts/lib/skill-homes.mjs');
    const dir = path.join(SANDBOX, 'homes-probe');
    fs.mkdirSync(path.join(dir, 'with-claude', '.claude'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'with-mirasim', '.mirasim'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'bare'), { recursive: true });

    assert.equal(looksLikeAgentHome(path.join(dir, 'with-claude')), true, '有 .claude/ ⇒ 要守');
    assert.equal(looksLikeAgentHome(path.join(dir, 'with-mirasim')), false, '只有 .mirasim/ ⇒ 不守（那是 mirasim 发现面，不凭空造 .claude/skills）');
    assert.equal(looksLikeAgentHome(path.join(dir, 'bare')), false, '光秃秃的家 ⇒ 不守（不凭空造装载面）');

    const pw = 'root:x:0:0:root:/root:/bin/bash\nnobody:x:65534:65534:nobody:/nonexistent:/usr/sbin/nologin\n';
    assert.deepEqual(homesFromPasswd(pw), ['/root', '/nonexistent'], 'passwd 第 6 栏取家目录');

    // 显式覆盖：够不着 passwd 的容器里也能指定；相对路径不许进（会凭空扫到别处）
    const r = agentHomes({ env: { DAO_SKILL_HOMES: `${path.join(dir, 'with-claude')},relative/path` }, readdir: fs.readdirSync, readFile: fs.readFileSync });
    assert.deepEqual(r.homes, [path.join(dir, 'with-claude')], '相对路径必须被丢掉  →  ' + JSON.stringify(r));

    // 覆盖里全是垃圾路径 ⇒ 没查成，不是「一个家都没有」
    const bad = agentHomes({ env: { DAO_SKILL_HOMES: 'nope' }, readdir: fs.readdirSync, readFile: fs.readFileSync });
    assert.equal(bad.ok, false, '覆盖值里没有绝对路径 ⇒ 没查成，不许当空列表  →  ' + JSON.stringify(bad));

    // 一个候选都读不到 ⇒ 没查成（「没读到」和「都没有装载面」必须分得开）
    const none = agentHomes({ env: { DAO_SKILL_HOMES: '/nope-a,/nope-b' }, readdir: fs.readdirSync, readFile: fs.readFileSync });
    assert.equal(none.ok, false, '候选一个都读不到 ⇒ 没查成  →  ' + JSON.stringify(none));

    const miraOnly = agentHomes({
      env: { DAO_SKILL_HOMES: path.join(dir, 'with-mirasim') },
      readdir: fs.readdirSync, readFile: fs.readFileSync,
    });
    assert.equal(miraOnly.ok, true, JSON.stringify(miraOnly));
    assert.deepEqual(miraOnly.homes, [], '只有 .mirasim/ 的家不得进守护名单');

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('passwd 读不了时回退 HOME/USERPROFILE（含 Windows 盘符），不把当前家丢掉', async () => {
    const { agentHomes } = await import('../scripts/lib/skill-homes.mjs');
    const enoent = () => {
      const e = new Error('ENOENT');
      e.code = 'ENOENT';
      throw e;
    };
    const winHome = 'C:/Users/alice';
    const win = agentHomes({
      env: { USERPROFILE: winHome },
      readFile: enoent,
      readdir: (dir) => {
        if (dir === winHome) return ['.claude', 'Desktop'];
        const e = new Error('ENOENT');
        e.code = 'ENOENT';
        throw e;
      },
    });
    assert.equal(win.ok, true, 'Windows 无 passwd 也要守 USERPROFILE 下的 .claude  →  ' + JSON.stringify(win));
    assert.deepEqual(win.homes, [winHome]);

    const backslash = 'C:\\Users\\bob';
    const winBs = agentHomes({
      env: { USERPROFILE: backslash },
      readFile: enoent,
      readdir: (dir) => {
        if (dir === backslash) return ['.claude'];
        const e = new Error('ENOENT');
        e.code = 'ENOENT';
        throw e;
      },
    });
    assert.equal(winBs.ok, true, JSON.stringify(winBs));
    assert.deepEqual(winBs.homes, [backslash]);

    const unix = '/home/alice';
    const posix = agentHomes({
      env: { HOME: unix },
      readFile: enoent,
      readdir: (dir) => {
        if (dir === unix) return ['.claude'];
        const e = new Error('ENOENT');
        e.code = 'ENOENT';
        throw e;
      },
    });
    assert.equal(posix.ok, true, JSON.stringify(posix));
    assert.deepEqual(posix.homes, [unix]);

    const miss = agentHomes({
      env: { USERPROFILE: 'relative/nope' },
      readFile: enoent,
      readdir: enoent,
    });
    assert.equal(miss.ok, false, 'passwd 没有且 USERPROFILE 不是绝对路径 ⇒ 没查成  →  ' + JSON.stringify(miss));
    assert.match(miss.reason, /passwd|HOME|USERPROFILE/);
  });

  it('硬塞一个只有 .mirasim/ 的家进检查 ⇒ SKIP 不是红，也不造 .claude/skills', async () => {
    const { checkSkillLinks } = await import('../scripts/lib/skill-link-check.mjs');
    const root = makeRoot('mira-skip');
    const good = makeHome('mira-skip-good');
    for (const s of SKILLS) linkSkill(good, s, path.join(root, 'host', 'skills', s));
    const mira = path.join(SANDBOX, 'homes', 'mira-skip-only');
    fs.mkdirSync(path.join(mira, '.mirasim', 'skills'), { recursive: true });

    const onlyMira = checkSkillLinks({ root, home: mira, homes: [mira] });
    assert.equal(onlyMira.fail, undefined, '没有 .claude/skills 是没装，不是被劫  →  ' + JSON.stringify(onlyMira).slice(0, 300));
    assert.ok(onlyMira.skip, '必须 SKIP  →  ' + JSON.stringify(onlyMira).slice(0, 300));

    const mixed = checkSkillLinks({ root, home: good, homes: [good, mira] });
    assert.equal(mixed.fail, undefined, JSON.stringify(mixed).slice(0, 300));
    assert.match(mixed.green, /mira-skip-good/);
    assert.equal(fs.existsSync(path.join(mira, '.claude')), false, '检查不得凭空建 .claude');

    fs.rmSync(path.join(SANDBOX, 'homes', 'mira-skip-good'), { recursive: true, force: true });
    fs.rmSync(mira, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  });
});
