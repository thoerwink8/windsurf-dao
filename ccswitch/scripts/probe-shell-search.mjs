#!/usr/bin/env node
/**
 * probe-shell-search.mjs — 「哪些搜索/读文件命令会被拦、被谁拦」的**实测**探针
 *
 * 跑法：node ccswitch/scripts/probe-shell-search.mjs
 * 退出码：恒 0。**它不是闸**（故意不叫 `check-*`）——它不判红绿、不参与任何验证入口，
 *         只把两层拦截此刻的实况打印出来，供人读。
 *
 * ── 为什么有这个文件（issue #110）────────────────────────────────────────────
 * 用户级 `CLAUDE.md` 里曾写着一句「`permissions.deny` 已 deny 掉 `Bash(grep:*)`…」，
 * 自 2026-08-02 G7 上线、grep 被从 deny 摘掉那一刻起**即为假**，而它住在 always-on
 * 文件里、每轮注入给包括 subagent 在内的所有人。同型前科：mousse `CLAUDE.md` 的
 * 「CI 交叉构建保编译通过」自 2026-07-10 起为假、17 天无人订正。
 *
 * **病根不是那句话写错了，是「覆盖面」这种会变的事实被写成了散文里的静态断言。**
 * 处方因此不是「把那句话改对」，而是**让它可以被重新问出来** —— 本探针就是那个提问动作。
 * 配套的人读版覆盖面表在 `ccswitch/rules/dao-shell-search.md`，那张表的每一行都指回这里。
 *
 * ── 射程，照直写（本探针答得了什么、答不了什么）──────────────────────────────
 * ✅ 答得了：**G7 拦不拦**。判据取自闸本身的退出码（2=拦 / 0=放行）与 stderr 里的闸 id，
 *    中间没有插入任何本文件自己写的正则去「解析」它 —— dao-hard-gates 头注 G7 ㈤ 记过
 *    一次教训：测一道闸时中间插一条自己写的正则，那条正则就成了新的被测对象而没人测它。
 * ❌ 答不了：**`permissions.deny` 拦不拦**。deny 是宿主权限层，hook 进程结构上看不见它。
 *    那一半只能 ①读 live `~/.claude/settings.json` 的 `permissions.deny`
 *    ②真跑一条命令撞一次（最快、最硬，见 rules 档「最快的一验」）。
 * ⚠️ live settings.json 是**投影不是源**：源是 cc-switch DB 的 `providers.settings_config`，
 *    **切一次 provider 就整体覆盖一次** ⇒ 本探针读到的 deny 只代表此刻。
 * ⚠️ 本探针测的是**它自己这棵树里**那份 hook（路径相对自身解析）。在 worktree 里跑就是在测
 *    worktree 那一份，而**真正挂在 PreToolUse 上的是 settings.json 里写死的那条绝对路径**
 *    （本机指向主仓）。两者不同时，下表说的是你手上这份代码，不是此刻在守的那一份。
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.resolve(HERE, "..", "hooks", "dao-hard-gates.js");
const SETTINGS = path.join(os.homedir(), ".claude", "settings.json");

/** [工具, 命令, 这一格在验什么] */
const CASES = [
  ["Bash", 'grep -rn "foo" src/', "grep 段首"],
  ["Bash", 'find . -name "*.ts"', "find 段首"],
  ["Bash", "rg foo src/", "rg 段首"],
  ["Bash", "ag foo src/", "ag 段首"],
  ["Bash", "ack foo src/", "ack 段首"],
  ["Bash", "sed -n '1,20p' f.txt", "sed 段首"],
  ["Bash", "awk '{print $1}' f.txt", "awk 段首 —— 两层都不收，见 rules 档「一格照直写」"],
  ["Bash", "cat f.txt", "cat 段首"],
  ["Bash", "head -20 f.txt", "head 段首"],
  ["Bash", "tail -50 f.txt", "tail 段首"],
  ["Bash", "ls -la src/", "ls 段首（刻意不收，头注 G7 ㈢）"],
  ["Bash", "wc -l f.txt", "wc 段首（刻意不收，头注 G7 ㈢）"],
  ["PowerShell", "Select-String -Pattern foo -Path f.txt", "Select-String 段首"],
  ["PowerShell", "$m = Select-String -Pattern foo -Path f.txt", "PS 赋值式段首"],
  ["PowerShell", "Get-Content f.txt", "Get-Content（刻意不收，头注 G7 ㈦）"],
  ["PowerShell", "($x | ConvertTo-Json) | Select-String -SimpleMatch 'foo'", "管道位 Select-String —— G7 豁免而 deny 照拦，两层分歧的实证"],
  ["Bash", "node t.js | grep FAIL", "管道位 grep（豁免①）"],
  ["Bash", "grep -rn foo src/ > out.txt", "stdout 落真实文件（豁免②）"],
  ["Bash", "tail -f server.log", "tail -f 流式（豁免④）"],
  ["Bash", "head -c 200 blob.bin", "head -c 字节模式（豁免⑤）"],
  ["Bash", "git log --grep=fix", "段首是 git，天然豁免"],
];

