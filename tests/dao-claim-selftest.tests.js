// dao-claim-selftest.tests.js — 把认领协议的回归网接进 dao check
//
// 这套是薄 wrapper，自己不含任何判据：断言全在 ccswitch/scripts/dao-claim.ps1 的
// `-Action selftest` 里（纯函数自测，不碰网络、可无条件复跑）。它存在的唯一理由是
// **回归网自己得有人跑**——dao check 自动扫 tests/ 下的每一套，而 selftest 是那个脚本
// 自带的子命令、不落在扫描面内；没有这个文件，那张网一轮都不会被跑到，
// 而「没人跑的回归网」与「没有回归网」在每一次体检的输出里逐字节相同。
//
// 判成败只看退出码（selftest 的契约：0 = 全绿 · 1 = 有红），不看输出里有没有 "error"。
// 红了把输出尾部打出来：dao check 只摘一行含 FAIL 的证据，全文要本地复跑才看得到。
//
// ⚠ 跳过的可见性，照直写：两个 PowerShell 宿主都起不来时本套 exit 0（跳过），
// 而 dao check 在退出码为 0 时不打印被测套的任何输出 ⇒ **那次跳过在体检视图里看不见**。
// 要让它可见得给 dao check 加第三态，而它的第一条不变量明写退出码只有 0 和 1。
// 单独跑 `node tests/dao-claim-selftest.tests.js` 时，跳过的原因是醒目的。

const path = require("path");
const fs = require("fs");
const { spawnSync } = require("child_process");

const REPO = path.resolve(__dirname, "..");
const SCRIPT = path.join(REPO, "ccswitch", "scripts", "dao-claim.ps1");
const REPRO = "pwsh -NoProfile -ExecutionPolicy Bypass -File ccswitch/scripts/dao-claim.ps1 -Action selftest";

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? "  →  " + detail : ""}`); }
}
function summary(extra) {
  console.log(`\n=== 汇总: PASS=${pass} FAIL=${fail}${extra || ""} ===`);
}

// 被测脚本先得在盘上：它不在的时候，下面跑出来的失败会指向 PowerShell，而真因是文件没了。
if (!fs.existsSync(SCRIPT)) {
  check("被测脚本在盘上", false, SCRIPT);
  summary();
  process.exit(1);
}

// 宿主探测：pwsh 优先、powershell 回退。判据是「真的起得来并退出 0」，不是「where 命中」——
// 装了但坏掉的宿主在 where 下同样命中，而它跑什么都失败。
function hostWorks(cmd) {
  const r = spawnSync(cmd, ["-NoProfile", "-Command", "exit 0"], {
    encoding: "utf8", windowsHide: true, timeout: 30000,
  });
  return !r.error && r.status === 0;
}

const host = ["pwsh", "powershell"].find(hostWorks);
if (!host) {
  console.log("  SKIP  pwsh 与 powershell 都起不来 ⇒ 认领协议回归网本轮没跑（这不是「通过」）");
  console.log(`        装上任一 PowerShell 后复跑：${REPRO}`);
  summary("  SKIP=1（本轮没查成，不是没问题）");
  process.exit(0);
}

const r = spawnSync(host, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", SCRIPT, "-Action", "selftest"], {
  encoding: "utf8", windowsHide: true, cwd: REPO, timeout: 120000,
});
const out = (r.stdout || "") + (r.stderr || "");
const tail = out.split(/\r?\n/).filter(Boolean).slice(-12).join("\n      ");

check(
  `认领协议 selftest 退出码 0（宿主 ${host}）`,
  !r.error && r.status === 0,
  r.error ? `起不来：${r.error.message}` : `exit=${r.status}\n      ${tail}\n      复跑：${REPRO}`
);

// 零样本闸：selftest 若被改成「什么都不做直接 exit 0」，上面那条照样绿。
// 数到 0 条断言和没看到输出，在退出码里长得一模一样——所以这里单独数一次。
const passLines = out.split(/\r?\n/).filter((l) => l.includes("PASS")).length;
check(
  "selftest 真的跑出了断言（零样本闸：一条 PASS 都没有 ⇒ 本轮等于没查）",
  passLines > 0,
  `输出里的 PASS 行数 = ${passLines}`
);

summary();
process.exit(fail ? 1 : 0);
