#!/usr/bin/env node
// gen-agents-md.mjs — 从 CLAUDE.md 生成 AGENTS.md（架构优化 P8）
//
// ── 治的是什么病 ─────────────────────────────────────────────────────────────
// `AGENTS.md` 是非 Claude 宿主（Codex CLI 等）读项目规则的事实标准入口，60k+ 仓库在用。
// 想让别的宿主读到同一套规则，只有两条路：**手写第二份**，或**从同一真相源生成**。
// 手写第二份等于把「双份必漂移」写进项目骨架 —— 两份文件在第 1 天完全一致，
// 此后每一次只改其中一份，而**没有任何东西会告诉你另一份已经过期**。
// 本脚本走第二条：`CLAUDE.md` 是唯一真相源，`AGENTS.md` 是它的**生成投影**，
// 带源 hash，`--check` 一跑就知道过没过期。
//
// ── 与「根目录无冗余 AI 入口」那条共性 rule 的关系（必须说清，否则看起来是打架）──
// scaffold-manifest 有两条 universal 条目在禁根目录的第二个 AI 入口
// （`no-redundant-agent-guide` / `no-redundant-knowledge-md`），理由是**多入口 = AI 上下文
// 通道分裂，规范写在哪一份全凭运气**。`AGENTS.md` 看起来正是第三个这样的入口。
// 差别在**它有没有独立的写入端**：
//   · `AGENT_GUIDE.md` / `KNOWLEDGE.md` —— 手写、可被单独编辑 ⇒ 真·第二个真相源；
//   · 生成的 `AGENTS.md` —— 头部写明「勿手改」、带源 hash、手改会被 `--check` 逮到、
//     下次生成即被覆盖 ⇒ **投影，不是源**。
// 判据一句话：**能不能被单独改而不被发现**。能 ⇒ 是第二个真相源，该禁；
// 不能 ⇒ 是投影，只是同一份规则的另一种投递格式（同 dao.md Shell 节「改配置先认源与投影」）。
// 配套的清单条目因此不查「AGENTS.md 在不在」（那要判「这个项目有没有第二个宿主」，
// 是语义判断、清单明令不收），只查**已经有 AGENTS.md 的项目里，那一份是不是生成的**。
//
// ── 幂等怎么做到（时间戳与「跑两次逐字节同」的冲突）────────────────────────
// 头部要写生成时间，而时间戳每次都变 ⇒ 天真实现跑两次必不同。
// 解法不是去掉时间戳，是**只在真的要变时才写盘**：源 hash + 生成器版本 + 正文三者都对得上
// 就一个字节都不动。于是「跑两次逐字节同」成立，且顺带避免了每次生成都产生一个
// 只有时间戳不同的假 diff（那种 diff 会训练人对这个文件的改动视而不见）。
//
// ── `--check` 查三样，不是只查 hash ─────────────────────────────────────────
//   ① 源 hash 对不对   —— CLAUDE.md 改了而没重新生成（最常见的过期形态）
//   ② 生成器版本对不对 —— 头部模板本身改了（只查 ① 会漏掉这一类）
//   ③ **正文与源逐字相等** —— 有人直接手改了 AGENTS.md 的正文。
//      只查 hash 对这一类**结构上失明**：源没动、hash 照样对得上，而投影已经不是投影了。
//
// ── 已知边界，照直写 ────────────────────────────────────────────────────────
//   · **`@import` 不展开**：CLAUDE.md 里的 `@路径` 导入是 Claude Code 宿主的机制，
//     别的宿主不认。本脚本检测到这类行会**出声警告**（不判红），但不代为展开 ——
//     展开会把用户级/跨仓文件的内容烘焙进项目仓库，那是另一个量级的决定，不在这里做。
//   · v1 **全文转写，不做段落筛选**。「哪些段落对任意 agent 通用」是语义判断，
//     做成启发式只会产生一个两边都不像的东西；宁可多给，也不猜着删。
//   · 生成的文件里那条再生成命令写成 **`<windsurf-dao 根>` 占位形态**而非本机绝对路径 ——
//     绝对路径会让同一份内容在两台机器上生成出不同的字节（又一个漂移源）。
//     **解析好的绝对命令打在 stdout 上**，要粘贴的人当场就能拿到。
//
// ── 跑法 ────────────────────────────────────────────────────────────────────
//   node ccswitch/scripts/gen-agents-md.mjs <项目根>            生成 / 更新（幂等）
//   node ccswitch/scripts/gen-agents-md.mjs <项目根> --check    只查漂移，不写
//   node ccswitch/scripts/gen-agents-md.mjs <项目根> --force    忽略幂等，强制重写
//   <项目根> 省略即当前目录。
// 退出码：0 一致/已生成 · 1 过期（--check） · 2 源缺失或读不了 · 3 目标存在但**不是生成物**
//
// 末行契约：AGENTS_MD_SUMMARY exit=<N> action=<written|unchanged|drift|refused|error> source=<路径> sha=<短hash>
//
// 真相源：windsurf-dao/ccswitch/scripts/gen-agents-md.mjs
// 自证：node tests/agents-md.tests.js

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DAO_ROOT = path.resolve(HERE, "..", "..");

