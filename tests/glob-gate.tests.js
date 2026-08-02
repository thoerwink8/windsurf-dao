// dao-glob-gate hook 回归网 — 四条分支的正控 + 误伤负控 + settings.json 文案钉死 + mutation 判别力
//
// 跑法：node tests/glob-gate.tests.js   （全绿 exit 0，任一红 exit 1）
//
// ── 为什么现在才有这个文件（issue #67）──────────────────────────────────────
// 这个 hook 从建立起**一直零测试**。2026-08-02 修它的 settings.json 分支文案时才发现：
// `tests/` 下没有任何东西盯着它 —— 而这个分支教了很久一条**已被 #49 实测证伪**的路径
// （改 git 快照层 + 跑 `dao.bat --direction=down`，两层都不在下发路径上，照做永不生效）。
// 它的投递面比硬闸 G2 更宽：G2 只在有人写 live 那一份时才打，本 hook 是**任何** settings.json /
// mcp_servers.json 改动后自动注入 additionalContext，不必等谁去读。同一个文件里的
// `isWindsurfDaoFile` 分支注释记着「错误提醒已连续误导三名 subagent 照抄进交付报告」——
// **一条错文案在这个位置是会批量污染交付物的**，所以它值得一份回归网，而不只是一次改对。
//
// ── 钉的是文案关键词，不是措辞（这是刻意取舍，两侧代价都写出来）────────────
// ① 断言钉 `providers` / `settings_config` / `每个 provider 都要改` / `镜像层`+`不会生效` 这几个
//    **事实锚**，不钉整句。改写措辞而语义不变时它不会红；语义被回退成旧路径时它会红（下面三向
//    mutation 实测过）。代价：换同义词（如把「镜像层」写成「common_config_* 那一层」）会误红。
// ② **刻意不写成 `!/direction/` 这种反向断言**：新文案仍然点名 `dao.bat --direction=down/up`，
//    只是把它从「正路」改成「别拿它来让配置生效」——旧说法散在历史文档与 PR body 里，
//    光删不说等于让下一个人再试一次。这与 PR #68 给 G2 stderr 的取舍逐条一致。
//
// ── 已知不覆盖（照直写，别读成全覆盖）──────────────────────────────────────
// · 本 hook 分不出 live `~/.claude/settings.json` 与**项目级** `.claude/settings.json`，两者都命中。
//   故文案必须是条件式的（"若这是 live 那一份"），下面有一条断言钉着这个条件式措辞。
// · `settings.local.json` 不在本 hook 的正则里（G2 硬闸覆盖它，本 hook 不覆盖）——下面按
//   **已知边界**钉住当前行为，不是负控；哪天决定扩覆盖面，改这条断言即可。
// · 本文件只验 hook 自己的输出，**不验它在 live settings.json 里注册没注册**（那取决于用户的
//   cc-switch provider 配置，锚死会让测试随用户配置变红）。注册面归 dead-gates / settings-drift。

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

const REPO = path.resolve(__dirname, "..");
const HOOK = path.join(REPO, "ccswitch", "hooks", "dao-glob-gate.js");
const TMP = path.join(REPO, "_tmp", "glob-gate-tests");

fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? "  →  " + detail : ""}`); }
}

function sha(p) {
  return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
}

// 喂一次 PostToolUse 输入，返回注入的 additionalContext（没注入则空串）。
// script 缺省=真 hook；mutation 用它指向 _tmp/ 里的副本，从不碰真文件。
function fire(filePath, { tool = "Edit", script = HOOK } = {}) {
  const payload = { tool_name: tool, tool_input: filePath === null ? {} : { file_path: filePath } };
  const r = spawnSync(process.execPath, [script], { input: JSON.stringify(payload), encoding: "utf8" });
  let out = {};
  try { out = JSON.parse(r.stdout || "{}"); } catch (_) { /* 无输出即无提醒 */ }
  const hs = out.hookSpecificOutput || {};
  return { code: r.status, ctx: String(hs.additionalContext || ""), raw: String(r.stdout || "") };
}

const PRISTINE_SHA = sha(HOOK);

// ── settings.json 分支的四条事实锚（正文与 mutation 共用同一组判据，免得两处漂移）──
const anchors = {
  真实下发源: (c) => /providers/.test(c) && /settings_config/.test(c),
  每个provider都要改: (c) => /每个 provider 都要改/.test(c),
  旧路径明说不生效: (c) => /镜像层/.test(c) && /不会生效/.test(c),
  条件式措辞: (c) => /若这是 live/.test(c),
};

console.log("\n──── ① settings.json / mcp_servers.json 分支 · 新文案钉死（issue #67 的本体）────");
{
  const cases = [
    ["live 正斜杠", "C:/Users/tester/.claude/settings.json"],
    ["live 反斜杠（Windows 原生形态）", "C:\\Users\\tester\\.claude\\settings.json"],
    ["mcp_servers.json 同分支", "C:/Users/tester/.claude/mcp_servers.json"],
    ["项目级 .claude/settings.json 同样命中（本 hook 分不出 live 与项目级）", "D:/frank/mousse-cli/.claude/settings.json"],
  ];
  for (const [name, p] of cases) {
    const { ctx } = fire(p);
    check(`正控：${name} → 走同步提醒分支`, /【dao 同步提醒】/.test(ctx), JSON.stringify(ctx.slice(0, 60)));
    check(`正控：${name} 指出真实下发源 providers.settings_config`,
      anchors.真实下发源(ctx), JSON.stringify(ctx.slice(0, 260)));
    check(`正控：${name} 点明每个 provider 都要改（只改一个等于没改）`,
      anchors.每个provider都要改(ctx), JSON.stringify(ctx.slice(0, 260)));
    check(`正控：${name} 明说快照层/镜像层不会生效（旧「正路」已被 #49 证伪）`,
      anchors.旧路径明说不生效(ctx), JSON.stringify(ctx.slice(-300)));
  }

  // 条件式措辞是硬要求，不是客套：正则对项目级 .claude/settings.json 同样命中，
  // 写成无条件断言就等于对项目级配置说了一句假话。
  check("正控：文案对「是不是 live 那一份」保持条件式，不做无条件断言",
    anchors.条件式措辞(fire("D:/frank/mousse-cli/.claude/settings.json").ctx));

  // 判据指针（不复述正文）+ 长期对齐机制的挂账编号，两者都是这段话的可复核出处
  const ctx = fire("C:/Users/tester/.claude/settings.json").ctx;
  check("正控：给出判据指针（dao.md「改配置先认源与投影」），不复述正文",
    /改配置先认源与投影/.test(ctx), JSON.stringify(ctx.slice(-200)));
  check("正控：per-provider 漂移挂着可查的 issue 编号（#50）", /issue #50/.test(ctx));
  check("正控：点明写 DB 属用户动作（AI 侧被权限分类器拦）",
    /用户动作/.test(ctx) && /权限分类器/.test(ctx), JSON.stringify(ctx.slice(0, 300)));
  check("hook 始终 exit 0（只注入不阻断）", fire("C:/Users/tester/.claude/settings.json").code === 0);
}

