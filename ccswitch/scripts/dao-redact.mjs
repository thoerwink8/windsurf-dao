#!/usr/bin/env node
// dao-redact.mjs — 凭据脱敏两层防线的**命令行入口**（跨语言消费方从这里进）
//
// ── 三个模式 ─────────────────────────────────────────────────────────────────
//   --copy <src> <dest>        读源 → 脱敏 → 写目标。**源不动，目标位置从无裸内容。**【推荐】
//   --in-place <path...>       就地脱敏。失败即隔离该文件（fail-closed，见 lib 头注 ③）
//   --scan <path...>           只检出不改盘。命中 ⇒ exit 1
// 通用开关：--json（机器读）· --no-quarantine（in-place 失败时不隔离，**由你自己负责那个文件**）
//
// ── 退出码四态（只有 0 叫「干净地做完了」）──────────────────────────────────
//   0  做完了，没问题（scan：零命中且零不可读）
//   1  **scan 模式专用**：扫到了疑似凭据。这不是「错误」，是「有活要干」
//   2  **fail-closed 失败**：脱敏抛错 / 读不到 / 目标写不了 / 二进制工件 / 有文件读不了
//      —— 与 0 必须分得开：「没做成」和「做了没事」在只读退出码的消费方眼里长得一样
//   3  用法错（参数缺失、模式冲突、模式没给）
// 判成败的谓词写 `-eq 0` / `=== 0`，别写 `-le 1`（那个区间把 scan 的命中也算成通过了）。
//
// ── 末行契约（机器读这一行，别去正则匹配上面的中文）──────────────────────────
//   DAO_REDACT_SUMMARY exit=<n> mode=<copy|in-place|scan> files=<n> ok=<n> hits=<n> binary=<n> unreadable=<n> failed=<n>
//   **每条路径都打印**（含用法错与失败路径）：只在成功时打摘要，等于让「没做成」在机器
//   通道上表现为「什么都没说」。新字段一律追加在末尾，消费方按字段名取值。
//
// ── 怎么从别的语言调（这是本文件存在的理由：一份实现，多语言消费）─────────────
//   PowerShell（devin-byok 的 QA 链是这个形态）：
//     node "<dao>/ccswitch/scripts/dao-redact.mjs" --copy $src $dest
//     if ($LASTEXITCODE -ne 0) { throw "脱敏失败，拒绝落盘：$src" }   # 别 try/catch 吞掉
//   Node（mousse-cli 的 scripts/qa/*.mjs 形态）：直接 import ccswitch/lib/redact.js 更省一次进程
//
// ── 2026-08-02 全域分布摸底（建护栏前先摸，dao-writing-rules.md 第二节第一条）────────
// 本文件是这组数字的**唯一真相源**（lib 头注指过来，别在两处各记一份）。
// 命令：`node ccswitch/scripts/dao-redact.mjs --scan <路径>`，逐仓真跑，数字照抄末行 summary。
//
//   | 仓 · 扫的面 | scanned | binary | hits | 这些 hit 是什么 |
//   |---|---|---|---|---|
//   | mousse-cli `_tmp/qa`    | 785 | 977 | 5  | 2 真（一次性会话 token，低价值）+ 3 假阳性（`*_TOKEN = False` / `query_tokens =` 这类代码行） |
//   | mousse-cli `scripts/qa` | 3   | 0   | 0  | — |
//   | mousse-cli `docs/qa`    | 8   | 0   | 0  | — |
//   | windsurf-dao `_tmp`     | 932 | 32  | 84 | **见下，本次摸底最重要的一格** |
//   | devin-byok `scripts`    | 15  | 0   | 10 | 全部是**脱敏器自身**的正则字面量与种子假 key（`sk-smoke` 等） |
//   | TraceyU `_tmp/qa`       | 1   | 212 | 0  | — |
//
// **windsurf-dao `_tmp` 那 84 处的分类（这一格推翻了本条上移时的原始假设）**：
//   · 58 —— 本仓 `tests/settings-drift.tests.js` 落的夹具（合成串，测试源码里就写着），假阳性
//   · 2  —— 第三方解包源码 `dao-proxy-extracted/`，假阳性
//   · 2  —— `firecrawl-mcp/ADD-FIRECRAWL.md` 里的 `"FIRECRAWL_API_KEY": "…"` ——**真值**
//   · 22 —— `hook-register-202608/00-current.*.json`：cc-switch 各 provider 配置的 **live dump**，
//           里面是 `"ANTHROPIC_AUTH_TOKEN": "sk-…"` 与 JWT ——**真凭据**
//   ⇒ **原始判断「dao 侧只是纸面风险」不成立**：dao 自己的诊断链**此刻就在往盘上写真凭据**，
//     而产出它们的那条链（那个 ops 批的 `00-read-current.mjs`）**没有任何脱敏步**——正是本条
//     要补的那一步。
//   ⇒ 但**风险的边界也要照直写**：这些文件都在 `_tmp/`，`.gitignore:1` 就是 `_tmp/`，
//     `git ls-files _tmp` 为空 ⇒ **它们没有进 git 历史**。真实的暴露面是「`_tmp/` 里的东西
//     经常被整段贴进 PR body / issue / 交付报告」——那条路上此前一个过滤器都没有。
//   ⚠ **未验的一格（不许当成已验）**：这些 dump 里的值**是不是等于用户此刻在用的那把 key**，
//     本批**没有验证**——比对要读 `~/.claude/settings.json`，该操作被权限分类器当场拒绝，
//     没有绕。故只声明「形状是真凭据形状、来源是 live dump」，不声明「就是那把在用的」。
//
// **另一条摸底捞出来的东西（H1-4：清单化/外部化必须如实报告现场捞出的缺项）**：
//   devin-byok 那 10 处**全部是守卫自己**（脱敏器的正则字面量、种子配置里的假 key）。
//   这是「检查器的输出落进自己的扫描面」那条的近亲——**扫描面里含着守卫自己**，
//   而它的表现是「每加一条模式，扫描报告就多几处命中」。故 CLI 提供 `--exclude <substr>`，
//   把守卫自身排除；**不做成默认排除**（默认排除等于给自己开了个永久豁免口）。
//
// ⚠ 射程：以上只覆盖**当前工作树**，不覆盖 **git 历史**。历史面要 `git rev-list` 全史扫，
//   成本另一个量级，本批未做（见 PR 未尽处）。
//
// 真相源：windsurf-dao/ccswitch/scripts/dao-redact.mjs

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require_ = createRequire(import.meta.url);
const R = require_(path.join(HERE, "..", "lib", "redact.js"));

