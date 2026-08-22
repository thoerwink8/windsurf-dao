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

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const REPO = path.resolve(__dirname, "..");
const SKILL_DIR = path.join(REPO, "host", "skills", "dao-mode");
const HOOK = path.join(SKILL_DIR, "hooks", "dao-mode.mjs");
const SANDBOX = path.join(REPO, "_tmp", "mode-sandbox");
const STATE = path.join(SANDBOX, "state.json");

// 沙箱初始化（原文件在模块加载时清理重建；这里保持在 describe 的 it 运行前执行）
fs.rmSync(SANDBOX, { recursive: true, force: true });
fs.mkdirSync(SANDBOX, { recursive: true });

/** 跑 dao-mode.mjs 的一个子命令，状态文件固定指向沙箱。 */
function mode(args, opts = {}) {
  const r = spawnSync(process.execPath, [HOOK, ...args], {
    encoding: "utf8",
    input: opts.input === undefined ? "" : opts.input,
    env: { ...process.env, DAO_STATE_FILE: opts.state || STATE, DAO_NO_ORCA: "1", ...(opts.env || {}) },
  });
  return { status: r.status, out: (r.stdout || "") + (r.stderr || ""), stdout: r.stdout || "" };
}

/** 造一份可直接写盘的非常态 state 文档。 */
function stateDoc(modeName, { hoursAgo = 0, userMessages = 0, offTopicStreak = 0, decisions = [] } = {}) {
  const doc = {
    mode: modeName,
    since: new Date(Date.now() - hoursAgo * 3600000).toISOString(),
    focus: null,
    standby: null,
    offTopicStreak,
    lastOffTopic: null,
    parked: [],
    userMessages,
    decisions,
    updatedBy: "test",
    updatedAt: new Date().toISOString(),
  };
  if (modeName === "standby") doc.standby = { canDecideAlone: ["选型"], alwaysHold: ["合并 master"] };
  if (modeName === "focus") doc.focus = { what: "#607 侦测", doneWhen: "验完" };
  return doc;
}

function injection(promptText, state) {
  return mode(["hook"], { input: JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: promptText }), state });
}

