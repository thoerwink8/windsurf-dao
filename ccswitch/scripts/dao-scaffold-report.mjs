// dao 脚手架核对 · 命令行报告（`/dao-project-scaffold --init` 的机器侧）
//
// 跑法：node ccswitch/scripts/dao-scaffold-report.mjs [项目根]   （缺省 = 当前工作目录）
//       node ccswitch/scripts/dao-scaffold-report.mjs [项目根] --json
//
// ── 为什么需要这个文件（它替掉的是什么）─────────────────────────────────────
// 共性 rule 备案清单此前**只有一个消费方**：SessionStart hook。于是「现在这个项目还缺什么」
// 这个问题只在**开会话那一刻**被回答过一次；修了几条之后想复核，唯一办法是重开会话。
// 而 `--init` 要求的是一个**可重复跑到零**的循环（物化 → 重跑 → 看还剩几条），没有这个入口，
// 那个循环就只能靠 AI 凭印象重判一遍清单 —— 那正是本体系实测携带率 9-24% 的那种形态。
//
// ── 退出码四态语义（只有 0 叫「零缺项」）────────────────────────────────────
//   0 —— 查了，零缺项
//   1 —— 查了，有缺项。**这不是「错误」，是「有活要干」** —— 别把它当 CI 红灯读
//   2 —— **没查成**（清单加载/校验失败、项目根不存在）。与 0 必须区分得开：
//        「没查」和「查了没事」在只读退出码的消费方眼里长得一样，那是本仓反复治的病
// 判成败的谓词写 `-eq 0`，别写 `-le 1`（那个区间把「有缺项」也算成通过了）。
//
// ── 它**不做**什么（边界，别读成「一键修好」）──────────────────────────────
// 本脚本**只读**：不复制、不写、不删任何项目文件。它输出的是「该跑哪些指令」，
// 跑不跑由人或由 `--init` 流程里的 AI 决定。lib 头注那句「只生成指令，绝不自己动手复制」
// 讲的是 **SessionStart hook 不得静默改用户文件**；`--init` 是用户显式发起的动作，
// 授权量级不同 —— 但即便如此，动手的也是执行者，不是这个脚本。
//
// 真相源：windsurf-dao/ccswitch/scripts/dao-scaffold-report.mjs

import fs from "fs";
import path from "path";
import { createRequire } from "module";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require_ = createRequire(import.meta.url);
const M = require_(path.join(HERE, "..", "lib", "scaffold-manifest.js"));

const argv = process.argv.slice(2);
const asJson = argv.includes("--json");
const positional = argv.filter((a) => !a.startsWith("--"));
const projectRoot = path.resolve(positional[0] || process.cwd());

function out(s) { process.stdout.write(s + "\n"); }

// 汇总行必须**每一条路径都打印**（含 exit=2 的失败路径）——只在成功时打摘要，
// 等于让「没查成」在机器可读通道上表现为「什么都没说」，与静默通过不可区分。
function summary(exit, counts) {
  out(`SCAFFOLD_REPORT_SUMMARY exit=${exit} findings=${counts.findings} ` +
      `materialize=${counts.materialize} assisted=${counts.assisted} advise=${counts.advise} errors=${counts.errors}`);
}
const ZERO = { findings: 0, materialize: 0, assisted: 0, advise: 0, errors: 0 };

if (!fs.existsSync(projectRoot) || !fs.statSync(projectRoot).isDirectory()) {
  out(`✗ 项目根不存在或不是目录：${projectRoot}`);
  summary(2, Object.assign({}, ZERO, { errors: 1 }));
  process.exit(2);
}

// ── 三档动作分级（判据取自清单**数据本身**，不靠 id 硬编码）──────────────────
// 甲「物化」  entry 带 template ⇒ 有 canonical 可零编辑复制，执行时零现场判断。
// 丙「只建议」require 顶层是 not（删除/搬移类）或 maxLines（拆分类）⇒ 动的是用户既有内容、
//            且删除/搬移不可逆 ⇒ 属判断档，**永远只建议不代做**（不是能力问题，是授权问题）。
// 乙「代做」  其余（要新建一个 dao 没有 canonical 的文件，或往既有文件补一行）⇒ AI 可代做，
//            但每条都要说清「写什么、依据是哪一句」，且与甲**分开计数**——两者可靠性不是一回事。
// 反例照直写：`.gitignore` 缺 `_tmp/` 看起来像照做档，其实不是 —— `_tmp/` 与 `**/_tmp/`
// 都能过闸而处方是后者，机器判不出该写哪个，故它落在乙不落在甲。
function tierOf(entry) {
  if (!entry) return "代做";
  if (entry.template) return "物化";
  const req = entry.require || {};
  const kind = Object.keys(req).filter((k) => k !== "label")[0];
  if (kind === "not" || kind === "maxLines") return "只建议";
  return "代做";
}

const { manifest, errors } = M.load(process.env.DAO_SCAFFOLD_MANIFEST || null);
if (!manifest) {
  for (const e of errors) out("✗ " + e);
  out("→ 清单没加载成功 ⇒ **一条都没查**（不是「零缺项」）");
  if (asJson) out(JSON.stringify({ ok: false, errors, findings: [] }, null, 2));
  summary(2, Object.assign({}, ZERO, { errors: errors.length }));
  process.exit(2);
}

const byId = new Map((manifest.entries || []).map((e) => [e.id, e]));
let findings;
try {
  findings = M.evaluate(manifest, projectRoot);
} catch (e) {
  out("✗ 清单求值抛错：" + (e && e.message ? e.message : String(e)));
  summary(2, Object.assign({}, ZERO, { errors: 1 }));
  process.exit(2);
}

const rows = findings.map((f) => Object.assign({}, f, { tier: tierOf(byId.get(f.id)) }));
const counts = {
  findings: rows.length,
  materialize: rows.filter((r) => r.tier === "物化").length,
  assisted: rows.filter((r) => r.tier === "代做").length,
  advise: rows.filter((r) => r.tier === "只建议").length,
  errors: 0,
};

if (asJson) {
  out(JSON.stringify({ ok: true, projectRoot, counts, findings: rows }, null, 2));
  summary(rows.length ? 1 : 0, counts);
  process.exit(rows.length ? 1 : 0);
}

out(`\n=== dao 脚手架核对 · ${projectRoot} ===`);
if (rows.length === 0) {
  out("✓ 共性 rule 备案清单逐条求值：零缺项");
  summary(0, counts);
  process.exit(0);
}

// 按档排序：先物化（可机械执行）、再代做、最后只建议 —— 让「现在就能跑的」排在最上面。
const ORDER = { "物化": 0, "代做": 1, "只建议": 2 };
rows.sort((a, b) => (ORDER[a.tier] - ORDER[b.tier]) || a.id.localeCompare(b.id));
rows.forEach((r, i) => {
  const sev = r.severity === "info" ? "（建议）" : "";
  out(`\n${i + 1}. [${r.tier}] ${r.id}（${r.class}）`);
  out("   " + sev + r.message.split("\n").join("\n   "));
});

out(`\n── 分档合计：物化 ${counts.materialize} · 代做 ${counts.assisted} · 只建议 ${counts.advise}（共 ${counts.findings}）`);
out("   物化 = 跑上面那条零编辑复制指令即可；代做 = 可代写但要逐条说依据；");
out("   只建议 = 删除/搬移/拆分类，**不代做**（不可逆或改用户既有内容 ⇒ 判断档，归用户）。");
out("   补齐流程见 dao-project-scaffold skill 的 §`--init`。");
summary(1, counts);
process.exit(1);
