// 专注/值守三态状态机 · 回归网（issue #488）
//
// 验两个部件：
//   ① host/skills/dao-mode/hooks/dao-mode.mjs —— 态的读写与每轮注入文本。重点不是「能不能切态」，
//      而是三条硬规矩：四种结局各自不同形（常态 / 非常态 / 文件不在 / 文件坏了）、
//      失效方向朝安全一侧（hook 永远 exit 0）、连续第二次偏离才升级为弹确认。
//   ② scripts/lib/dao-mode-hook-check.mjs —— dao-check 第 ⑧ 项的判别力。这里拿假 HOME
//      故意造违规样本（没注册 / 断链 / 输出恒定 / settings 坏了），每一种都必须报红。
//      不这么验，就只能证明「装过」，证明不了「被覆盖时会叫」。
//
// 判别力自检问句：把 hook 从 settings 里删掉、把 symlink 断开、把输出写死成一句话，
// 这三件事里任何一件发生，下面是否都至少有一条断言变红？
//
// 状态文件一律走 DAO_STATE_FILE 指到沙箱，DAO_NO_ORCA=1 关掉态标——本测试不碰
// 本机 ~/.claude/state.json，也不改任何 Orca 卡片。

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const REPO = path.resolve(__dirname, "..");
const SKILL_DIR = path.join(REPO, "host", "skills", "dao-mode");
const HOOK = path.join(SKILL_DIR, "hooks", "dao-mode.mjs");
const SANDBOX = path.join(REPO, "_tmp", "mode-sandbox");

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? "  →  " + detail : ""}`); }
}

fs.rmSync(SANDBOX, { recursive: true, force: true });
fs.mkdirSync(SANDBOX, { recursive: true });

const STATE = path.join(SANDBOX, "state.json");

/** 跑 dao-mode.mjs 的一个子命令，状态文件固定指向沙箱。 */
function mode(args, opts = {}) {
  const r = spawnSync(process.execPath, [HOOK, ...args], {
    encoding: "utf8",
    input: opts.input === undefined ? "" : opts.input,
    env: { ...process.env, DAO_STATE_FILE: opts.state || STATE, DAO_NO_ORCA: "1" },
  });
  return { status: r.status, out: (r.stdout || "") + (r.stderr || ""), stdout: r.stdout || "" };
}

function injection(promptText, state) {
  return mode(["hook"], { input: JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: promptText }), state });
}

console.log("\n=== ① 四种结局各自不同形（规格要的三形 + 「读坏了」单列）===");
{
  // ③ 文件压根不在
  const absent = injection("随便一句", path.join(SANDBOX, "不存在.json"));
  check("文件不在 ⇒ 明说「状态文件不在，一个字都没读到」", /状态文件不在/.test(absent.out), absent.out.slice(0, 120));
  check("文件不在 ⇒ 退出码 0（没读到是降级不是错误）", absent.status === 0, `status=${absent.status}`);
  check("文件不在 ⇒ 不冒充常态", !/常态 · 无锁/.test(absent.out), absent.out.slice(0, 120));

  // ④ 文件在但用不了——和 ③ 是两件事，不许合并
  const brokenPath = path.join(SANDBOX, "broken.json");
  fs.writeFileSync(brokenPath, "{oops", "utf8");
  const broken = injection("x", brokenPath);
  check("文件坏了 ⇒ 明说「读到了但用不了」并带原因", /读到了但用不了/.test(broken.out) && /JSON 解析失败/.test(broken.out), broken.out.slice(0, 140));
  check("文件坏了 ≠ 文件不在（两种降级分得开）", !/状态文件不在/.test(broken.out) && broken.out.trim() !== absent.out.trim(), broken.out.slice(0, 140));

  const aliasPath = path.join(SANDBOX, "alien.json");
  fs.writeFileSync(aliasPath, JSON.stringify({ mode: "睡了" }), "utf8");
  const alien = injection("x", aliasPath);
  check("mode 字段不认识 ⇒ 归「读到了但用不了」，不猜也不冒充没读到", /读到了但用不了/.test(alien.out) && !/状态文件不在/.test(alien.out), alien.out.slice(0, 140));

  // ① 读到了且是常态
  mode(["normal"]);
  const normal = injection("随便一句");
  check("常态 ⇒ 明说「已读到」", /常态 · 无锁/.test(normal.out) && /已读到/.test(normal.out), normal.out.slice(0, 120));

  // ② 读到了且非常态
  mode(["focus", "--what", "#四形自检", "--done-when", "验完"]);
  const engaged = injection("随便一句");
  check("非常态 ⇒ 出的是态块不是一行常态", /━━ 当前态/.test(engaged.out) && !/常态 · 无锁/.test(engaged.out), engaged.out.slice(0, 120));

  const shapes = { "常态": normal.out.trim(), "非常态": engaged.out.trim(), "文件不在": absent.out.trim(), "文件坏了": broken.out.trim() };
  const names = Object.keys(shapes);
  let allDistinct = true, dup = "";
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      if (shapes[names[i]] === shapes[names[j]]) { allDistinct = false; dup = `${names[i]}==${names[j]}`; }
    }
  }
  check("四形两两不同（任何两形被合并都在这里红）", allDistinct, dup);
  mode(["normal"]);
}

console.log("\n=== ② hook 路径永不把用户锁死（失效方向朝安全一侧）===");
{
  for (const [label, input] of [["空 stdin", ""], ["不是 JSON", "hello"], ["JSON 但没 prompt", "{}"]]) {
    const r = mode(["hook"], { input, state: path.join(SANDBOX, "不存在.json") });
    check(`${label} ⇒ 仍 exit 0 且有输出`, r.status === 0 && r.stdout.trim().length > 0, `status=${r.status} out=${r.stdout.slice(0, 60)}`);
  }
  // 退出码 2 会让宿主拦下用户这一轮的 prompt。hook 路径永远不许走到 2。
  const r = mode(["hook"], { input: "{}" });
  check("hook 退出码不是 2（2 会拦下用户的 prompt）", r.status !== 2, `status=${r.status}`);
}

console.log("\n=== ③ 进专注：两道追问一道都不能删 ===");
{
  const noDone = mode(["focus", "--what", "#488"]);
  check("只给焦点不给退出判据 ⇒ 拒绝（exit 2）", noDone.status === 2, `status=${noDone.status}`);
  const noWhat = mode(["focus", "--done-when", "合并"]);
  check("只给退出判据不给焦点 ⇒ 拒绝（exit 2）", noWhat.status === 2, `status=${noWhat.status}`);

  const ok = mode(["focus", "--what", "#488 状态机", "--done-when", "PR #490 合并"]);
  check("两道都给 ⇒ 进得去", ok.status === 0 && /已进入专注/.test(ok.out), ok.out.slice(0, 80));
  const doc = JSON.parse(fs.readFileSync(STATE, "utf8"));
  check("state.json 字段自解释（mode/focus.what/focus.doneWhen）",
    doc.mode === "focus" && doc.focus.what === "#488 状态机" && doc.focus.doneWhen === "PR #490 合并",
    JSON.stringify(doc).slice(0, 120));

  const inj = injection("继续干 #488");
  check("专注注入带焦点原文", inj.out.includes("#488 状态机"));
  check("专注注入带退出判据", inj.out.includes("PR #490 合并"));
  check("专注注入自带违背判据（不靠 skill 正文）", /只有「用户指派一个新的工作对象」才算偏离/.test(inj.out));
  check("专注注入说明第一次偏离该怎么办", /照办/.test(inj.out) && /焦点仍锁/.test(inj.out));
}

console.log("\n=== ④ 偏离：第一次照办，连续第二次才弹确认 ===");
{
  const first = injection("顺手看下 #999 的登录 bug");
  check("streak=0 时注入的是「照办 + 挂提示行」", /offTopicStreak=0/.test(first.out) && !/不要直接照办/.test(first.out), first.out.slice(0, 200));
  check("prompt 里出现别的编号 ⇒ 注入里点名提醒去判断", first.out.includes("#999"), first.out.slice(0, 300));

  const d1 = mode(["drift", "--what", "#999 登录 bug"]);
  check("记一次偏离 ⇒ 计数 1，仍是照办", /连续偏离 1 次/.test(d1.out) && /照办/.test(d1.out), d1.out.slice(0, 100));

  const second = injection("再顺手看下 #1000");
  check("streak=1 时注入改口为「不要直接照办」", /不要直接照办/.test(second.out), second.out.slice(0, 300));
  check("streak=1 时注入要求调 skill 让用户拍板", /`\/dao-mode`/.test(second.out) && /拍板/.test(second.out));
  check("两种 streak 下注入不同形", first.out.trim() !== second.out.trim());

  const d2 = mode(["drift", "--what", "#1000"]);
  check("第二次偏离 ⇒ 命令自己也改口要求弹确认", /连续偏离 2 次/.test(d2.out) && /拍板/.test(d2.out), d2.out.slice(0, 120));

  const cleared = mode(["clear-drift"]);
  check("用户判「只是插曲」⇒ 计数归零", /归零/.test(cleared.out) && JSON.parse(fs.readFileSync(STATE, "utf8")).offTopicStreak === 0);

  // 换焦点也要把计数清掉，否则新焦点一上来就欠着旧账。
  mode(["drift", "--what", "旧账"]);
  mode(["focus", "--what", "#500 新焦点", "--done-when", "跑通"]);
  check("换焦点 ⇒ 偏离计数归零", JSON.parse(fs.readFileSync(STATE, "utf8")).offTopicStreak === 0);
}

console.log("\n=== ⑤ 暂存队列：进去攒，出来回放 ===");
{
  mode(["park", "--what", "用户提的 #493 想法"]);
  mode(["park", "--what", "另一个念头"]);
  const doc = JSON.parse(fs.readFileSync(STATE, "utf8"));
  check("park 攒进 state.json 且带时间", doc.parked.length === 2 && !!doc.parked[0].at, JSON.stringify(doc.parked).slice(0, 120));
  const out = mode(["normal"]);
  check("退出时把队列逐条回放", /暂存队列 2 条/.test(out.out) && out.out.includes("#493") && out.out.includes("另一个念头"), out.out.slice(0, 200));
  check("退出后回常态", JSON.parse(fs.readFileSync(STATE, "utf8")).mode === "normal");
  const empty = mode(["normal"]);
  check("队列空时明说空（不与「有队列」同形）", /暂存队列：空/.test(empty.out), empty.out.slice(0, 120));
  const driftInNormal = mode(["drift", "--what", "x"]);
  check("常态下记偏离 ⇒ 说没有焦点可偏离，不乱记账", /没有焦点可偏离/.test(driftInNormal.out), driftInNormal.out.slice(0, 100));
}

console.log("\n=== ⑥ 值守：只问授权边界，行为规范不复述 ===");
{
  const r = mode(["standby", "--what", "#488", "--decide", "选型；改动方案", "--hold", "合并 master；对外发布"]);
  check("进得去值守", r.status === 0 && /已进入值守/.test(r.out), r.out.slice(0, 80));
  const inj = injection("我睡了");
  check("值守注入带授权边界", /可以自己拍/.test(inj.out) && /恒挂起等用户/.test(inj.out), inj.out.slice(0, 300));
  check("值守注入指向 CLAUDE.md 而不是复述规范", /全局 CLAUDE\.md/.test(inj.out) && !/批量给出每件事的三行摘要/.test(inj.out));
  check("值守可以带焦点（今晚只把 #N 干完）", inj.out.includes("#488"));
  mode(["normal"]);
}

// ── ② 检查器自己的判别力 ────────────────────────────────────────────
// 下面这段验的是 dao-check 第 ⑧ 项：被覆盖 / 断链 / 输出写死时，它到底会不会叫。

async function checkerTests() {
  const { checkModeHook } = await import("../scripts/lib/dao-mode-hook-check.mjs");

  function reg(command) {
    return { hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command, timeout: 10 }] }] } };
  }
  /** 造一个假 HOME。settings：写进 ~/.claude/ 的文件；plugin：装进 ~/.claude/skills/dao-mode/ 的 hook 脚本内容（null=只放 hooks.json，模拟断链）。 */
  function fakeHome(name, { settings = {}, plugin } = {}) {
    const home = path.join(SANDBOX, "homes", name);
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    for (const [file, doc] of Object.entries(settings)) {
      fs.writeFileSync(path.join(home, ".claude", file), typeof doc === "string" ? doc : JSON.stringify(doc, null, 2), "utf8");
    }
    if (plugin !== undefined) {
      const hooksDir = path.join(home, ".claude", "skills", "dao-mode", "hooks");
      fs.mkdirSync(hooksDir, { recursive: true });
      // 命令原样抄仓内声明：带 ${CLAUDE_PLUGIN_ROOT}，检查器展开不对就会红。
      fs.copyFileSync(path.join(SKILL_DIR, "hooks", "hooks.json"), path.join(hooksDir, "hooks.json"));
      if (plugin !== null) fs.writeFileSync(path.join(hooksDir, "dao-mode.mjs"), plugin, "utf8");
    }
    return home;
  }
  const realScript = fs.readFileSync(HOOK, "utf8");
  const realCmd = `node "${HOOK.replace(/\\/g, "/")}" hook`;

  console.log("\n=== ⑦ 覆盖检测：故意构造违规样本，每一种都必须报红 ===");

  {
    const r = checkModeHook({ root: REPO, home: fakeHome("bare") });
    check("一个装载面都没有（没装/被删）⇒ 报红并给装法", !!r.fail && /一个装载面都没点到/.test(r.fail[0]), JSON.stringify(r).slice(0, 160));
  }
  {
    const r = checkModeHook({ root: REPO, home: fakeHome("other-hook", { settings: { "settings.json": reg("echo 我是别人的 hook") } }) });
    check("settings 面被别的 hook 全量占用（模拟三方覆盖）⇒ 报「没被点到」", !!r.fail && /没被任何装载面点到/.test(r.fail[0]), JSON.stringify(r).slice(0, 160));
  }
  {
    // 插件面 hooks.json 在，脚本没了 —— worktree 被删 / symlink 断掉就长这样。静态那层看不出来。
    const r = checkModeHook({ root: REPO, home: fakeHome("dangling", { plugin: null }) });
    check("插件面装着但脚本断链 ⇒ 运行时抓出来", !!r.fail && /跑不出正确输出/.test(r.fail[0]), JSON.stringify(r).slice(0, 200));
  }
  {
    const r = checkModeHome_liar();
    check("输出恒定的假 hook ⇒ 报「两种输入输出同形」", !!r.fail && /跑不出正确输出/.test(r.fail[0]) && /同形|没把焦点吐出来/.test(r.fail[2]), JSON.stringify(r).slice(0, 220));
  }
  function checkModeHome_liar() {
    // 装载面点得到、跑得动、退出码 0，但根本不看状态文件——最难抓的一种「装死」。
    return checkModeHook({ root: REPO, home: fakeHome("liar", { plugin: 'process.stdout.write("[态] 常态 · 无锁\\n");\n' }) });
  }
  {
    // 把「常态」「文件不在」「文件坏了」揉成同一句话的假 hook：专注那形照样吐焦点，所以
    // 只有「四形两两不同」那条断言拦得住它。这正是本单第一版栽的坑（拿坏 JSON 顶替「没读到」）。
    const merger = [
      "import { readFileSync } from 'node:fs';",
      "let doc = null;",
      "try { doc = JSON.parse(readFileSync(process.env.DAO_STATE_FILE, 'utf8')); } catch {}",
      "if (doc && doc.mode !== 'normal') process.stdout.write('焦点：' + doc.focus.what + '\\n');",
      "else process.stdout.write('[态] 常态\\n');",
      "",
    ].join("\n");
    const r = checkModeHook({ root: REPO, home: fakeHome("merger-all", { plugin: merger }) });
    check("假 hook 把常态/不在/坏了揉成一句 ⇒ 报「输出同形」", !!r.fail && /同形/.test(r.fail[2]), JSON.stringify(r).slice(0, 260));
  }
  {
    // 只把「文件不在」和「文件坏了」合并——原实现就是这样，审官抓的就是这一条。
    const conflate = [
      "import { readFileSync } from 'node:fs';",
      "let doc = null;",
      "try { doc = JSON.parse(readFileSync(process.env.DAO_STATE_FILE, 'utf8')); } catch {}",
      "if (doc && doc.mode !== 'normal') process.stdout.write('焦点：' + doc.focus.what + '\\n');",
      "else if (doc) process.stdout.write('[态] 常态 · 无锁\\n');",
      "else process.stdout.write('[态] 读不到状态文件\\n');",
      "",
    ].join("\n");
    const r = checkModeHook({ root: REPO, home: fakeHome("conflate-absent-corrupt", { plugin: conflate }) });
    check("假 hook 把「文件不在」和「文件坏了」并成一形 ⇒ 报「输出同形」", !!r.fail && /同形/.test(r.fail[2]), JSON.stringify(r).slice(0, 260));
  }
  {
    const r = checkModeHook({ root: REPO, home: fakeHome("broken-json", { settings: { "settings.json": "{oops" }, plugin: realScript }) });
    check("settings 面是坏 JSON ⇒ 报「没查成」而不是绿", !!r.fail && /解析不了/.test(r.fail[0]), JSON.stringify(r).slice(0, 140));
  }
  {
    const emptyRoot = path.join(SANDBOX, "empty-root");
    fs.mkdirSync(path.join(emptyRoot, "host", "skills", "某skill"), { recursive: true });
    const r = checkModeHook({ root: emptyRoot, home: fakeHome("whatever", { plugin: realScript }) });
    check("仓内没有任何自带 hook 的 skill ⇒ 报「等于没查」而不是绿", !!r.fail && /一个自带 hook 的 skill 都没扫到/.test(r.fail[0]), JSON.stringify(r).slice(0, 140));
  }
  {
    const noScriptRoot = path.join(SANDBOX, "no-script-root");
    fs.mkdirSync(path.join(noScriptRoot, "host", "skills", "dao-mode", "hooks"), { recursive: true });
    fs.copyFileSync(path.join(SKILL_DIR, "hooks", "hooks.json"), path.join(noScriptRoot, "host", "skills", "dao-mode", "hooks", "hooks.json"));
    const r = checkModeHook({ root: noScriptRoot, home: fakeHome("whatever3", { plugin: realScript }) });
    check("仓内声明了 hook 但脚本没了 ⇒ 报「注册指向空气」", !!r.fail && /一个 \.mjs 都没有/.test(r.fail[0]), JSON.stringify(r).slice(0, 140));
  }
  {
    const badRoot = path.join(SANDBOX, "bad-decl-root");
    fs.mkdirSync(path.join(badRoot, "host", "skills", "dao-mode", "hooks"), { recursive: true });
    fs.writeFileSync(path.join(badRoot, "host", "skills", "dao-mode", "hooks", "hooks.json"), "{oops", "utf8");
    const r = checkModeHook({ root: badRoot, home: fakeHome("whatever4", { plugin: realScript }) });
    check("仓内 hooks.json 是坏 JSON ⇒ 报「没查成」", !!r.fail && /hooks\.json 解析不了/.test(r.fail[0]), JSON.stringify(r).slice(0, 140));
  }
  {
    const noRoot = path.join(SANDBOX, "no-root");
    const r = checkModeHook({ root: noRoot, home: fakeHome("whatever2", { plugin: realScript }) });
    check("host/skills 不在 ⇒ 报「没查成」", !!r.fail && /host\/skills 不在/.test(r.fail[0]), JSON.stringify(r).slice(0, 140));
  }

  console.log("\n=== ⑧ 正控：装对了必须绿（否则上面全红只是因为它恒红）===");
  {
    const r = checkModeHook({ root: REPO, home: fakeHome("good-plugin", { plugin: realScript }) });
    check("插件面装好 ⇒ 绿（同时证明 ${CLAUDE_PLUGIN_ROOT} 展开对了）", !!r.green && /插件面/.test(r.green), JSON.stringify(r).slice(0, 220));
    const r2 = checkModeHook({ root: REPO, home: fakeHome("good-settings", { settings: { "settings.json": reg(realCmd) } }) });
    check("注册在 settings.json 的老路子同样认", !!r2.green, JSON.stringify(r2).slice(0, 220));
    const r3 = checkModeHook({ root: REPO, home: fakeHome("good-local", { settings: { "settings.local.json": reg(realCmd) } }) });
    check("注册在 settings.local.json 也认（虽然本机实测宿主不读它，检查器不替宿主下结论）", !!r3.green, JSON.stringify(r3).slice(0, 220));
  }

  console.log(`\n通过 ${pass} · 失败 ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
}

checkerTests();
