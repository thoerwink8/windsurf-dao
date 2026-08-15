// 本机 memory 断链检查 · 判别力回归网（issue #503）
//
// 验 scripts/lib/dao-memory-link-check.mjs（dao-check 第 ⑨ 项的实现）：
//   红样本 —— 本机 memory 是普通目录（#503 现场形态）/ 指向别处 / 链接悬空，三种都必须报红；
//   绿样本 —— 正确 Junction 必须绿（证明检查器不是「恒红」）；
//   SKIP  —— 本机没有该项目 memory 目录（CI / 新机 / 未接的 worktree）必须 SKIP 而不是绿——
//            SKIP 与绿分不开，CI 就会永远绿而本机永远没人查。
// 另按 NEW-MACHINE §10 硬钉两条编码示例（D:\frank\windsurf-dao → D--frank-windsurf-dao、
// 468-审官-gpt-5.6-sol → 468----gpt-5-6-sol），编码规则错了检查器就查错目录。
//
// 全部在 _tmp/memlink-sandbox 里造假 root + 假 HOME，不碰本机 ~/.claude。
// Junction 只在 Windows 上能建；非 Windows 平台跳过依赖 Junction 的样本（部署目标是 Windows）。

const fs = require("fs");
const path = require("path");

const REPO = path.resolve(__dirname, "..");
const SANDBOX = path.join(REPO, "_tmp", "memlink-sandbox");

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? "  →  " + detail : ""}`); }
}

function makeRoot(name) {
  const root = path.join(SANDBOX, "roots", name);
  fs.mkdirSync(path.join(root, "host", "memory"), { recursive: true });
  fs.writeFileSync(path.join(root, "host", "memory", "x.md"), "# x", "utf8");
  return root;
}

function homeFor(name) {
  const home = path.join(SANDBOX, "homes", name);
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  return home;
}

async function main() {
  const { checkMemoryLink, encodeProjectDir } = await import("../scripts/lib/dao-memory-link-check.mjs");
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  fs.mkdirSync(SANDBOX, { recursive: true });

  console.log("\n=== ① 编码规则与 NEW-MACHINE §10 一致（硬钉文档示例）===");
  {
    const a = encodeProjectDir("D:\\frank\\windsurf-dao");
    check("D:\\frank\\windsurf-dao → D--frank-windsurf-dao", a === "D--frank-windsurf-dao", a);
    const b = encodeProjectDir("468-审官-gpt-5.6-sol");
    check("468-审官-gpt-5.6-sol → 468----gpt-5-6-sol（中文/点都算非字母数字）", b === "468----gpt-5-6-sol", b);
  }

  const root = makeRoot("proj");
  const encoded = encodeProjectDir(root);
  const projHome = homeFor("good");   // 这个 home 下会建 .claude/projects/<encoded>/memory
  const mem = path.join(projHome, ".claude", "projects", encoded, "memory");
  const want = path.join(root, "host", "memory");

  console.log("\n=== ② 红样本：本机 memory 是普通目录（#503 现场形态）⇒ 必须报红 ===");
  {
    fs.mkdirSync(mem, { recursive: true });
    const r = checkMemoryLink({ root, home: projHome });
    check("普通目录 ⇒ 报「普通目录」且带修法", !!r.fail && /普通目录/.test(r.fail[0]) && /NEW-MACHINE/.test(r.fail[1]), JSON.stringify(r).slice(0, 200));
    check("普通目录 ⇒ 不是绿也不是 SKIP", !r.green && !r.skip, JSON.stringify(r).slice(0, 120));
  }

  console.log("\n=== ③ 正样本：正确 Junction ⇒ 必须绿（证明不是恒红）===");
  if (process.platform !== "win32") {
    console.log("  跳过：非 Windows 平台建不了 Junction（部署目标 Windows）");
  } else {
    fs.rmSync(mem, { recursive: true, force: true });
    fs.symlinkSync(want, mem, "junction");
    const r = checkMemoryLink({ root, home: projHome });
    check("正确 Junction ⇒ 绿且点名指向 host/memory", !!r.green && /已接/.test(r.green) && r.green.includes(want), JSON.stringify(r).slice(0, 200));
  }

  console.log("\n=== ④ 故意断开：删掉目标 ⇒ 链接悬空报红（仓规：断开必须当场被拦）===");
  if (process.platform === "win32") {
    fs.rmSync(want, { recursive: true, force: true });
    const r = checkMemoryLink({ root, home: projHome });
    check("目标被删 ⇒ 报「悬空」", !!r.fail && /悬空/.test(r.fail[0]), JSON.stringify(r).slice(0, 160));
    fs.mkdirSync(want, { recursive: true });
    fs.writeFileSync(path.join(want, "x.md"), "# x", "utf8");
  } else {
    console.log("  跳过：非 Windows 平台");
  }

  console.log("\n=== ⑤ 指向别处（链接还活着但目标不是 host/memory）⇒ 报红 ===");
  if (process.platform === "win32") {
    const wrong = path.join(SANDBOX, "wrong-target");
    fs.mkdirSync(wrong, { recursive: true });
    fs.rmSync(mem, { recursive: true, force: true });
    fs.symlinkSync(wrong, mem, "junction");
    const r = checkMemoryLink({ root, home: projHome });
    check("指向别处 ⇒ 报「指向别处」并带真实目标", !!r.fail && /指向别处/.test(r.fail[0]) && r.fail[2].includes(wrong), JSON.stringify(r).slice(0, 200));
  } else {
    console.log("  跳过：非 Windows 平台");
  }

  console.log("\n=== ⑥ SKIP 与绿必须分开：没有该项目 memory 目录 ⇒ SKIP 不是绿 ===");
  {
    const bareHome = homeFor("bare");   // 只有 .claude/，没有 projects/<encoded>/memory
    const r = checkMemoryLink({ root, home: bareHome });
    check("无目录 ⇒ SKIP 且不是绿", !!r.skip && !r.green && !r.fail, JSON.stringify(r).slice(0, 200));
  }
  {
    const weirdRoot = path.join(SANDBOX, "roots", "no-host-mem");  // 仓里连 host/memory 都没有
    fs.mkdirSync(weirdRoot, { recursive: true });
    const r = checkMemoryLink({ root: weirdRoot, home: homeFor("bare2") });
    check("仓内 host/memory 不在 + 本机也没目录 ⇒ SKIP 不是红", !!r.skip && !r.fail, JSON.stringify(r).slice(0, 200));
  }

  console.log("\n=== ⑦ 仓内 host/memory 被移走（链接指向旧位置）⇒ 报「没查成」不是绿 ===");
  if (process.platform === "win32") {
    const ghost = path.join(SANDBOX, "ghost-target");
    fs.mkdirSync(ghost, { recursive: true });
    const root2 = makeRoot("proj2");
    const home2 = homeFor("ghost");
    const mem2 = path.join(home2, ".claude", "projects", encodeProjectDir(root2), "memory");
    fs.mkdirSync(path.dirname(mem2), { recursive: true });
    fs.rmSync(mem2, { recursive: true, force: true });
    fs.symlinkSync(ghost, mem2, "junction");
    fs.rmSync(path.join(root2, "host", "memory"), { recursive: true, force: true });  // 真相源被移走
    const r = checkMemoryLink({ root: root2, home: home2 });
    check("链接活着但真相源不在 ⇒ 报「host/memory 不在」", !!r.fail && /host\/memory 不在/.test(r.fail[0]), JSON.stringify(r).slice(0, 200));
  } else {
    console.log("  跳过：非 Windows 平台");
  }

  fs.rmSync(SANDBOX, { recursive: true, force: true });

  console.log(`\n通过 ${pass} · 失败 ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
