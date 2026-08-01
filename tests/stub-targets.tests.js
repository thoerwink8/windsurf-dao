// stub-targets 回归网 — 「存根行指向的文件必须真的存在」
//
// 跑法：node tests/stub-targets.tests.js      （全绿 exit 0，任一红 exit 1）
//       node scripts/run-tests.mjs            （自动发现本文件，无需登记）
//
// ── 治的是什么病 ─────────────────────────────────────────────────────────────
// dao.md 的存根化把正文迁去 `ccswitch/rules/*.md`，dao.md 只留一行「Read `<路径>` 全文」。
// 于是**整条条款的存活挂在一个字符串上**：路径写错、文件被改名或被删，dao.md 照样是一份
// 语法正确的 Markdown，没有任何东西会红——读到那一行的人去 Read，得到「文件不存在」，
// 然后只能凭记忆继续。这正是本仓明训「**留一个指向空气的指针比没有指针更糟**」
// （读者以为有兜底）在存根化上的具体形态。
//
// ── 扫什么（射程边界照直写，别把「绿」读成「存根都是对的」）──────────────────
//   扫描面：`ccswitch/dao.md` + `ccswitch/rules/**.md`（含 `scoped/`）
//   只判**路径存不存在**。以下三面**明确不覆盖**：
//     ① 不判那份文件里**有没有存根宣称的内容**——文件是空的照样绿（判语义没有机械判据，
//        不为它编一个近似判据充数）。
//     ② 只认 `ccswitch/rules/**.md` 这一种形态的指针；指向 skills / scripts / templates 的
//        指针不在射程内（本批产生的就是这一种，不为假想敌先扩面）。
//     ③ 不扫 `~/.claude/rules/` 的投影（派生物，漂移归 dao-rules-deploy.mjs --check 管）。
//   **本文件自己在 `tests/` 下，刻意不在扫描面内**——否则下面 §③ 夹具里那个故意写错的路径
//   会被自己扫成违例。这是「检查器的输出不能落在它自己的扫描面内」的同型（见
//   ccswitch/rules/dao-guard-writing.md 第三条）。
//
// ── 自检那一半为什么另起一套读法 ────────────────────────────────────────────
// 本检查最危险的失效形态是**静默变绿**：抽取正则一旦坏掉（或扫描面塌了），
// 「一个存根都没找到」与「所有存根都对」在输出上一模一样，且退出码都是 0。
// 故普查半边**不用正则**、只做字符串切分数 `ccswitch/rules/` 的出现次数：
// 普查数 > 0 而抽取数 == 0 ⇒ 抽取瞎了；普查数 == 0 ⇒ 零样本（扫描面塌陷）。
// 两半唯一的共同前提是「文件读得进来」。

const fs = require("fs");
const path = require("path");

const REPO = path.resolve(__dirname, "..");

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail ? "  ->  " + detail : "")); }
}

// ── 主逻辑：抽取 + 存在性 ───────────────────────────────────────────────────
// 反引号包裹与否都认；`*` 不在字符类里 ⇒ `ccswitch/rules/*.md` 这类 glob 自然不被当成
// 具体路径（§③ 有负控钉住这一点）。
const REF_RE = /ccswitch\/rules\/(?:scoped\/)?[A-Za-z0-9._-]+\.md/g;

function extractRefs(text) {
  const out = new Set();
  let m;
  while ((m = REF_RE.exec(text)) !== null) out.add(m[0]);
  REF_RE.lastIndex = 0;
  return [...out];
}

// 普查半边：**不用正则**，只数字面出现次数。抽取瞎掉时它仍然看得见样本。
function censusMentions(text) {
  return text.split("ccswitch/rules/").length - 1;
}

function scanFiles() {
  const files = [path.join(REPO, "ccswitch", "dao.md")];
  const rulesDir = path.join(REPO, "ccswitch", "rules");
  for (const ent of fs.readdirSync(rulesDir, { withFileTypes: true })) {
    if (ent.isFile() && ent.name.toLowerCase().endsWith(".md")) files.push(path.join(rulesDir, ent.name));
    else if (ent.isDirectory()) {
      const sub = path.join(rulesDir, ent.name);
      for (const e2 of fs.readdirSync(sub, { withFileTypes: true })) {
        if (e2.isFile() && e2.name.toLowerCase().endsWith(".md")) files.push(path.join(sub, e2.name));
      }
    }
  }
  return files;
}