const GENERATOR = "gen-agents-md.mjs";
const GENERATOR_VERSION = "1";

// 标记写成 HTML 注释：Markdown 渲染时不可见（人读的那一面干净），而机器一眼可解析。
const MARK_FROM = "<!-- dao:generated-from CLAUDE.md -->";
const MARK_GEN = (v) => "<!-- dao:generator " + GENERATOR + " v" + v + " -->";
const MARK_SHA = (h) => "<!-- dao:source-sha256 " + h + " -->";
const MARK_BODY = "<!-- dao:body-begin -->";
// 清单条目查的就是这个子串（`fileContains` 纯子串匹配）。改它要同步改 scaffold-manifest.json。
const MARK_DETECT = "dao:generated-from CLAUDE.md";

const ARGV = process.argv.slice(2);
const FLAGS = new Set(ARGV.filter((a) => a.startsWith("--")));
const POSITIONAL = ARGV.filter((a) => !a.startsWith("--"));
const CHECK_ONLY = FLAGS.has("--check");
const FORCE = FLAGS.has("--force");
const PROJECT_ROOT = path.resolve(POSITIONAL[0] || process.cwd());
const SRC = path.join(PROJECT_ROOT, "CLAUDE.md");
const DEST = path.join(PROJECT_ROOT, "AGENTS.md");

function out(s) { process.stdout.write(s + "\n"); }

let shaShort = "-";
function finish(code, action) {
  out("AGENTS_MD_SUMMARY exit=" + code + " action=" + action +
      " source=" + SRC.replace(/\\/g, "/") + " sha=" + shaShort);
  process.exit(code);
}

// LF 规范化 + 去 BOM。理由同 check-alwayson-budget：core.autocrlf 下同一份内容
// 在两台机器上字节不同，拿原始字节做 hash 会产生**永远修不好的漂移**。
function norm(s) {
  let t = String(s);
  if (t.charCodeAt(0) === 0xfeff) t = t.slice(1);
  return t.replace(/\r\n/g, "\n");
}
function sha256(s) { return crypto.createHash("sha256").update(s, "utf8").digest("hex"); }

// ── 取源 ────────────────────────────────────────────────────────────────────
let srcRaw;
try { srcRaw = fs.readFileSync(SRC, "utf8"); }
catch (e) {
  out("✗ 真相源读不到：" + SRC + "（" + (e && e.message ? e.message : String(e)) + "）");
  out("  AGENTS.md 是 CLAUDE.md 的投影 —— 没有源就没有投影，本脚本不凭空造一份。");
  finish(2, "error");
}
const srcText = norm(srcRaw);
if (!srcText.trim()) {
  out("✗ 真相源是空的：" + SRC);
  out("  空源不是「无漂移」，是「无样本」—— 照它生成会产出一份空的 AGENTS.md 并宣告成功。");
  finish(2, "error");
}
const srcSha = sha256(srcText);
shaShort = srcSha.slice(0, 12);

