// 不可逆闸的自测 —— 这是全系统唯一「必须存在」的测试。
//
// 守的对象：ccswitch/hooks/dao-hard-gates.js 里两道自述「不可逆」的闸（它们的 why 字段原文）：
//   G3-publish        对外发布没有撤销键（gh release / npm|pnpm|yarn|bun publish / cargo publish）
//   G2-live-settings  覆写 live settings.json 可触发 401 device revoked，把文件改回去也恢复不了
// 闸是静默失效型部件：它挂了的样子和它放行的样子一模一样（都是 exit 0）。所以每道闸配一条自测。
//
// 判别力自问：把这两道闸放宽或关掉，下面是否至少有一条断言变红？末尾两条 mutation 钉住这一问——
// 没有 mutation 的正控只证明「今天是绿的」，证明不了「它明天变坏时会红」。
//
// 契约：hook 从 fd 0 读 JSON payload，拦下 = exit 2，放行 = exit 0，逃生阀只认真实环境变量。

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const REPO = path.resolve(__dirname, "..");
const HOOK = path.join(REPO, "ccswitch", "hooks", "dao-hard-gates.js");
const HOME = process.env.USERPROFILE || process.env.HOME || os.homedir();
const LIVE = path.join(HOME, ".claude", "settings.json");

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? "  →  " + detail : ""}`); }
}

/** 跑一次 hook，返回退出码。2 = 拦下，0 = 放行。 */
function run(payload, env, hookPath) {
  const r = spawnSync(process.execPath, [hookPath || HOOK], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, ...(env || {}) },
  });
  return r.status;
}
const shell = (command) => ({ tool_name: "Bash", tool_input: { command }, cwd: REPO });
const write = (file_path) => ({ tool_name: "Write", tool_input: { file_path }, cwd: REPO });

console.log("\n=== G3-publish · 对外发布不可逆 ===");
check("正控 gh release create ⇒ 拦", run(shell("gh release create v9.9.9")) === 2);
check("正控 npm publish ⇒ 拦", run(shell("npm publish")) === 2);
check("正控 cargo publish ⇒ 拦", run(shell("cargo publish --allow-dirty")) === 2);
// 负控和正控一样重要：拦住一切的闸会被当场关掉，那等于没有闸。
check("负控 --dry-run 演练 ⇒ 放行", run(shell("gh release create v9.9.9 --dry-run")) === 0);
check("负控 gh pr create（形似不该拦）⇒ 放行", run(shell("gh pr create --title x")) === 0);
check("逃生阀 DAO_PUBLISH_APPROVED=1 ⇒ 放行", run(shell("npm publish"), { DAO_PUBLISH_APPROVED: "1" }) === 0);

console.log("\n=== G2-live-settings · 覆写 live 配置不可逆 ===");
check("正控 编辑器写 live settings.json ⇒ 拦", run(write(LIVE)) === 2, LIVE);
check("正控 shell 写 live settings.json ⇒ 拦",
  run(shell(`Copy-Item "x.json" "$env:USERPROFILE\\.claude\\settings.json" -Force`)) === 2);
check("负控 写仓内镜像层 config-sync/common/settings.json ⇒ 放行",
  run(write(path.join(REPO, "config-sync", "common", "settings.json"))) === 0);
check("逃生阀 DAO_SETTINGS_EDIT_APPROVED=1 ⇒ 放行",
  run(write(LIVE), { DAO_SETTINGS_EDIT_APPROVED: "1" }) === 0);

console.log("\n=== 判别力 · mutation（把闸改坏，正控必须跟着掉下来）===");
const SRC = fs.readFileSync(HOOK, "utf8");
function mutate(name, find, replace, payload) {
  if (!SRC.includes(find)) {
    // 判据搬了家而 mutation 静默变成空操作 ⇒ 这一条会「通过」而什么都没验。必须红。
    check(`mutation ${name}`, false, `锚点串在 hook 里找不到了：${find.slice(0, 60)}`);
    return;
  }
  const p = path.join(REPO, "_tmp", `hard-gates-mutant-${process.pid}-${Math.random().toString(36).slice(2)}.js`);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  try {
    fs.writeFileSync(p, SRC.replace(find, replace), "utf8");
    check(`mutation ${name} ⇒ 正控从「拦」掉到「放行」`, run(payload, null, p) === 0);
  } finally {
    fs.rmSync(p, { force: true });
  }
}
mutate("G3 发布命令表被改瞎", "/^(npm|pnpm|yarn|bun)\\s+publish\\b/", "/^__NEVER_MATCHES__/",
  shell("npm publish"));
mutate("G2 live 文件名表被改瞎", `["settings.json", "settings.local.json"]`, `["settings.json.NEVER"]`,
  write(LIVE));

console.log(`\n=== 汇总: PASS=${pass} FAIL=${fail} ===`);
process.exit(fail > 0 ? 1 : 0);
