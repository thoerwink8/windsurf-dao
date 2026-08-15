// grill-ai 指针与记录契约回归网（issue #483，PR #484 审官红项）
//
// 背景一：grill-ai 的五步法本体不复制，指向 grill-me 的「五步法（存量决策）」节；判例指针指向
// 本机 memory 目录里的 patch-stacking-is-two-strikes.md。CLAUDE.md 规矩：写了指针就要配一道会
// 报警的检查——落点被改名或删除时必须有东西叫。
//
// 判例落点判据（issue #529 改写）：memory 已搬到独立仓 thoerwink8/windsurf-dao-memory，
// 主仓不再持有 memory。判例落点**跟着本机 Junction 走**——本机
// `~/.claude/projects/<编码后的仓库路径>/memory/` 是指向 memory 仓的 Junction，物理上住哪个仓
// 不关心；这样 memory 再搬家这道检查也不用改。三态：
//   SKIP —— 本机没有该项目 memory 目录 ⇒ 判例落点与后续断言未执行，明说「没查成」，不是「查过没事」；
//   RED  —— 目录在，但 patch-stacking-is-two-strikes.md 不在里面 ⇒ 判例指针指向空气；
//   GREEN—— 目录在、文件在，全部契约断言跑过。
// 可用环境变量 GRILL_MEM_DIR 覆盖 memory 目录（造违规样本验判别力；不传则用本机默认路径）。
//
// 背景二（二轮红 2）：契约字段原先用整文件 includes() 查，字段名在别处的表头/正文里都有副本，
// 把定义块整段删光仍全绿（审官样本 E）。所以契约类断言一律**切片后再查**：只认
// 「## 补丁链记录」到「### 边界判例」之间那段正文。
//
// 只做纯文本比对，不复用 skill 自己的任何解析逻辑（自己查自己查不出错）。
// 零样本报红：断言全部先登记（含数量），落点缺失时明说「多少条没跑」——「没查成」≠「查过没事」。

const fs = require("fs");
const path = require("path");

const REPO = path.resolve(__dirname, "..");
const PRECEDENT = "patch-stacking-is-two-strikes";

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

function readAbs(p) {
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, "utf8");
}

async function main() {
  const { encodeProjectDir } = await import("../scripts/lib/dao-memory-link-check.mjs");

  // ── 两端文件都得在（零样本报红）─────────────────────────────────────
  const grillAi = read("host/skills/grill-ai/SKILL.md");
  const grillMe = read("host/skills/grill-me/SKILL.md");

  check("host/skills/grill-ai/SKILL.md 在", grillAi !== null, "指针起点缺失 ⇒ 本次等于没查");
  check("host/skills/grill-me/SKILL.md 在", grillMe !== null, "指针落点缺失 ⇒ grill-ai 的五步法指向空气");

  // 「补丁链记录」节的正文切片：从节标题到「### 边界判例」之前。
  // 切不出来（节被摘掉/改名）时给空串——契约类断言随即全红，这是要的行为。
  function contractSlice(txt) {
    const m = /^##\s*补丁链记录[^\n]*$/m.exec(txt || "");
    if (!m) return "";
    const rest = txt.slice(m.index + m[0].length);
    const end = /^###\s*边界判例/m.exec(rest);
    // 尾锚找不到时返回空串（⇒ 契约断言全红），不是把后面全部正文并进来——
    // 并进来会让切片变宽，本该报红的样本反而变绿（三轮观察项 1）。
    return end ? rest.slice(0, end.index) : "";
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
    () => grillAi.includes(PRECEDENT),
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
  // 断言要认**载体**不只认字面——审官样本 O 把锚从 commit 挪回 PR 正文（病灶原样复活），
  // 只查 /\[chain:/ 的旧断言一条不响。所以要求同一行里 commit 与锚串共现。
  g("跨 PR 锚点：锚在 commit 消息里（不是 PR 正文）",
    () => contractSlice(grillAi).split(/\r?\n/).some(
      l => l.includes("[chain:") && /commit/.test(l)),
    "锚挪出 commit（如挪回 PR 正文）⇒ 跨 PR 就失联，正是二轮红 1 的病灶");
  g("跨 PR 读取：检索命令带 --all（不只搜当前分支）",
    () => /git log[^\n]*--all[^\n]*--grep[^\n]*chain:/.test(contractSlice(grillAi)),
    "少了 --all 就只搜当前分支 ⇒ 新分支上必然 0 命中，闸静默开门");
  g("锚自带层号是与回抄互不依赖的双保险",
    () => /双保险/.test(contractSlice(grillAi)),
    "只写回抄 ⇒ 读者以为正文没了就判不出层数，实际锚串里的 #N 就够落闸");

  // 0 命中的自证：「查不到」与「没查成」同貌，不自证就 fail-open（三轮红 1）。
  g("0 命中要先自证「查得成」，不直接判第 0 层",
    () => /没查成/.test(contractSlice(grillAi)) && /第 0 层/.test(contractSlice(grillAi)),
    "「查不到才当第 0 层」没有自证 ⇒ 浅克隆/锚没进主干时静默判成没有链");
  g("自证含浅克隆探针 is-shallow-repository",
    () => /--is-shallow-repository/.test(contractSlice(grillAi)),
    "浅克隆下 git log --all 恒 0 命中且 exit=0，与「没有链」同貌");
  g("自证含合并口径前提 squash_merge_commit_message",
    () => /squash_merge_commit_message/.test(contractSlice(grillAi)),
    "锚能否进主干挂在这个仓库设置上，skill 不写明 ⇒ 换个项目就静默失效");
  g("查不成时 fail-close：按有链处理",
    () => /按\*\*有链\*\*处理|按有链处理/.test(contractSlice(grillAi)),
    "查不成当没查出问题 ⇒ 闸朝开门那侧失效");
  g("不进 git 的补丁链有落点（建 issue）",
    () => /不进 git/.test(contractSlice(grillAi)) && /issue/.test(contractSlice(grillAi)),
    "本机配置/面板按钮类的链没有 commit 可锚，不给替代落点就无处可记");
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

  // ── 判例落点三态（#529）：跟着本机 Junction 走 ──────────────────
  // memory 住在独立仓；本机 ~/.claude/projects/<编码>/memory 是它的 Junction。
  // GRILL_MEM_DIR 覆盖 memory 目录（造违规样本）；不传 = 本机默认路径。
  const home = process.env.USERPROFILE || process.env.HOME || "";
  const memDir = process.env.GRILL_MEM_DIR || path.join(home, ".claude", "projects", encodeProjectDir(path.resolve(REPO)), "memory");
  const verdictPath = path.join(memDir, PRECEDENT + ".md");
  const verdict = readAbs(verdictPath);

  if (!fs.existsSync(memDir)) {
    console.log(`  SKIP  本机无该项目 memory 目录（${memDir}）⇒ 判例落点与后续 ${gated.length} 条断言未执行（这是「没查成」，不是「查过没事」）`);
  } else {
    check(`判例 ${PRECEDENT}.md 在本机 memory 目录里`, verdict !== null,
      `判例落点缺失 ⇒ grill-ai 末尾的判例引用指向空气（${verdictPath}）`);
    if (grillAi && grillMe && verdict) {
      for (const t of gated) t();
    } else {
      console.log(`  SKIP  判例落点不可读 ⇒ 后续 ${gated.length} 条断言未执行（这是「没查成」，不是「查过没事」）`);
    }
  }

  console.log(`\ngrill-ai 指针网：${pass} 通过 / ${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
}

main();