const argv = process.argv.slice(2);
const asJson = argv.includes("--json");
const noQuarantine = argv.includes("--no-quarantine");

function out(s) { process.stdout.write(s + "\n"); }

const ZERO = { files: 0, ok: 0, hits: 0, binary: 0, unreadable: 0, failed: 0 };
function summary(exit, c) {
  const x = Object.assign({}, ZERO, c || {});
  out(`DAO_REDACT_SUMMARY exit=${exit} mode=${x.mode || "none"} files=${x.files} ok=${x.ok} ` +
      `hits=${x.hits} binary=${x.binary} unreadable=${x.unreadable} failed=${x.failed}`);
}

function usage(msg) {
  if (msg) out("✗ " + msg);
  out([
    "用法：",
    "  node ccswitch/scripts/dao-redact.mjs --copy <src> <dest>",
    "  node ccswitch/scripts/dao-redact.mjs --in-place <path...> [--no-quarantine]",
    "  node ccswitch/scripts/dao-redact.mjs --scan <path...> [--exclude <substr>]...",
    "  通用：--json",
    "退出码：0 干净 / 1 scan 有命中 / 2 fail-closed 失败 / 3 用法错",
  ].join("\n"));
  summary(3, { mode: "none" });
  process.exit(3);
}

// 取某个开关后面的位置参数（到下一个 `--` 开头为止）
function tail(flag) {
  const i = argv.indexOf(flag);
  if (i === -1) return null;
  const rest = [];
  for (let j = i + 1; j < argv.length; j++) {
    if (argv[j].startsWith("--")) break;
    rest.push(argv[j]);
  }
  return rest;
}

const modes = ["--copy", "--in-place", "--scan"].filter((m) => argv.includes(m));
if (modes.length === 0) usage("没给模式");
if (modes.length > 1) usage("模式互斥，一次只能给一个：" + modes.join(" "));
const mode = modes[0].slice(2);

// ── --copy ──────────────────────────────────────────────────────────────────
if (mode === "copy") {
  const a = tail("--copy") || [];
  if (a.length !== 2) usage("--copy 要恰好两个参数：<src> <dest>");
  const [src, dest] = a;
  try {
    const r = R.redactFileTo(src, dest, {});
    if (asJson) out(JSON.stringify({ ok: true, src, dest, hits: r.hits }, null, 2));
    else out(`✓ 已脱敏落盘：${dest}${r.hits.length ? `（命中模式：${r.hits.join(", ")}）` : "（无命中）"}`);
    summary(0, { mode, files: 1, ok: 1, hits: r.hits.length });
    process.exit(0);
  } catch (e) {
    out(`✗ ${e.code || "EFAIL"} ${e.message}`);
    out("   → 目标位置**没有**留下任何未脱敏内容（fail-closed）。修掉原因后重跑，别绕过这一步。");
    summary(2, { mode, files: 1, failed: 1, binary: e.code === "EBINARY" ? 1 : 0, unreadable: e.code === "EIO" ? 1 : 0 });
    process.exit(2);
  }
}

