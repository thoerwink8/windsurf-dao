// TODO.md 存废表述一致性守卫 — 扫 ccswitch/skills/** + ccswitch/commands/**
//
// 跑法：node tests/skills-todo-ledger.tests.js   （全绿 exit 0，任一红 exit 1）
//
// ── 为什么有这个文件 ────────────────────────────────────────────────────────
// `dao.md` 帅节「TODO 候选池三级准入」与 Shell 节「dogfood 发现写入 TODO.md」**要求**
// 部分项目主动维护根目录 TODO.md；而 skill 侧曾**无条件**建议「清理遗留 TODO.md」。
// 两条同级规则在同一触发条件下给出相反指令 —— 2026-07-22 查冲突 spike 抓获。
//
// 那次修缮只改了 dao-project-scaffold 检查清单**一处**，2026-07-27 复核发现另外五处
// 仍是无条件表述，**其中 dao-loop §0 预飞恰是 spike 点名「下次跑 loop 就会撞上」的
// 那条路径** —— 补丁打在了不会被触发的地方，而没有任何机制能发现这件事。
//
// 这就是本文件要提供的东西：一个**会变红的地方**。散在六个文件里的措辞一致性靠人记
// 必漏（本仓实测：无标记时刻的自由裁量携带率 9-24%），扫一遍不会。
//
// ── 判据是近似的，两侧反例都存在（不许把全绿读成「措辞已正确」）────────────
// 判据 = 同一行里「提到 TODO.md」+「带处置类动词」+「不带条件化标记」。已知盲区：
//   · 跨行表述（动词与条件化标记分处两行）——扫不到，会漏放；
//   · 条件化标记塞进一行但语义仍是无条件（如「活账本」只是被顺口提了一句）——会漏放；
//   · 正常引用碰巧同时含两类词（如讲「PROJECT.md 替代品」的元讨论）——会误报。
// 失败方向选「漏放」而非「误报」：误报会训练人给测试加豁免，一旦养成，守卫就废了。
// 真正的语义正确性仍归人判，本文件只钉住「不会有人悄悄把它改回无条件」。
//
// ── 扫描范围为什么不含 ccswitch/dao.md ──────────────────────────────────────
// dao.md 是 always-on 注入面、编辑频次最高、且本窗有并行改动。把它纳入扫描
// 会让本守卫与它的措辞演化强耦合（那边一句正常引用就能把这边扫红）。dao.md 侧的
// 表述是「要求维护 TODO.md」，与本守卫要防的「无条件建议删除」方向相反，
// 不在同一风险面上。**这是一条刻意的覆盖面缺口，不是遗漏。**

const fs = require("fs");
const path = require("path");

const REPO = path.resolve(__dirname, "..");
const SCAN_DIRS = [
  path.join(REPO, "ccswitch", "skills"),
  path.join(REPO, "ccswitch", "commands"),
];
// 判据正文所在处（唯一真相源）。它自己必须存在，否则所有指针都指向空气。
const CANON_FILE = path.join(REPO, "ccswitch", "skills", "dao-project-scaffold", "SKILL.md");
const CANON_ANCHOR = "TODO.md 存废判据";

// 处置类动词：把 TODO.md 当作「该被处理掉的东西」的措辞。
const DISPOSAL = /(清理|删除|遗留物|不在根目录放|替代|唯一入口)/;
// 条件化标记：出现任一即视为「已声明这不是无条件的」。
// 刻意不收「静态打勾」——活账本同样用复选框，那个词分不开两种身份，
// 正是 2026-07-22 那版措辞失手的地方（它写了「静态打勾清单 → 建议删除」）。
const CONDITIONED = /(存废判据|活账本|在役候选池|幽灵|豁免)/;

function isUnconditionalDisposal(line) {
  return line.includes("TODO.md") && DISPOSAL.test(line) && !CONDITIONED.test(line);
}

