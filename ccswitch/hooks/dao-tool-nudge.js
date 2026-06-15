// dao tool-nudge hook — 纠偏"绕道 Bash 跑 grep/cat/find"
//
// 背景:Claude Code 同时允许内置 Grep(ripgrep)/Glob/Read 与 Bash(*),
// 两条路都零摩擦,模型常习惯性写 shell 一行(grep -nE "..." file | head)绕过内置工具。
// 内置工具更快(自动跳过 .git/node_modules/二进制)、结果可点击跳转、不撑爆主上下文。
//
// 本 hook 在 Bash 执行后,检测命令是否"直接搜文件/读文件",是则注入软提醒,纠正后续行为。
//   - grep/egrep/fgrep 直接搜文件(带 -r/-l/--include 或 文件路径参数)→ 建议 Grep
//   - find ... -name/-path/-type/-exec  → 建议 Glob / Explore
//   - cat/head/tail/less/more 直接读文件 → 建议 Read
//
// 关键豁免(降噪):管道下游的过滤(`ps | grep x`、`cmd | head`)内置工具替代不了 → 不提示。
//   只有"段首 + 带文件特征"才算绕道。git grep / --grep / ripgrep / zgrep 一律豁免。
//
// 配在 PostToolUse(复刻 dao-glob-gate 已验证的 additionalContext 注入路径)。始终 exit 0,只提醒不阻断。
//
// 真相源:windsurf-dao/ccswitch/hooks/dao-tool-nudge.js
// 由 settings.json 的 PostToolUse hook(matcher: Bash)调用。

const fs = require("fs");

let raw = "";
try { raw = fs.readFileSync(0, "utf8"); } catch (_) {}

let input = {};
try { input = JSON.parse(raw); } catch (_) {}

const toolName = input.tool_name || "";
const cmd = (input.tool_input && input.tool_input.command) || "";

if (toolName !== "Bash" || !cmd) process.exit(0);

// 把命令拆成"命令段":按 ; \n && || 以及单管道 | 切分。
// 切分后,被管道喂入的命令独立成段(段首即 grep/head 等),且不带源文件参数 → 天然豁免。
const segments = cmd.split(/;|\n|&&|\|\|?/);

const hints = new Set();

for (let seg of segments) {
  seg = seg.trim();
  if (!seg) continue;
  // 去掉前导 `cd <path>` 残留(`cd x && grep` 已被 && 拆开,这里兜底 `cd x; grep` 同段情况)
  const s = seg.replace(/^\s*cd\s+[^\s]+\s+/, "");

  // ── grep 搜文件:排除 ripgrep/zgrep/--grep(git);要求段首是 grep 且带文件搜索特征 ──
  if (/^(e?grep|fgrep)\b/.test(s) && !/--grep|\bripgrep\b|\bzgrep\b/.test(s)) {
    const hasFlag = /\s-[a-zA-Z]*[rRl][a-zA-Z]*(\s|$)|\s--(include|exclude|recursive)/.test(s);
    // 文件型参数:含 / 的路径,或形如 name.ext 的文件名(.go/.js/.ts...)
    const hasFileArg = /\s[^\s-][^\s]*\/[^\s]*|\s[^\s-][^\s]*\.[a-zA-Z0-9]{1,6}(\s|$)/.test(s);
    if (hasFlag || hasFileArg) hints.add("grep");
  }

  // ── find 搜文件 ──
  if (/^find\b/.test(s) && /-(name|path|iname|type|exec|maxdepth)\b/.test(s)) {
    hints.add("find");
  }

  // ── cat/head/tail/less/more 直接读文件(段首 + 跟一个文件名,非管道下游)──
  if (/^(cat|head|tail|less|more)\b/.test(s)) {
    const hasFileArg = /\s[^\s-][^\s]*\/[^\s]*|\s[^\s-][^\s]*\.[a-zA-Z0-9]{1,6}(\s|$)/.test(s);
    if (hasFileArg) hints.add("read");
  }
}

if (hints.size === 0) process.exit(0);

const parts = [];
if (hints.has("grep")) parts.push("grep 直接搜文件 → 用内置 Grep(底层 ripgrep,自动跳过 .git/node_modules/二进制,可 glob/type 过滤)");
if (hints.has("find")) parts.push("find 搜文件名 → 用内置 Glob(如 **/*.go);大范围扫荡派 Explore subagent");
if (hints.has("read")) parts.push("cat/head/tail 读文件 → 用内置 Read(可点击跳转,带行号)");

const context =
  "【dao 工具选择】本次 Bash 命令绕过了内置工具:" + parts.join("；") + "。" +
  "内置工具更快、结果可点击、不会把搜索原文撑爆主上下文。下次优先用内置工具;" +
  "仅当内置确实做不到(管道过滤如 `ps | grep`、find -exec、流式处理)才用 shell。";

process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: "PostToolUse",
    additionalContext: context
  }
}));

process.exit(0);