function checkText(text) {
  const refs = extractRefs(text);
  const missing = refs.filter((r) => !fs.existsSync(path.join(REPO, r)));
  return { refs, missing, census: censusMentions(text) };
}

// ── ① 真语料：所有存根指向的文件都在盘上 ────────────────────────────────────
console.log("\n① 真语料 — dao.md + ccswitch/rules/**.md 的存根指针");
{
  let totalRefs = 0, totalCensus = 0;
  const allMissing = [];
  const seen = new Set();
  for (const f of scanFiles()) {
    const r = checkText(fs.readFileSync(f, "utf8"));
    totalRefs += r.refs.length;
    totalCensus += r.census;
    for (const ref of r.refs) seen.add(ref);
    for (const m of r.missing) allMissing.push(path.relative(REPO, f) + " → " + m);
  }
  check("存根指向的文件全部存在（红了就是有指针指向空气）", allMissing.length === 0, allMissing.join(" | "));

  // 自检半边（两条，都要能在主逻辑瞎掉时把绿变红）
  check("自检·非零样本：扫描面里确有 `ccswitch/rules/` 提及", totalCensus > 0,
    "census=" + totalCensus + " ⇒ 扫描面塌了，此时的『零违例』不可信");
  check("自检·抽取没瞎：普查看得见提及时，抽取必须抽得出具体路径",
    !(totalCensus > 0 && totalRefs === 0), "census=" + totalCensus + " 而 refs=0");

  console.log("  ⓘ 抽到 " + seen.size + " 个不同的 rules 指针，字面提及 " + totalCensus + " 处");

  // 反向观察线（**不设闸，只打印**）：盘上有而没人指向的 rules 文件。
  // 「这份文件是不是该退役了」是判断不是对错，做成硬闸会让人为过闸而硬塞一个指针。
  const onDisk = fs.readdirSync(path.join(REPO, "ccswitch", "rules"), { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".md")).map((e) => "ccswitch/rules/" + e.name);
  const orphan = onDisk.filter((f) => !seen.has(f));
  console.log("  ⓘ 无人指向的 rules 文件 " + orphan.length + " 份" + (orphan.length ? "：" + orphan.join("、") : "（观察线，不判红）"));
}

// ── ② 正控：故意指向不存在的文件必须被抓到 ──────────────────────────────────
console.log("\n② 正控 — 断错的指针要变红");
{
  const bogus = "**存根**：动手前 = Read `ccswitch/rules/dao-this-file-does-not-exist.md` 全文。";
  const r = checkText(bogus);
  check("不存在的存根路径被报为违例", r.missing.length === 1, JSON.stringify(r));
  const bogusScoped = "见 `ccswitch/rules/scoped/dao-scope-nope.md`";
  check("scoped/ 子目录下的错路径同样被抓", checkText(bogusScoped).missing.length === 1);
}

// ── ③ 负控：合法形态不许被误判 ──────────────────────────────────────────────
console.log("\n③ 负控 — 合法形态零误伤");
{
  const good = "细则见 `ccswitch/rules/dao-workitem.md`，另见 ccswitch/rules/dao-dispatch.md。";
  check("真实存在的路径零违例", checkText(good).missing.length === 0);

  const glob = "`ccswitch/rules/*.md` 每个开头都写着「必经动作」；源在 `ccswitch/rules/scoped/*.md`。";
  const g = checkText(glob);
  check("glob 写法不被当成具体路径（refs=0 且不报违例）", g.refs.length === 0 && g.missing.length === 0,
    JSON.stringify(g));
  check("但 glob 仍被普查计入（否则会被误判成零样本）", g.census === 2, "census=" + g.census);
}

// ── ④ 自检半边的判别力：把「瞎掉」构造出来 ──────────────────────────────────
console.log("\n④ 自检半边 — 瞎掉的两种形态各构造一次");
{
  // 形态一：语料里一句都不提 ⇒ 零样本
  check("零样本形态：普查数为 0", checkText("这段话与 rules 无关。").census === 0);
  // 形态二：普查看得见、抽取抽不出（模拟正则坏掉：把提及写成抽取器认不出的形态）
  const blindable = "见 ccswitch/rules/ 目录下那份细则。";
  const b = checkText(blindable);
  check("抽取抽不出而普查看得见 ⇒ 自检条件成立（census>0 && refs==0）",
    b.census > 0 && b.refs.length === 0, JSON.stringify(b));
}

console.log("\n=== 汇总: PASS=" + pass + " FAIL=" + fail + " ===");
process.exit(fail ? 1 : 0);