// ── 组装投影 ────────────────────────────────────────────────────────────────
// 再生成命令刻意写成占位形态（理由见头注「已知边界」第三条）。
const REGEN_HINT = "node <windsurf-dao 根>/ccswitch/scripts/" + GENERATOR + " <项目根>";

function render(nowIso) {
  return [
    MARK_FROM,
    MARK_GEN(GENERATOR_VERSION),
    MARK_SHA(srcSha),
    "",
    "# AGENTS.md（生成物 · 请勿手改）",
    "",
    "> **这份文件是生成的，不是写的。** 真相源是同目录下的 `CLAUDE.md`；",
    "> 本文件是它面向**非 Claude 宿主**（Codex CLI 等按 `AGENTS.md` 约定读取项目规则的 agent）",
    "> 的派生副本，内容与 `CLAUDE.md` 逐字相同。",
    ">",
    "> - **要改规则 → 改 `CLAUDE.md`**，然后重新生成本文件",
    "> - 再生成：`" + REGEN_HINT + "`",
    "> - 查过期：同一条命令加 `--check`（源 hash 不匹配即 exit 1）",
    "> - **直接编辑本文件 = 制造第二份真相源**：`--check` 会逮到，下次生成会覆盖掉你的改动",
    ">",
    "> 之所以生成而不手写：两份手写的规则文件在第 1 天完全一致，此后每次只改其中一份，",
    "> 而没有任何东西会告诉你另一份已经过期。带源 hash 的投影则一跑就知道。",
    ">",
    "> ⚠ `CLAUDE.md` 里的 `@路径` 导入**不会**在本文件里展开（那是 Claude Code 宿主的机制，",
    "> 别的宿主不认）。读到那种行时请自行取对应文件。",
    ">",
    "> 生成时间 `" + nowIso + "` ｜ 源 `CLAUDE.md` sha256 `" + shaShort + "`",
    "",
    "---",
    "",
    MARK_BODY,
    "",
    srcText.replace(/\n+$/, ""),
    "",
  ].join("\n");
}

// ── 解析既有投影 ────────────────────────────────────────────────────────────
// 标记只在**文件开头**认（前 512 字符）：正文里恰好出现同样字样的文件不该被误判成投影。
function parseExisting(text) {
  const t = norm(text);
  const head = t.slice(0, 512);
  if (head.indexOf(MARK_DETECT) === -1) return { generated: false };
  const mSha = /<!-- dao:source-sha256 ([0-9a-f]{64}) -->/.exec(head);
  const mGen = new RegExp("<!-- dao:generator " + GENERATOR + " v(\\d+) -->").exec(head);
  const i = t.indexOf(MARK_BODY);
  const body = i === -1 ? null : t.slice(i + MARK_BODY.length).replace(/^\n+/, "").replace(/\n+$/, "");
  return {
    generated: true,
    sha: mSha ? mSha[1] : null,
    version: mGen ? mGen[1] : null,
    body,
  };
}

let destRaw = null;
try { destRaw = fs.readFileSync(DEST, "utf8"); } catch (_) { destRaw = null; }
const existing = destRaw === null ? null : parseExisting(destRaw);

// ── 目标存在但不是生成物 ⇒ 拒绝覆盖 ─────────────────────────────────────────
// 静默覆盖一份人写的 AGENTS.md 是不可逆的数据损失。**拒绝并说清怎么走**，
// 不做「我猜你想要」的自动迁移。
if (existing && !existing.generated) {
  out("✗ " + DEST + " 已存在，但它**不是本脚本的生成物**（开头没有生成标记）。");
  out("  拒绝覆盖 —— 那可能是手写的规则，覆盖不可逆。");
  out("  想改成生成式：把它的内容并进 CLAUDE.md（唯一真相源），删掉 AGENTS.md，再跑本脚本。");
  out("  只想看差异：先备份，再跑 --force。");
  finish(3, "refused");
}

