// codex-skill-policy —— 「哪些 skill 允许 Codex 的模型自动调用」这条契约的双向守卫
//
// 跑法：node tests/codex-skill-policy.tests.js   （全绿 exit 0，任一红 exit 1）
//       run-tests.mjs 扫 tests/*.tests.js，本文件放进来即自动纳入，无清单要维护。
//
// ── 守的是什么 ────────────────────────────────────────────────────────────────
// `disable-model-invocation: true` 是 **Claude Code 专有** frontmatter 字段，Codex
// **静默忽略**它（不报错、不警告）⇒ 同一个 skill 在 Codex 侧默认**允许模型自动调用**，
// 比 Claude 侧更松。2026-07-27（windsurf-dao `17957dd`）给用户面 5 个 skill 各加了一份
// `agents/openai.yaml`（`policy.allow_implicit_invocation: false`）补齐语义；AI 内部件
// 4 个**刻意不加**——那个开关的效果是「禁 AI 自动调用、只留用户显式调用」，与「用户不敲、
// AI 用」的定位正好相反。
// 分组判据与完整证据：mousse-cli `docs/ops/dao-ecosystem-audit.md` §8.4 / §8.8。
//
// 加完之后**零守卫**：文件被删、被改成 true、新 skill 忘了加，都不会有任何信号。本测试补这一面。
//
// ── 两层断言，判别力不同，别混为一谈 ──────────────────────────────────────────
// A 层 **源侧**（仓内文件，零外部依赖，**永不跳过**）：5 个必须有且为 false，4 个必须没有。
//     这一层守的是「文件被删/被改」，也是本测试的主要价值。
// B 层 **效果侧**（`codex debug prompt-input` 实跑，依赖本机 codex）：那 5 个必须**不在**
//     注入模型上下文的 "Available skills" 列表里，那 4 个必须**在**。
//     这一层守的是「Codex 改语义了 / 这个字段哪天不认了」——A 层结构上看不见这种事。
//
// ── 已知缺口，照直写（别当它全包）────────────────────────────────────────────
// ① **环境跳过在 run-tests.mjs 的汇总表里不可见**：那张表只打 exit code 与 PASS/FAIL 计数、
//    不打 stdout。B 层跳过时本测试仍 exit 0，**唯一的可见信号是 PASS 计数变小**
//    （A 层条数 vs A+B 条数）。要知道 B 层到底跑没跑，别看汇总表，直接单跑本文件。
//    **这两个数字刻意不写死在本头注里**——它们由 `USER_FACING`/`AI_INTERNAL` 两个数组的长度
//    **算**出来，并由「A 层条数自检」那条断言钉住（往数组里加 skill，期望值自动跟上，
//    这个信号不会悄悄过期）。缘由是第一人称的：本头注一度把 SKIP 态条数写成 11（实为 14），
//    **一个「唯一可见信号」的数字写错，比不写更糟**，而任何写死的数字都必然随数组增减过期。
//    **自检的射程，两组 mutation 实测过，照直写**：往数组加一个名字 ⇒ 期望值自动跟到 15，
//    **不变红**（这正是设计目标，不是漏）；把 A 层断言循环删掉一条 check、数组不动 ⇒ **变红**
//    （14 vs 9，exit 1）。即它守的是「**断言循环悄悄缩水**」，不是「数组被改了」。
//    ⚠️ 仍未解决的那一半：自检只保证「数字是对的」，**不保证「有人会去看它」**——
//    汇总表看不见 stdout 这一点没变，那一面无护栏。
// ② A 层用正则读 YAML（本仓无 yaml 依赖），**先剥注释再匹配**，故注释里写 `allow_implicit_
//    invocation: false` 不会被误当成生效声明；但真 YAML 的锚点/多文档/引号形态它读不了。
//    当前 5 份文件都是同一份 20 行模板，这个近似够用——**形态一变就得改这里**。
// ③ B 层只对**确实装进 `~/.codex/skills/` 的**那些 skill 断言注入面。全部 9 个都没装 ⇒
//    整个 B 层跳过（那是「Codex 侧压根没部署」，不是契约被破坏）。
// ④ `codex debug prompt-input` 是**本地渲染**，不发请求、不烧 token（它只把「本轮会发出去的
//    prompt」打成 JSON）。但它仍会读 `~/.codex/config.toml` 与整个 skills 目录，故不是零成本。

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const SKILLS_SRC = path.join(ROOT, "ccswitch", "skills");
const HOME = process.env.USERPROFILE || process.env.HOME || os.homedir();
const CODEX_HOME = process.env.CODEX_HOME || path.join(HOME, ".codex");
const CODEX_SKILLS = path.join(CODEX_HOME, "skills");

