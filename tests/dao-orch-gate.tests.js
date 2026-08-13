// dao-orch-gate.tests.js — 派单书「便签链两跳」存在性闸的回归网（issue #405 对抗审 Y6）
//
// 闸在 scripts/dao-orch.mjs：派单前逐个核 PREAMBLE 与 NOTES 两份文件真在盘上，
// 缺哪一跳都拒派——因为派单书第一行是「Read 便签」，便签不在就是一个指向空气的指针，
// 而工人照着空指针走会得到「我没找到，那就跳过吧」，退出码全程是干净的。
//
// **为什么在沙箱里跑，不动真仓的文件**：负控要制造「文件不在」这一态。
// 在真仓里搬走 ccswitch/rules/*.md 会踩两个坑——多路并行时别人正读着那份文件；
// 测试中途崩掉的话文件就永久留在搬走的位置。所以复制一份脚本到临时目录，
// 按同样的目录形状摆两个桩文件（脚本用 <自己所在目录>/.. 当仓根，形状对了就够）。
//
// **自检那一半刻意不复用被守对象**：本文件自己写死它认为该有的两跳路径，
// 不从 dao-orch.mjs import 那两个常量——否则有人把某一跳删掉时，
// 常量和断言会一起消失，测试照样绿（那正是「一起错」的经典形态）。
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// 本测试独立主张的「必须核到的两跳」。改闸的人若少核一跳，负控就会红在这里。
const EXPECTED_HOPS = [
  "ccswitch/rules/dao-worker-preamble.md",
  "ccswitch/rules/dao-officer-clauses.md",
];

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? "  →  " + detail : ""}`); }
}

// ── 搭沙箱：<box>/scripts/dao-orch.mjs + <box>/ccswitch/rules/两个桩 ──────────
const box = fs.mkdtempSync(path.join(os.tmpdir(), "dao-orch-gate-"));
try {
  fs.mkdirSync(path.join(box, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(box, "ccswitch", "rules"), { recursive: true });
  fs.copyFileSync(path.join(REPO, "scripts", "dao-orch.mjs"), path.join(box, "scripts", "dao-orch.mjs"));
  for (const hop of EXPECTED_HOPS) fs.writeFileSync(path.join(box, hop), "桩：内容不参与判定，闸只看在不在\n");
  const specFile = path.join(box, "spec.md");
  fs.writeFileSync(specFile, "【边界】不许碰 X。\n");

  const run = () => spawnSync(process.execPath, [
    path.join(box, "scripts", "dao-orch.mjs"), "dispatch",
    "--role", "implementer", "--spec-file", specFile, "--issue", "405", "--dry-run",
  ], { encoding: "utf8" });

  // ── 正控：两跳都在 ⇒ 放行，且真的拼出了 spec ────────────────────────────────
  // 这一格是「我是不是瞎了」那一半：闸若改成无条件拒派，下面两条负控照样绿，
  // 只有正控会红。所以正控不能只看退出码，要看 spec 真被拼出来了。
  const okRun = run();
  check("正控：两跳都在 ⇒ exit 0", okRun.status === 0, `status=${okRun.status} stderr=${(okRun.stderr || "").slice(0, 200)}`);
  check("正控：首行真指向便签（不是空跑一趟）",
    okRun.stdout.includes(EXPECTED_HOPS[0]), okRun.stdout.slice(0, 200));
  for (const grid of ["【任务】", "【验收】", "【审计锚】"]) {
    check(`正控：骨架含 ${grid}`, okRun.stdout.includes(grid));
  }

  // ── 负控：逐跳藏起来，每一跳都必须自己拦得住 ────────────────────────────────
  for (const hop of EXPECTED_HOPS) {
    const abs = path.join(box, hop);
    const saved = fs.readFileSync(abs);
    fs.rmSync(abs);
    const bad = run();
    fs.writeFileSync(abs, saved); // 立刻复原，后一条负控要在「其余都在」的前提下跑
    check(`负控：藏掉 ${hop} ⇒ exit 1`, bad.status === 1, `status=${bad.status}`);
    check(`负控：报文点名了缺的那一跳 ${hop}`,
      (bad.stderr || "").includes(hop), (bad.stderr || "").slice(0, 200));
  }

  // 复原后必须回到放行态——否则上面的负控可能是被别的原因弄红的。
  check("复原后回到 exit 0（负控红的是缺文件，不是别的）", run().status === 0);

  // ── 闸的两跳与派单书首行实际指向一致（真仓侧的静态核对）──────────────────────
  // 闸核的是 A、B 两份，而派单书首行只写 A；A 再指向 B。这条断言防的是
  // 「首行改指别的文件，闸还在核老的两份」——那时闸绿，指针依然指向空气。
  const orchSrc = fs.readFileSync(path.join(REPO, "scripts", "dao-orch.mjs"), "utf8");
  for (const hop of EXPECTED_HOPS) {
    check(`真仓：dao-orch.mjs 里写着 ${hop}`, orchSrc.includes(hop));
    check(`真仓：${hop} 真在盘上`, fs.existsSync(path.join(REPO, hop)));
  }
  const preambleSrc = fs.readFileSync(path.join(REPO, EXPECTED_HOPS[0]), "utf8");
  check("真仓：便签正文确实把第二跳指出去了",
    preambleSrc.includes(path.basename(EXPECTED_HOPS[1])));
} finally {
  fs.rmSync(box, { recursive: true, force: true });
}

assert.equal(fs.existsSync(box), false, "沙箱必须被清掉");
console.log(`\ndao-orch-gate.tests  pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
