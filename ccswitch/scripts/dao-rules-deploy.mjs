#!/usr/bin/env node
// dao-rules-deploy.mjs — 作用域规则（paths-scoped rules）部署与漂移自检
//
// ── 治的是什么病 ─────────────────────────────────────────────────────────────
// dao 体系里有一批「细则正文」文件（ccswitch/rules/dao-{dispatch,longwindow,guard-writing,
// powershell}.md），每个开头都写着「**必经动作**：动手之前 Read 本文件全文」。
// 那四个字**没有任何机器投递**——它要求在无标记时刻发起一次自由裁量动作，
// 而本仓实测这一类的携带率是 9-24%（对照：跟着模板走的槽位类 100%）。
//
// Claude Code 的 `paths:` 作用域规则提供了缺的那个投递通道：把一份带
// `paths:` frontmatter 的 md 放进 `~/.claude/rules/`，宿主会在**Read 到匹配文件**时
// 自动把它注入上下文（system-reminder 形态）。于是「你正要改守卫」这件事本身
// 就成了触发器，不再依赖谁想起来。
//
// ── 本机实测的机制事实（2026-08-01 canary，正负控双向）────────────────────────
//   ① 用户级 `~/.claude/rules/*.md` + `paths:` **生效**，且**能送达 subagent**；
//   ② glob 按**当前项目根**解析（不是 home）——`".github/**"` 在 mousse-cli 会话里
//      匹配 `D:/frank/mousse-cli/.github/**`，故一份用户级规则可覆盖全部项目；
//   ③ 负控：读不匹配的文件时零注入，确系作用域触发而非 always-on；
//   ④ 用户级**无 `paths:`** 的规则文件，三个 subagent 观察员 3/3 均未收到
//      （主会话侧未验）⇒ 别把 `~/.claude/rules/` 当 always-on 用，它只对作用域型可靠。
//   ⑤ 键名必须是 `paths:`；`globs:` 完全不生效**且零报错**。
//   ⑥ 前导 `*` 的 glob 不加引号会被 YAML 当 alias 锚点 ⇒ 解析失败且静默。
// ⑤⑥ 是静默失败形态，故本脚本把它们做成硬校验（见 validateRule）。
//
// ── 源与投影 ─────────────────────────────────────────────────────────────────
// 源  = `ccswitch/rules/scoped/*.md`（git 跟踪，唯一真相源）
// 投影 = `~/.claude/rules/dao-scope-*.md`（宿主扫描目录，不进 git）
// 按 dao.md Shell 节「改配置先认源与投影」：改投影立即生效但不持久，正道是改源再部署。
// 本脚本**只管 `dao-scope-` 前缀的文件**，`~/.claude/rules/` 下其它文件一律不碰。
//
// 用法：
//   node ccswitch/scripts/dao-rules-deploy.mjs            部署（源 → 投影）
//   node ccswitch/scripts/dao-rules-deploy.mjs --check     只报漂移，不写；有漂移 exit 1
//   node ccswitch/scripts/dao-rules-deploy.mjs --prune     另删除投影里已无对应源的 dao-scope-*
// 退出码：0 一致/已部署 · 1 有漂移（--check）· 2 源目录为空或不存在 · 3 规则本身不合法

import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = join(HERE, "..", "rules", "scoped");
const DEST_DIR = join(homedir(), ".claude", "rules");
const PREFIX = "dao-scope-";

function fail(code, msg) {
  console.error(`✗ ${msg}`);
  process.exit(code);
}

// ── 规则合法性校验 ───────────────────────────────────────────────────────────
// 刻意逐行读原始文本，不用 YAML 库：要检的两个病（`globs:` 键名、未加引号的前导 `*`）
// 恰恰是**解析器吃不下或静默吃错**的形态，交给解析器就看不见了。
export function validateRule(name, text) {
  const errs = [];
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) {
    errs.push("缺 YAML frontmatter —— 无 frontmatter 的用户级规则实测不注入（机制事实④）");
    return errs;
  }
  const fm = m[1];
  if (/^\s*globs\s*:/m.test(fm)) {
    errs.push("frontmatter 用了 `globs:` —— 该键名完全不生效且零报错，必须写 `paths:`（机制事实⑤）");
  }
  if (!/^\s*paths\s*:/m.test(fm)) {
    errs.push("frontmatter 缺 `paths:` 键");
  }
  // 列表项形如 `  - <glob>`；前导 * 未加引号 ⇒ YAML 视为 alias 锚点，静默失败
  const items = fm.split(/\r?\n/).filter((l) => /^\s*-\s+/.test(l));
  if (items.length === 0) errs.push("`paths:` 下没有任何 glob 条目");
  for (const line of items) {
    const val = line.replace(/^\s*-\s+/, "").trim();
    const quoted = /^(".*"|'.*')$/.test(val);
    if (!quoted) {
      errs.push(`glob 未加引号：${val} —— 前导 * 会被 YAML 当 alias 锚点，静默失效（机制事实⑥）`);
    }
  }
  return errs;
}

