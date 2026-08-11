#!/usr/bin/env node
// dao-affected-tests.mjs — 「改谁才检谁」：按 diff 映射受影响的留守测试套（2026-08-11 tests 终局追加）
//
// 合并链验证步调它：碰了某 hook 才跑它那套（秒级）；没碰闸一套不跑。
// **映射表住本脚本，不住文字**——文字里的清单会过期，脚本里的表随代码评审走。
//
// 用法：
//   node scripts/dao-affected-tests.mjs                  # 自动取 git diff origin/main...HEAD
//   node scripts/dao-affected-tests.mjs --files a.js b.ps1   # 显式文件清单（自测/离线用）
//   node scripts/dao-affected-tests.mjs --json           # JSON 输出（默认逐行一套，空=无需跑）
// 退出码：0 正常（含「无需跑」）· 3 拿不到 diff（fail-open 还是 closed 由调用方定——
//   dao-pr-merge 拿非 0 当「判不出 ⇒ 跑全部」，见它头注）。
//
// 判不了归属的改动（CLAUDE.md / docs/ / _tmp/ 等纯文字）⇒ 零套，秒过——
// 它们没有行为可测；这正是归宿表灭掉文字一致性检查后的自洽形态。
import { spawnSync } from "node:child_process";

// ── 映射表：仓内路径前缀 → 留守测试套 ────────────────────────────────────────
// 维护判据：加/删/改名留守测试套 ⇒ 改这里；除此之外不许长新条目（条目越少，合并链越快）。
const MAP = [
  // hook 行为组（源文件 → 它那套）
  { prefixes: ["ccswitch/hooks/dao-glob-gate.js", "ccswitch/lib/guarded-scan.js"], tests: ["tests/glob-gate.tests.js"] },
  { prefixes: ["ccswitch/scripts/check-dead-gates.mjs"], tests: ["tests/dead-gates.tests.js"] },
  { prefixes: ["ccswitch/hooks/dao-subagent-clauses.js", "ccswitch/scripts/render-clauses.mjs", "ccswitch/lib/clause-parser.mjs", "ccswitch/scripts/clause-sources.mjs"], tests: ["tests/subagent-clauses.tests.js"] },
  { prefixes: ["ccswitch/hooks/dao-tool-nudge.js"], tests: ["tests/dao-tool-nudge.tests.js"] },
  { prefixes: ["ccswitch/hooks/dao-scaffold-check.js"], tests: ["tests/dao-scaffold-check.tests.js"] },
  { prefixes: ["ccswitch/hooks/dao-hard-gates.js"], tests: ["tests/hard-gates.tests.js"] },
  { prefixes: ["ccswitch/hooks/dao-probe-gate.js"], tests: ["tests/probe-gate.tests.js"] },
  { prefixes: ["ccswitch/hooks/dao-rate-limit-sentinel.js"], tests: ["tests/rate-limit-sentinel.tests.js"] },
  { prefixes: ["ccswitch/lib/redact"], tests: ["tests/redact.tests.js"] },
  { prefixes: ["ccswitch/lib/hook-budget.js"], tests: ["tests/hook-budget.tests.js"] },
  { prefixes: ["ccswitch/lib/hook-selfcheck.js"], tests: ["tests/hook-selfcheck.tests.js"] },
  // 流程脚本组
  { prefixes: ["ccswitch/scripts/dao-pr-merge.ps1"], tests: ["tests/dao-pr-merge.tests.ps1"] },
  { prefixes: ["scripts/dao-merge-cleanup.ps1"], tests: ["tests/dao-merge-cleanup.tests.ps1"] },
  { prefixes: ["scripts/dao-exit-gate.mjs"], tests: ["tests/exit-gate.tests.js"] },
  { prefixes: ["scripts/dao-orch.mjs"], tests: ["tests/dao-orch.tests.js"] },
  { prefixes: ["scripts/dao-gates.mjs"], tests: ["tests/dao-gates.tests.js"] },
  // 基建组
  { prefixes: ["scripts/run-tests.mjs"], tests: ["tests/run-tests-tier.tests.js"] },
  { prefixes: ["scripts/dao-affected-tests.mjs"], tests: ["tests/affected-tests.tests.js"] },
];

// 共享面：碰了这些 ⇒ 全部留守套都受影响（ hook 公共底座 / 测试协议本身）
const FANOUT_ALL = ["ccswitch/lib/hook-selfcheck.js", "ccswitch/lib/hook-budget.js"];

function affected(files) {
  const out = new Set();
  let fanout = false;
  for (const f of files) {
    const norm = String(f).split("\\").join("/");
    if (FANOUT_ALL.some((p) => norm.startsWith(p))) fanout = true;
    for (const m of MAP) {
      if (m.prefixes.some((p) => norm === p || norm.startsWith(p))) m.tests.forEach((t) => out.add(t));
    }
  }
  if (fanout) MAP.forEach((m) => m.tests.forEach((t) => out.add(t)));
  return [...out].sort();
}

const argv = process.argv.slice(2);
const asJson = argv.includes("--json");
let files = null;
const fi = argv.indexOf("--files");
if (fi >= 0) {
  files = argv.slice(fi + 1).filter((a) => !a.startsWith("--"));
} else {
  const base = process.env.DAO_AFFECTED_BASE || "origin/main";
  const r = spawnSync("git", ["diff", "--name-only", `${base}...HEAD`], { encoding: "utf8", timeout: 15000, windowsHide: true });
  if (r.status !== 0) {
    process.stderr.write(`[affected-tests] 拿不到 diff（git diff ${base}...HEAD 退出 ${r.status}）\n`);
    process.exit(3);
  }
  files = String(r.stdout || "").split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
}

const list = affected(files);
if (asJson) process.stdout.write(JSON.stringify({ files: files.length, tests: list }) + "\n");
else list.forEach((t) => process.stdout.write(t + "\n"));
process.exit(0);