describe('dao-mode', () => {
  it('① 四种结局各自不同形（规格要的三形 + 「读坏了」单列）', async (t) => {
    // ③ 文件压根不在
    const absent = injection("随便一句", path.join(SANDBOX, "不存在.json"));
    await t.test('文件不在 ⇒ 明说「状态文件不在，一个字都没读到」', () => {
      assert.ok(/状态文件不在/.test(absent.out), '文件不在 ⇒ 明说「状态文件不在，一个字都没读到」  →  ' + absent.out.slice(0, 120));
    });
    await t.test('文件不在 ⇒ 退出码 0（没读到是降级不是错误）', () => {
      assert.ok(absent.status === 0, '文件不在 ⇒ 退出码 0（没读到是降级不是错误）  →  ' + `status=${absent.status}`);
    });
    await t.test('文件不在 ⇒ 不冒充常态', () => {
      assert.ok(!/常态 · 无锁/.test(absent.out), '文件不在 ⇒ 不冒充常态  →  ' + absent.out.slice(0, 120));
    });

    // ④ 文件在但用不了——和 ③ 是两件事，不许合并
    const brokenPath = path.join(SANDBOX, "broken.json");
    fs.writeFileSync(brokenPath, "{oops", "utf8");
    const broken = injection("x", brokenPath);
    await t.test('文件坏了 ⇒ 明说「读到了但用不了」并带原因', () => {
      assert.ok(/读到了但用不了/.test(broken.out) && /JSON 解析失败/.test(broken.out), '文件坏了 ⇒ 明说「读到了但用不了」并带原因  →  ' + broken.out.slice(0, 140));
    });
    await t.test('文件坏了 ≠ 文件不在（两种降级分得开）', () => {
      assert.ok(!/状态文件不在/.test(broken.out) && broken.out.trim() !== absent.out.trim(), '文件坏了 ≠ 文件不在（两种降级分得开）  →  ' + broken.out.slice(0, 140));
    });

    const aliasPath = path.join(SANDBOX, "alien.json");
    fs.writeFileSync(aliasPath, JSON.stringify({ mode: "睡了" }), "utf8");
    const alien = injection("x", aliasPath);
    await t.test('mode 字段不认识 ⇒ 归「读到了但用不了」，不猜也不冒充没读到', () => {
      assert.ok(/读到了但用不了/.test(alien.out) && !/状态文件不在/.test(alien.out), 'mode 字段不认识 ⇒ 归「读到了但用不了」，不猜也不冒充没读到  →  ' + alien.out.slice(0, 140));
    });

    // ① 读到了且是常态
    mode(["normal"]);
    const normal = injection("随便一句");
    await t.test('常态 ⇒ 明说「已读到」', () => {
      assert.ok(/常态 · 无锁/.test(normal.out) && /已读到/.test(normal.out), '常态 ⇒ 明说「已读到」  →  ' + normal.out.slice(0, 120));
    });

    // ② 读到了且非常态
    mode(["focus", "--what", "#四形自检", "--done-when", "验完"]);
    const engaged = injection("随便一句");
    await t.test('非常态 ⇒ 出的是态块不是一行常态', () => {
      assert.ok(/━━ 当前态/.test(engaged.out) && !/常态 · 无锁/.test(engaged.out), '非常态 ⇒ 出的是态块不是一行常态  →  ' + engaged.out.slice(0, 120));
    });

    const shapes = { "常态": normal.out.trim(), "非常态": engaged.out.trim(), "文件不在": absent.out.trim(), "文件坏了": broken.out.trim() };
    const names = Object.keys(shapes);
    let allDistinct = true, dup = "";
    for (let i = 0; i < names.length; i++) {
      for (let j = i + 1; j < names.length; j++) {
        if (shapes[names[i]] === shapes[names[j]]) { allDistinct = false; dup = `${names[i]}==${names[j]}`; }
      }
    }
    await t.test('四形两两不同（任何两形被合并都在这里红）', () => {
      assert.ok(allDistinct, '四形两两不同（任何两形被合并都在这里红）  →  ' + dup);
    });
    mode(["normal"]);
  });

  it('② hook 路径永不把用户锁死（失效方向朝安全一侧）', async (t) => {
    for (const [label, input] of [["空 stdin", ""], ["不是 JSON", "hello"], ["JSON 但没 prompt", "{}"]]) {
      const r = mode(["hook"], { input, state: path.join(SANDBOX, "不存在.json") });
      await t.test(`${label} ⇒ 仍 exit 0 且有输出`, () => {
        assert.ok(r.status === 0 && r.stdout.trim().length > 0, `${label} ⇒ 仍 exit 0 且有输出  →  ` + `status=${r.status} out=${r.stdout.slice(0, 60)}`);
      });
    }
    // 退出码 2 会让宿主拦下用户这一轮的 prompt。hook 路径永远不许走到 2。
    const r = mode(["hook"], { input: "{}" });
    await t.test('hook 退出码不是 2（2 会拦下用户的 prompt）', () => {
      assert.ok(r.status !== 2, 'hook 退出码不是 2（2 会拦下用户的 prompt）  →  ' + `status=${r.status}`);
    });
  });

  it('③ 进专注：两道追问一道都不能删', async (t) => {
    const noDone = mode(["focus", "--what", "#488"]);
    await t.test('只给焦点不给退出判据 ⇒ 拒绝（exit 2）', () => {
      assert.ok(noDone.status === 2, '只给焦点不给退出判据 ⇒ 拒绝（exit 2）  →  ' + `status=${noDone.status}`);
    });
    const noWhat = mode(["focus", "--done-when", "合并"]);
    await t.test('只给退出判据不给焦点 ⇒ 拒绝（exit 2）', () => {
      assert.ok(noWhat.status === 2, '只给退出判据不给焦点 ⇒ 拒绝（exit 2）  →  ' + `status=${noWhat.status}`);
    });

    const ok = mode(["focus", "--what", "#488 状态机", "--done-when", "PR #490 合并"]);
    await t.test('两道都给 ⇒ 进得去', () => {
      assert.ok(ok.status === 0 && /已进入专注/.test(ok.out), '两道都给 ⇒ 进得去  →  ' + ok.out.slice(0, 80));
    });
    const doc = JSON.parse(fs.readFileSync(STATE, "utf8"));
    await t.test('state.json 字段自解释（mode/focus.what/focus.doneWhen）',
      () => {
        assert.ok(doc.mode === "focus" && doc.focus.what === "#488 状态机" && doc.focus.doneWhen === "PR #490 合并", 'state.json 字段自解释（mode/focus.what/focus.doneWhen）  →  ' + JSON.stringify(doc).slice(0, 120));
      });

    const inj = injection("继续干 #488");
    await t.test('专注注入带焦点原文', () => {
      assert.ok(inj.out.includes("#488 状态机"), '专注注入带焦点原文');
    });
    await t.test('专注注入带退出判据', () => {
      assert.ok(inj.out.includes("PR #490 合并"), '专注注入带退出判据');
    });
    await t.test('专注注入自带违背判据（不靠 skill 正文）', () => {
      assert.ok(/只有「用户指派一个新的工作对象」算偏离/.test(inj.out), '专注注入自带违背判据（不靠 skill 正文）  →  ' + inj.out.slice(0, 200));
    });
    await t.test('专注注入说明第一次偏离该怎么办', () => {
      assert.ok(/照办/.test(inj.out) && /焦点仍锁/.test(inj.out), '专注注入说明第一次偏离该怎么办  →  ' + inj.out.slice(0, 200));
    });
  });

  it('④ 偏离：第一次照办，连续第二次才弹确认', async (t) => {
    const first = injection("顺手看下 #999 的登录 bug");
    await t.test('streak=0 时注入的是「照办 + 挂提示行」', () => {
      assert.ok(/照办/.test(first.out) && /焦点仍锁/.test(first.out) && !/不要直接照办/.test(first.out), 'streak=0 时注入的是「照办 + 挂提示行」  →  ' + first.out.slice(0, 200));
    });
    await t.test('prompt 里出现别的编号 ⇒ 注入里点名提醒去判断', () => {
      assert.ok(first.out.includes("#999"), 'prompt 里出现别的编号 ⇒ 注入里点名提醒去判断  →  ' + first.out.slice(0, 300));
    });

    const d1 = mode(["drift", "--what", "#999 登录 bug"]);
    await t.test('记一次偏离 ⇒ 计数 1，仍是照办', () => {
      assert.ok(/连续偏离 1 次/.test(d1.out) && /照办/.test(d1.out), '记一次偏离 ⇒ 计数 1，仍是照办  →  ' + d1.out.slice(0, 100));
    });

    const second = injection("再顺手看下 #1000");
    await t.test('streak=1 时注入改口为「不要直接照办」', () => {
      assert.ok(/不要直接照办/.test(second.out), 'streak=1 时注入改口为「不要直接照办」  →  ' + second.out.slice(0, 300));
    });
    await t.test('streak=1 时注入要求调 skill 让用户拍板', () => {
      assert.ok(/\/dao-mode/.test(second.out) && /拍板/.test(second.out), 'streak=1 时注入要求调 skill 让用户拍板  →  ' + second.out.slice(0, 300));
    });
    await t.test('两种 streak 下注入不同形', () => {
      assert.ok(first.out.trim() !== second.out.trim(), '两种 streak 下注入不同形');
    });

    const d2 = mode(["drift", "--what", "#1000"]);
    await t.test('第二次偏离 ⇒ 命令自己也改口要求弹确认', () => {
      assert.ok(/连续偏离 2 次/.test(d2.out) && /拍板/.test(d2.out), '第二次偏离 ⇒ 命令自己也改口要求弹确认  →  ' + d2.out.slice(0, 120));
    });

    const cleared = mode(["clear-drift"]);
    await t.test('用户判「只是插曲」⇒ 计数归零', () => {
      assert.ok(/归零/.test(cleared.out) && JSON.parse(fs.readFileSync(STATE, "utf8")).offTopicStreak === 0, '用户判「只是插曲」⇒ 计数归零');
    });

    // 换焦点也要把计数清掉，否则新焦点一上来就欠着旧账。
    mode(["drift", "--what", "旧账"]);
    mode(["focus", "--what", "#500 新焦点", "--done-when", "跑通"]);
    await t.test('换焦点 ⇒ 偏离计数归零', () => {
      assert.ok(JSON.parse(fs.readFileSync(STATE, "utf8")).offTopicStreak === 0, '换焦点 ⇒ 偏离计数归零');
    });
  });

  it('⑤ 暂存队列：进去攒，出来回放', async (t) => {
    mode(["park", "--what", "用户提的 #493 想法"]);
    mode(["park", "--what", "另一个念头"]);
    const doc = JSON.parse(fs.readFileSync(STATE, "utf8"));
    await t.test('park 攒进 state.json 且带时间', () => {
      assert.ok(doc.parked.length === 2 && !!doc.parked[0].at, 'park 攒进 state.json 且带时间  →  ' + JSON.stringify(doc.parked).slice(0, 120));
    });
    const out = mode(["normal"]);
    await t.test('退出时把队列逐条回放', () => {
      assert.ok(/暂存队列 2 条/.test(out.out) && out.out.includes("#493") && out.out.includes("另一个念头"), '退出时把队列逐条回放  →  ' + out.out.slice(0, 200));
    });
    await t.test('退出后回常态', () => {
      assert.ok(JSON.parse(fs.readFileSync(STATE, "utf8")).mode === "normal", '退出后回常态');
    });
    const empty = mode(["normal"]);
    await t.test('队列空时明说空（不与「有队列」同形）', () => {
      assert.ok(/暂存队列：空/.test(empty.out), '队列空时明说空（不与「有队列」同形）  →  ' + empty.out.slice(0, 120));
    });
    const driftInNormal = mode(["drift", "--what", "x"]);
    await t.test('常态下记偏离 ⇒ 说没有焦点可偏离，不乱记账', () => {
      assert.ok(/没有焦点可偏离/.test(driftInNormal.out), '常态下记偏离 ⇒ 说没有焦点可偏离，不乱记账  →  ' + driftInNormal.out.slice(0, 100));
    });
  });

  it('⑥ 值守：只问授权边界，行为规范不复述', async (t) => {
    const r = mode(["standby", "--what", "#488", "--decide", "选型；改动方案", "--hold", "合并 master；对外发布"]);
    await t.test('进得去值守', () => {
      assert.ok(r.status === 0 && /已进入值守/.test(r.out), '进得去值守  →  ' + r.out.slice(0, 80));
    });
    const inj = injection("我睡了");
    await t.test('值守注入带授权边界指针（瘦身：不再注入全文）', () => {
      assert.ok(/status --json/.test(inj.out) && /授权/.test(inj.out) && !/可以自己拍：/.test(inj.out) && !/恒挂起等用户：/.test(inj.out), '值守注入带授权边界指针（瘦身：不再注入全文）  →  ' + inj.out.slice(0, 300));
    });
    await t.test('值守注入不复述行为规范（CLAUDE.md 已常驻）', () => {
      assert.ok(!/全局 CLAUDE\.md/.test(inj.out) && !/批量给出每件事的三行摘要/.test(inj.out), '值守注入不复述行为规范（CLAUDE.md 已常驻）  →  ' + inj.out.slice(0, 300));
    });
    await t.test('值守可以带焦点（今晚只把 #N 干完）', () => {
      assert.ok(inj.out.includes("#488"), '值守可以带焦点（今晚只把 #N 干完）');
    });
    mode(["normal"]);
  });

  it('⑦ 覆盖检测：故意构造违规样本，每一种都必须报红', async (t) => {
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
        if (plugin !== null) {
          fs.writeFileSync(path.join(hooksDir, "dao-mode.mjs"), plugin, "utf8");
          // 真脚本会 import 同目录的 should-ask-exit.mjs（#607 纯函数）；假 hook 不 import 它，多拷无害。
          fs.copyFileSync(path.join(SKILL_DIR, "hooks", "should-ask-exit.mjs"), path.join(hooksDir, "should-ask-exit.mjs"));
        }
      }
      return home;
    }
    const realScript = fs.readFileSync(HOOK, "utf8");
    const realCmd = `node "${HOOK.replace(/\\/g, "/")}" hook`;

    {
      const r = checkModeHook({ root: REPO, home: fakeHome("bare") });
      await t.test('一个装载面都没有（没装/被删）⇒ 报红并给装法', () => {
        assert.ok(!!r.fail && /一个装载面都没点到/.test(r.fail[0]), '一个装载面都没有（没装/被删）⇒ 报红并给装法  →  ' + JSON.stringify(r).slice(0, 160));
      });
    }
    {
      const r = checkModeHook({ root: REPO, home: fakeHome("other-hook", { settings: { "settings.json": reg("echo 我是别人的 hook") } }) });
      await t.test('settings 面被别的 hook 全量占用（模拟三方覆盖）⇒ 报「没被点到」', () => {
        assert.ok(!!r.fail && /没被任何装载面点到/.test(r.fail[0]), 'settings 面被别的 hook 全量占用（模拟三方覆盖）⇒ 报「没被点到」  →  ' + JSON.stringify(r).slice(0, 160));
      });
    }
    {
      // 插件面 hooks.json 在，脚本没了 —— worktree 被删 / symlink 断掉就长这样。静态那层看不出来。
      const r = checkModeHook({ root: REPO, home: fakeHome("dangling", { plugin: null }) });
      await t.test('插件面装着但脚本断链 ⇒ 运行时抓出来', () => {
        assert.ok(!!r.fail && /跑不出正确输出/.test(r.fail[0]), '插件面装着但脚本断链 ⇒ 运行时抓出来  →  ' + JSON.stringify(r).slice(0, 200));
      });
    }
    {
      const r = checkModeHook({ root: REPO, home: fakeHome("liar", { plugin: 'process.stdout.write("[态] 常态 · 无锁\\n");\n' }) });
      await t.test('输出恒定的假 hook ⇒ 报「两种输入输出同形」', () => {
        assert.ok(!!r.fail && /跑不出正确输出/.test(r.fail[0]) && /同形|没把焦点吐出来/.test(r.fail[2]), '输出恒定的假 hook ⇒ 报「两种输入输出同形」  →  ' + JSON.stringify(r).slice(0, 220));
      });
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
      await t.test('假 hook 把常态/不在/坏了揉成一句 ⇒ 报「输出同形」', () => {
        assert.ok(!!r.fail && /同形/.test(r.fail[2]), '假 hook 把常态/不在/坏了揉成一句 ⇒ 报「输出同形」  →  ' + JSON.stringify(r).slice(0, 260));
      });
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
      await t.test('假 hook 把「文件不在」和「文件坏了」并成一形 ⇒ 报「输出同形」', () => {
        assert.ok(!!r.fail && /同形/.test(r.fail[2]), '假 hook 把「文件不在」和「文件坏了」并成一形 ⇒ 报「输出同形」  →  ' + JSON.stringify(r).slice(0, 260));
      });
    }
    {
      const r = checkModeHook({ root: REPO, home: fakeHome("broken-json", { settings: { "settings.json": "{oops" }, plugin: realScript }) });
      await t.test('settings 面是坏 JSON ⇒ 报「没查成」而不是绿', () => {
        assert.ok(!!r.fail && /解析不了/.test(r.fail[0]), 'settings 面是坏 JSON ⇒ 报「没查成」而不是绿  →  ' + JSON.stringify(r).slice(0, 140));
      });
    }
    {
      const emptyRoot = path.join(SANDBOX, "empty-root");
      fs.mkdirSync(path.join(emptyRoot, "host", "skills", "某skill"), { recursive: true });
      const r = checkModeHook({ root: emptyRoot, home: fakeHome("whatever", { plugin: realScript }) });
      await t.test('仓内没有任何自带 hook 的 skill ⇒ 报「等于没查」而不是绿', () => {
        assert.ok(!!r.fail && /一个自带 hook 的 skill 都没扫到/.test(r.fail[0]), '仓内没有任何自带 hook 的 skill ⇒ 报「等于没查」而不是绿  →  ' + JSON.stringify(r).slice(0, 140));
      });
    }
    {
      const noScriptRoot = path.join(SANDBOX, "no-script-root");
      fs.mkdirSync(path.join(noScriptRoot, "host", "skills", "dao-mode", "hooks"), { recursive: true });
      fs.copyFileSync(path.join(SKILL_DIR, "hooks", "hooks.json"), path.join(noScriptRoot, "host", "skills", "dao-mode", "hooks", "hooks.json"));
      const r = checkModeHook({ root: noScriptRoot, home: fakeHome("whatever3", { plugin: realScript }) });
      await t.test('仓内声明了 hook 但脚本没了 ⇒ 报「注册指向空气」', () => {
        assert.ok(!!r.fail && /一个 \.mjs 都没有/.test(r.fail[0]), '仓内声明了 hook 但脚本没了 ⇒ 报「注册指向空气」  →  ' + JSON.stringify(r).slice(0, 140));
      });
    }
    {
      const badRoot = path.join(SANDBOX, "bad-decl-root");
      fs.mkdirSync(path.join(badRoot, "host", "skills", "dao-mode", "hooks"), { recursive: true });
      fs.writeFileSync(path.join(badRoot, "host", "skills", "dao-mode", "hooks", "hooks.json"), "{oops", "utf8");
      const r = checkModeHook({ root: badRoot, home: fakeHome("whatever4", { plugin: realScript }) });
      await t.test('仓内 hooks.json 是坏 JSON ⇒ 报「没查成」', () => {
        assert.ok(!!r.fail && /hooks\.json 解析不了/.test(r.fail[0]), '仓内 hooks.json 是坏 JSON ⇒ 报「没查成」  →  ' + JSON.stringify(r).slice(0, 140));
      });
    }
    {
      const noRoot = path.join(SANDBOX, "no-root");
      const r = checkModeHook({ root: noRoot, home: fakeHome("whatever2", { plugin: realScript }) });
      await t.test('host/skills 不在 ⇒ 报「没查成」', () => {
        assert.ok(!!r.fail && /host\/skills 不在/.test(r.fail[0]), 'host/skills 不在 ⇒ 报「没查成」  →  ' + JSON.stringify(r).slice(0, 140));
      });
    }
  });

  it('⑧ 正控：装对了必须绿（否则上面全红只是因为它恒红）', async (t) => {
    const { checkModeHook } = await import("../scripts/lib/dao-mode-hook-check.mjs");
    function reg(command) {
      return { hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command, timeout: 10 }] }] } };
    }
    function fakeHome(name, { settings = {}, plugin } = {}) {
      const home = path.join(SANDBOX, "homes", name);
      fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
      for (const [file, doc] of Object.entries(settings)) {
        fs.writeFileSync(path.join(home, ".claude", file), typeof doc === "string" ? doc : JSON.stringify(doc, null, 2), "utf8");
      }
      if (plugin !== undefined) {
        const hooksDir = path.join(home, ".claude", "skills", "dao-mode", "hooks");
        fs.mkdirSync(hooksDir, { recursive: true });
        fs.copyFileSync(path.join(SKILL_DIR, "hooks", "hooks.json"), path.join(hooksDir, "hooks.json"));
        if (plugin !== null) {
          fs.writeFileSync(path.join(hooksDir, "dao-mode.mjs"), plugin, "utf8");
          // 真脚本会 import 同目录的 should-ask-exit.mjs（#607 纯函数）；假 hook 不 import 它，多拷无害。
          fs.copyFileSync(path.join(SKILL_DIR, "hooks", "should-ask-exit.mjs"), path.join(hooksDir, "should-ask-exit.mjs"));
        }
      }
      return home;
    }
    const realScript = fs.readFileSync(HOOK, "utf8");
    const realCmd = `node "${HOOK.replace(/\\/g, "/")}" hook`;
    {
      const r = checkModeHook({ root: REPO, home: fakeHome("good-plugin", { plugin: realScript }) });
      await t.test('插件面装好 ⇒ 绿（同时证明 ${CLAUDE_PLUGIN_ROOT} 展开对了）', () => {
        assert.ok(!!r.green && /插件面/.test(r.green), '插件面装好 ⇒ 绿（同时证明 ${CLAUDE_PLUGIN_ROOT} 展开对了）  →  ' + JSON.stringify(r).slice(0, 220));
      });
      const r2 = checkModeHook({ root: REPO, home: fakeHome("good-settings", { settings: { "settings.json": reg(realCmd) } }) });
      await t.test('注册在 settings.json 的老路子同样认', () => {
        assert.ok(!!r2.green, '注册在 settings.json 的老路子同样认  →  ' + JSON.stringify(r2).slice(0, 220));
      });
      const r3 = checkModeHook({ root: REPO, home: fakeHome("good-local", { settings: { "settings.local.json": reg(realCmd) } }) });
      await t.test('注册在 settings.local.json 也认（虽然本机实测宿主不读它，检查器不替宿主下结论）', () => {
        assert.ok(!!r3.green, '注册在 settings.local.json 也认（虽然本机实测宿主不读它，检查器不替宿主下结论）  →  ' + JSON.stringify(r3).slice(0, 220));
      });
    }
  });

  it('⑨ shouldAskExit 纯函数（#607 ①）：三信号各自独立生效 + 防噪音', async (t) => {
    const { shouldAskExit, EXIT_DEFAULTS } = await import("../host/skills/dao-mode/hooks/should-ask-exit.mjs");
    await t.test('默认阈值 = 8 小时 / 3 条消息 / 2 次偏离', () => {
      assert.deepStrictEqual(EXIT_DEFAULTS, { hours: 8, messages: 3, offTopic: 2 });
    });
    await t.test('值守 + 0 时长 + 0 消息 + 0 偏离 ⇒ 不提示（防噪音）', () => {
      assert.strictEqual(shouldAskExit({ mode: "standby", hours: 0, messages: 0 }).ask, false);
    });
    await t.test('值守 + 7.9 小时 + 2 条消息 + 偏离 1 ⇒ 不提示（都没超）', () => {
      assert.strictEqual(shouldAskExit({ mode: "standby", hours: 7.9, messages: 2, offTopicStreak: 1 }).ask, false);
    });
    await t.test('值守 + 满 3 条消息 ⇒ 提示且理由含消息数', () => {
      const r = shouldAskExit({ mode: "standby", hours: 0, messages: 3 });
      assert.strictEqual(r.ask, true);
      assert.ok(r.reasons.join("").includes("3 条消息"), r.reasons.join(""));
    });
    await t.test('值守 + 满 8 小时 + 0 消息 ⇒ 提示（时长信号独立生效）', () => {
      const r = shouldAskExit({ mode: "standby", hours: 8, messages: 0 });
      assert.strictEqual(r.ask, true);
      assert.ok(r.reasons.join("").includes("8 小时"), r.reasons.join(""));
    });
    await t.test('值守 + 连续偏离 2 次 ⇒ 提示（偏离信号独立生效）', () => {
      assert.strictEqual(shouldAskExit({ mode: "standby", hours: 0, messages: 0, offTopicStreak: 2 }).ask, true);
    });
    await t.test('常态 ⇒ 永不提示（即使时长/消息/偏离全爆表）', () => {
      assert.strictEqual(shouldAskExit({ mode: "normal", hours: 999, messages: 999, offTopicStreak: 99 }).ask, false);
    });
    await t.test('阈值可配：自定义 thresholds 生效、默认值不变', () => {
      assert.strictEqual(shouldAskExit({ mode: "standby", hours: 1, messages: 0, thresholds: { hours: 1 } }).ask, true);
      assert.strictEqual(shouldAskExit({ mode: "standby", hours: 1, messages: 0 }).ask, false);
    });
    await t.test('专注 + 满 8 小时 + 0 消息 ⇒ 提示「是否还在专注」', () => {
      assert.strictEqual(shouldAskExit({ mode: "focus", hours: 8, messages: 0 }).ask, true);
    });
    await t.test('专注 + 满 8 小时但用户在发消息 ⇒ 不打扰（用户在场是专注的常态）', () => {
      assert.strictEqual(shouldAskExit({ mode: "focus", hours: 8, messages: 3 }).ask, false);
    });
    await t.test('专注 + 未满 8 小时 ⇒ 不提示', () => {
      assert.strictEqual(shouldAskExit({ mode: "focus", hours: 2, messages: 0 }).ask, false);
    });
    await t.test('未知态 ⇒ 不提示（unreadable 由调用方按「态没查成」处理）', () => {
      assert.strictEqual(shouldAskExit({ mode: "外星态", hours: 99 }).ask, false);
    });
  });

  it('⑩ hook 注入结论（#607 ①③）：正负样本 + 计数 + 字段缺失 + 崩溃', async (t) => {
    const oldFile = path.join(SANDBOX, "old-standby.json");
    fs.writeFileSync(oldFile, JSON.stringify(stateDoc("standby", { hoursAgo: 8.5 })), "utf8");
    const a = injection("早安", oldFile);
    await t.test('值守 + 时长超阈值 ⇒ 注入出现「必须问是否退出值守」', () => {
      assert.ok(/现在必须问是否退出值守/.test(a.out), "→  " + a.out.slice(0, 300));
    });
    await t.test('时长超但消息未超 ⇒ 理由只有时长（时长信号独立）', () => {
      assert.ok(/已值守 8\.[0-9] 小时/.test(a.out) && !/此间用户发了/.test(a.out), "→  " + a.out.slice(0, 300));
    });
    await t.test('注入的是结论不是原料：授权清单全文不在注入里', () => {
      assert.ok(!/可以自己拍：/.test(a.out) && !/恒挂起等用户：/.test(a.out), "→  " + a.out.slice(0, 300));
    });
    await t.test('注入带 selfie / status 指针（一行指针）', () => {
      assert.ok(/selfie/.test(a.out) && /status --json/.test(a.out), "→  " + a.out.slice(0, 300));
    });

    const freshFile = path.join(SANDBOX, "fresh-standby.json");
    fs.writeFileSync(freshFile, JSON.stringify(stateDoc("standby")), "utf8");
    const b = injection("睡了吗", freshFile);
    await t.test('值守 + 0 消息 + 时长未超 ⇒ 不出现「必须问」（防噪音）', () => {
      assert.ok(!/现在必须问是否退出值守/.test(b.out), "→  " + b.out.slice(0, 300));
    });
    await t.test('不触发时也不带「建议问」', () => {
      assert.ok(!/建议问用户/.test(b.out), "→  " + b.out.slice(0, 300));
    });

    const msgFile = path.join(SANDBOX, "msg-standby.json");
    fs.writeFileSync(msgFile, JSON.stringify(stateDoc("standby", { userMessages: 2 })), "utf8");
    const c = injection("在吗", msgFile);
    await t.test('值守 + 消息满 3 条 ⇒ 提示且理由含消息数', () => {
      assert.ok(/现在必须问是否退出值守/.test(c.out) && /此间用户发了 3 条消息/.test(c.out), "→  " + c.out.slice(0, 300));
    });

    const normalFile = path.join(SANDBOX, "normal-state.json");
    fs.writeFileSync(normalFile, JSON.stringify(stateDoc("normal")), "utf8");
    const n = injection("随便", normalFile);
    await t.test('常态 ⇒ 不出现任何值守/专注提示', () => {
      assert.ok(!/值守/.test(n.out) && !/必须问/.test(n.out) && !/建议问/.test(n.out), "→  " + n.out.slice(0, 300));
    });

    const noSince = stateDoc("standby");
    delete noSince.since;
    const noSinceFile = path.join(SANDBOX, "no-since.json");
    fs.writeFileSync(noSinceFile, JSON.stringify(noSince), "utf8");
    const d = injection("x", noSinceFile);
    await t.test('standby 缺 since ⇒ 报「态没查成」，不许静默当常态', () => {
      assert.ok(/读到了但用不了/.test(d.out) && /since/.test(d.out), "→  " + d.out.slice(0, 300));
    });
    await t.test('字段缺失时退出码仍 0（降级不是错误）', () => {
      assert.ok(d.status === 0, `status=${d.status}`);
    });

    const cntFile = path.join(SANDBOX, "count.json");
    fs.writeFileSync(cntFile, JSON.stringify(stateDoc("standby")), "utf8");
    injection("一", cntFile);
    injection("二", cntFile);
    await t.test('hook 每触发一次消息计数 +1 写回 state.json（在场侦测）', () => {
      assert.strictEqual(JSON.parse(fs.readFileSync(cntFile, "utf8")).userMessages, 2);
    });
    const cntNormal = path.join(SANDBOX, "count-normal.json");
    fs.writeFileSync(cntNormal, JSON.stringify(stateDoc("normal")), "utf8");
    injection("x", cntNormal);
    await t.test('常态下 hook 不写计数', () => {
      assert.strictEqual(JSON.parse(fs.readFileSync(cntNormal, "utf8")).userMessages, 0);
    });

    const crash = mode(["hook"], { input: JSON.stringify({ prompt: "x" }), state: path.join(SANDBOX, "none.json"), env: { DAO_MODE_TEST_CRASH: "1" } });
    await t.test('hook 崩溃 ⇒ exit 0 + 明说降级 + 不冒充常态（#607 补验 #488 那条）', () => {
      assert.ok(crash.status === 0 && /状态机自己出错了/.test(crash.out) && !/常态 · 无锁/.test(crash.out), `status=${crash.status} out=${crash.out.slice(0, 200)}`);
    });
  });

  it('⑪ 自拍登记（#607 ②）：先记后做，退出回放；偏离无登记会报警', async (t) => {
    mode(["normal"]);
    const sn = mode(["selfie", "--what", "x"]);
    await t.test('常态下 selfie ⇒ 说无需登记', () => {
      assert.ok(/无需登记/.test(sn.out), "→  " + sn.out.slice(0, 200));
    });
    mode(["focus", "--what", "#1 专注", "--done-when", "完"]);
    const sf = mode(["selfie", "--what", "y"]);
    await t.test('专注下 selfie ⇒ 说无需登记（用户在场应直接问）', () => {
      assert.ok(/无需登记/.test(sf.out), "→  " + sf.out.slice(0, 200));
    });
    mode(["standby", "--what", "#607 值守", "--decide", "选型", "--hold", "合并 master"]);
    const noWhat = mode(["selfie"]);
    await t.test('selfie 缺 --what ⇒ exit 2（没记什么不许记账）', () => {
      assert.ok(noWhat.status === 2, `status=${noWhat.status}`);
    });
    const s1 = mode(["selfie", "--what", "派 Codex 审官", "--category", "选型", "--basis", "授权清单第 1 条"]);
    await t.test('值守下 selfie ⇒ 登记第 1 条', () => {
      assert.ok(/已登记第 1 条自拍/.test(s1.out), "→  " + s1.out.slice(0, 200));
    });
    const doc = JSON.parse(fs.readFileSync(STATE, "utf8"));
    await t.test('state.json decisions 落账：at/what/category/basis 齐全', () => {
      assert.ok(doc.decisions.length === 1 && doc.decisions[0].what === "派 Codex 审官" && doc.decisions[0].category === "选型" && doc.decisions[0].basis === "授权清单第 1 条" && !!doc.decisions[0].at, JSON.stringify(doc.decisions));
    });
    mode(["selfie", "--what", "返工调度", "--category", "调度", "--basis", "授权清单第 1 条"]);
    const out = mode(["normal"]);
    await t.test('退出值守 ⇒ 回放自拍登记', () => {
      assert.ok(/值守期间自拍登记 2 条/.test(out.out) && /派 Codex 审官/.test(out.out) && /返工调度/.test(out.out), "→  " + out.out.slice(0, 300));
    });

    mode(["standby", "--what", "#607", "--decide", "选型"]);
    mode(["drift", "--what", "#100 甲"]);
    mode(["drift", "--what", "#101 乙"]);
    const out2 = mode(["normal"]);
    await t.test('值守期间偏离 2 次但 0 登记 ⇒ 退出时报警对账', () => {
      assert.ok(/连续偏离 2 次/.test(out2.out) && /0 条自拍登记/.test(out2.out), "→  " + out2.out.slice(0, 300));
    });

    mode(["standby", "--what", "#607", "--decide", "选型"]);
    mode(["drift", "--what", "#100 丙"]);
    const out3 = mode(["normal"]);
    await t.test('只偏离 1 次且 0 登记 ⇒ 不报警（第一次偏离是照办不是拍板）', () => {
      assert.ok(!/0 条自拍登记/.test(out3.out), "→  " + out3.out.slice(0, 300));
    });
  });
});
