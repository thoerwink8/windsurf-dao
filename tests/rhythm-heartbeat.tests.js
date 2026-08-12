// 心跳唤醒的投递点：定时唤醒醒来的那一轮，留守四句真的被注进去了。
//
// 守的对象：ccswitch/hooks/dao-rhythm.js（UserPromptSubmit 事件）。
// 它失效的样子是**静默的**——不注入与「注入了但没照做」在日志上、退出码上长得一模一样，
// 而心跳轮是这份载荷唯一的投递时刻：用户已经去睡了，没有别人会在那一刻把它递过来。
//
// 四条断言，缺哪一条都证明不了什么：
//   ① 正控：`[dao-heartbeat]` 开头的 prompt ⇒ 有注入，且取证串在里面
//   ② 正控：注入内容指向的那份手册**真的存在**——指向空气的指针比没有指针更糟
//   ③ 判别力负控：普通 prompt ⇒ **不**注入。没有它，「恒注入」也能让 ①② 变绿
//   ④ mutation：把心跳签名改成永不命中 ⇒ 正控从「注入」掉到「不注入」。
//      没有 mutation 的正控只证明今天是绿的，证明不了它明天变坏时会红。
//
// 全程沙盒化：mutation 跑的是复制到临时目录的副本，仓里那份一个字节不碰。

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const REPO = path.resolve(__dirname, "..");
const HOOK = path.join(REPO, "ccswitch", "hooks", "dao-rhythm.js");
const SANDBOX = path.join(os.tmpdir(), `dao-rhythm-${process.pid}-${Math.random().toString(36).slice(2)}`);

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? "  →  " + detail : ""}`); }
}

/** 跑一次 hook，返回它写到 stdout 的东西（没有注入就是空串）。 */
function run(prompt, hookPath) {
  const r = spawnSync(process.execPath, [hookPath || HOOK], {
    input: JSON.stringify({ prompt }),
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(`hook 退出码 ${r.status}，它契约上恒 0：${r.stderr}`);
  return r.stdout || "";
}

function injected(out) {
  if (!out.trim()) return null;
  try { return JSON.parse(out).hookSpecificOutput.additionalContext; } catch (_) { return null; }
}

console.log("=== ① 正控：心跳轮真的被注入了 ===");
const hit = injected(run("[dao-heartbeat] 醒了，对账。"));
check("心跳 prompt ⇒ 有注入", !!hit, JSON.stringify(hit));
check("注入里带取证串（要问「送到没有」靠 Grep 它，不靠自陈）",
  !!hit && hit.includes("[dao-rhythm WAKEUP v1]"));
check("留守四句都在（防停摆 / 简报铁序 / 水位线 / 自主边界）",
  !!hit && ["防停摆", "简报", "水位", "自主边界"].every((k) => hit.includes(k)));

console.log("\n=== ② 注入里那个指针，指得到一份真的手册 ===");
{
  const m = hit && hit.match(/Read `([^`]+)`/);
  check("注入里有一条 Read 指令", !!m, hit ? hit.slice(0, 120) : "(无注入)");
  const target = m ? path.join(REPO, m[1]) : null;
  check(`指针落点存在（${m ? m[1] : "?"}）`, !!target && fs.existsSync(target), target || "");
}

console.log("\n=== ③ 判别力负控：普通一轮不许被打扰 ===");
check("普通 prompt ⇒ 零注入", !injected(run("帮我看一下这个函数")));
check("签名不在行首（只是提到它）⇒ 零注入", !injected(run("我刚才看到 [dao-heartbeat] 这个串")));

console.log("\n=== ④ mutation：把心跳签名改成永不命中 ⇒ 正控必须掉绿 ===");
{
  fs.mkdirSync(SANDBOX, { recursive: true });
  const mutated = path.join(SANDBOX, "dao-rhythm.mutated.js");
  const SRC = fs.readFileSync(HOOK, "utf8");
  const ANCHOR = /const HEARTBEAT_SIG = \/\^\\\[dao-heartbeat\\\]\/;/;
  check("mutation 锚点命中（锚点落空时变异体等于原文，那与「守卫没塌陷」逐字节相同）",
    ANCHOR.test(SRC));
  const body = SRC.replace(ANCHOR, "const HEARTBEAT_SIG = /^\\[never-matches-anything\\]/;");
  check("变异体与原文不同（改到了）", body !== SRC);
  fs.writeFileSync(mutated, body, "utf8");

  // 先确认变异体还活着：它得跑得起来、只是行为被改。
  check("变异体还活着（负控仍是零注入，不是整个崩了）", !injected(run("帮我看一下这个函数", mutated)));
  check("变异体下正控掉绿 ⇒ 这条断言真的守着心跳签名", !injected(run("[dao-heartbeat] 醒了。", mutated)));

  fs.rmSync(SANDBOX, { recursive: true, force: true });
}

console.log(`\n${fail === 0 ? "好的" : "不好"}：${pass} 条绿 / ${fail} 条红`);
process.exit(fail === 0 ? 0 : 1);