// 用户面：只许用户手敲，AI 不许自动调用 ⇒ 必须有 opt-out，必须不在注入面
const USER_FACING = ["dao-design", "dao-evolution", "dao-loop", "dao-project-scaffold", "dao-verify"];
// AI 内部件：用户不敲、AI 用 ⇒ 必须没有 opt-out，必须在注入面
const AI_INTERNAL = ["dao-brainstorm", "dao-plan", "dao-review", "dao-worktree"];

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? "  →  " + detail : ""}`); }
}

// ── A 层 · 源侧 ──────────────────────────────────────────────────────────────
// 剥掉整行注释与行尾注释后再匹配，否则本模板顶部那段解释性注释会造成假阳性。
function readPolicy(skillName) {
  const p = path.join(SKILLS_SRC, skillName, "agents", "openai.yaml");
  if (!fs.existsSync(p)) return { exists: false, path: p, value: null };
  const raw = fs.readFileSync(p, "utf8");
  const stripped = raw
    .split(/\r?\n/)
    .map((l) => l.replace(/(^|\s)#.*$/, ""))
    .join("\n");
  // 要求它真的挂在 policy: 块下，不是散落在文件任意位置
  const m = stripped.match(/(^|\n)policy:\s*\n(?:[ \t]+[^\n]*\n?)*?[ \t]+allow_implicit_invocation:\s*(true|false)\b/);
  return { exists: true, path: p, value: m ? m[2] : null, raw };
}

console.log("\n=== A 层 · 源侧：用户面 5 个必须声明 allow_implicit_invocation: false ===");
for (const n of USER_FACING) {
  const r = readPolicy(n);
  check(`${n} 有 agents/openai.yaml`, r.exists, r.path);
  check(`${n} policy.allow_implicit_invocation === false`, r.value === "false",
    `实读=${r.value === null ? "（policy 块里没解析到该字段）" : r.value}`);
}

console.log("\n=== A 层 · 源侧：AI 内部件 4 个必须【不】声明（加了等于改成只有用户能敲）===");
for (const n of AI_INTERNAL) {
  const r = readPolicy(n);
  check(`${n} 不带 allow_implicit_invocation: false`, !(r.exists && r.value === "false"),
    r.exists ? `存在 ${r.path} 且值=${r.value}` : "无该文件（预期）");
}

// ── B 层 · 效果侧 ────────────────────────────────────────────────────────────
function resolveCodex() {
  if (process.env.CODEX_CLI_PATH && fs.existsSync(process.env.CODEX_CLI_PATH)) {
    return { exe: process.env.CODEX_CLI_PATH, from: "环境变量 CODEX_CLI_PATH" };
  }
  const cfg = path.join(CODEX_HOME, "config.toml");
  if (fs.existsSync(cfg)) {
    // codex 不在 PATH 上，真实路径写在 config.toml 里（本机形态）
    const m = fs.readFileSync(cfg, "utf8").match(/^\s*CODEX_CLI_PATH\s*=\s*['"]([^'"]+)['"]/m);
    if (m && fs.existsSync(m[1])) return { exe: m[1], from: `${cfg} 的 CODEX_CLI_PATH` };
  }
  // 最后再试 PATH（换台机器可能就在 PATH 上）
  const probe = spawnSync(process.platform === "win32" ? "where" : "which", ["codex"], { encoding: "utf8" });
  if (probe.status === 0) {
    const first = String(probe.stdout).split(/\r?\n/).find((x) => x.trim());
    if (first && fs.existsSync(first.trim())) return { exe: first.trim(), from: "PATH" };
  }
  return null;
}

// 注入面里 "### Available skills" 之后每行形如 `- <name>: <描述> (file: …)`
function parseInjectedSkillNames(promptJson) {
  let items;
  try { items = JSON.parse(promptJson); } catch (_) { return null; }
  let text = "";
  for (const it of Array.isArray(items) ? items : []) {
    for (const c of (it && it.content) || []) if (typeof c.text === "string") text += c.text;
  }
  const idx = text.indexOf("### Available skills");
  if (idx < 0) return null;
  const names = [];
  for (const line of text.slice(idx).split(/\r?\n/)) {
    const m = line.match(/^- ([A-Za-z0-9_.-]+):/);
    if (m) names.push(m[1]);
    else if (/^##\s/.test(line) && names.length) break;
  }
  return names;
}

// ── A 层条数自检 ──────────────────────────────────────────────────────────────
// 把「B 层跑没跑」那个唯一可见信号（PASS 计数）变成**算出来的**数，而不是头注里写死的数。
// `pass + fail` = 已执行的断言数，与「通过数」不同，故 A 层里真有一条红时本条不会连带变红。
const ranA = pass + fail;
const expectedA = USER_FACING.length * 2 + AI_INTERNAL.length;
check(`A 层条数自检：实际执行 ${ranA} 条 === 由两个数组长度算出的 ${expectedA} 条`,
  ranA === expectedA,
  "数组长度变了而 A 层断言没跟上（或反之）⇒ 头注里那个『PASS 计数变小』的信号已失真");

console.log("\n=== B 层 · 效果侧：注入模型上下文的 Available skills 列表 ===");
let bLayerRan = false;
const codex = resolveCodex();
if (!codex) {
  console.log("  ⏭ SKIP  本机找不到 codex 可执行（查过：$CODEX_CLI_PATH / ~/.codex/config.toml / PATH）");
  console.log("          ⇒ 效果侧断言全部跳过；上面的源侧断言已经跑完，契约文件层仍受保护。");
} else if (!fs.existsSync(CODEX_SKILLS)) {
  console.log(`  ⏭ SKIP  ${CODEX_SKILLS} 不存在 ⇒ Codex 侧压根没部署这些 skill，注入面无从谈起。`);
} else {
  const installed = (n) => fs.existsSync(path.join(CODEX_SKILLS, n));
  const deployed = [...USER_FACING, ...AI_INTERNAL].filter(installed);
  if (deployed.length === 0) {
    console.log(`  ⏭ SKIP  9 个 dao skill 在 ${CODEX_SKILLS} 里一个都没装 ⇒ 注入面断言无意义。`);
  } else {
    const r = spawnSync(codex.exe, ["debug", "prompt-input"], { encoding: "utf8", timeout: 120000, maxBuffer: 64 * 1024 * 1024 });
    const names = r.status === 0 ? parseInjectedSkillNames(r.stdout) : null;
    if (!names) {
      // 探测失败**不判红**：这是环境/上游形态问题，不是契约被破坏。但要吵得够响。
      console.log(`  ⏭ SKIP  \`codex debug prompt-input\` 没给出可解析的 Available skills 列表`);
      console.log(`          exe=${codex.exe}（来源：${codex.from}） exit=${r.status} err=${String(r.stderr || "").slice(0, 200)}`);
      console.log(`          ⇒ 若是 Codex 改了输出形态，本层从此静默失效，得来改 parseInjectedSkillNames()。`);
    } else {
      bLayerRan = true;
      console.log(`  ⓘ codex=${codex.exe}（来源：${codex.from}）；注入面共 ${names.length} 个 skill`);
      for (const n of USER_FACING) {
        if (!installed(n)) { console.log(`  ⏭ skip  ${n} 未装进 ~/.codex/skills，注入面断言 N/A`); continue; }
        check(`${n} 不在注入面（AI 不会自动调用）`, !names.includes(n),
          "它出现在 Available skills 里 ⇒ opt-out 没生效");
      }
      for (const n of AI_INTERNAL) {
        if (!installed(n)) { console.log(`  ⏭ skip  ${n} 未装进 ~/.codex/skills，注入面断言 N/A`); continue; }
        check(`${n} 在注入面（AI 用得上）`, names.includes(n),
          "它从 Available skills 里消失了 ⇒ 可能被误加了 opt-out，或链接断了");
      }
      // ── 观察线（恒不参与红绿）──────────────────────────────────────────────
      // 「注入面里还有别的 dao-*」是**人该看一眼**的事，不是「代码错了」：可能是新加的 skill
      // 还没登记进本文件，也可能是已废弃的孤儿副本还在往每个 Codex 会话里灌描述。
      // 做成硬闸只会逼人去改数组凑绿（判据见 mousse-cli 条款库「新增机检项先判闸位」）。
      const known = new Set([...USER_FACING, ...AI_INTERNAL]);
      const extra = names.filter((n) => n.startsWith("dao-") && !known.has(n));
      if (extra.length) {
        console.log(`  ⚠ 观察线（不判红）：注入面里另有 ${extra.length} 个未登记的 dao-*：${extra.join(", ")}`);
        console.log(`      每个 Codex 会话都会读到它们的 description。是新 skill 忘了登记，还是该退役的孤儿？`);
      } else {
        console.log("  ⓘ 观察线：注入面里没有未登记的 dao-*（零增量）");
      }
    }
  }
}

// 这一行是给「只看得到计数」的人留的解码钥匙：它说清本次的计数由哪两段构成。
console.log(`\nⓘ 断言构成：A 层 ${ranA} 条（源侧，永不跳过）+ B 层 ${pass + fail - ranA - 1} 条` +
  `（效果侧，${bLayerRan ? "本次已跑" : "**本次已跳过** ⇒ 契约只在文件层受检"}）+ 条数自检 1 条`);
console.log(`=== 汇总: PASS=${pass} FAIL=${fail} ===`);
process.exit(fail ? 1 : 0);
