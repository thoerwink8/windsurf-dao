// doctor-hooks-drift.tests.js — claude hooks 三层对账回归网（issue #366）
//
// 治的病：#324 退役 hook 只清了 git 快照，cc-switch DB 的 common_config_claude 里的
// 注册没跟着清，doctor 当时全绿——它只数行数，从不看 hooks 段内容，也不看 live
// settings.json 的 hooks 指向的文件在不在。判据全在 config-sync/lib/hooks-drift.mjs
// （纯函数），本套测试不碰真机 DB / live settings.json / common/settings.json 快照
// 本体——真实语料来自把仓库里已提交的快照原样读进来再拷贝改造（不自造 settings 结构），
// 存在性检查则直接用仓库里真实存在/真实不存在的文件路径，不注入假的 existsSync。
//
// 层次：①绿态（当前机三层应一致，2026-08-13 手术后实况）②人造指空→红
// ③人造 DB≠快照→红 ④Orca 段被正确忽略 ⑤mutation：弄坏「过滤 Orca 段」判据→必须变红。
// 判别力自问：任何放松/收紧 hooks 对账判据的改动，是否至少有一条断言会变红？

const fs = require("fs");
const path = require("path");

const REPO = path.resolve(__dirname, "..");
const H = require(path.join(REPO, "config-sync", "lib", "hooks-drift.mjs"));
const { stableJson } = require(path.join(REPO, "config-sync", "lib", "sqlite.mjs"));
const { decodePaths, encodePaths } = require(path.join(REPO, "config-sync", "lib", "paths.mjs"));

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? "  →  " + detail : ""}`); }
}

// ── 真实语料：仓库里已提交的快照本体（不自造结构）───────────────────────────
const SNAPSHOT_PATH = path.join(REPO, "config-sync", "common", "settings.json");
const snapshotDoc = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, "utf8").replace(/^\uFEFF/, ""));
const snapshotRows = Array.isArray(snapshotDoc) ? snapshotDoc : (snapshotDoc.rows || []);
const claudeRow = snapshotRows.find((r) => r.key === "common_config_claude");
if (!claudeRow) {
  check("前置条件：快照里有 common_config_claude 行", false, "本套测试的真实语料来源没了，其余断言全跳过没有意义");
  console.log(`\n=== 汇总: PASS=${pass} FAIL=${fail} ===`);
  process.exit(1);
}
const SNAPSHOT_RAW = claudeRow.value; // 占位符形态（真实提交内容）
const SNAPSHOT_HOOKS = JSON.parse(SNAPSHOT_RAW).hooks;

// 「DB 形态」= 快照的占位符还原成本机真实路径（用生产同一份 decodePaths，
// 不是测试自己拍脑袋拼一份真实路径）——这就是「三层手术对齐后」DB 应该长的样子。
const DB_REAL_RAW = decodePaths(SNAPSHOT_RAW);
const DB_HOOKS_REAL = JSON.parse(DB_REAL_RAW).hooks;

// 真实机器上 Orca 往 live settings.json 注入的原文（2026-08-13 本机实采，见 issue #366
// 交付记录）——不是拍脑袋编的字符串。
const ORCA_COMMAND = "if [ -f 'C:/Users/Administrator/.orca/agent-hooks/claude-hook.cmd' ]; then 'C:/Users/Administrator/.orca/agent-hooks/claude-hook.cmd'; else { command -p cat 2>/dev/null || cat; } >/dev/null 2>&1 || :; fi";
function orcaGroup(matcher) {
  const group = { hooks: [{ type: "command", command: ORCA_COMMAND, timeout: 10 }] };
  if (matcher !== undefined) group.matcher = matcher;
  return group;
}

// 深拷贝一份 DB 形态的 hooks，往真实存在的事件里插一条 Orca 分组，并且额外新增
// dao 完全没注册过的事件（PostToolUse）——跟真实机器观察到的形状一致：Orca 既往
// dao 已注册的事件里插队，也会自己开新事件。
function buildLiveHooksWithOrca() {
  const live = JSON.parse(JSON.stringify(DB_HOOKS_REAL));
  live.PreToolUse = [...live.PreToolUse, orcaGroup("*")];
  live.SessionStart = [...live.SessionStart, orcaGroup()];
  live.PostToolUse = [orcaGroup("*")]; // dao 从未注册过的事件，整个键应在过滤后消失
  return live;
}

console.log("\n=== ① 绿态：当前机三层对账应一致（2026-08-13 手术后实况）===");
{
  const dbFiltered = H.filterOrcaHookGroups(JSON.parse(encodePaths(DB_REAL_RAW)).hooks);
  const snapFiltered = H.filterOrcaHookGroups(SNAPSHOT_HOOKS);
  check("DB↔快照：占位符还原往返后深比较一致", stableJson(dbFiltered) === stableJson(snapFiltered));

  const liveHooks = buildLiveHooksWithOrca();
  const liveFiltered = H.filterOrcaHookGroups(liveHooks);
  const snapDecodedFiltered = H.filterOrcaHookGroups(JSON.parse(decodePaths(SNAPSHOT_RAW)).hooks);
  check("live（含 Orca 注入）↔快照：排除 Orca 段后深比较一致", stableJson(liveFiltered) === stableJson(snapDecodedFiltered));

  const cmdCount = H.extractHookCommands(H.filterOrcaHookGroups(SNAPSHOT_HOOKS)).length;
  check("零样本闸：真实快照解析出的 command 数 > 0（不是 0 条误判一致）", cmdCount > 0, `实际 ${cmdCount}`);
}

console.log("\n=== ② 人造指空：hook 命令指向不存在的文件 → 必须报 missing（真实磁盘存在性，不注入假 existsSync）===");
{
  // 正控：仓库里真实存在的 hook 文件，必须判「存在」。
  const okCheck = H.checkNodeHookExistence(DB_HOOKS_REAL);
  check("正控：真实 hook 文件全部判定存在", okCheck.missing.length === 0, JSON.stringify(okCheck.missing));
  check("正控：checked 非空（零样本闸没有误判「查过」）", okCheck.checked.length > 0);

  // 红：拷贝一份，把其中一条命令的路径改成真实不存在的文件（复刻 #324 那次「hook 文件被
  // 删但注册没清」的实况：文件名刻意带 issue 号，保证在这台机器上一定不存在）。
  const broken = JSON.parse(JSON.stringify(DB_HOOKS_REAL));
  const brokenPath = path.join(REPO, "ccswitch", "hooks", "dao-hard-gates-RETIRED-324-fixture.js");
  check("前置：造假路径在真实磁盘上确实不存在", !fs.existsSync(brokenPath));
  broken.PreToolUse[0].hooks[0].command = `node "${brokenPath}"`;
  const brokenCheck = H.checkNodeHookExistence(broken);
  check("红：人造指空被正确抓到", brokenCheck.missing.some((m) => m.path === brokenPath), JSON.stringify(brokenCheck.missing));
}

console.log("\n=== ③ 人造 DB≠快照：改一个真实字段 → 深比较必须报不一致 ===");
{
  const mutatedDbRaw = DB_REAL_RAW.replace('"timeout":10', '"timeout":99999');
  check("前置：mutation 锚点在真实语料里确实命中", mutatedDbRaw !== DB_REAL_RAW);
  const mutatedDbFiltered = H.filterOrcaHookGroups(JSON.parse(encodePaths(mutatedDbRaw)).hooks);
  const snapFiltered = H.filterOrcaHookGroups(SNAPSHOT_HOOKS);
  check("红：DB 与快照字段不同 ⇒ 深比较不相等", stableJson(mutatedDbFiltered) !== stableJson(snapFiltered));
}

console.log("\n=== ④ Orca 段被正确忽略（结构层面单独验证，不止靠①的整体深比较）===");
{
  const liveHooks = buildLiveHooksWithOrca();
  const beforeFilter = H.extractHookCommands(liveHooks);
  const afterFilter = H.extractHookCommands(H.filterOrcaHookGroups(liveHooks));
  check("过滤前含 Orca 命令", beforeFilter.some((c) => H.isOrcaHookCommand(c.command)));
  check("过滤后不含任何 Orca 命令", afterFilter.every((c) => !H.isOrcaHookCommand(c.command)));
  check("过滤后命令数比过滤前少（真的删了东西，不是空操作）", afterFilter.length < beforeFilter.length);
  check("dao 从未注册过的纯 Orca 事件（PostToolUse）过滤后整个键消失", !Object.prototype.hasOwnProperty.call(H.filterOrcaHookGroups(liveHooks), "PostToolUse"));
  check("dao 已注册事件混入 Orca 分组后，dao 自己那条分组仍保留（PreToolUse）", H.filterOrcaHookGroups(liveHooks).PreToolUse.length === 1);
}

console.log("\n=== ⑤ 自检半：独立正则扫描与结构化遍历（互不复用解析逻辑）===");
{
  const liveHooks = buildLiveHooksWithOrca();
  const rawText = JSON.stringify({ hooks: liveHooks });
  const ok = H.selfCheckHookSampleCount(liveHooks, rawText);
  check("正常情况下结构遍历与原文本数字对得上，不判定「瞎了」", ok.structural > 0 && !ok.blind, JSON.stringify(ok));

  // 模拟「结构化遍历本身坏了」：喂一个空对象当 hooksSection，但原始文本仍然是真的。
  const blind = H.selfCheckHookSampleCount({}, rawText);
  check("结构遍历返回 0 但原文本 > 0 ⇒ 判定「瞎了」", blind.structural === 0 && blind.textual > 0 && blind.blind === true, JSON.stringify(blind));
}

console.log("\n=== ⑥ extractNodeHookPath：截取带尾随参数的 node hook 命令 ===");
{
  check("form 一：无尾随参数", H.extractNodeHookPath('node "C:/x/y.js"') === "C:/x/y.js");
  check("form 二：带尾随参数（真实样本 dao-timecode.js claude）", H.extractNodeHookPath('node "C:/x/y.js" claude') === "C:/x/y.js");
  check("非 node hook 形态返回 null（Orca 的 if 判断句）", H.extractNodeHookPath(ORCA_COMMAND) === null);
}

console.log("\n=== ⑦ 判别力 · mutation：弄坏「过滤 Orca 段」判据，①的绿态必须跟着变红（先破再验）===");
{
  const SRC_PATH = path.join(REPO, "config-sync", "lib", "hooks-drift.mjs");
  const SRC = fs.readFileSync(SRC_PATH, "utf8");
  const ANCHOR = "const ORCA_HOOK_MARKER = '.orca/agent-hooks';";
  if (!SRC.includes(ANCHOR)) {
    check("mutation 锚点在源文件里找得到", false, `锚点串没命中：${ANCHOR}`);
  } else {
    const mutantPath = path.join(REPO, "_tmp", `hooks-drift-mutant-${process.pid}-${Math.random().toString(36).slice(2)}.mjs`);
    fs.mkdirSync(path.dirname(mutantPath), { recursive: true });
    try {
      fs.writeFileSync(mutantPath, SRC.replace(ANCHOR, "const ORCA_HOOK_MARKER = '.orca/agent-hooks-NEVER-MATCH-XYZ';"), "utf8");
      const M = require(mutantPath);

      const liveHooks = buildLiveHooksWithOrca();
      const snapDecodedFiltered = M.filterOrcaHookGroups(JSON.parse(decodePaths(SNAPSHOT_RAW)).hooks);
      const liveFilteredMutant = M.filterOrcaHookGroups(liveHooks);

      // 变异体判别力自检：靶没被打死——mutant 的过滤函数仍然「能跑」，只是不再识别
      // Orca 命令，所以过滤后的 live 侧应该比正常版本多出 Orca 那几条，而不是直接抛错。
      check("变异体仍存活（不是把靶弄死，抛错/返回空对象都算靶死）",
        typeof liveFilteredMutant === "object" && Object.keys(liveFilteredMutant).length > 0);

      check("mutation ⇒ 正控从「一致」掉到「不一致」（Orca 段不再被滤掉，深比较必须变红）",
        stableJson(liveFilteredMutant) !== stableJson(snapDecodedFiltered));
    } finally {
      fs.rmSync(mutantPath, { force: true });
    }
  }
}

console.log(`\n=== 汇总: PASS=${pass} FAIL=${fail} ===`);
process.exit(fail ? 1 : 0);
