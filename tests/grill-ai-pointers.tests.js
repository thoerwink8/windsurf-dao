// grill-ai 指针落点回归网（issue #483）
//
// 背景：grill-ai 的五步法本体不复制，指向 grill-me 的「五步法（存量决策）」节；判例指向
// host/memory/patch-stacking-is-two-strikes.md。CLAUDE.md 规矩：写了指针就要配一道会报警的
// 检查——落点被改名或删除时必须有东西叫。这就是那道检查。
//
// 只做纯文本比对，不复用 skill 自己的任何解析逻辑（自己查自己查不出错）。
// 零样本报红：被检查的文件不在 ⇒ 直接 FAIL，不是静默跳过。

const fs = require("fs");
const path = require("path");

const REPO = path.resolve(__dirname, "..");

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? "  →  " + detail : ""}`); }
}

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

if (grillAi && grillMe && verdict) {
  // ── 指针 1：五步法本体在 grill-me 的这一节 ───────────────────────
  const SECTION = "五步法（存量决策）";
  check(
    `grill-ai 引用了小节名「${SECTION}」`,
    grillAi.includes(SECTION),
    "grill-ai 改了引用写法 ⇒ 同步这道检查"
  );
  check(
    `grill-me 里确有小节「${SECTION}」`,
    new RegExp(`^##\\s*${SECTION}\\s*$`, "m").test(grillMe),
    "grill-me 的小节被改名/删除 ⇒ 修 grill-ai 的指针，或改回小节名"
  );
  check(
    "grill-ai 引用了 grill-me 的仓内路径",
    grillAi.includes("host/skills/grill-me/SKILL.md"),
    "路径写法变了 ⇒ 同步这道检查"
  );

  // ── 指针 2：判例 ────────────────────────────────────────────────
  check(
    "grill-ai 引用了判例 patch-stacking-is-two-strikes",
    grillAi.includes("patch-stacking-is-two-strikes"),
    "判例引用被删 ⇒ 要么补回，要么删掉这条检查"
  );
  check(
    "判例文件的 name 就是 patch-stacking-is-two-strikes",
    /^name:\s*patch-stacking-is-two-strikes\s*$/m.test(verdict),
    "memory 条目改名 ⇒ 修 grill-ai 的引用"
  );

  // ── 不复制：五步法本体的正文不得出现在 grill-ai（两处维护必然分叉）──
  // 取 grill-me 五步法节里几句只可能出现在本体里的句子当指纹。
  const BODY_FINGERPRINTS = [
    "删到偶尔要加回来才算删够",
    "自动化一个错误的流程只会更快地产出错误",
    "最贵的错误是优化一个本不该存在的东西",
  ];
  for (const s of BODY_FINGERPRINTS) {
    check(
      `grill-me 本体里有指纹句「${s.slice(0, 12)}…」`,
      grillMe.includes(s),
      "指纹句被改写 ⇒ 更新这道检查的指纹，否则「不复制」这一项等于没查"
    );
    check(
      `grill-ai 没有复制指纹句「${s.slice(0, 12)}…」`,
      !grillAi.includes(s),
      "五步法本体被复制进 grill-ai ⇒ 两处维护必然分叉，删掉复制的正文只留指针"
    );
  }

  // ── grill-ai 自身的三条硬要求（issue #483 设计要点）─────────────
  check(
    "写了与 grill-me 的分工",
    grillAi.includes("grill-me") && /分工/.test(grillAi),
    "设计要点 1：分工必须写进 skill"
  );
  check(
    "含 AI 自触发条款",
    /自触发/.test(grillAi),
    "设计要点 3：触发条件必须含 AI 自己察觉时触发，否则只是等用户发现问题的被动工具"
  );
  check(
    "收尾要求 AskUserQuestion 交拍板",
    grillAi.includes("AskUserQuestion"),
    "设计要点 4：禁止替用户默认取舍"
  );
  check(
    "删除步含「删掉整层」选项要求",
    grillAi.includes("删掉整层"),
    "五条清单第 3 条的加严项丢了"
  );

  // ── 自触发的可审计状态（PR #484 审官红 1）───────────────────────
  // 层号只存在于当前上下文 ⇒ 跨会话即失效，而补丁链常跨会话形成。
  // 所以记录契约的五个字段、三个时机、正反两条判例都是硬要求，缺一即红。
  check(
    "有「补丁链」记录段",
    /^##\s*补丁链记录/m.test(grillAi),
    "自触发缺可审计状态：层号只能靠回忆，跨会话失效"
  );
  for (const field of ["层号", "目标", "方向", "起因", "所修副作用"]) {
    check(`记录契约含字段「${field}」`, grillAi.includes(field), "最小记录契约五字段缺一即不可审计");
  }
  for (const when of ["何时创建", "何时更新", "何时读取"]) {
    check(`记录契约含时机「${when}」`, grillAi.includes(when), "只说记什么不说何时记 = 不会被执行");
  }
  check(
    "有边界判例节",
    /^###\s*边界判例/m.test(grillAi),
    "缺判例 ⇒ 「同一方向」全凭主观"
  );
  check(
    "正例是信箱台补丁链（#464 / #466）",
    grillAi.includes("#464") && grillAi.includes("#466"),
    "正例被删或改成了虚构场景（判例必须是真实语料）"
  );
  check(
    "反例是 #467 返工（不该触发）",
    grillAi.includes("#467"),
    "反例被删 ⇒ 只教了什么算、没教什么不算，会误触发"
  );
  check(
    "写明返工与补丁的分界线",
    grillAi.includes("返工，不加层"),
    "分界线丢了 ⇒ 返工次数会被误计成补丁层数"
  );
}

console.log(`\ngrill-ai 指针网：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
