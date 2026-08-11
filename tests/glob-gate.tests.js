// dao-glob-gate hook 回归网 — 每个行为分支留正控 1 + 负控 1 + mutation 1（判别力）
//
// 钉的是**文案关键词**不是措辞（刻意取舍）：断言钉 `providers` / `settings_config` /
// `每个 provider 都要改` / `镜像层`+`不会生效` / `同一动作内`+`漂移检测`+`不算收尾` 这几个
// 事实锚；换同义词会误红，语义回退成旧路径时会红（下面 mutation 实测过）。
// 刻意不写 `!/direction/` 反向断言：新文案仍点名 direction=down/up，只是把它从「正路」
// 改成「别拿它来让配置生效」——旧说法散在历史文档里，光删不说等于让人再试一次。
//
// 已知不覆盖：本 hook 分不出 live 与项目级 `.claude/settings.json`（故文案必须条件式，
// 下面有断言钉这个措辞）；settings.local.json 归 G2 硬闸、本 hook 不覆盖（按已知边界钉当前
// 行为，不是负控）；注册没注册不在这里验（那取决于用户的 cc-switch provider 配置）。

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
function sha(p) { return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex"); }

// script 缺省=真 hook；mutation 用它指向 _tmp/ 里的副本，从不碰真文件。
function fire(filePath, { tool = "Edit", script = HOOK } = {}) {
  const payload = { tool_name: tool, tool_input: filePath === null ? {} : { file_path: filePath } };
  const r = spawnSync(process.execPath, [script], { input: JSON.stringify(payload), encoding: "utf8" });
  let out = {};
  try { out = JSON.parse(r.stdout || "{}"); } catch (_) { /* 无输出即无提醒 */ }
  return { code: r.status, ctx: String((out.hookSpecificOutput || {}).additionalContext || ""), raw: String(r.stdout || "") };
}

const PRISTINE_SHA = sha(HOOK);
const LIVE = "C:/Users/tester/.claude/settings.json";
const PROJECT = "D:/frank/mousse-cli/.claude/settings.json";

console.log("\n──── ① settings.json 分支（正控，关键词级）────");
{
  const ctx = fire(LIVE).ctx;
  check("正控：live settings.json → 同步提醒 + 真实下发源 providers.settings_config",
    /【dao 同步提醒】/.test(ctx) && /providers/.test(ctx) && /settings_config/.test(ctx),
    JSON.stringify(ctx.slice(0, 260)));
  check("正控：点明每个 provider 都要改 + 快照层/镜像层不会生效",
    /每个 provider 都要改/.test(ctx) && /镜像层/.test(ctx) && /不会生效/.test(ctx),
    JSON.stringify(ctx.slice(0, 300)));
  check("正控：要求同一动作内跑漂移检测收尾（settings-drift.js --providers，不算收尾的兜底不算）",
    /同一动作内/.test(ctx) && /漂移检测/.test(ctx) && /settings-drift\.js/.test(ctx) &&
    /--providers/.test(ctx) && /不算收尾/.test(ctx), JSON.stringify(ctx.slice(-400)));
  // 项目级命中同一分支，文案因此必须条件式——写成无条件断言就是对项目级配置说假话。
  check("正控：项目级 settings.json 同样命中，但文案保持「若这是 live」条件式",
    /【dao 同步提醒】/.test(fire(PROJECT).ctx) && /若这是 live/.test(fire(PROJECT).ctx));
  check("正控：hook 始终 exit 0（只注入不阻断）", fire(LIVE).code === 0);
}

console.log("\n──── ② 其余分支（正控，分支次序 + 关键字）────");
{
  check("正控：ccswitch/dao.md → dao-meta 优先（不叠加仓内同步提醒）",
    /【dao-meta 守卫】/.test(fire("D:/frank/windsurf-dao/ccswitch/dao.md").ctx) &&
    !/仓库文件/.test(fire("D:/frank/windsurf-dao/ccswitch/dao.md").ctx));
  const wd = fire("D:/frank/windsurf-dao/docs/POSITIONING.md").ctx;
  check("正控：windsurf-dao 仓内文件 → 同步提醒（git push 即生效），且仍劝阻 --direction=up",
    /仓库文件/.test(wd) && /git push/.test(wd) && /--direction=up/.test(wd), JSON.stringify(wd.slice(0, 200)));
  const tsx = fire("D:/proj/src/App.tsx").ctx;
  check("正控：.tsx → 质量门与 design 两段同时注入",
    /【dao-quality 质量门】/.test(tsx) && /【dao-design】/.test(tsx));
  check("正控：.ts → 只有质量门，没有 design",
    /【dao-quality 质量门】/.test(fire("D:/proj/src/app.ts").ctx) && !/【dao-design】/.test(fire("D:/proj/src/app.ts").ctx));
}

console.log("\n──── ③ 误伤负控 ────");
{
  check("负控：普通 .md 文件零输出", fire("D:/frank/mousse-cli/README.md").raw.trim() === "");
  check("负控：Read 工具调用一律不响", fire(LIVE, { tool: "Read" }).raw.trim() === "");
  check("负控：没有 file_path → 零输出", fire(null).raw.trim() === "");
}

console.log("\n──── ④ mutation 判别力 ────");
{
  const src = fs.readFileSync(HOOK, "utf8");
  const lines = src.split(/\r?\n/);
  const ctxLineIdx = lines.findIndex((l) => l.includes('context = "【dao 同步提醒】你刚修改了 " + norm'));
  const SETTINGS_RE = /const isSettingsJson = .*;/;
  const settingsReHits = (src.match(new RegExp(SETTINGS_RE.source, "g")) || []).length;
  check("mutation 靶点：settings 分支 context 行与 isSettingsJson 判定行各唯一（锚与 mutation 同源）",
    ctxLineIdx >= 0 && settingsReHits === 1, `idx=${ctxLineIdx} hits=${settingsReHits}`);

  // MUT1 · 整条回退成 #49 证伪前的旧文案（教快照层 + direction=down 是正路）
  {
    const old = '  context = "【dao 同步提醒】你刚修改了 " + norm.split("/").pop() + '
      + '"。若这是 live 那一份，它是 DB 的投影。正道：同步改 git 快照层 config-sync/common/settings.json，'
      + '并提醒用户跑 dao.bat --direction=down（快照到 DB）。";';
    const mutant = path.join(TMP, "mut1-old-wording.js");
    fs.writeFileSync(mutant, lines.map((l, i) => (i === ctxLineIdx ? old : l)).join("\n"), "utf8");
    const ctx = fire(LIVE, { script: mutant }).ctx;
    check("MUT1 canary：变异体仍走同步提醒分支（靶还活着）", /【dao 同步提醒】/.test(ctx));
    check("MUT1：回退旧文案 ⇒ 真实下发源/每 provider/镜像层/漂移收尾 四条锚全红",
      !/providers/.test(ctx) && !/每个 provider 都要改/.test(ctx) && !/镜像层/.test(ctx) &&
      !/同一动作内/.test(ctx));
  }

  // MUT3 · 判定改成永不命中（验证正控真在测这条判定）
  {
    const mutant = path.join(TMP, "mut3-dead-branch.js");
    fs.writeFileSync(mutant, src.replace(
      SETTINGS_RE,
      "const isSettingsJson = /__NEVER_MATCHES__/.test(norm);"
    ), "utf8");
    const dead = fire(LIVE, { script: mutant });
    check("MUT3：判定失效 ⇒ settings.json 掉成零输出", dead.raw.trim() === "");
    check("MUT3 canary：别的分支仍然响 ⇒ 不是整个 hook 崩了",
      /【dao-meta 守卫】/.test(fire("D:/frank/windsurf-dao/ccswitch/dao.md", { script: mutant }).ctx));
  }

  check("canary 恒等：整个 mutation 过程真文件逐字节没动过", sha(HOOK) === PRISTINE_SHA);
}

console.log(`\n=== 汇总: PASS=${pass} FAIL=${fail} ===`);
process.exit(fail ? 1 : 0);