// ── --check：查三样（源 hash / 生成器版本 / 正文逐字）───────────────────────
if (CHECK_ONLY) {
  if (existing === null) {
    // 没有 AGENTS.md 不是「过期」—— 本脚本不主张每个项目都该有一份。
    out("ⓘ " + DEST + " 不存在 ⇒ 无投影可查（本脚本不主张每个项目都要有 AGENTS.md，" +
        "该不该有是项目自己的事）");
    finish(0, "unchanged");
  }
  const bad = [];
  if (existing.sha !== srcSha) {
    bad.push("源 hash 不匹配：投影记的是 " + String(existing.sha).slice(0, 12) +
             "，而 CLAUDE.md 现在是 " + shaShort + " ⇒ **CLAUDE.md 改过而 AGENTS.md 没重新生成**");
  }
  if (existing.version !== GENERATOR_VERSION) {
    bad.push("生成器版本不匹配：投影由 v" + existing.version + " 生成，当前是 v" + GENERATOR_VERSION +
             " ⇒ 头部模板已变（只查 hash 会漏掉这一类）");
  }
  if (existing.body === null) {
    bad.push("找不到正文起点标记 " + MARK_BODY + " ⇒ 文件结构被改坏了");
  } else if (existing.body !== srcText.replace(/\n+$/, "")) {
    bad.push("正文与 CLAUDE.md 不再逐字相等 ⇒ **有人直接手改了 AGENTS.md 的正文**" +
             "（只查 hash 对这一类结构上失明：源没动、hash 照样对得上）");
  }
  if (bad.length === 0) {
    out("✓ AGENTS.md 与 CLAUDE.md 一致（源 hash / 生成器版本 / 正文三样都对）");
    out("  源 " + SRC.replace(/\\/g, "/") + " sha256 " + shaShort);
    finish(0, "unchanged");
  }
  out("✗ AGENTS.md 已过期 " + bad.length + " 处：");
  for (const b of bad) out("    · " + b);
  out("  → 重新生成：node " + path.join(DAO_ROOT, "ccswitch", "scripts", GENERATOR).replace(/\\/g, "/") +
      " " + PROJECT_ROOT.replace(/\\/g, "/"));
  finish(1, "drift");
}

// ── 生成（幂等：三样都对就一个字节都不写）───────────────────────────────────
const upToDate = existing !== null &&
  existing.sha === srcSha &&
  existing.version === GENERATOR_VERSION &&
  existing.body !== null &&
  existing.body === srcText.replace(/\n+$/, "");

if (upToDate && !FORCE) {
  out("✓ 已是最新，未写盘（源 hash / 生成器版本 / 正文三样都对）");
  out("  " + DEST.replace(/\\/g, "/") + " ← " + SRC.replace(/\\/g, "/") + " sha256 " + shaShort);
  out("  幂等是刻意的：每次生成都写一遍会产生只差时间戳的假 diff，而假 diff 会训练人对这个文件视而不见。");
  finish(0, "unchanged");
}

const content = render(new Date().toISOString().replace(/\.\d{3}Z$/, "Z"));
try { fs.writeFileSync(DEST, content, "utf8"); }
catch (e) {
  out("✗ 写不进去：" + DEST + "（" + (e && e.message ? e.message : String(e)) + "）");
  finish(2, "error");
}

out("↻ 已生成 " + DEST.replace(/\\/g, "/"));
out("  真相源 " + SRC.replace(/\\/g, "/") + " sha256 " + shaShort +
    "（" + Buffer.byteLength(srcText, "utf8") + " 字节正文）");
out("  查过期：node " + path.join(DAO_ROOT, "ccswitch", "scripts", GENERATOR).replace(/\\/g, "/") +
    " " + PROJECT_ROOT.replace(/\\/g, "/") + " --check");

// `@import` 警告：出声但不判红（见头注「已知边界」第一条）。
const imports = srcText.split("\n").filter((l) => /^@\S/.test(l.trim()));
if (imports.length) {
  out("");
  out("⚠ 源里有 " + imports.length + " 行 `@路径` 导入，**本文件不展开**（那是 Claude Code 宿主的机制，别的宿主不认）：");
  for (const l of imports.slice(0, 5)) out("    · " + l.trim());
  if (imports.length > 5) out("    · …另 " + (imports.length - 5) + " 行");
  out("  不代为展开是刻意的：展开会把用户级/跨仓文件的内容烘焙进项目仓库，那是另一个量级的决定。");
}

finish(0, "written");