// ── 纯检测：读源、读投影、校验、算漂移，不落盘（issue #376 A）───────────────
// doctor.mjs 的「作用域规则漂移」段调这个函数做报告；CLI 的 --check / 部署两条
// 路径也调它，只是消费方式不同（CLI 会话把结果拿去 fail()/写盘，doctor 只报）。
// 不落盘、不 process.exit——纯函数，fs 读操作可注入供测试用假文件系统。
// errorCode 语义与原 CLI 的 exit code 一致：2=源目录空或不存在、3=规则本身不合法；
// null 表示读取与校验都过了，drift/orphans 里是真正的漂移结果。
export function detectRulesDrift({
  srcDir = SRC_DIR,
  destDir = DEST_DIR,
  fsExistsSync = existsSync,
  fsReadFileSync = readFileSync,
  fsReaddirSync = readdirSync,
} = {}) {
  const result = { srcDir, destDir, errorCode: null, errorMessage: null, loaded: [], invalid: [], drift: [], orphans: [] };

  if (!fsExistsSync(srcDir)) {
    result.errorCode = 2;
    result.errorMessage = `源目录不存在：${srcDir}`;
    return result;
  }
  const srcFiles = fsReaddirSync(srcDir).filter((f) => f.endsWith(".md"));

  // 零样本断言：源目录空 ≠ 「一致」。不区分这两种 0，会在源被误删时报绿。
  if (srcFiles.length === 0) {
    result.errorCode = 2;
    result.errorMessage = `源目录 ${srcDir} 里一个 .md 都没有 —— 这不是「无漂移」，是「无样本」`;
    return result;
  }

  const badNames = srcFiles.filter((f) => !f.startsWith(PREFIX));
  if (badNames.length) {
    result.errorCode = 3;
    result.errorMessage = `源文件名必须以 \`${PREFIX}\` 开头（部署侧靠前缀界定管辖范围）：${badNames.join(", ")}`;
    return result;
  }

  for (const f of srcFiles) {
    const text = fsReadFileSync(join(srcDir, f), "utf8");
    const errs = validateRule(f, text);
    if (errs.length) result.invalid.push({ name: f, errors: errs });
    result.loaded.push({ name: f, text });
  }
  if (result.invalid.length) {
    result.errorCode = 3;
    result.errorMessage = `${result.invalid.length}/${srcFiles.length} 份作用域规则不合法，未部署`;
    return result;
  }

  // 比对刻意**规范化行尾再比**，不做字节相等：源文件受 git 的 autocrlf 摆布
  // （同一份内容在不同机器/不同 checkout 下 LF 与 CRLF 都可能），而投影是本脚本写的。
  // 拿字节相等去比，会在一次 `git checkout` 之后开始报**永远修不好的漂移**——
  // 而那种「每次都红、修了还红」的检查最终一定会被静音，等于白建。
  const norm = (s) => s.replace(/\r\n/g, "\n");
  for (const { name, text } of result.loaded) {
    const dest = join(destDir, name);
    const cur = fsExistsSync(dest) ? fsReadFileSync(dest, "utf8") : null;
    if (cur !== null && norm(cur) === norm(text)) continue;
    result.drift.push({ name, kind: cur === null ? "缺失" : "内容不一致" });
  }

  const srcNames = new Set(result.loaded.map((r) => r.name));
  result.orphans = fsExistsSync(destDir)
    ? fsReaddirSync(destDir).filter((f) => f.startsWith(PREFIX) && f.endsWith(".md") && !srcNames.has(f))
    : [];

  return result;
}

// ── CLI 入口守卫 ─────────────────────────────────────────────────────────────
// 本文件同时是「给人跑的 CLI 脚本」和「给 doctor.mjs import 的检测库」。只有直接
// `node ccswitch/scripts/dao-rules-deploy.mjs` 执行时才跑下面这段（写盘 + exit）；
// 被 import/require 时（doctor.mjs、测试）只取上面的纯函数，不触发任何副作用。
const isMainModule = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMainModule) {
  const args = new Set(process.argv.slice(2));
  const CHECK_ONLY = args.has("--check");
  const PRUNE = args.has("--prune");

  const info = detectRulesDrift();
  if (info.errorCode) {
    for (const item of info.invalid) {
      console.error(`✗ ${item.name}`);
      for (const e of item.errors) console.error(`    · ${e}`);
    }
    fail(info.errorCode, info.errorMessage);
  }

  // ── 部署（源 → 投影）：detectRulesDrift 只读不写，这里按它算出的 drift/orphans 落盘 ──
  if (!existsSync(DEST_DIR)) {
    if (CHECK_ONLY) fail(1, `投影目录不存在：${DEST_DIR}（${info.loaded.length} 份规则全部未部署）`);
    mkdirSync(DEST_DIR, { recursive: true });
  }

  if (!CHECK_ONLY) {
    const driftNames = new Set(info.drift.map((d) => d.name));
    for (const { name, text } of info.loaded) {
      if (driftNames.has(name)) writeFileSync(join(DEST_DIR, name), text, "utf8");
    }
    if (PRUNE) for (const o of info.orphans) unlinkSync(join(DEST_DIR, o));
  }

  // ── 报告 ───────────────────────────────────────────────────────────────────
  console.log(`源 ${SRC_DIR}`);
  console.log(`投影 ${DEST_DIR}`);
  console.log(`作用域规则 ${info.loaded.length} 份：${info.loaded.map((r) => r.name).join(", ")}`);

  if (CHECK_ONLY) {
    if (info.drift.length === 0 && info.orphans.length === 0) {
      console.log("✓ 投影与源一致，无漂移");
      process.exit(0);
    }
    for (const d of info.drift) console.error(`✗ ${d.name}：${d.kind}`);
    for (const o of info.orphans) console.error(`✗ ${o}：孤儿投影（源已无对应文件，--prune 可删）`);
    fail(1, `${info.drift.length} 份漂移 + ${info.orphans.length} 份孤儿`);
  }

  if (info.drift.length === 0) console.log("✓ 已是最新，无需写入");
  else for (const d of info.drift) console.log(`↻ ${d.name}（${d.kind}）已部署`);
  if (info.orphans.length) {
    console.log(PRUNE
      ? `🗑 已删孤儿投影 ${info.orphans.length} 份：${info.orphans.join(", ")}`
      : `⚠ 孤儿投影 ${info.orphans.length} 份未处理（加 --prune 删）：${info.orphans.join(", ")}`);
  }
  process.exit(0);
}