function walkMd(dir, out) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkMd(p, out);
    else if (e.name.endsWith(".md")) out.push(p);
  }
  return out;
}

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? "  →  " + detail : ""}`); }
}

// ══ 判据函数自身的正负控（先证明这把尺子是活的，再拿它量文件）═══════════════
// 「比较基线必须先验证它自己真的是活的」——一条永远返回 false 的判据当然零命中。
console.log("\n[判据函数正负控]");
{
  const positives = [
    ["无条件『应清理』", "- [ ] 根目录无遗留 `TODO.md`（已完成的静态清单应清理）"],
    ["无条件『建议删除』", "   - `TODO.md`（静态打勾清单）→ 建议删除，职责由 Loop 承担"],
    ["无条件『唯一入口』", "替代 TODO.md，成为项目追踪唯一入口。"],
    ["无条件『不在根目录放』", "项目追踪用 docs/PROJECT.md，不在根目录放 TODO.md。"],
    ["无条件『遗留物』", "检测遗留物（`TODO.md`、散 plan 文件）。"],
  ];
  for (const [name, line] of positives) {
    check("正控命中：" + name, isUnconditionalDisposal(line), JSON.stringify(line.slice(0, 40)));
  }
  const negatives = [
    ["带判据指针", "- `TODO.md` → 先判身份，判据见 §TODO.md 存废判据；幽灵才建议清理"],
    ["带活账本限定", "替代遗留型 TODO.md；在役候选池型活账本并存，不构成删除它的理由"],
    ["无处置动词的正常引用", "dogfood 体验发现写入项目 `TODO.md`（不阻塞本 PR）"],
    ["不提 TODO.md 的清理句", "散落的 spec/design 文件 → 提议归并，遗留物建议清理"],
  ];
  for (const [name, line] of negatives) {
    check("负控不误伤：" + name, !isUnconditionalDisposal(line), JSON.stringify(line.slice(0, 40)));
  }
}

// ══ 唯一真相源必须存在 ══════════════════════════════════════════════════════
console.log("\n[唯一真相源]");
{
  const canon = fs.existsSync(CANON_FILE) ? fs.readFileSync(CANON_FILE, "utf8") : "";
  check("判据正文存在于 dao-project-scaffold SKILL.md", canon.includes(CANON_ANCHOR), CANON_FILE);
  // 三条判据缺任何一条，「三条全不成立才是幽灵」这句话就落不了地。
  for (const needle of ["CLAUDE.md", "30 天", "来源标记"]) {
    check("判据正文含第三方可核对的条件：" + needle, canon.includes(needle));
  }
  check("判据正文声明失败方向选「留」", /失败方向.*留|刻意选「留」/.test(canon));
  // 指针指向的锚点必须真的被指向者引用，否则这一节会在无人引用中悄悄腐烂。
  const referrers = walkMd(path.join(REPO, "ccswitch", "skills"), [])
    .concat(walkMd(path.join(REPO, "ccswitch", "commands"), []))
    .filter((f) => f !== CANON_FILE)
    .filter((f) => fs.readFileSync(f, "utf8").includes(CANON_ANCHOR));
  check("至少两个别处文件指向该判据（dao-loop 两处是最低要求）",
    referrers.length >= 2, "实际 " + referrers.length + " 个：" + referrers.map((f) => path.basename(path.dirname(f)) + "/" + path.basename(f)).join(", "));
}

// ══ 全量扫描：skills/ + commands/ 里不得有无条件处置表述 ═════════════════════
console.log("\n[全量扫描]");
{
  const files = SCAN_DIRS.reduce((acc, d) => walkMd(d, acc), []);
  check("扫描面非空（目录改名/搬家会让守卫静默空转）", files.length > 0, "文件数 " + files.length);
  const hits = [];
  for (const f of files) {
    const lines = fs.readFileSync(f, "utf8").split(/\r?\n/);
    lines.forEach((line, i) => {
      if (isUnconditionalDisposal(line)) {
        hits.push(path.relative(REPO, f) + ":" + (i + 1) + "  " + line.trim().slice(0, 70));
      }
    });
  }
  check("skills/ + commands/ 无「无条件处置 TODO.md」表述",
    hits.length === 0, hits.length ? "\n        " + hits.join("\n        ") : "");
  // 提到 TODO.md 的文件数报出来当观察值：突然归零多半是扫描面塌了而非措辞变干净了。
  const mentioning = files.filter((f) => fs.readFileSync(f, "utf8").includes("TODO.md"));
  console.log(`  INFO  扫描 ${files.length} 个 md，其中 ${mentioning.length} 个提到 TODO.md：` +
    mentioning.map((f) => path.relative(REPO, f)).join(", "));
  check("提到 TODO.md 的文件不少于 4 个（少于此说明扫描面或措辞被整体删掉了，需人看一眼）",
    mentioning.length >= 4, "实际 " + mentioning.length);
}

console.log(`\n=== 汇总: PASS=${pass} FAIL=${fail} ===`);
process.exit(fail ? 1 : 0);
