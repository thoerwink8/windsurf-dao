// 本机 memory 断链检查 · 判别力回归网（issue #503 / 判据改写 #529）
//
// 验 scripts/lib/dao-memory-link-check.mjs（dao-check 第 ⑨ 项的实现）：
//   红样本 —— 普通目录（#503 现场形态）/ 链接悬空 / 目标不是 git 仓库 / 目标仓没有 origin /
//              origin 不是 windsurf-dao-memory（含「指向主仓旧 memory 目录」的搬家前形态），
//              全部必须报红；
//   绿样本 —— 正确 Junction（目标仓 origin == thoerwink8/windsurf-dao-memory）必须绿，
//              证明检查器不是「恒红」；origin 用 SSH 与 HTTPS 两种 URL 形式都要绿
//              （换机 clone 用 HTTPS，判据不能只认 SSH 一种）；
//   SKIP  —— 本机没有该项目 memory 目录（CI / 新机 / 未接的 worktree）必须 SKIP 而不是绿——
//            SKIP 与绿分不开，CI 就会永远绿而本机永远没人查。
// 另按 NEW-MACHINE §10 硬钉两条编码示例（D:\frank\windsurf-dao → D--frank-windsurf-dao、
// 468-审官-gpt-5.6-sol → 468----gpt-5-6-sol），编码规则错了检查器就查错目录。
//
// 全部在 _tmp/memlink-sandbox 里造假 root + 假 HOME + 假 git 仓（.git/config 手写出来，
// 检查器读配置不 shell 出 git，测试也不用依赖本机有没有 git 命令）。
// Junction 只在 Windows 上能建；非 Windows 平台跳过依赖 Junction 的样本（部署目标是 Windows）。

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require("fs");
const path = require("path");

const REPO = path.resolve(__dirname, "..");
const SANDBOX = path.join(REPO, "_tmp", "memlink-sandbox");

