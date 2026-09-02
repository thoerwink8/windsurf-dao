// skill 发现面符号链接检查 · 判别力回归网（issue #793）
//
// 验 scripts/lib/skill-link-check.mjs（dao-check 第 ㉘ 项的实现）：
//   红样本 —— 缺链（#789 现场形态）/ 存在但不是链接（普通目录）/ 链接悬空（目标被删）/
//              指错 skill（name=dispatch 却指向 host/skills/dao-commit）/
//              指到别处（不是 host/skills/<名> 布局），全部必须报红；
//   绿样本 —— 全部 skill 链齐（指向本 checkout）必须绿，证明检查器不是「恒红」；
//              指向**另一个 checkout**（部署事实：本机只给主仓 checkout 建链，worktree 里
//              dao-check 也必须绿）同样必须绿；
//   SKIP  —— 本机没有 ~/.claude/skills（CI / 新机）必须 SKIP 而不是绿——
//             SKIP 与绿分不开，CI 就会永远绿而本机永远没人查；
//   没查成 —— host/skills 不在 / 一个 skill 都没扫到 / HOME 探测不了，全部单独报红。
//
// 全部在 _tmp/skilllink-sandbox 里造假 root（host/skills/<名>/SKILL.md）+ 假 HOME
// （.claude/skills/<名> 符号链接）。Windows 上目录链接用 junction（lstat 也报 isSymbolicLink，
// 与 memory-link 同一判据；不需要管理员权限），POSIX 用普通 symlink。

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require("fs");
const path = require("path");

const REPO = path.resolve(__dirname, "..");
const SANDBOX = path.join(REPO, "_tmp", "skilllink-sandbox");

const SKILLS = ["dispatch", "dao-commit", "grill-ai"];

function makeRoot(name) {
  const root = path.join(SANDBOX, "roots", name);
  fs.mkdirSync(path.join(root, "host", "skills"), { recursive: true });
  for (const s of SKILLS) {
    fs.mkdirSync(path.join(root, "host", "skills", s), { recursive: true });
    fs.writeFileSync(path.join(root, "host", "skills", s, "SKILL.md"), `---\nname: ${s}\n---\n# ${s}\n`, "utf8");
  }
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

    // ── ② 绿样本：指向**另一个 checkout**（部署事实：只给主仓建链，worktree 也要绿）⇒ 绿 ──
    {
      const root = makeRoot("worktree-checkout");
      const other = makeRoot("main-checkout");
      const home = makeHome("worktree-home");
      for (const s of SKILLS) linkSkill(home, s, path.join(other, "host", "skills", s));
      const r = checkSkillLinks({ root, home });
      await t.test('链接指向另一 checkout 的 host/skills/<名> ⇒ 绿（worktree 不假红）', () => {
        assert.ok(!!r.green, '链接指向另一 checkout 的 host/skills/<名> ⇒ 绿（worktree 不假红）  →  ' + JSON.stringify(r).slice(0, 200));
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

    // ── ⑧ SKIP：本机没有 ~/.claude/skills（CI / 新机）⇒ SKIP 不是绿 ──
    {
      const root = makeRoot("ci");
      const bareHome = path.join(SANDBOX, "homes", "bare");   // 连 .claude 都没有
      fs.mkdirSync(bareHome, { recursive: true });
      const r = checkSkillLinks({ root, home: bareHome });
      await t.test('无 ~/.claude/skills ⇒ SKIP 且不是绿不是红', () => {
        assert.ok(!!r.skip && !r.green && !r.fail, '无 ~/.claude/skills ⇒ SKIP 且不是绿不是红  →  ' + JSON.stringify(r).slice(0, 200));
      });
    }

    // ── ⑧b SKIP：CI 环境（GITHUB_ACTIONS/CI 置真）⇒ SKIP 不是绿不是红，
    //    即使 ~/.claude/skills 存在且缺链（CI 只为 ⑧ 装带 hook 的 skill，发现面非全量）──
    {
      const root = makeRoot("ci-env");
      const home = makeHome("ci-env-home");
      for (const s of SKILLS.slice(1)) linkSkill(home, s, path.join(root, "host", "skills", s));  // 故意缺 dispatch
      const r = checkSkillLinks({ root, home, isCi: true });
      await t.test('CI 置真且缺链 ⇒ SKIP 不是红（CI 装不了全量发现面）', () => {
        assert.ok(!!r.skip && !r.fail && !r.green, 'CI 置真且缺链 ⇒ SKIP 不是红  →  ' + JSON.stringify(r).slice(0, 200));
      });
      const r2 = checkSkillLinks({ root, home });   // 同一台机器不标 CI ⇒ 必须红
      await t.test('同一缺链不标 CI ⇒ 红（判别力：CI 标志不能掩盖真机缺链）', () => {
        assert.ok(!!r2.fail && /缺链/.test(r2.fail[2]), '同一缺链不标 CI ⇒ 红  →  ' + JSON.stringify(r2).slice(0, 200));
      });
    }

    // ── ⑨ 红样本：~/.claude/skills 存在但是文件（发现面坏了）⇒ 报红 ──
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

    // ── ⑩ 没查成：host/skills 不在 / 0 个 skill / HOME 空 ⇒ 各报红 ──
    {
      const noSkills = path.join(SANDBOX, "roots", "no-skills");
      fs.mkdirSync(path.join(noSkills, "host"), { recursive: true });  // 有 host/ 但没 host/skills/
      const r10 = checkSkillLinks({ root: noSkills, home: makeHome("no-skills-home") });
      await t.test('host/skills 不在 ⇒ 报「没查成」', () => {
        assert.ok(!!r10.fail && /host\/skills 不在/.test(r10.fail[0]), 'host/skills 不在 ⇒ 报「没查成」  →  ' + JSON.stringify(r10).slice(0, 200));
      });
    }
    {
      const emptySkills = path.join(SANDBOX, "roots", "empty-skills");
      fs.mkdirSync(path.join(emptySkills, "host", "skills"), { recursive: true });  // host/skills 空
      const r10b = checkSkillLinks({ root: emptySkills, home: makeHome("empty-skills-home") });
      await t.test('host/skills 空 ⇒ 报「一个 skill 都没扫到」', () => {
        assert.ok(!!r10b.fail && /一个 skill 都没扫到/.test(r10b.fail[0]), 'host/skills 空 ⇒ 报「一个 skill 都没扫到」  →  ' + JSON.stringify(r10b).slice(0, 200));
      });
    }
    {
      const root = makeRoot("no-home");
      const r10c = checkSkillLinks({ root, home: "" });
      await t.test('HOME 空 ⇒ 报「探测不了」', () => {
        assert.ok(!!r10c.fail && /探测不了/.test(r10c.fail[0]), 'HOME 空 ⇒ 报「探测不了」  →  ' + JSON.stringify(r10c).slice(0, 200));
      });
    }

    fs.rmSync(SANDBOX, { recursive: true, force: true });
  });
});
