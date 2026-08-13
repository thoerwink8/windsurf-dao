// doctor-pwsh-detect.tests.js — pwsh 三态探测回归网（issue #364）
//
// 治的病：doctor 的 pwsh 检测只查 PATH（where/which），装完 PS7 但没开新终端/长驻
// 进程时会假阴性——机器级 PATH 更新要新进程才继承，与 dao-roster.mjs 假阴性
// （#337）同族。判据全在 config-sync/lib/pwsh.mjs 的 detectPwshState()（PATH 命中 /
// 兜底候选存在且真跑通 / 真未装三态），本套测试验的是那个函数，不是 doctor.mjs 的
// 打印层（打印层只是取数转文案，无独立判据）。
//
// 真实语料而非内生 mock：三态测试都让 spawnSyncFn 真的 spawn 一个进程（真实可执行的
// fixture .cmd 文件，或本机真实安装的 pwsh.exe），退出码由那个真进程决定——不直接
// stub spawnSyncFn 返回一个编好的 {status:0} 对象糊弄判据。existsSyncFn 同理用真实
// fs.existsSync 查真实磁盘上的 fixture 文件。

const fs = require("fs");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");

const REPO = path.resolve(__dirname, "..");
const PWSH_SRC_PATH = path.join(REPO, "config-sync", "lib", "pwsh.mjs");
const { detectPwshState, pickPwsh } = require(PWSH_SRC_PATH);

