// canonical issue 模板 · 结构 lint（ccswitch/templates/ISSUE_TEMPLATE/*.yml）
//
// 跑法：node tests/issue-templates.tests.js   （全绿 exit 0，任一红 exit 1）
//
// ── 🔴 先说这套断言**证不了什么**（别把全绿读成「模板一定能用」）────────────────
// 本机没有任何 YAML 解析器（实测：无 js-yaml / 无 yaml / 无 python+pyyaml），
// 所以这里是**逐行结构 lint，不是 YAML 解析，更不是 GitHub issue-forms schema 校验**。
// 它夹得住的：缩进用了 Tab、顶层键缺失、body 项的 type 不在合法集合里、非 markdown 项
// 缺 id/label、dropdown/checkboxes 缺 options、labels 用了 dao 标签体系之外的值。
// 它夹不住的：YAML 层面的语法错（引号/冒号/锚点）、GitHub 侧的 schema 细则、
// **模板在 GitHub 上真的渲染成什么样**。最后那一条只有把文件推进某个仓的 .github/
// 再去网页开一次单才验得到 —— 本批**没做**，作为未尽处交出去，不假装它被覆盖了。
//
// 为什么仍然值得有：这四个文件是给**人**填的，最常见的坏法不是 YAML 语法错，
// 是「复制第三个模板时忘了改 labels」「新加一项忘了给 id」这类结构性走样，
// 而那类走样在网页上表现为**静默的错标签 / 表单项丢失**。

const fs = require("fs");
const path = require("path");

const REPO = path.resolve(__dirname, "..");
const DIR = path.join(REPO, "ccswitch", "templates", "ISSUE_TEMPLATE");

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? "  →  " + detail : ""}`); }
}

// dao 标签体系的类型四选一（真相源：dao.md「工作项三态归位」+ issue 派单中枢纪律）。
// `真机欠账` 刻意**不在**这里：它是某个项目的兜底遗留，不进 canonical 标签基线。
const TYPE_LABELS = ["缺陷", "任务", "欠账", "待拍板"];
const EXPECTED = { "bug.yml": "缺陷", "task.yml": "任务", "debt.yml": "欠账", "decision.yml": "待拍板" };
const BODY_TYPES = ["markdown", "textarea", "input", "dropdown", "checkboxes"];

console.log("\n=== 目录构成 ===");
let files = [];
try { files = fs.readdirSync(DIR).filter((f) => f.endsWith(".yml")).sort(); } catch (_) {}
check("四个模板齐全（缺陷/任务/欠账/待拍板）",
  JSON.stringify(files) === JSON.stringify(Object.keys(EXPECTED).sort()),
  "actual=" + JSON.stringify(files));

for (const f of files) {
  console.log(`\n=== ${f} ===`);
  const raw = fs.readFileSync(path.join(DIR, f), "utf8");
  const lines = raw.split(/\r?\n/);

  // YAML 禁止用 Tab 缩进，而 Tab 引起的错在编辑器里**看不见**。
  const tabLines = lines.map((l, i) => (/^\s*\t/.test(l) ? i + 1 : 0)).filter(Boolean);
  check(`${f}：无 Tab 缩进（YAML 禁止，且肉眼看不出来）`, tabLines.length === 0, "lines=" + tabLines.join(","));

  check(`${f}：有顶层 name/description/body`,
    /^name:/m.test(raw) && /^description:/m.test(raw) && /^body:/m.test(raw));

  // 标签预填：必须恰好是本文件对应的那一个类型标签。
  // 这一条防的是最常见的坏法 —— 复制上一个模板改内容时**忘了改 labels**，
  // 于是所有单都进同一个类型，而用户筛标签时看起来"一切正常"。
  const lm = /^labels:\s*\[([^\]]*)\]/m.exec(raw);
  const labels = lm ? lm[1].split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean) : [];
  check(`${f}：labels 恰为 ["${EXPECTED[f]}"]`,
    labels.length === 1 && labels[0] === EXPECTED[f], "labels=" + JSON.stringify(labels));
  check(`${f}：labels 只用 dao 类型四选一（不夹带项目专属标签）`,
    labels.every((l) => TYPE_LABELS.includes(l)), "labels=" + JSON.stringify(labels));

  // body 项逐个查。按缩进切块：`  - type: X` 起一项，到下一个同缩进 `  - ` 为止。
  const items = [];
  let cur = null;
  for (let i = 0; i < lines.length; i++) {
    const m = /^ {2}- type:\s*(\S+)/.exec(lines[i]);
    if (m) { cur = { type: m[1], line: i + 1, body: [] }; items.push(cur); continue; }
    if (cur && /^ {2}\S/.test(lines[i])) { cur = null; }   // 回到顶层键，本项结束
    if (cur) cur.body.push(lines[i]);
  }
  check(`${f}：body 项数 ≥3（一个空模板不该通过）`, items.length >= 3, "count=" + items.length);
  check(`${f}：每项 type 都合法（${BODY_TYPES.join("/")}）`,
    items.every((it) => BODY_TYPES.includes(it.type)),
    "bad=" + items.filter((it) => !BODY_TYPES.includes(it.type)).map((it) => it.type + "@" + it.line).join(","));

  const nonMd = items.filter((it) => it.type !== "markdown");
  check(`${f}：非 markdown 项都有 id`,
    nonMd.every((it) => it.body.some((l) => /^ {4}id:\s*\S/.test(l))),
    "missing=" + nonMd.filter((it) => !it.body.some((l) => /^ {4}id:\s*\S/.test(l))).map((it) => it.line).join(","));
  check(`${f}：非 markdown 项都有 attributes.label`,
    nonMd.every((it) => it.body.some((l) => /^ {6}label:\s*\S/.test(l))),
    "missing=" + nonMd.filter((it) => !it.body.some((l) => /^ {6}label:\s*\S/.test(l))).map((it) => it.line).join(","));

  const choice = items.filter((it) => it.type === "dropdown" || it.type === "checkboxes");
  check(`${f}：dropdown/checkboxes 都有 options`,
    choice.every((it) => it.body.some((l) => /^ {6}options:/.test(l))),
    "missing=" + choice.filter((it) => !it.body.some((l) => /^ {6}options:/.test(l))).map((it) => it.line).join(","));

  // markdown 项不接受 validations（GitHub 会拒），且它是纯说明块。
  const md = items.filter((it) => it.type === "markdown");
  check(`${f}：markdown 项不带 validations`,
    md.every((it) => !it.body.some((l) => /^ {4}validations:/.test(l))));

  // 内容侧的两条**弱**断言（判据是子串，两向都构造得出反例，故只当"忘了整段"的哨兵）：
  // ①有折叠证据段的占位（技术证据进 <details>）②抬头有给人看的说明块。
  check(`${f}：留了 <details> 折叠证据段的位置（人读顶部、AI 读全部）`,
    raw.indexOf("<details>") !== -1);
  check(`${f}：抬头有 markdown 说明块（给填单的人一句人话，不是直接甩表单）`,
    items.length > 0 && items[0].type === "markdown", "first=" + (items[0] && items[0].type));

  // canonical 抬头注释：说清真相源在 dao + 收益边界（issue forms 只在两条支路兑现）。
  check(`${f}：抬头注明 canonical 真相源在 windsurf-dao`, /真相源.*windsurf-dao/.test(raw));
}

console.log(`\n=== 汇总: PASS=${pass} FAIL=${fail} ===`);
process.exit(fail ? 1 : 0);
