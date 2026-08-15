// grill-ai 指针与记录契约回归网（issue #483，PR #484 审官红项）
//
// 背景一：grill-ai 的五步法本体不复制，指向 grill-me 的「五步法（存量决策）」节；判例指向
// host/memory/patch-stacking-is-two-strikes.md。CLAUDE.md 规矩：写了指针就要配一道会报警的
// 检查——落点被改名或删除时必须有东西叫。
//
// 背景二（二轮红 2）：契约字段原先用整文件 includes() 查，字段名在别处的表头/正文里都有副本，
// 把定义块整段删光仍全绿（审官样本 E）。所以契约类断言一律**切片后再查**：只认
// 「## 补丁链记录」到「### 边界判例」之间那段正文。
//
// 只做纯文本比对，不复用 skill 自己的任何解析逻辑（自己查自己查不出错）。
// 零样本报红：被检查的文件不在 ⇒ FAIL，且明说后续多少条断言没跑（「没查成」≠「查过没事」）。

const fs = require("fs");
const path = require("path");

const REPO = path.resolve(__dirname, "..");

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? "  →  " + detail : ""}`); }
}

// 落点齐了才跑的断言先登记、后执行——落点缺失时要报得出「多少条没跑」。
const gated = [];
// cond 传的是**函数**（延迟求值）——落点缺失时不能提前触碰 null 文本。
const g = (name, cond, detail) => gated.push(() => check(name, cond(), detail));

function read(rel) {
  const p = path.join(REPO, rel);
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, "utf8");
}

// ── 两端文件都得在（零样本报红）─────────────────────────────────────
const grillAi = read("host/skills/grill-ai/SKILL.md");
const grillMe = read("host/skills/grill-me/SKILL.md");
const verdict = read("host/memory/patch-stacking-is-two-strikes.md");

check("host/skills/grill-ai/SKILL.md 在", grillAi !== null, "指针起点缺失 ⇒ 本次等于没查");
check("host/skills/grill-me/SKILL.md 在", grillMe !== null, "指针落点缺失 ⇒ grill-ai 的五步法指向空气");
check("host/memory/patch-stacking-is-two-strikes.md 在", verdict !== null, "判例落点缺失 ⇒ grill-ai 末尾的判例引用指向空气");

// 「补丁链记录」节的正文切片：从节标题到「### 边界判例」之前。
// 切不出来（节被摘掉/改名）时给空串——契约类断言随即全红，这是要的行为。
function contractSlice(txt) {
  const m = /^##\s*补丁链记录[^\n]*$/m.exec(txt || "");
  if (!m) return "";
  const rest = txt.slice(m.index + m[0].length);
  const end = /^###\s*边界判例/m.exec(rest);
  return end ? rest.slice(0, end.index) : rest;
}

// ── 指针 1：五步法本体在 grill-me 的这一节 ───────────────────────
const SECTION = "五步法（存量决策）";
g(`grill-ai 引用了小节名「${SECTION}」`,
  () => grillAi.includes(SECTION),
  "grill-ai 改了引用写法 ⇒ 同步这道检查");
g(`grill-me 里确有小节「${SECTION}」`,
  () => new RegExp(`^##\\s*${SECTION}\\s*$`, "m").test(grillMe),
  "grill-me 的小节被改名/删除 ⇒ 修 grill-ai 的指针，或改回小节名");
g("grill-ai 引用了 grill-me 的仓内路径",
  () => grillAi.includes("host/skills/grill-me/SKILL.md"),
  "路径写法变了 ⇒ 同步这道检查");

// ── 指针 2：判例 ────────────────────────────────────────────────
g("grill-ai 引用了判例 patch-stacking-is-two-strikes",
  () => grillAi.includes("patch-stacking-is-two-strikes"),
  "判例引用被删 ⇒ 要么补回，要么删掉这条检查");
g("判例文件的 name 就是 patch-stacking-is-two-strikes",
  () => /^name:\s*patch-stacking-is-two-strikes\s*$/m.test(verdict),
  "memory 条目改名 ⇒ 修 grill-ai 的引用");