console.log("\n──── ② 其余三条分支不受本次改动波及（证明改的只是一段话）────");
{
  const daoMeta = [
    ["ccswitch/dao.md", "D:/frank/windsurf-dao/ccswitch/dao.md"],
    ["ccswitch/skills/dao-*", "D:/frank/windsurf-dao/ccswitch/skills/dao-design/SKILL.md"],
    [".windsurf/rules/", "D:/frank/proj/.windsurf/rules/quality.md"],
  ];
  for (const [name, p] of daoMeta) {
    check(`正控：${name} → dao-meta 三关`, /【dao-meta 守卫】/.test(fire(p).ctx), JSON.stringify(fire(p).ctx.slice(0, 60)));
  }
  check("分支次序：ccswitch/dao.md 同时满足 dao-meta 与 windsurf-dao，dao-meta 优先",
    !/仓库文件/.test(fire("D:/frank/windsurf-dao/ccswitch/dao.md").ctx));

  const wd = fire("D:/frank/windsurf-dao/docs/POSITIONING.md").ctx;
  check("正控：windsurf-dao 仓内文件 → 同步提醒（提交并 push 即生效）",
    /仓库文件/.test(wd) && /git push/.test(wd), JSON.stringify(wd.slice(0, 80)));
  check("正控：windsurf-dao 分支仍在劝阻 --direction=up（本单不动它，钉住免得被顺手改掉）",
    /--direction=up/.test(wd), JSON.stringify(wd.slice(0, 200)));

  check("正控：.ts → 只有质量门，没有 design",
    /【dao-quality 质量门】/.test(fire("D:/proj/src/app.ts").ctx) && !/【dao-design】/.test(fire("D:/proj/src/app.ts").ctx));
  check("正控：.tsx → 质量门与 design 两段同时注入",
    /【dao-quality 质量门】/.test(fire("D:/proj/src/App.tsx").ctx) && /【dao-design】/.test(fire("D:/proj/src/App.tsx").ctx));
  check("正控：.css → 只有 design，没有质量门",
    /【dao-design】/.test(fire("D:/proj/src/app.css").ctx) && !/【dao-quality 质量门】/.test(fire("D:/proj/src/app.css").ctx));
  check("正控：Write / MultiEdit 与 Edit 同样触发",
    /【dao 同步提醒】/.test(fire("C:/Users/t/.claude/settings.json", { tool: "Write" }).ctx) &&
    /【dao 同步提醒】/.test(fire("C:/Users/t/.claude/settings.json", { tool: "MultiEdit" }).ctx));
}

console.log("\n──── ③ 误伤负控 / 已知边界 ────");
{
  const negatives = [
    ["普通 .md 文件不该提醒", "D:/frank/mousse-cli/README.md"],
    ["普通 .json 文件不该提醒", "D:/frank/mousse-cli/package.json"],
    ["非写入工具（Read）一律不响", "C:/Users/t/.claude/settings.json", { tool: "Read" }],
    ["Bash 工具不该走这个 hook", "C:/Users/t/.claude/settings.json", { tool: "Bash" }],
  ];
  for (const [name, p, opts] of negatives) {
    check(`负控：${name}`, fire(p, opts || {}).raw.trim() === "", JSON.stringify(fire(p, opts || {}).raw.slice(0, 80)));
  }
  check("负控：没有 file_path → 零输出", fire(null).raw.trim() === "");

  check("负控：windsurf-dao/node_modules 下的文件不走仓内同步分支（走质量门）",
    !/仓库文件/.test(fire("D:/frank/windsurf-dao/node_modules/x/index.js").ctx) &&
    /【dao-quality 质量门】/.test(fire("D:/frank/windsurf-dao/node_modules/x/index.js").ctx));
  check("负控：windsurf-dao/_tmp 下的文件不走仓内同步分支",
    !/仓库文件/.test(fire("D:/frank/windsurf-dao/_tmp/scratch.md").ctx));

  // 已知边界（不是负控）：G2 硬闸拦 settings.local.json，本 hook 的正则不认它。
  // 钉住当前行为是为了让「哪天有人扩了覆盖面」这件事被看见，不是主张这个边界一定对。
  check("已知边界：settings.local.json 不命中本 hook（G2 硬闸覆盖它，本 hook 不覆盖）",
    fire("C:/Users/t/.claude/settings.local.json").raw.trim() === "");
}