if (!fs.existsSync(HOOK)) {
  process.stdout.write(`[probe-shell-search] ⚠ 找不到闸本体：${HOOK}\n` +
    `⇒ 下表无从测起。这不是「没有违例」，是**探针瞎了**——先修路径再读结论。\n`);
  process.exit(0);
}

const rows = CASES.map(([tool, command, note]) => {
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ tool_name: tool, tool_input: { command } }),
    encoding: "utf8",
    // 逃生阀显式清空：否则调用者环境里若设了它，整张表会全绿而看不出原因
    env: { ...process.env, DAO_SHELL_SEARCH_OK: "" },
  });
  const gate = (String(r.stderr || "").match(/dao-hard-gates (G\d[\w-]*)/) || [])[1] || "";
  return { tool, command, note, code: r.status, gate };
});

// 自检半边：这张表**必须两种结果都有**。全拦或全放行都说明探针本身出了问题
// （闸没接上 / 逃生阀开着 / 输入格式变了），而那两种情况与「实况如此」在输出上长得一样。
const blocked = rows.filter((r) => r.code === 2).length;
const allowed = rows.filter((r) => r.code === 0).length;
const sane = blocked > 0 && allowed > 0;

const pad = (s, n) => String(s) + " ".repeat(Math.max(0, n - [...String(s)].length));
process.stdout.write(`\n=== G7 实测：哪些命令被闸拦下 ===\n  闸本体 ${HOOK}\n\n`);
process.stdout.write(`  ${pad("结果", 10)}${pad("闸 id", 18)}${pad("工具", 12)}命令\n`);
for (const r of rows) {
  process.stdout.write(`  ${pad(r.code === 2 ? "🔒 拦下" : "→ 放行", 10)}${pad(r.gate || "—", 18)}${pad(r.tool, 12)}${r.command}\n`);
  process.stdout.write(`  ${pad("", 10)}${pad("", 18)}${pad("", 12)}〔${r.note}〕\n`);
}

// deny 那一半：只读投影，不做判断——本探针无权代替宿主宣布「这条会不会被 deny」
let denyLine = "读不到";
try {
  const s = JSON.parse(fs.readFileSync(SETTINGS, "utf8"));
  const d = (s.permissions && s.permissions.deny) || [];
  denyLine = d.length ? `${d.length} 条：${d.join(" · ")}` : "0 条（护栏此刻不在）";
} catch (e) {
  denyLine = `读不到（${e && e.message}）`;
}
process.stdout.write(`\n=== permissions.deny 实况（**投影**，源是 cc-switch DB 的 providers.settings_config）===\n`);
process.stdout.write(`  ${SETTINGS}\n  ${denyLine}\n`);
process.stdout.write(`  ⚠ 本探针**测不了 deny 会不会真的拦** —— 它只是把清单读出来。要硬证据就真跑一条撞它。\n`);

process.stdout.write(`\n  自检：${sane ? "ok（拦/放行两种结果都出现了）" : "⚠ 可疑——全拦或全放行，多半是闸没接上或逃生阀开着，别读上表结论"}\n`);
process.stdout.write(`PROBE_SHELL_SEARCH_SUMMARY exit=0 blocked=${blocked} allowed=${allowed} total=${rows.length} deny=${denyLine.split("：")[0]} selfcheck=${sane ? "ok" : "suspect"}\n`);
process.exit(0);