// ── 不复制：五步法本体的正文不得出现在 grill-ai（两处维护必然分叉）──
const BODY_FINGERPRINTS = [
  "删到偶尔要加回来才算删够",
  "自动化一个错误的流程只会更快地产出错误",
  "最贵的错误是优化一个本不该存在的东西",
];
for (const s of BODY_FINGERPRINTS) {
  g(`grill-me 本体里有指纹句「${s.slice(0, 12)}…」`,
    () => grillMe.includes(s),
    "指纹句被改写 ⇒ 更新这道检查的指纹，否则「不复制」这一项等于没查");
  g(`grill-ai 没有复制指纹句「${s.slice(0, 12)}…」`,
    () => !grillAi.includes(s),
    "五步法本体被复制进 grill-ai ⇒ 两处维护必然分叉，删掉复制的正文只留指针");
}

// ── grill-ai 自身的硬要求（issue #483 设计要点）─────────────────
g("写了与 grill-me 的分工",
  () => grillAi.includes("grill-me") && /分工/.test(grillAi),
  "设计要点 1：分工必须写进 skill");
g("含 AI 自触发条款",
  () => /自触发/.test(grillAi),
  "设计要点 3：触发条件必须含 AI 自己察觉时触发，否则只是等用户发现问题的被动工具");
g("收尾要求 AskUserQuestion 交拍板",
  () => grillAi.includes("AskUserQuestion"),
  "设计要点 4：禁止替用户默认取舍");
g("删除步含「删掉整层」选项要求",
  () => grillAi.includes("删掉整层"),
  "五条清单第 3 条的加严项丢了");

// ── 自触发的可审计状态（一轮红 1 / 二轮红 1、红 2）───────────────
// 层号只存在于当前上下文 ⇒ 跨会话失效；只记在当前 PR 正文 ⇒ 跨 PR 失效。
// 所以：契约字段、时机、跨 PR 锚点与检索命令都是硬要求，且一律在切片内查。
g("有「补丁链记录」节",
  () => contractSlice(grillAi) !== "",
  "自触发缺可审计状态：层号只能靠回忆，跨会话失效");

for (const field of ["层号", "目标", "方向", "起因", "所修副作用", "落点"]) {
  g(`记录契约在本节内定义了字段「${field}」`,
    () => new RegExp(`-\\s*\\*\\*${field}\\*\\*`).test(contractSlice(grillAi)),
    "字段定义块被删 ⇒ 契约不可执行（整文件 includes 查不出来，字段名在别处有副本）");
}
for (const when of ["何时创建", "何时更新", "何时读取"]) {
  g(`记录契约在本节内写了时机「${when}」`,
    () => contractSlice(grillAi).includes(when),
    "只说记什么不说何时记 = 不会被执行");
}

// 跨 PR 可追溯：正文落点会随 PR 归档失联，锚必须在 git 历史里。
g("跨 PR 锚点：commit 标记 chain:<slug>#<层号>",
  () => /\[chain:/.test(contractSlice(grillAi)),
  "没有 git 历史锚 ⇒ 第二层在新 PR 里动手时读不到上一层，退回回忆");
g("跨 PR 读取：给了 git log --grep 检索命令",
  () => /git log[^\n]*--grep[^\n]*chain:/.test(contractSlice(grillAi)),
  "只说记不说怎么查回来 ⇒ 契约在最需要它的跨 PR 场景失效");
g("建段要回抄全部历史层",
  () => /回抄/.test(contractSlice(grillAi)),
  "不回抄 ⇒ 要逐个 PR 翻，链越长越读不全");
g("换方向有可查判准（上一层机制被整段删掉）",
  () => /整段删掉/.test(contractSlice(grillAi)),
  "「换了根本办法就归零」无判准 ⇒ 自我执法时宣称一句就能清零");

// ── 边界判例 ────────────────────────────────────────────────────
g("有边界判例节",
  () => /^###\s*边界判例/m.test(grillAi),
  "缺判例 ⇒ 「同一方向」全凭主观");
g("正例是信箱台补丁链（#464 / #466）",
  () => grillAi.includes("#464") && grillAi.includes("#466"),
  "正例被删或改成了虚构场景（判例必须是真实语料）");
g("反例是 #467 返工（不该触发）",
  () => grillAi.includes("#467"),
  "反例被删 ⇒ 只教了什么算、没教什么不算，会误触发");
g("写明返工与补丁的分界线",
  () => grillAi.includes("返工，不加层"),
  "分界线丢了 ⇒ 返工次数会被误计成补丁层数");

// ── 跑 ──────────────────────────────────────────────────────────
if (grillAi && grillMe && verdict) {
  for (const t of gated) t();
} else {
  console.log(`  SKIP  落点缺失 ⇒ 后续 ${gated.length} 条断言未执行（这是「没查成」，不是「查过没事」）`);
}

console.log(`\ngrill-ai 指针网：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