// .cmd fixture 在 Windows 上不是原生可执行体，CreateProcess 直接调用会 ENOENT——
// 真实批处理脚本本就要靠 cmd.exe 解释，这不是在绕开真实执行，是它本来的运行方式。
// 生产代码里真正的候选（pwsh.exe/where.exe/which）都是原生 .exe，不受此影响，
// 所以生产侧 spawnSync 调用不必也不该加 shell:true——这层包装只服务测试 fixture。
function shellSpawnSync(cmd, args, opts) {
  return spawnSync(cmd, args, { ...opts, shell: true });
}

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? "  →  " + detail : ""}`); }
}

if (process.platform !== "win32") {
  console.log("非 win32 平台：本套测试的 fixture 是 .cmd 批处理，只在 Windows 上有意义，跳过。");
  console.log(`\n=== 汇总: PASS=${pass} FAIL=${fail} ===`);
  process.exit(0);
}

// ── 真实可执行 fixture：写到 _tmp/ 下，测试结束统一清理 ─────────────────────
const FIXTURE_DIR = fs.mkdtempSync(path.join(REPO, "_tmp", "pwsh-detect-"));
function writeFixtureCmd(name, exitCode) {
  const p = path.join(FIXTURE_DIR, name);
  fs.writeFileSync(p, `@echo off\r\nexit /b ${exitCode}\r\n`, "utf8");
  return p;
}

const LOCATOR_FOUND = writeFixtureCmd("locator-found.cmd", 0); // 模拟 where/which 命中
const LOCATOR_MISSING = writeFixtureCmd("locator-missing.cmd", 1); // 模拟 where/which 未命中
const FAKE_PWSH_OK = writeFixtureCmd("fake-pwsh.cmd", 0); // 模拟兜底候选：真实存在且真跑通
const NONEXISTENT_CANDIDATE = path.join(FIXTURE_DIR, "does-not-exist.exe"); // 真实不存在

// 独立确认 fixture 本身的退出码是真的（不是测试自己瞎编的期望），避免「靶死了还判过」。
console.log("=== 前置：fixture .cmd 本身的真实退出码 ===");
{
  let okExit = -1, missExit = -1;
  try { execFileSync(LOCATOR_FOUND, { windowsHide: true, shell: true }); okExit = 0; } catch (e) { okExit = e.status; }
  try { execFileSync(LOCATOR_MISSING, { windowsHide: true, shell: true }); } catch (e) { missExit = e.status; }
  check("locator-found.cmd 真实退出码 0", okExit === 0, `实际 ${okExit}`);
  check("locator-missing.cmd 真实退出码 1", missExit === 1, `实际 ${missExit}`);
  check("fake-pwsh.cmd 在真实磁盘上存在", fs.existsSync(FAKE_PWSH_OK));
  check("does-not-exist.exe 在真实磁盘上确实不存在", !fs.existsSync(NONEXISTENT_CANDIDATE));
}

console.log("\n=== ① 正控：PATH 直接命中 → state='path' ===");
{
  const state = detectPwshState({ locator: LOCATOR_FOUND, spawnSyncFn: shellSpawnSync, candidatePaths: [], registryQueryFn: () => [] });
  check("state === 'path'", state.state === "path", JSON.stringify(state));
  check("resolvedPath === 'pwsh'（字面量，交给调用方直接当命令名用）", state.resolvedPath === "pwsh");
}

console.log("\n=== ② PATH 未命中但兜底候选真跑通 → state='fallback'（已装，进程 PATH 未刷新）===");
{
  const state = detectPwshState({
    locator: LOCATOR_MISSING,
    spawnSyncFn: shellSpawnSync,
    candidatePaths: [FAKE_PWSH_OK],
    registryQueryFn: () => [],
  });
  check("state === 'fallback'", state.state === "fallback", JSON.stringify(state));
  check("resolvedPath 指向真实兜底候选的绝对路径", state.resolvedPath === FAKE_PWSH_OK);
}

console.log("\n=== ③ 负控：PATH 未命中且兜底候选也不存在 → state='missing' ===");
{
  const state = detectPwshState({
    locator: LOCATOR_MISSING,
    spawnSyncFn: shellSpawnSync,
    candidatePaths: [NONEXISTENT_CANDIDATE],
    registryQueryFn: () => [],
  });
  check("state === 'missing'", state.state === "missing", JSON.stringify(state));
  check("resolvedPath === null", state.resolvedPath === null);
}

console.log("\n=== ④ pickPwsh() 三态语义对照：'path'/'fallback' 都返回可直接调用的路径，'missing' 才回退 5.1 ===");
{
  // pickPwsh(overrides) 把 overrides 原样转给 detectPwshState——用同一组真实 fixture
  // 直接驱动 pickPwsh 本体（不是重新实现它的分支逻辑再单独断言），三态各验一次映射。
  const pathResult = pickPwsh({ locator: LOCATOR_FOUND, spawnSyncFn: shellSpawnSync, candidatePaths: [], registryQueryFn: () => [] });
  check("'path' 态：pickPwsh 返回 'pwsh'", pathResult === "pwsh", pathResult);

  const fallbackResult = pickPwsh({ locator: LOCATOR_MISSING, spawnSyncFn: shellSpawnSync, candidatePaths: [FAKE_PWSH_OK], registryQueryFn: () => [] });
  check("'fallback' 态：pickPwsh 返回兜底绝对路径（不是 5.1）", fallbackResult === FAKE_PWSH_OK, fallbackResult);

  const missingResult = pickPwsh({ locator: LOCATOR_MISSING, spawnSyncFn: shellSpawnSync, candidatePaths: [NONEXISTENT_CANDIDATE], registryQueryFn: () => [] });
  check("'missing' 态：pickPwsh 才回退 'powershell.exe'（回退语义不变）", missingResult === "powershell.exe", missingResult);

  check("pickPwsh() 无参调用仍是真实可调用的冒烟（走真机 PATH/候选，不校验具体值）", typeof pickPwsh() === "string");
}

console.log("\n=== ⑤ 判别力 · mutation：弄坏兜底判据（把「真跑通」判据条件改到永不成立）→ ②必须从 fallback 掉到 missing（先破再验）===");
{
  const SRC = fs.readFileSync(PWSH_SRC_PATH, "utf8");
  const ANCHOR = "if (r.error === undefined && r.status === 0) return { state: 'fallback', resolvedPath: candidate };";
  if (!SRC.includes(ANCHOR)) {
    check("mutation 锚点在源文件里找得到", false, `锚点串没命中：${ANCHOR}`);
  } else {
    const mutantPath = path.join(FIXTURE_DIR, `pwsh-mutant-${process.pid}.mjs`);
    const mutated = SRC.replace(ANCHOR, "if (r.error === undefined && r.status === 999) return { state: 'fallback', resolvedPath: candidate };");
    check("mutation 真的改变了源文本", mutated !== SRC);
    fs.writeFileSync(mutantPath, mutated, "utf8");
    try {
      const M = require(mutantPath);
      const mutantState = M.detectPwshState({
        locator: LOCATOR_MISSING,
        spawnSyncFn: shellSpawnSync,
        candidatePaths: [FAKE_PWSH_OK],
        registryQueryFn: () => [],
      });
      // 变异体判别力自检：靶没被打死——mutant 的探测函数仍然「能跑」并返回结构化结果，
      // 只是不再能把真跑通的候选判成 fallback，而不是直接抛错或返回 undefined。
      check("变异体仍存活（不是把靶弄死，抛错/undefined 都算靶死）", mutantState && typeof mutantState.state === "string", JSON.stringify(mutantState));
      check("mutation ⇒ 同一份真实 fixture 从 'fallback' 掉到 'missing'（判据真的被测到了）", mutantState.state === "missing", JSON.stringify(mutantState));
    } finally {
      fs.rmSync(mutantPath, { force: true });
    }
  }
}

fs.rmSync(FIXTURE_DIR, { recursive: true, force: true });

console.log(`\n=== 汇总: PASS=${pass} FAIL=${fail} ===`);
process.exit(fail ? 1 : 0);