console.log("\n──── ④ mutation 判别力（三向）· 每向先 canary 确认靶还活着 ────");
{
  const src = fs.readFileSync(HOOK, "utf8");
  const SETTINGS_PATH = "C:/Users/tester/.claude/settings.json";

  // 靶点唯一性先断言：锚点漂移导致的 replace 落空，表现与「文案已经不在了」不可区分，
  // 而那正是 PR #68 记下的那个坑（静默 ANCHOR MISS）。
  const lines = src.split(/\r?\n/);
  const ctxLineIdx = lines.findIndex((l) => l.includes('context = "【dao 同步提醒】你刚修改了 " + norm'));
  check("mutation 靶点①：settings 分支的 context 赋值行在源码里唯一存在",
    ctxLineIdx >= 0 && lines.filter((l) => l.includes('context = "【dao 同步提醒】你刚修改了 " + norm')).length === 1,
    `idx=${ctxLineIdx}`);
  const PROVIDER_CLAUSE = "**且每个 provider 都要改**";
  check("mutation 靶点②：「每个 provider 都要改」在源码里唯一存在",
    src.split(PROVIDER_CLAUSE).length === 2, `出现 ${src.split(PROVIDER_CLAUSE).length - 1} 次`);
  const SETTINGS_RE_LINE = "const isSettingsJson =";
  check("mutation 靶点③：isSettingsJson 判定行在源码里唯一存在",
    src.split(SETTINGS_RE_LINE).length === 2, `出现 ${src.split(SETTINGS_RE_LINE).length - 1} 次`);

  // MUT1 · 整条回退成 #49 证伪前的旧文案（教快照层 + direction=down 是正路）
  {
    const old = '  context = "【dao 同步提醒】你刚修改了 " + norm.split("/").pop() + '
      + '"。若这是 live 那一份，它是 DB 的投影。正道：同步改 git 快照层 config-sync/common/settings.json，'
      + '并提醒用户跑 dao.bat --direction=down（快照到 DB）。";';
    const mutant = path.join(TMP, "mut1-old-wording.js");
    fs.writeFileSync(mutant, lines.map((l, i) => (i === ctxLineIdx ? old : l)).join("\n"), "utf8");
    const { ctx } = fire(SETTINGS_PATH, { script: mutant });
    check("MUT1 canary：变异体仍跑得起来、仍走同步提醒分支（不是把靶弄死了）",
      /【dao 同步提醒】/.test(ctx), JSON.stringify(ctx.slice(0, 80)));
    check("MUT1：回退旧文案 ⇒「真实下发源」断言变红", !anchors.真实下发源(ctx));
    check("MUT1：回退旧文案 ⇒「每个 provider 都要改」断言变红", !anchors.每个provider都要改(ctx));
    check("MUT1：回退旧文案 ⇒「旧路径明说不生效」断言变红", !anchors.旧路径明说不生效(ctx));
  }

  // MUT2 · 只删掉「且每个 provider 都要改」一句（证明三条断言不是同义反复）
  {
    const mutant = path.join(TMP, "mut2-drop-per-provider.js");
    fs.writeFileSync(mutant, src.replace(PROVIDER_CLAUSE, ""), "utf8");
    const { ctx } = fire(SETTINGS_PATH, { script: mutant });
    check("MUT2 canary：变异体仍走同步提醒分支", /【dao 同步提醒】/.test(ctx), JSON.stringify(ctx.slice(0, 80)));
    check("MUT2：只有「每个 provider 都要改」这一条红", !anchors.每个provider都要改(ctx));
    check("MUT2：另两条仍绿 ⇒ 三条断言覆盖面不同，不是同义反复",
      anchors.真实下发源(ctx) && anchors.旧路径明说不生效(ctx), JSON.stringify(ctx.slice(0, 260)));
  }

  // MUT3 · 把判定改成永不命中（本批一个字符没动它，这一向是给判定逻辑留的回归网）
  {
    const mutant = path.join(TMP, "mut3-dead-branch.js");
    fs.writeFileSync(mutant, src.replace(
      /const isSettingsJson = .*;/,
      "const isSettingsJson = /__NEVER_MATCHES__/.test(norm);"
    ), "utf8");
    const dead = fire(SETTINGS_PATH, { script: mutant });
    check("MUT3：判定失效 ⇒ settings.json 掉成零输出（上面那批正控真的在测这条判定）",
      dead.raw.trim() === "", JSON.stringify(dead.raw.slice(0, 80)));
    check("MUT3 canary：别的分支仍然响 ⇒ 不是整个 hook 崩了",
      /【dao-meta 守卫】/.test(fire("D:/frank/windsurf-dao/ccswitch/dao.md", { script: mutant }).ctx));
  }

  check("canary 恒等：整个 mutation 过程真文件逐字节没动过", sha(HOOK) === PRISTINE_SHA);
}

console.log(`\n=== 汇总: PASS=${pass} FAIL=${fail} ===`);
process.exit(fail ? 1 : 0);