// ── --in-place ──────────────────────────────────────────────────────────────
if (mode === "in-place") {
  const targets = tail("--in-place") || [];
  if (targets.length === 0) usage("--in-place 至少要一个路径");
  const c = { mode, files: targets.length, ok: 0, hits: 0, binary: 0, unreadable: 0, failed: 0 };
  const rows = [];
  for (const t of targets) {
    try {
      const r = R.redactFileInPlace(t, { onFailure: noQuarantine ? "throw" : "quarantine" });
      c.ok++; c.hits += r.hits.length;
      rows.push({ path: t, ok: true, hits: r.hits });
      if (!asJson) out(`✓ ${t}${r.hits.length ? `（命中：${r.hits.join(", ")}）` : ""}`);
    } catch (e) {
      c.failed++;
      if (e.code === "EBINARY") c.binary++;
      if (e.code === "EIO") c.unreadable++;
      rows.push({ path: t, ok: false, code: e.code || "EFAIL", quarantine: e.quarantine || null, message: e.message });
      if (!asJson) {
        out(`✗ ${t} —— ${e.code || "EFAIL"} ${e.message}`);
        // 三态要分开说：隔离成功 / **隔离也失败**（最坏的一格，必须喊出来）/ 显式没隔离。
        // 首版把后两态并进「已隔离（failed）」一句 —— 那句话在最坏的一格上是**谎报成功**。
        if (e.quarantine === "overwritten" || e.quarantine === "deleted") {
          out(`   → 已隔离该文件（${e.quarantine}）：宁可毁掉一份工件，不留一份裸密钥`);
        } else if (e.quarantine === "failed") {
          out("   → 🔴 **隔离也失败了**：该文件此刻可能是裸的，且本工具动不了它（多半被占用）。");
          out("      需要人手处置：关掉占用它的进程后删掉它，别把它 commit 进去。");
        } else if (noQuarantine) {
          out("   → 未隔离（--no-quarantine）：**这个文件现在可能是裸的，归你处置**");
        }
      }
    }
  }
  if (asJson) out(JSON.stringify({ ok: c.failed === 0, rows }, null, 2));
  const exit = c.failed ? 2 : 0;
  summary(exit, c);
  process.exit(exit);
}

// ── --scan ──────────────────────────────────────────────────────────────────
{
  const targets = tail("--scan") || [];
  if (targets.length === 0) usage("--scan 至少要一个路径");
  const excludes = [];
  for (let i = 0; i < argv.length; i++) if (argv[i] === "--exclude" && argv[i + 1]) excludes.push(argv[i + 1]);
  const c = { mode: "scan", files: 0, ok: 0, hits: 0, binary: 0, unreadable: 0, failed: 0 };
  const all = [];
  const unreadablePaths = [];
  for (const t of targets) {
    if (!fs.existsSync(t)) {
      // 「路径不在」必须与「扫了没事」分得开 —— 打错一个路径然后收获一句「零命中」，
      // 是这整套东西最容易骗到自己的地方。
      out(`✗ 路径不存在：${t}`);
      c.failed++;
      continue;
    }
    const r = R.scanTree(t, {});
    c.files += r.scanned; c.binary += r.binarySkipped; c.unreadable += r.unreadable;
    unreadablePaths.push(...r.unreadablePaths);
    for (const f of r.findings) {
      if (excludes.some((x) => f.file.includes(x))) continue;
      all.push(f);
    }
  }
  c.hits = all.length;
  c.ok = c.files;
  if (asJson) {
    out(JSON.stringify({ ok: c.hits === 0 && c.unreadable === 0 && c.failed === 0, counts: c, findings: all, unreadablePaths }, null, 2));
  } else {
    for (const f of all) out(`  ⚠ ${f.file}:${f.line}  ${f.pattern}  ${f.preview}`);
    for (const p of unreadablePaths) out(`  ✗ 读不到（不计入「零命中」）：${p}`);
    out(`\n扫描面：文件 ${c.files} · 二进制跳过 ${c.binary}（🚧 截图类工件不在射程内）· 读不到 ${c.unreadable}`);
    if (c.files === 0) out("⚠ **一个样本都没看到** —— 这不是「零命中」，先确认路径对不对");
    out(c.hits ? `⚠ 疑似凭据 ${c.hits} 处（只打码显示，报告里永不回显原值）` : "✓ 零命中");
  }
  // 读不到任何一个文件 ⇒ 不能声称干净（fail-closed）。零样本同理。
  const exit = (c.failed || c.unreadable || c.files === 0) ? 2 : (c.hits ? 1 : 0);
  summary(exit, c);
  process.exit(exit);
}