function makeRoot(name) {
  const root = path.join(SANDBOX, "roots", name);
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function homeFor(name) {
  const home = path.join(SANDBOX, "homes", name);
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  return home;
}

// 手写一个 git 仓：.git/config 由测试自己构造（不含 git 命令，检查器只读配置）。
function writeGitRepo(dir, originUrl) {
  fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
  const cfg = originUrl == null
    ? "[core]\n\trepositoryformatversion = 0\n"
    : `[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = ${originUrl}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`;
  fs.writeFileSync(path.join(dir, ".git", "config"), cfg, "utf8");
}

function junctionFor(home, root, encodeProjectDirFn, target) {
  const encoded = encodeProjectDirFn(root);
  const mem = path.join(home, ".claude", "projects", encoded, "memory");
  fs.mkdirSync(path.dirname(mem), { recursive: true });
  fs.rmSync(mem, { recursive: true, force: true });
  fs.symlinkSync(target, mem, "junction");
  return mem;
}

describe('memory-link', () => {
  it('memory 断链检查判别力', async (t) => {
    const { checkMemoryLink, encodeProjectDir, repoSlugFromUrl } = await import("../scripts/lib/dao-memory-link-check.mjs");
    const jf = (home, root, target) => junctionFor(home, root, encodeProjectDir, target);
    fs.rmSync(SANDBOX, { recursive: true, force: true });
    fs.mkdirSync(SANDBOX, { recursive: true });

    // ── ① 编码规则与 NEW-MACHINE §10 一致（硬钉文档示例）──────────────────
    await t.test('D:\\frank\\windsurf-dao → D--frank-windsurf-dao', () => {
      const a = encodeProjectDir("D:\\frank\\windsurf-dao");
      assert.ok(a === "D--frank-windsurf-dao", 'D:\\frank\\windsurf-dao → D--frank-windsurf-dao  →  ' + a);
    });
    await t.test('468-审官-gpt-5.6-sol → 468----gpt-5-6-sol（中文/点都算非字母数字）', () => {
      const b = encodeProjectDir("468-审官-gpt-5.6-sol");
      assert.ok(b === "468----gpt-5-6-sol", '468-审官-gpt-5.6-sol → 468----gpt-5-6-sol（中文/点都算非字母数字）  →  ' + b);
    });

    // ── ①b remote URL 抽出 owner/repo（SSH / HTTPS / 带 .git / 带尾斜杠）──
    for (const [url, expect] of [
      ["git@github.com:thoerwink8/windsurf-dao-memory.git", "thoerwink8/windsurf-dao-memory"],
      ["git@github.com:thoerwink8/windsurf-dao-memory", "thoerwink8/windsurf-dao-memory"],
      ["https://github.com/thoerwink8/windsurf-dao-memory.git", "thoerwink8/windsurf-dao-memory"],
      ["https://github.com/thoerwink8/windsurf-dao-memory.git/", "thoerwink8/windsurf-dao-memory"],
      ["ssh://git@github.com/thoerwink8/windsurf-dao-memory.git", "thoerwink8/windsurf-dao-memory"],
    ]) {
      await t.test(`repoSlugFromUrl(${url}) = ${expect}`, () => {
        const got = repoSlugFromUrl(url);
        assert.ok(got === expect, `repoSlugFromUrl(${url}) = ${expect}  →  实际 ${got}`);
      });
    }
    await t.test('本地路径 remote 抽不出 memory 仓 slug（判红）', () => {
      assert.ok(repoSlugFromUrl("D:/frank/other-repo") !== "thoerwink8/windsurf-dao-memory", '本地路径 remote 抽不出 memory 仓 slug（判红）  →  本地路径不是 GitHub remote，不能误判成 memory 仓');
    });

    const root = makeRoot("proj");
    const encoded = encodeProjectDir(root);
    const projHome = homeFor("good");   // 这个 home 下会建 .claude/projects/<encoded>/memory
    const mem = path.join(projHome, ".claude", "projects", encoded, "memory");

    // ── ② 红样本：本机 memory 是普通目录（#503 现场形态）⇒ 必须报红 ──
    fs.mkdirSync(mem, { recursive: true });
    const r2 = checkMemoryLink({ root, home: projHome });
    await t.test('普通目录 ⇒ 报「普通目录」且带修法', () => {
      assert.ok(!!r2.fail && /普通目录/.test(r2.fail[0]) && /NEW-MACHINE/.test(r2.fail[1]), '普通目录 ⇒ 报「普通目录」且带修法  →  ' + JSON.stringify(r2).slice(0, 200));
    });
    await t.test('普通目录 ⇒ 不是绿也不是 SKIP', () => {
      assert.ok(!r2.green && !r2.skip, '普通目录 ⇒ 不是绿也不是 SKIP  →  ' + JSON.stringify(r2).slice(0, 120));
    });

    // ── ③ 正样本：正确 Junction（目标仓 origin = windsurf-dao-memory，SSH 形式）⇒ 必须绿 ──
    if (process.platform === 'win32') {
      fs.rmSync(mem, { recursive: true, force: true });
      const memRepo = path.join(SANDBOX, "repos", "windsurf-dao-memory");
      writeGitRepo(memRepo, "git@github.com:thoerwink8/windsurf-dao-memory.git");
      const want = memRepo;
      fs.symlinkSync(want, mem, "junction");
      const r3 = checkMemoryLink({ root, home: projHome });
      await t.test('正确 Junction ⇒ 绿且点名 memory 仓', () => {
        assert.ok(!!r3.green && /已接/.test(r3.green) && r3.green.includes("windsurf-dao-memory"), '正确 Junction ⇒ 绿且点名 memory 仓  →  ' + JSON.stringify(r3).slice(0, 200));
      });
    } else {
      await t.test('③ 正样本：正确 Junction（跳过：非 Windows 平台建不了 Junction，部署目标 Windows）', { skip: true }, () => {});
    }

    // ── ③b origin 用 HTTPS 形式（换机 clone 的默认形态）⇒ 仍必须绿 ──
    if (process.platform === 'win32') {
      const memRepoH = path.join(SANDBOX, "repos", "windsurf-dao-memory-https");
      writeGitRepo(memRepoH, "https://github.com/thoerwink8/windsurf-dao-memory.git/");
      junctionFor(projHome, root, encodeProjectDir, memRepoH);
      const r3b = checkMemoryLink({ root, home: projHome });
      await t.test('HTTPS origin + 尾斜杠 ⇒ 绿', () => {
        assert.ok(!!r3b.green, 'HTTPS origin + 尾斜杠 ⇒ 绿  →  ' + JSON.stringify(r3b).slice(0, 200));
      });
    } else {
      await t.test('③b HTTPS origin 样本（跳过：非 Windows 平台，部署目标 Windows）', { skip: true }, () => {});
    }

    // ── ④ 故意断开：删掉目标 ⇒ 链接悬空报红（仓规：断开必须当场被拦）──
    if (process.platform === 'win32') {
      const t4 = path.join(SANDBOX, "repos", "windsurf-dao-memory");
      junctionFor(projHome, root, encodeProjectDir, t4);
      fs.rmSync(t4, { recursive: true, force: true });
      const r4 = checkMemoryLink({ root, home: projHome });
      await t.test('目标被删 ⇒ 报「悬空」', () => {
        assert.ok(!!r4.fail && /悬空/.test(r4.fail[0]), '目标被删 ⇒ 报「悬空」  →  ' + JSON.stringify(r4).slice(0, 160));
      });
    } else {
      await t.test('④ 悬空样本（跳过：非 Windows 平台，部署目标 Windows）', { skip: true }, () => {});
    }

    // ── ⑤ 红样本：指向主仓旧的 memory 目录（搬家前状态，#529 必须红）──
    if (process.platform === 'win32') {
      // 主仓旧真相源：普通目录、不是 git 仓——搬家前 Junction 指向它，现在必须报红
      const oldHostMem = path.join(SANDBOX, "roots", "old-hosts", "oldproj", "host", "memory");
      fs.mkdirSync(oldHostMem, { recursive: true });
      fs.writeFileSync(path.join(oldHostMem, "x.md"), "# x", "utf8");
      junctionFor(projHome, root, encodeProjectDir, oldHostMem);
      const r5 = checkMemoryLink({ root, home: projHome });
      await t.test('指向主仓旧 memory 目录 ⇒ 报「不是 windsurf-dao-memory 仓」', () => {
        assert.ok(!!r5.fail && /windsurf-dao-memory/.test(r5.fail[0]), '指向主仓旧 memory 目录 ⇒ 报「不是 windsurf-dao-memory 仓」  →  ' + JSON.stringify(r5).slice(0, 200));
      });
    } else {
      await t.test('⑤ 旧 memory 目录样本（跳过：非 Windows 平台，部署目标 Windows）', { skip: true }, () => {});
    }

    // ── ⑥ 红样本：指向一个 git 仓但 origin 不是 windsurf-dao-memory ⇒ 报红 ──
    if (process.platform === 'win32') {
      const wrong = path.join(SANDBOX, "repos", "some-other-repo");
      writeGitRepo(wrong, "git@github.com:thoerwink8/some-other-repo.git");
      junctionFor(projHome, root, encodeProjectDir, wrong);
      const r6 = checkMemoryLink({ root, home: projHome });
      await t.test('origin 是别的仓 ⇒ 报「origin 不是 windsurf-dao-memory」并带真实 origin', () => {
        assert.ok(!!r6.fail && /origin 不是|origin/.test(r6.fail[0]) && r6.fail[2].includes("some-other-repo"), 'origin 是别的仓 ⇒ 报「origin 不是 windsurf-dao-memory」并带真实 origin  →  ' + JSON.stringify(r6).slice(0, 200));
      });
    } else {
      await t.test('⑥ 别的仓样本（跳过：非 Windows 平台，部署目标 Windows）', { skip: true }, () => {});
    }

    // ── ⑦ 红样本：是 git 仓但没有 origin remote ⇒ 报红 ──
    if (process.platform === 'win32') {
      const noOrigin = path.join(SANDBOX, "repos", "no-origin-repo");
      writeGitRepo(noOrigin, null);
      junctionFor(projHome, root, encodeProjectDir, noOrigin);
      const r7 = checkMemoryLink({ root, home: projHome });
      await t.test('无 [remote origin] ⇒ 报「没有 origin remote」', () => {
        assert.ok(!!r7.fail && /没有 origin remote/.test(r7.fail[0]), '无 [remote origin] ⇒ 报「没有 origin remote」  →  ' + JSON.stringify(r7).slice(0, 200));
      });
    } else {
      await t.test('⑦ 无 origin 样本（跳过：非 Windows 平台，部署目标 Windows）', { skip: true }, () => {});
    }

    // ── ⑧ 绿样本：.git 是文件（worktree 形态，gitdir + commondir 指向主 git 目录）⇒ 仍绿 ──
    if (process.platform === 'win32') {
      // 真实 worktree 布局：worktree/.git 是文件(gitdir: → 主仓 .git/worktrees/<名>)；
      // 那个 gitdir 里的 commondir 再指向主仓 .git；config 只住主仓 .git/config
      const mainRepo = path.join(SANDBOX, "repos", "wt-main");
      const mainGit = path.join(mainRepo, ".git");
      fs.mkdirSync(path.join(mainGit, "worktrees", "wk"), { recursive: true });
      fs.writeFileSync(path.join(mainGit, "config"),
        `[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = git@github.com:thoerwink8/windsurf-dao-memory.git\n`, "utf8");
      fs.writeFileSync(path.join(mainGit, "worktrees", "wk", "commondir"), "..\\..\n", "utf8");
      const wk = path.join(SANDBOX, "repos", "wt-worktree");
      fs.mkdirSync(wk, { recursive: true });
      fs.writeFileSync(path.join(wk, ".git"), `gitdir: ${path.join(mainGit, "worktrees", "wk").replace(/\\/g, "/")}\n`, "utf8");
      junctionFor(projHome, root, encodeProjectDir, wk);
      const r8 = checkMemoryLink({ root, home: projHome });
      await t.test('.git 文件形态(gitdir+commondir) ⇒ 绿', () => {
        assert.ok(!!r8.green, '.git 文件形态(gitdir+commondir) ⇒ 绿  →  ' + JSON.stringify(r8).slice(0, 200));
      });
    } else {
      await t.test('⑧ worktree 形态样本（跳过：非 Windows 平台，部署目标 Windows）', { skip: true }, () => {});
    }

    // ── ⑨ SKIP 与绿必须分开：没有该项目 memory 目录 ⇒ SKIP 不是绿 ──
    {
      const bareHome = homeFor("bare");   // 只有 .claude/，没有 projects/<encoded>/memory
      const r9 = checkMemoryLink({ root, home: bareHome });
      await t.test('无目录 ⇒ SKIP 且不是绿', () => {
        assert.ok(!!r9.skip && !r9.green && !r9.fail, '无目录 ⇒ SKIP 且不是绿  →  ' + JSON.stringify(r9).slice(0, 200));
      });
    }
    {
      const weirdRoot = path.join(SANDBOX, "roots", "no-such-checkout");  // root 不存在也不影响：只看本机目录
      const r9b = checkMemoryLink({ root: weirdRoot, home: homeFor("bare2") });
      await t.test('root 任意路径 + 本机无目录 ⇒ SKIP 不是红', () => {
        assert.ok(!!r9b.skip && !r9b.fail, 'root 任意路径 + 本机无目录 ⇒ SKIP 不是红  →  ' + JSON.stringify(r9b).slice(0, 200));
      });
    }

    fs.rmSync(SANDBOX, { recursive: true, force: true });
  });
});