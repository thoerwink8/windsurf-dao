// 正式看门狗回归网（issue #442 + #500/#492/#471/#476 换代 + #569 降噪/换 provider/权限框）——每个检测项留正控 + 负控 + 判别力
//
// 验的层：①真实语料（live/ 2026-08-14 实录）扫完 0 异常 ②真实事故语料被拦（at-capacity 两起
// 实录 + terminal_handle_stale 读失败实录，字段未改写）③exited / 错误指纹 / waiting / 停摆 /
// NO_TARGETS 违规样本被拦 ④epoch 状态机边界（同 pane 重启 / 内容变化）⑤结构性排除（主工作区 /
// 自身 / 稳定 pane ID）⑥--once 只跑单轮 ⑦检测不依赖工人自报。
// #500 换代：⑧停摆判据 = 非 spinner 真实内容连续三轮不变（spinner 重绘/cursor 前进/ps updatedAt
// 前进都不算活性——转圈假工人 spinner-hang 样本：旧判据全放行、新判据第 3 轮报）⑨空转（git 证据）
// ⑩孤儿树（活跃执行者判据，跨主帅不误伤；#630 接真删：on 调 --force，off/快照只打印）⑪命名校验 ⑫flow 心跳/停滞态 ⑬处置矩阵动作行与连败报帅。
// #646：⑬b capacity 指纹（at capacity / try a different model）续命走专用调度——按 1/5/10 分钟
// 各续命一次（共 3 次），第 4 次按选型序换人；认不出审官卡才报帅。
// #569：⑭空转降噪三类豁免（角色·在途PR·活性否决，各留正控 negative + 真阳对照）⑮权限确认框
// selector 指纹（1/3:select 两连同，不自动替它选）⑯BLIND 隐形工人（垫片 watch-board 并进，
// 2026-08-17 判据订正：有活终端且查不到 dispatch 记账才报，agents=0 不算数）⑰model-change
// （pi 静默换 provider：诱因 errorMessage、初始选型不报）。
//
// 判别力自检问句：任何把检测放宽或收紧的改动，是否都至少有一条断言会变红？
// 每个违规样本都是「故意构造的违规，被当场拦下」——上线生效证据，v0.4 跳过这步首报即翻车。
//
// 语料分类（tests/watchdog-fixtures/README.md 有逐目录说明）：
//   real-incidents/  = 现场实录（2026-08-15），ps/read 字段未改写
//   其余目录         = 在真实录制基础上手工变异的单元样本，只作补充单元测试，不当现场实录

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const REPO = path.resolve(__dirname, "..");
const WATCHDOG = path.join(REPO, "scripts", "watchdog.mjs");
const FIXTURES = path.join(REPO, "tests", "watchdog-fixtures");

function runWatchdog(dir, extraArgs = []) {
  const r = spawnSync(process.execPath, [WATCHDOG, "--snapshot-dir", dir, ...extraArgs], {
    encoding: "utf8",
    cwd: REPO,
  });
  return { status: r.status, out: (r.stdout || "") + (r.stderr || "") };
}

// 把单轮快照目录复制成 n 轮同屏（两连同/停摆判据是跨轮状态机，单轮快照不够）
function multiRound(dir, n) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "watchdog-mr-"));
  for (let i = 1; i <= n; i++) {
    const dst = path.join(tmp, `round-${i}`);
    fs.mkdirSync(dst, { recursive: true });
    for (const f of fs.readdirSync(dir)) {
      const s = path.join(dir, f);
      if (fs.statSync(s).isFile()) fs.copyFileSync(s, path.join(dst, f));
    }
  }
  return tmp;
}

function runMultiRounds(dir, n, extraArgs = []) {
  const tmp = multiRound(dir, n);
  const r = runWatchdog(tmp, extraArgs);
  fs.rmSync(tmp, { recursive: true, force: true });
  return r;
}

const EVENT_RE = /^\[.+\] (exited|waiting|fingerprint|stall|read-failed|idle|orphan|naming|flow-stalled|flow-absent|stagnation|selector|blind|model-change|retry-loop|stale-completion|stale-code|报帅|动作):/m;
const SELF_WT = "1770a430-983a-4e86-9277-9f1e5c376b83::C:/Users/Administrator/orca/workspaces/windsurf-dao/看门狗正式版";
const NOW = 1786800000000;

describe('watchdog', () => {
  it('① 真实语料（2026-08-14 实录）——负向对照：健康工位不误报', async (t) => {
    const r = runWatchdog(path.join(FIXTURES, "live"));
    await t.test('退出码 0（扫完 0 异常）', () => {
      assert.ok(r.status === 0, '退出码 0（扫完 0 异常）  →  ' + `status=${r.status}`);
    });
    await t.test('OK 汇总含工位数（主工作区被结构性排除，剩 1 个）', () => {
      assert.ok(/OK 扫完 1 个工位/.test(r.out), 'OK 汇总含工位数（主工作区被结构性排除，剩 1 个）  →  ' + r.out.trim());
    });
    await t.test('被监视工位：#452 - 看门狗正式版在列', () => {
      assert.ok(r.out.includes("#452 - 看门狗正式版"), '被监视工位：#452 - 看门狗正式版在列  →  无 #452 - 看门狗正式版');
    });
    await t.test('主工作区 master 不在监视集合（结构性排除）', () => {
      assert.ok(!r.out.includes("master"), '主工作区 master 不在监视集合（结构性排除）  →  ' + r.out.trim());
    });
    await t.test('屏面上部叙述里的指纹字样不误报（v0 教训）', () => {
      assert.ok(!EVENT_RE.test(r.out), '屏面上部叙述里的指纹字样不误报（v0 教训）  →  ' + r.out.split("\n").filter(l => EVENT_RE.test(l)).join(" | "));
    });
    await t.test('命名合规树不报 naming（#476）', () => {
      assert.ok(!/naming:/.test(r.out), '命名合规树不报 naming（#476）  →  ' + r.out.trim());
    });
  });

  it('② 真实语料 + 自身排除：全被排除 → NO_TARGETS', async (t) => {
    const r = runWatchdog(path.join(FIXTURES, "live"), ["--self-worktree", SELF_WT]);
    await t.test('退出码 2（NO_TARGETS）', () => {
      assert.ok(r.status === 2, '退出码 2（NO_TARGETS）  →  ' + `status=${r.status}`);
    });
    await t.test('明确打印 NO_TARGETS', () => {
      assert.ok(/NO_TARGETS/.test(r.out), '明确打印 NO_TARGETS  →  ' + r.out.trim());
    });
  });

  it('③ 真实事故语料被拦（2026-08-15 现场实录，字段未改写）——指纹两连同才报警（2026-08-15 裁定书）', async (t) => {
    const r1 = runWatchdog(path.join(FIXTURES, "real-incidents", "at-capacity-450"),
      ["--self-worktree", SELF_WT]);
    await t.test('at-capacity-450：单轮 → 退出码 0（两连同未达成，不唤醒）', () => {
      assert.ok(r1.status === 0, 'at-capacity-450：单轮 → 退出码 0（两连同未达成，不唤醒）  →  ' + `status=${r1.status}`);
    });
    await t.test('at-capacity-450：单轮不报 fingerprint', () => {
      assert.ok(!/fingerprint:/.test(r1.out), 'at-capacity-450：单轮不报 fingerprint  →  ' + r1.out.trim());
    });

    const r2 = runMultiRounds(path.join(FIXTURES, "real-incidents", "at-capacity-450"), 2, ["--self-worktree", SELF_WT]);
    await t.test('at-capacity-450：两轮同屏 → 退出码 1（两连同报警）', () => {
      assert.ok(r2.status === 1, 'at-capacity-450：两轮同屏 → 退出码 1（两连同报警）  →  ' + `status=${r2.status}`);
    });
    await t.test('at-capacity-450：第二轮报 fingerprint 命中 at capacity（现场实录第二轮到）', () => {
      assert.ok(/round 2\/2[\s\S]*\[#450 - 点将台综合稿\] fingerprint:.*at capacity/.test(r2.out), 'at-capacity-450：第二轮报 fingerprint 命中 at capacity（现场实录第二轮到）  →  ' + r2.out.trim());
    });
    const seg1 = (r2.out.match(/round 1\/2([\s\S]*?)(?:round 2\/2|$)/) || [])[1] || "";
    await t.test('at-capacity-450：第一轮不报（streak 1）', () => {
      assert.ok(!/fingerprint:/.test(seg1), 'at-capacity-450：第一轮不报（streak 1）  →  ' + r2.out.trim());
    });
    await t.test('at-capacity-450：处置矩阵动作行出现（#646：capacity 指纹首警即续命 #1，注入续命）', () => {
      assert.ok(/动作: 注入续命（#646：1\/5\/10 分钟各一次，共 3 次，第 4 次换人）：将发送「看门狗续命/.test(r2.out), 'at-capacity-450：处置矩阵动作行出现（#646：capacity 指纹首警即续命 #1，注入续命）  →  ' + r2.out.trim());
    });

    const r3 = runMultiRounds(path.join(FIXTURES, "real-incidents", "at-capacity"), 2);
    await t.test('at-capacity（审官实录）：两轮同屏 → 退出码 1', () => {
      assert.ok(r3.status === 1, 'at-capacity（审官实录）：两轮同屏 → 退出码 1  →  ' + `status=${r3.status}`);
    });
    await t.test('at-capacity（审官实录）：报 fingerprint 且命中 at capacity', () => {
      assert.ok(/\[#452 - 看门狗正式版\] fingerprint:.*at capacity/.test(r3.out), 'at-capacity（审官实录）：报 fingerprint 且命中 at capacity  →  ' + r3.out.trim());
    });

    const r4 = runWatchdog(path.join(FIXTURES, "real-incidents", "read-error"));
    await t.test('read-error 实录（terminal_handle_stale）：退出码 1', () => {
      assert.ok(r4.status === 1, 'read-error 实录（terminal_handle_stale）：退出码 1  →  ' + `status=${r4.status}`);
    });
    await t.test('read-error 实录：首轮 read-failed 且错误码透传（快照样本验规整逻辑；live 侧错误码由 runOrca 解析 stdout 保证同形态）', () => {
      assert.ok(/read-failed:.*terminal_handle_stale/.test(r4.out), 'read-error 实录：首轮 read-failed 且错误码透传（快照样本验规整逻辑；live 侧错误码由 runOrca 解析 stdout 保证同形态）  →  ' + r4.out.trim());
    });
  });

  it('④ exited 违规样本被拦', async (t) => {
    const r = runWatchdog(path.join(FIXTURES, "exited"));
    await t.test('退出码 1（有报警）', () => {
      assert.ok(r.status === 1, '退出码 1（有报警）  →  ' + `status=${r.status}`);
    });
    await t.test('输出 [#452 - 看门狗正式版] exited: 事件', () => {
      assert.ok(/\[#452 - 看门狗正式版\] exited:/.test(r.out), '输出 [#452 - 看门狗正式版] exited: 事件  →  ' + r.out.trim());
    });
  });

  it('⑤ 宽指纹退役（2026-08-15 裁定书：删单发即唤醒的 \'Error:\'/\'terminated\'/\'Connection error\' 类）', async (t) => {
    // 判别力：指纹一律两连同才报警，单轮本来就不响——退役断言必须用两轮同屏证明
    const r = runMultiRounds(path.join(FIXTURES, "fingerprint"), 2);
    await t.test('fingerprint 样本两轮同屏：退出码 0（\'terminated\' 已退役，两连同也不报）', () => {
      assert.ok(r.status === 0, 'fingerprint 样本两轮同屏：退出码 0（\'terminated\' 已退役，两连同也不报）  →  ' + `status=${r.status}`);
    });
    await t.test('fingerprint 样本两轮同屏：无 fingerprint 事件', () => {
      assert.ok(!/fingerprint:/.test(r.out), 'fingerprint 样本两轮同屏：无 fingerprint 事件  →  ' + r.out.trim());
    });
    await t.test('fingerprint 样本两轮同屏：OK 扫完（不是没查成）', () => {
      assert.ok(/OK 扫完 1 个工位/.test(r.out), 'fingerprint 样本两轮同屏：OK 扫完（不是没查成）  →  ' + r.out.trim());
    });

    const r2 = runMultiRounds(path.join(FIXTURES, "wide-fp-deleted"), 2);
    await t.test('wide-fp-deleted 两轮同屏：\'Error:\'/\'Connection error\' 不再报警 → 退出码 0', () => {
      assert.ok(r2.status === 0, 'wide-fp-deleted 两轮同屏：\'Error:\'/\'Connection error\' 不再报警 → 退出码 0  →  ' + `status=${r2.status}`);
    });
    await t.test('wide-fp-deleted 两轮同屏：宽指纹字样在屏面但不报', () => {
      assert.ok(!/fingerprint:/.test(r2.out), 'wide-fp-deleted 两轮同屏：宽指纹字样在屏面但不报  →  ' + r2.out.trim());
    });
  });

  it('⑥ waiting 官方信号样本被拦', async (t) => {
    const r = runWatchdog(path.join(FIXTURES, "waiting"));
    await t.test('退出码 1（有报警）', () => {
      assert.ok(r.status === 1, '退出码 1（有报警）  →  ' + `status=${r.status}`);
    });
    await t.test('输出 waiting: 事件', () => {
      assert.ok(/\[#452 - 看门狗正式版\] waiting:/.test(r.out), '输出 waiting: 事件  →  ' + r.out.trim());
    });
  });

  it('⑦ 停摆判据（#500 换代）：非 spinner 真实内容三轮不变——第 3 轮才报警', async (t) => {
    const r = runWatchdog(path.join(FIXTURES, "hash-stable"));
    await t.test('退出码 1（有报警）', () => {
      assert.ok(r.status === 1, '退出码 1（有报警）  →  ' + `status=${r.status}`);
    });
    await t.test('第 3 轮输出 stall 事件', () => {
      assert.ok(/\[#452 - 看门狗正式版\] stall:/.test(r.out), '第 3 轮输出 stall 事件  →  ' + r.out.trim());
    });
    await t.test('前两轮是 OK 汇总不是报警', () => {
      assert.ok((r.out.match(/OK 扫完 1 个工位/g) || []).length === 2, '前两轮是 OK 汇总不是报警  →  OK 行数不对');
    });
  });

  it('⑧ 判别力：ps updatedAt 前进不算活性（#500：转圈挂死时 ps 也可能在动）——第 3 轮即报', async (t) => {
    // hash-stable-activity 原样本：ps updatedAt 第 2 轮推进一次、真实内容不动。
    // 旧判据以 updatedAt 重启计数 → 第 4 轮才报；新判据只认非 spinner 真实内容 → 第 3 轮报。
    // 判别力：把 updatedAt 重新接回 epoch 会让断言变红（改坏自检）。
    const r = runWatchdog(path.join(FIXTURES, "hash-stable-activity"));
    const seg = (n) => (r.out.match(new RegExp(`round ${n}\\/4([\\s\\S]*?)(?:round \\d\\/4|$)`)) || [])[1] || "";
    await t.test('退出码 1（有报警）', () => {
      assert.ok(r.status === 1, '退出码 1（有报警）  →  ' + `status=${r.status}`);
    });
    await t.test('第 3 轮输出 stall（updatedAt 前进不重启计数）', () => {
      assert.ok(/\[#452 - 看门狗正式版\] stall:/.test(seg(3)), '第 3 轮输出 stall（updatedAt 前进不重启计数）  →  ' + r.out.trim());
    });
    await t.test('第 2 轮还是 OK（streak 2 未达阈值）', () => {
      assert.ok(/OK 扫完 1 个工位/.test(seg(2)) && !/stall:/.test(seg(2)), '第 2 轮还是 OK（streak 2 未达阈值）  →  第 2 轮不该报警');
    });
  });

  it('⑨ epoch 状态机：同 pane 重启（incarnation 变、内容不变）→ 重启轮重新起算，第 5 轮才报', async (t) => {
    const r = runWatchdog(path.join(FIXTURES, "hash-stable-restart"));
    const seg = (n) => (r.out.match(new RegExp(`round ${n}\\/5([\\s\\S]*?)(?:round \\d\\/5|$)`)) || [])[1] || "";
    await t.test('退出码 1（有报警）', () => {
      assert.ok(r.status === 1, '退出码 1（有报警）  →  ' + `status=${r.status}`);
    });
    await t.test('第 5 轮输出 stall（重启后 3 个同屏轮）', () => {
      assert.ok(/\[#452 - 看门狗正式版\] stall:/.test(seg(5)), '第 5 轮输出 stall（重启后 3 个同屏轮）  →  ' + r.out.trim());
    });
    await t.test('第 3 轮还是 OK（重启轮重新起算——判别力：把 epoch 去掉 incarnation 会在第 3 轮就报）', () => {
      assert.ok(/OK 扫完 1 个工位/.test(seg(3)) && !/stall:/.test(seg(3)), '第 3 轮还是 OK（重启轮重新起算——判别力：把 epoch 去掉 incarnation 会在第 3 轮就报）  →  第 3 轮不该报警');
    });
    await t.test('第 4 轮还是 OK（没串用旧计数）', () => {
      assert.ok(/OK 扫完 1 个工位/.test(seg(4)) && !/stall:/.test(seg(4)), '第 4 轮还是 OK（没串用旧计数）  →  第 4 轮不该报警');
    });
  });

  it('⑩ epoch 状态机：内容变了又变回 → 连击清零，永不报', async (t) => {
    const r = runWatchdog(path.join(FIXTURES, "hash-stable-screenchange"));
    await t.test('退出码 0（无报警）', () => {
      assert.ok(r.status === 0, '退出码 0（无报警）  →  ' + `status=${r.status}`);
    });
    await t.test('没有 stall 事件', () => {
      assert.ok(!/stall:/.test(r.out), '没有 stall 事件  →  ' + r.out.trim());
    });
  });

  it('⑪ NO_TARGETS 与 OK 的区分（数到 0 ≠ 没看到样本）', async (t) => {
    const r = runWatchdog(path.join(FIXTURES, "no-targets"));
    await t.test('退出码 2（NO_TARGETS）', () => {
      assert.ok(r.status === 2, '退出码 2（NO_TARGETS）  →  ' + `status=${r.status}`);
    });
    await t.test('明确打印 NO_TARGETS 警告', () => {
      assert.ok(/NO_TARGETS/.test(r.out), '明确打印 NO_TARGETS 警告  →  ' + r.out.trim());
    });
    await t.test('不打出 OK 汇总（不能把没查成说成查过没事）', () => {
      assert.ok(!/OK 扫完/.test(r.out), '不打出 OK 汇总（不能把没查成说成查过没事）  →  ' + r.out.trim());
    });
    await t.test('无关联单证据的树不误报孤儿（查不到≠孤儿，#492）', () => {
      assert.ok(!/orphan:/.test(r.out), '无关联单证据的树不误报孤儿（查不到≠孤儿，#492）  →  ' + r.out.trim());
    });
    await t.test('#602：in-review 待合并盘面不报 all-idle（该扩判已退役）', () => {
      assert.ok(!/all-idle:/.test(r.out), '#602：in-review 待合并盘面不报 all-idle（该扩判已退役）  →  ' + r.out.trim());
    });
  });

  it('⑫ --once 只跑单轮', async (t) => {
    const r = runWatchdog(path.join(FIXTURES, "hash-stable"), ["--once"]);
    await t.test('单轮退出码 0（第 1 轮无违规）', () => {
      assert.ok(r.status === 0, '单轮退出码 0（第 1 轮无违规）  →  ' + `status=${r.status}`);
    });
    await t.test('没有 round 2/3 标记（没跑后面的轮）', () => {
      assert.ok(!r.out.includes("round 2/3"), '没有 round 2/3 标记（没跑后面的轮）  →  ' + r.out.trim());
    });
  });

  it('⑬ read-failed fail-closed：成功响应缺 result.terminal → 首轮即报（红 3 修法）', async (t) => {
    const r = runWatchdog(path.join(FIXTURES, "read-malformed"));
    await t.test('退出码 1（有报警）', () => {
      assert.ok(r.status === 1, '退出码 1（有报警）  →  ' + `status=${r.status}`);
    });
    await t.test('首轮输出 read-failed', () => {
      assert.ok(/\[#452 - 看门狗正式版\] read-failed:/.test(r.out), '首轮输出 read-failed  →  ' + r.out.trim());
    });
  });

  it('⑬b read-failed fail-closed：runOrca 回落形态（stdout 非 JSON 的字符串错误）也透传', async (t) => {
    const r = runWatchdog(path.join(FIXTURES, "read-error-livefallback"));
    await t.test('退出码 1（有报警）', () => {
      assert.ok(r.status === 1, '退出码 1（有报警）  →  ' + `status=${r.status}`);
    });
    await t.test('首轮 read-failed 且回落字符串进详情（live 字符串分支有断言看着，审读红 ② 返工）', () => {
      assert.ok(/\[#452 - 看门狗正式版\] read-failed:.*exit 1/.test(r.out), '首轮 read-failed 且回落字符串进详情（live 字符串分支有断言看着，审读红 ② 返工）  →  ' + r.out.trim());
    });
  });

  it('⑭ 结构性排除（红 2 修法）：主工作区 / 自身 / 稳定 pane ID（2026-08-15 起 --exclude-pane 分级排除）', async (t) => {
    const ex = path.join(FIXTURES, "exclusion");
    const r1 = runMultiRounds(ex, 2);
    await t.test('不传排除：主工作区被排除，自身卡（指纹屏面）被监视，两轮同屏 → 退出码 1', () => {
      assert.ok(r1.status === 1, '不传排除：主工作区被排除，自身卡（指纹屏面）被监视，两轮同屏 → 退出码 1  →  ' + `status=${r1.status}`);
    });
    await t.test('不传排除：master 不在监视集合', () => {
      assert.ok(!r1.out.includes("master"), '不传排除：master 不在监视集合  →  ' + r1.out.trim());
    });
    await t.test('不传排除：#452 指纹屏面两连同报警（自身未排除时会报）', () => {
      assert.ok(/round 2\/2[\s\S]*\[#452 - 看门狗正式版\] fingerprint:/.test(r1.out), '不传排除：#452 指纹屏面两连同报警（自身未排除时会报）  →  ' + r1.out.trim());
    });

    const r2 = runWatchdog(ex, ["--self-worktree", "wt::self-card-452"]);
    await t.test('--self-worktree：自身卡被排除 → 只扫工人卡，退出码 0', () => {
      assert.ok(r2.status === 0, '--self-worktree：自身卡被排除 → 只扫工人卡，退出码 0  →  ' + `status=${r2.status}`);
    });
    await t.test('--self-worktree：OK 只含工人卡 #999', () => {
      assert.ok(/OK 扫完 1 个工位（#999 - 排除测试工人）/.test(r2.out), '--self-worktree：OK 只含工人卡 #999  →  ' + r2.out.trim());
    });
    await t.test('--self-worktree：不再报自身指纹（审官复现场景被结构性拦住）', () => {
      assert.ok(!/\[#452 - 看门狗正式版\] fingerprint:/.test(r2.out), '--self-worktree：不再报自身指纹（审官复现场景被结构性拦住）  →  ' + r2.out.trim());
    });

    const r3 = runWatchdog(ex, ["--self-worktree", "wt::self-card-452", "--exclude-pane", "worker-pane-999:leaf"]);
    await t.test('--exclude-pane：分级排除——工位仍被监视（保留死活判据）→ OK 扫完 1 个工位', () => {
      assert.ok(r3.status === 0 && /OK 扫完 1 个工位（#999 - 排除测试工人）/.test(r3.out), '--exclude-pane：分级排除——工位仍被监视（保留死活判据）→ OK 扫完 1 个工位  →  ' + `status=${r3.status} ${r3.out.trim()}`);
    });
    await t.test('--exclude-pane：不再 NO_TARGETS（旧版整体排除把工位整个摘掉=死活也没人盯）', () => {
      assert.ok(!/NO_TARGETS/.test(r3.out), '--exclude-pane：不再 NO_TARGETS（旧版整体排除把工位整个摘掉=死活也没人盯）  →  ' + r3.out.trim());
    });
  });

  it('⑮ 检测不依赖工人自报（删掉 lastAssistantMessage 依旧报警）', async (t) => {
    // 在临时目录复制 exited 样本，把 ps.json 里全部 lastAssistantMessage 清掉再跑
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "watchdog-noself-"));
    (function copyDir(src, dst) {
      fs.mkdirSync(dst, { recursive: true });
      for (const f of fs.readdirSync(src)) {
        const s = path.join(src, f);
        if (fs.statSync(s).isDirectory()) copyDir(s, path.join(dst, f));
        else fs.copyFileSync(s, path.join(dst, f));
      }
    })(path.join(FIXTURES, "exited"), tmp);
    const psPath = path.join(tmp, "ps.json");
    const ps = JSON.parse(fs.readFileSync(psPath, "utf8"));
    for (const w of ps.result.worktrees) for (const a of w.agents) delete a.lastAssistantMessage;
    fs.writeFileSync(psPath, JSON.stringify(ps, null, 2), "utf8");
    const r = runWatchdog(tmp);
    await t.test('退出码 1（有报警）', () => {
      assert.ok(r.status === 1, '退出码 1（有报警）  →  ' + `status=${r.status}`);
    });
    await t.test('exited 报警照常触发', () => {
      assert.ok(/\[#452 - 看门狗正式版\] exited:/.test(r.out), 'exited 报警照常触发  →  ' + r.out.trim());
    });
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('⑯ 判别性实验（#500）：转圈假工人——spinner 重绘 + cursor 前进 + ps updatedAt 前进', async (t) => {
    // spinner-hang/：三轮真实内容完全不动，spinner 帧轮换、nextCursor 前进、ps updatedAt 前进。
    // 旧判据（cursor 增量/整屏哈希/ps updatedAt）：全放行 → 瞎（这就是 #500 当天三种探头全瞎的复现）。
    // 新判据（非 spinner 内容哈希）：第 3 轮 stall。
    const r = runWatchdog(path.join(FIXTURES, "spinner-hang"));
    await t.test('退出码 1（新判据当场抓住）', () => {
      assert.ok(r.status === 1, '退出码 1（新判据当场抓住）  →  ' + `status=${r.status}`);
    });
    await t.test('第 3 轮输出 stall 事件', () => {
      assert.ok(/round 3\/3[\s\S]*\[#452 - 看门狗正式版\] stall:/.test(r.out), '第 3 轮输出 stall 事件  →  ' + r.out.trim());
    });
    await t.test('前两轮是 OK（streak 1/2 未达阈值）', () => {
      assert.ok((r.out.match(/OK 扫完 1 个工位/g) || []).length === 2, '前两轮是 OK（streak 1/2 未达阈值）  →  OK 行数不对');
    });
    // 判别力自检：把 spinner 剔除逻辑改坏（比如直接用整屏哈希）→ spinner 帧轮换让哈希每轮都变 → 永不报 → 本条断言变红。
    // 原始输出（判别性实验 2）已贴 PR #505 正文。

    // 负对照：真实内容逐轮变化 + spinner 也在转 → 健康工人不误报
    const ra = runWatchdog(path.join(FIXTURES, "real-advance"));
    await t.test('real-advance：退出码 0（真实内容在动 = 活着）', () => {
      assert.ok(ra.status === 0, 'real-advance：退出码 0（真实内容在动 = 活着）  →  ' + `status=${ra.status}`);
    });
    await t.test('real-advance：不报 stall', () => {
      assert.ok(!/stall:/.test(ra.out), 'real-advance：不报 stall  →  ' + ra.out.trim());
    });
  });

  it('⑰ 空转强判据（#471 第四类事故）：进程在动但工作树 N 分钟无 git 活动', async (t) => {
    const r = runWatchdog(path.join(FIXTURES, "idle"), ["--once", "--now", String(NOW)]);
    await t.test('idle：退出码 1（空转报警）', () => {
      assert.ok(r.status === 1, 'idle：退出码 1（空转报警）  →  ' + `status=${r.status}`);
    });
    await t.test('idle：输出 idle 事件且带 git 证据分钟数', () => {
      assert.ok(/\[#452 - 看门狗正式版\] idle:.*30 分钟无 git 活动/.test(r.out), 'idle：输出 idle 事件且带 git 证据分钟数  →  ' + r.out.trim());
    });

    const rf = runWatchdog(path.join(FIXTURES, "idle-fresh"), ["--once", "--now", String(NOW)]);
    await t.test('idle-fresh：5 分钟内有活动 → 退出码 0', () => {
      assert.ok(rf.status === 0, 'idle-fresh：5 分钟内有活动 → 退出码 0  →  ' + `status=${rf.status}`);
    });
    await t.test('idle-fresh：不报 idle', () => {
      assert.ok(!/idle:/.test(rf.out), 'idle-fresh：不报 idle  →  ' + rf.out.trim());
    });
  });

  it('⑰a #569 降噪①（角色判据）：审官/辅助子卡不判 git 空转（#568 审官案例同类）', async (t) => {
    const r = runWatchdog(path.join(FIXTURES, "idle-reviewer"), ["--once", "--now", String(NOW)]);
    await t.test('idle-reviewer：退出码 0（子卡豁免，不再是假阳）', () => {
      assert.ok(r.status === 0, 'idle-reviewer：退出码 0（子卡豁免，不再是假阳）  →  ' + `status=${r.status}`);
    });
    await t.test('idle-reviewer：不报 idle（审官产出是 review comment 与 notify 不是 commit）', () => {
      assert.ok(!/idle:/.test(r.out), 'idle-reviewer：不报 idle（审官产出是 review comment 与 notify 不是 commit）  →  ' + r.out.trim());
    });
    await t.test('idle-reviewer：打角色豁免观察行（判据可见）', () => {
      assert.ok(/\[#455 - 审官·grok-4.6\] 观察: 子卡（parentWorktreeId 非空）不判 git 空转/.test(r.out), 'idle-reviewer：打角色豁免观察行  →  ' + r.out.trim());
    });
  });

  it('⑰a2 #589 判别实验：卡名改成 zzz，四处判定不变', async (t) => {
    function copyRound(src, dst, mutator) {
      fs.mkdirSync(dst, { recursive: true });
      for (const f of fs.readdirSync(src)) {
        const from = path.join(src, f);
        const to = path.join(dst, f);
        if (fs.statSync(from).isDirectory()) continue;
        if (f === 'ps.json' && mutator) {
          const doc = JSON.parse(fs.readFileSync(from, 'utf8'));
          mutator(doc);
          fs.writeFileSync(to, JSON.stringify(doc, null, 2));
        } else {
          fs.copyFileSync(from, to);
        }
      }
    }

    const zzzRev = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-zzz-rev-'));
    copyRound(path.join(FIXTURES, 'idle-reviewer', 'round-1'), path.join(zzzRev, 'round-1'), (doc) => {
      for (const w of doc.result.worktrees) {
        if (w.displayName === '#455 - 审官·grok-4.6') w.displayName = 'zzz';
      }
    });
    const zr = runWatchdog(zzzRev, ['--once', '--now', String(NOW)]);
    fs.rmSync(zzzRev, { recursive: true, force: true });
    await t.test('审官卡改名 zzz：仍豁免 git 空转（不读卡名）', () => {
      assert.ok(zr.status === 0 && !/idle:/.test(zr.out), zr.out.trim());
    });
    await t.test('审官卡改名 zzz：豁免观察行还在', () => {
      assert.ok(/\[zzz\] 观察: 子卡（parentWorktreeId 非空）不判 git 空转/.test(zr.out), zr.out.trim());
    });

    const zzzWorker = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-zzz-w-'));
    copyRound(path.join(FIXTURES, 'idle', 'round-1'), path.join(zzzWorker, 'round-1'), (doc) => {
      for (const w of doc.result.worktrees) {
        if (w.displayName === '#452 - 看门狗正式版') w.displayName = 'zzz';
      }
    });
    const zw = runWatchdog(zzzWorker, ['--once', '--now', String(NOW)]);
    fs.rmSync(zzzWorker, { recursive: true, force: true });
    await t.test('工人卡改名 zzz：仍报 idle（顶层不豁免）', () => {
      assert.ok(zw.status === 1 && /\[zzz\] idle:/.test(zw.out), zw.out.trim());
    });
  });

  it('⑰b #569 降噪②（在途 PR 豁免）：已交付等下一环的工位不算空转', async (t) => {
    const re = runWatchdog(path.join(FIXTURES, "idle-pr-exempt"), ["--once", "--now", String(NOW)]);
    await t.test('idle-pr-exempt（OPEN 非 draft APPROVED）：退出码 0（在途 PR 等着别人 = 不算空转）', () => {
      assert.ok(re.status === 0, 'idle-pr-exempt（OPEN 非 draft APPROVED）：退出码 0（在途 PR 等着别人 = 不算空转）  →  ' + `status=${re.status}`);
    });
    await t.test('idle-pr-exempt：不报 idle', () => {
      assert.ok(!/idle:/.test(re.out), 'idle-pr-exempt：不报 idle  →  ' + re.out.trim());
    });
    await t.test('idle-pr-exempt：打在途 PR 观察行（判据可见）', () => {
      assert.ok(/观察: 在途 PR #999（OPEN 非 draft，APPROVED）等着别人/.test(re.out), 'idle-pr-exempt：打在途 PR 观察行（判据可见）  →  ' + re.out.trim());
    });

    const rr = runWatchdog(path.join(FIXTURES, "idle-pr-rework"), ["--once", "--now", String(NOW)]);
    await t.test('idle-pr-rework（CHANGES_REQUESTED 要返工）：退出码 1（责任仍在本工位，真阳不减）', () => {
      assert.ok(rr.status === 1, 'idle-pr-rework（CHANGES_REQUESTED 要返工）：退出码 1（责任仍在本工位，真阳不减）  →  ' + `status=${rr.status}`);
    });
    await t.test('idle-pr-rework：idle 照报', () => {
      assert.ok(/\[#999 - 返工PR测试\] idle:/.test(rr.out), 'idle-pr-rework：idle 照报  →  ' + rr.out.trim());
    });
  });

  it('⑰c #569 降噪③（活性否决）：非 spinner 真实内容在动 = 不算空转（#500 一致性）', async (t) => {
    // 三轮：第 1 轮冻结（git 空置）→ idle 报；第 2 轮真实内容在动 → 豁免（刚重启正在开 PR 的形态）；
    // 第 3 轮内容又冻结 → idle 再报。判别力：把否决删掉 → 第 2 轮把 idle 再报一遍 → 断言变红。
    const r = runWatchdog(path.join(FIXTURES, "idle-veto"), ["--now", String(NOW)]);
    const seg = (n) => (r.out.match(new RegExp(`round ${n}\\/3([\\s\\S]*?)(?:round \\d\\/3|$)`)) || [])[1] || "";
    await t.test('退出码 1（有报警）', () => {
      assert.ok(r.status === 1, '退出码 1（有报警）  →  ' + `status=${r.status}`);
    });
    await t.test('第 1 轮：idle 报（屏面冻结 + git 空置）', () => {
      assert.ok(/idle:/.test(seg(1)), '第 1 轮：idle 报（屏面冻结 + git 空置）  →  ' + seg(1).trim());
    });
    await t.test('第 2 轮：不报 idle，打活性否决观察行', () => {
      assert.ok(!/idle:/.test(seg(2)) && /观察: 空转豁免：非 spinner 真实内容在动——活性否决/.test(seg(2)), '第 2 轮：不报 idle，打活性否决观察行  →  ' + seg(2).trim());
    });
    await t.test('第 3 轮：内容冻结回来 → idle 再报（豁免不是永久放行）', () => {
      assert.ok(/idle:/.test(seg(3)), '第 3 轮：内容冻结回来 → idle 再报（豁免不是永久放行）  →  ' + seg(3).trim());
    });
  });

  it('⑱ 孤儿树判据（#492/#476）：还有没有活跃执行者，跨主帅不误伤', async (t) => {
    const rc = runWatchdog(path.join(FIXTURES, "orphan-closed"), ["--once"]);
    await t.test('真孤儿（无活跃执行者 + 关联 issue 已关 + 终端已关）：退出码 1', () => {
      assert.ok(rc.status === 1, '真孤儿（无活跃执行者 + 关联 issue 已关 + 终端已关）：退出码 1  →  ' + `status=${rc.status}`);
    });
    await t.test('真孤儿：输出 orphan 事件且带判断依据', () => {
      assert.ok(/\[#483 - 调研单\] orphan:.*关联 issue 483/.test(rc.out), '真孤儿：输出 orphan 事件且带判断依据  →  ' + rc.out.trim());
    });

    const ro = runWatchdog(path.join(FIXTURES, "orphan-open"), ["--once"]);
    await t.test('关联单还开着：不报 orphan（#492 v3：任一开着就不算孤儿）', () => {
      assert.ok(!/orphan:/.test(ro.out), '关联单还开着：不报 orphan（#492 v3：任一开着就不算孤儿）  →  ' + ro.out.trim());
    });

    const ra = runWatchdog(path.join(FIXTURES, "orphan-active"), ["--once"]);
    await t.test('另一位主帅的活跃工位（working agent）：退出码 0 且不报 orphan（#492 关条件 3）', () => {
      assert.ok(ra.status === 0 && !/orphan:/.test(ra.out), '另一位主帅的活跃工位（working agent）：退出码 0 且不报 orphan（#492 关条件 3）  →  ' + `status=${ra.status} ${ra.out.trim()}`);
    });

    const rs = runWatchdog(path.join(FIXTURES, "orphan-noassoc-stale"), ["--once"]);
    await t.test('无关联 + 静置超 60 分钟：退出码 1（孤儿候选）', () => {
      assert.ok(rs.status === 1, '无关联 + 静置超 60 分钟：退出码 1（孤儿候选）  →  ' + `status=${rs.status}`);
    });
    await t.test('无关联 + 静置超阈值：输出 orphan 且带静置分钟数', () => {
      assert.ok(/orphan:.*无关联.*静置 \d+ 分钟/.test(rs.out), '无关联 + 静置超阈值：输出 orphan 且带静置分钟数  →  ' + rs.out.trim());
    });

    const rf = runWatchdog(path.join(FIXTURES, "orphan-noassoc-fresh"), ["--once"]);
    await t.test('无关联 + 静置 5 分钟：不报 orphan（未超阈值）', () => {
      assert.ok(!/orphan:/.test(rf.out), '无关联 + 静置 5 分钟：不报 orphan（未超阈值）  →  ' + rf.out.trim());
    });
  });

  it('⑱b #630 孤儿树接真删：dispose on 真调 --force；off/默认快照只打印不真删', async (t) => {
    const FAKE_RM = path.join(REPO, 'tests', 'fixtures', 'fake-worktree-rm.mjs');
    const ORPHAN_CLOSED = path.join(FIXTURES, 'orphan-closed');
    const ORPHAN_OPEN = path.join(FIXTURES, 'orphan-open');
    const ORPHAN_ID = '1770a430-983a-4e86-9277-9f1e5c376b83::C:/Users/Administrator/orca/workspaces/windsurf-dao/看门狗正式版';

    function runWithHook(dir, extraArgs = []) {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'watchdog-orphan-rm-'));
      const mark = path.join(tmp, 'tree');
      const log = path.join(tmp, 'rm.log');
      fs.mkdirSync(mark);
      fs.writeFileSync(path.join(mark, 'keep'), 'x');
      const r = spawnSync(process.execPath, [WATCHDOG, '--snapshot-dir', dir, '--once', ...extraArgs], {
        encoding: 'utf8',
        cwd: REPO,
        env: {
          ...process.env,
          WATCHDOG_ORPHAN_RM: FAKE_RM,
          WATCHDOG_ORPHAN_RM_LOG: log,
          WATCHDOG_ORPHAN_RM_MARK: mark,
        },
      });
      return {
        status: r.status,
        out: (r.stdout || '') + (r.stderr || ''),
        markExists: fs.existsSync(mark),
        log: fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '',
        fixtureExists: fs.existsSync(path.join(dir, 'round-1', 'ps.json')),
        tmp,
      };
    }

    const dry = runWatchdog(ORPHAN_CLOSED, ['--once']);
    await t.test('默认快照：真孤儿打印「将执行 worktree-rm」，不写「已清理」', () => {
      assert.ok(
        /动作: 将执行 worktree-rm --worktree .+ --force/.test(dry.out) && !/已清理/.test(dry.out),
        '默认快照：真孤儿打印「将执行 worktree-rm」，不写「已清理」  →  ' + dry.out.trim(),
      );
    });
    await t.test('默认快照：夹具树还在（没调真 worktree-rm）', () => {
      assert.ok(
        fs.existsSync(path.join(ORPHAN_CLOSED, 'round-1', 'ps.json')),
        '默认快照：夹具树还在（没调真 worktree-rm）  →  夹具丢了',
      );
    });

    const hit = runWithHook(ORPHAN_CLOSED);
    await t.test('真孤儿 + 测试钩：退出码 1 且 events 有「已清理」', () => {
      assert.ok(
        hit.status === 1 && /动作: 已清理：worktree-rm --force /.test(hit.out),
        '真孤儿 + 测试钩：退出码 1 且 events 有「已清理」  →  ' + `status=${hit.status} ${hit.out.trim()}`,
      );
    });
    await t.test('真孤儿 + 测试钩：调用带 --force，标记树被删掉', () => {
      assert.ok(
        hit.log.includes(`--worktree ${ORPHAN_ID} --force`) && hit.markExists === false,
        '真孤儿 + 测试钩：调用带 --force，标记树被删掉  →  ' + JSON.stringify({ log: hit.log, markExists: hit.markExists }),
      );
    });
    await t.test('真孤儿 + 测试钩：快照夹具目录仍在（删的是标记树，不是语料）', () => {
      assert.ok(hit.fixtureExists, '真孤儿 + 测试钩：快照夹具目录仍在（删的是标记树，不是语料）');
    });
    fs.rmSync(hit.tmp, { recursive: true, force: true });

    const miss = runWithHook(ORPHAN_OPEN);
    await t.test('假孤儿（关联单还开着）：不调 worktree-rm，标记树还在', () => {
      assert.ok(
        !/worktree-rm/.test(miss.out) && !/已清理/.test(miss.out) && miss.markExists === true && miss.log === '',
        '假孤儿（关联单还开着）：不调 worktree-rm，标记树还在  →  ' + JSON.stringify({
          markExists: miss.markExists,
          log: miss.log,
          out: miss.out.trim(),
        }),
      );
    });
    fs.rmSync(miss.tmp, { recursive: true, force: true });

    const off = runWithHook(ORPHAN_CLOSED, ['--dispose-actions', 'off']);
    await t.test('--dispose-actions off：只打印将执行，不真删（钩未跑、标记树还在）', () => {
      assert.ok(
        /动作: 将执行 worktree-rm/.test(off.out)
          && !/已清理：/.test(off.out)
          && off.markExists === true
          && off.log === '',
        '--dispose-actions off：只打印将执行，不真删  →  ' + JSON.stringify({
          markExists: off.markExists,
          log: off.log,
          out: off.out.trim(),
        }),
      );
    });
    fs.rmSync(off.tmp, { recursive: true, force: true });
  });

  it('⑱c #652 扫描器按 gh MERGED 关树：有 PR 关联的树只认 MERGED 判删', async (t) => {
    const FAS_TR = path.join(REPO, 'tests', 'fixtures', 'fake-worktree-rm.mjs');
    function run(dir) {
      return runWatchdog(path.join(FIXTURES, dir), ['--once']);
    }
    function runWithHook(dir) {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'watchdog-pr-rm-'));
      const mark = path.join(tmp, 'tree');
      const log = path.join(tmp, 'rm.log');
      fs.mkdirSync(mark);
      fs.writeFileSync(path.join(mark, 'keep'), 'x');
      const r = spawnSync(process.execPath, [WATCHDOG, '--snapshot-dir', path.join(FIXTURES, dir), '--once'], {
        encoding: 'utf8', cwd: REPO, env: {
          ...process.env,
          WATCHDOG_ORPHAN_RM: FAS_TR,
          WATCHDOG_ORPHAN_RM_LOG: log,
          WATCHDOG_ORPHAN_RM_MARK: mark,
        },
      });
      return {
        out: (r.stdout || '') + (r.stderr || ''),
        markExists: fs.existsSync(mark),
        log: fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '',
        tmp,
      };
    }

    const merged = run('orphan-pr-merged');
    await t.test('PR MERGED → 退出码 1 且报 orphan（#652 判删）', () => {
      assert.ok(merged.status === 1 && /orphan:.*已合并（gh state==MERGED）/.test(merged.out), 'PR MERGED → 退出码 1 且报 orphan  →  ' + merged.out.trim());
    });
    await t.test('PR MERGED → 打 worktree-rm 动作行（默认快照只打印）', () => {
      assert.ok(/动作: 将执行 worktree-rm --worktree .+ --force/.test(merged.out), 'PR MERGED → 打 worktree-rm 动作行  →  ' + merged.out.trim());
    });

    const open = run('orphan-pr-open');
    await t.test('PR OPEN → 不报 orphan、不打 rm（#652：不是 MERGED 不删）', () => {
      assert.ok(!/orphan:/.test(open.out) && !/worktree-rm/.test(open.out), 'PR OPEN → 不报 orphan、不打 rm  →  ' + open.out.trim());
    });

    const closed = run('orphan-pr-closed');
    await t.test('PR CLOSED（未合）→ 不报 orphan、不打 rm（#652：CLOSED 不算 MERGED）', () => {
      assert.ok(!/orphan:/.test(closed.out) && !/worktree-rm/.test(closed.out), 'PR CLOSED → 不报 orphan、不打 rm  →  ' + closed.out.trim());
    });

    const unscanned = run('orphan-pr-unscanned');
    await t.test('gh 没查成（快照缺 prState）→ PR_STATE_UNSCANNED note，不报 orphan、不打 rm（fail-closed）', () => {
      assert.ok(/PR_STATE_UNSCANNED/.test(unscanned.out) && !/orphan:/.test(unscanned.out) && !/worktree-rm/.test(unscanned.out), 'gh 没查成 → 不删  →  ' + unscanned.out.trim());
    });

    const nameonly = run('orphan-pr-nameonly');
    await t.test('审官子卡 linkedPR=null 但卡名带 PR-#N → 也认 PR 号，MERGED → 判删', () => {
      assert.ok(/\[PR-#777 审官·grok-4.6\] orphan:.*已合并（gh state==MERGED）/.test(nameonly.out), '审官子卡卡名 PR-#N 也认  →  ' + nameonly.out.trim());
    });

    const parent = runWithHook('orphan-pr-parent-open-child-merged');
    await t.test('父树挂未合 PR → 只拆已合子卡，父树不删（#652）', () => {
      assert.ok(
        /\[PR-#101 工人·deepseek-v4-flash 分块1\] orphan:.*已合并/.test(parent.out)
          && !/\[PR-#200 工人·grok-4.6 拆分协调.*orphan:/.test(parent.out),
        '父树挂未合 PR → 只拆已合子卡  →  ' + parent.out.trim(),
      );
    });
    await t.test('子卡 MERGED → 只对子卡调 worktree-rm，不碰父卡', () => {
      assert.ok(
        parent.log.includes('--worktree 1770a430-983a-4e86-9277-9f1e5c376b83::C:/Users/Administrator/orca/workspaces/windsurf-dao/101-w1 --force')
          && !parent.log.includes('200-head'),
        '子卡 MERGED → 只对子卡调 worktree-rm  →  ' + JSON.stringify({ log: parent.log, markExists: parent.markExists }),
      );
    });
    fs.rmSync(parent.tmp, { recursive: true, force: true });
  });

  it('⑲ 命名校验（#476）：任务卡显示名格式', async (t) => {
    const r = runWatchdog(path.join(FIXTURES, "naming-bad"), ["--once"]);
    await t.test('不合规卡名：退出码 1（naming 报警）', () => {
      assert.ok(r.status === 1, '不合规卡名：退出码 1（naming 报警）  →  ' + `status=${r.status}`);
    });
    await t.test('输出 naming 事件且带卡名', () => {
      assert.ok(/\[审官·GPT\] naming:.*审官·GPT/.test(r.out), '输出 naming 事件且带卡名  →  ' + r.out.trim());
    });
    await t.test('命名违规但终端在跑的树不报 orphan（活跃执行者判据优先）', () => {
      assert.ok(!/orphan:/.test(r.out), '命名违规但终端在跑的树不报 orphan（活跃执行者判据优先）  →  ' + r.out.trim());
    });
  });

  it('⑳ flow 心跳消费端（#471 停滞态/flow 停摆；契约 #497 立约；#580 从未存在）', async (t) => {
    const rs = runWatchdog(path.join(FIXTURES, "heartbeat-stale"), ["--once", "--now", String(NOW)]);
    await t.test('心跳 10 分钟未更新：退出码 1（flow 停摆候选）', () => {
      assert.ok(rs.status === 1, '心跳 10 分钟未更新：退出码 1（flow 停摆候选）  →  ' + `status=${rs.status}`);
    });
    await t.test('心跳过期三态话：flow-stalled 含「心跳过期」', () => {
      assert.ok(/\[flow\] flow-stalled:.*心跳过期.*10 分钟未更新/.test(rs.out), '心跳过期三态话：flow-stalled 含「心跳过期」  →  ' + rs.out.trim());
    });

    const rp = runWatchdog(path.join(FIXTURES, "heartbeat-pending"), ["--once", "--now", String(NOW)]);
    await t.test('在途 PR 停留 40 分钟：退出码 1（停滞态：该发生而没发生）', () => {
      assert.ok(rp.status === 1, '在途 PR 停留 40 分钟：退出码 1（停滞态：该发生而没发生）  →  ' + `status=${rp.status}`);
    });
    await t.test('在途 PR 停留超阈值：输出 stagnation 且带 state', () => {
      assert.ok(/\[PR#456\] stagnation:.*state=approved.*40 分钟/.test(rp.out), '在途 PR 停留超阈值：输出 stagnation 且带 state  →  ' + rp.out.trim());
    });

    const rf = runWatchdog(path.join(FIXTURES, "heartbeat-fresh"), ["--once", "--now", String(NOW)]);
    await t.test('心跳新鲜 + 无停滞 PR：不报 flow-stalled/stagnation', () => {
      assert.ok(!/flow-stalled:/.test(rf.out) && !/stagnation:/.test(rf.out), '心跳新鲜 + 无停滞 PR：不报 flow-stalled/stagnation  →  ' + rf.out.trim());
    });
    await t.test('心跳新鲜三态话', () => {
      assert.ok(/心跳新鲜/.test(rf.out), '心跳新鲜三态话  →  ' + rf.out.trim());
    });
    await t.test('心跳缺失且待流转没查成：HEARTBEAT_MISSING（不是查过没事）', () => {
      assert.ok(/HEARTBEAT_MISSING/.test(runWatchdog(path.join(FIXTURES, "live"), ["--once"]).out), '心跳缺失且待流转没查成：HEARTBEAT_MISSING（不是查过没事）  →  live/ 快照无 heartbeat.json 应显形');
    });

    const ap = runWatchdog(path.join(FIXTURES, "heartbeat-absent-pending"), ["--once"]);
    await t.test('无心跳 + 有待流转（红判定待返工注入）：退出码 1', () => {
      assert.ok(ap.status === 1, '无心跳 + 有待流转（红判定待返工注入）：退出码 1  →  ' + `status=${ap.status}`);
    });
    await t.test('无心跳 + 有待流转：报 flow-absent 心跳从未存在', () => {
      assert.ok(/\[flow\] flow-absent:.*心跳从未存在.*待流转/.test(ap.out), '无心跳 + 有待流转：报 flow-absent 心跳从未存在  →  ' + ap.out.trim());
    });
    await t.test('无心跳 + 有待流转：不报 flow-stalled（过期和从未存在分得开）', () => {
      assert.ok(!/flow-stalled:/.test(ap.out), '无心跳 + 有待流转：不报 flow-stalled（过期和从未存在分得开）  →  ' + ap.out.trim());
    });

    const ai = runWatchdog(path.join(FIXTURES, "heartbeat-absent-idle"), ["--once"]);
    await t.test('无心跳 + 无待流转（已绿待帅）：不报 flow-absent/flow-stalled', () => {
      assert.ok(!/flow-absent:/.test(ai.out) && !/flow-stalled:/.test(ai.out), '无心跳 + 无待流转（已绿待帅）：不报 flow-absent/flow-stalled  →  ' + ai.out.trim());
    });
    await t.test('无心跳 + 无待流转：心跳从未存在但不报', () => {
      assert.ok(/心跳从未存在.*无待流转对象，不报/.test(ai.out), '无心跳 + 无待流转：心跳从未存在但不报  →  ' + ai.out.trim());
    });

    const tp = runWatchdog(path.join(FIXTURES, "heartbeat-absent-ticket-pending"), ["--once"]);
    await t.test('PR#582≠issue#580：署名 issue 完工 + 红判定 → 报 flow-absent', () => {
      assert.ok(/\[flow\] flow-absent:.*心跳从未存在/.test(tp.out), 'PR#582≠issue#580：署名 issue 完工 + 红判定 → 报 flow-absent  →  ' + tp.out.trim());
    });
    const ti = runWatchdog(path.join(FIXTURES, "heartbeat-absent-ticket-idle"), ["--once"]);
    await t.test('PR#582≠issue#580：完工只在 PR 会话 → 不报', () => {
      assert.ok(!/flow-absent:/.test(ti.out) && /心跳从未存在.*无待流转对象/.test(ti.out), 'PR#582≠issue#580：完工只在 PR 会话 → 不报  →  ' + ti.out.trim());
    });
  });

  it('⑳r #595 守卫版本闸（heartbeat.revision 三态）', async (t) => {
    const behind = runWatchdog(path.join(FIXTURES, "heartbeat-revision-behind"), ["--once", "--now", String(NOW)]);
    await t.test('落后 1 个 commit：报 stale-code', () => {
      assert.ok(/\[flow\] stale-code:.*落后 origin\/master 1 个 commit/.test(behind.out), '落后 1 个 commit：报 stale-code  →  ' + behind.out.trim());
    });
    await t.test('落后样本不含「已是最新」', () => {
      assert.ok(!/已是最新/.test(behind.out), '落后样本不含「已是最新」  →  ' + behind.out.trim());
    });

    const current = runWatchdog(path.join(FIXTURES, "heartbeat-revision-current"), ["--once", "--now", String(NOW)]);
    await t.test('已是最新：不报 stale-code', () => {
      assert.ok(!/stale-code:/.test(current.out), '已是最新：不报 stale-code  →  ' + current.out.trim());
    });

    const unknown = runWatchdog(path.join(FIXTURES, "heartbeat-revision-unknown"), ["--once", "--now", String(NOW)]);
    await t.test('fetch 失败：报查不成', () => {
      assert.ok(/\[flow\] stale-code:.*查不成/.test(unknown.out), 'fetch 失败：报查不成  →  ' + unknown.out.trim());
    });
    await t.test('查不成不含「已是最新」', () => {
      assert.ok(!/已是最新/.test(unknown.out), '查不成不含「已是最新」  →  ' + unknown.out.trim());
    });
  });

  it('⑳k #575 ① 真实故障注入：跑 flow 写心跳 → 停写（kill）→ 5 分钟报 flow-stalled', async (t) => {
    // 硬证据：心跳必须是 flow.mjs 自己写的，不是测试手搓 JSON。
    // kill = 只跑一轮然后不再跑（停写）。阈值 = heartbeatStaleMs = 5 分钟。
    // 不真睡 5 分钟：用 --now 把「现在」拨过阈值。报警必须是 [flow] flow-stalled / 5 分钟未更新。
    const FLOW = path.join(REPO, "scripts", "flow.mjs");
    const FLOW_FIXTURE = path.join(REPO, "tests", "flow-fixtures", "no-open");
    const STALE_MS = 5 * 60 * 1000;
    const tmpFlow = fs.mkdtempSync(path.join(os.tmpdir(), "wd-kill-flow-src-"));
    const stateFile = path.join(tmpFlow, "state.json");
    const flowRun = spawnSync(process.execPath, [
      FLOW, "--snapshot-dir", FLOW_FIXTURE, "--state-file", stateFile, "--dry-run",
    ], { encoding: "utf8", cwd: REPO });
    const hbFile = path.join(tmpFlow, "heartbeat.json");
    let hb = null;
    try { hb = JSON.parse(fs.readFileSync(hbFile, "utf8")); } catch { hb = null; }
    const tWrite = hb && Date.parse(hb.ts);
    await t.test('kill 前：flow.mjs 真写下 heartbeat.json（含可解析 ts）',
      () => {
        assert.ok(fs.existsSync(hbFile) && Number.isFinite(tWrite),
          'kill 前：flow.mjs 真写下 heartbeat.json（含可解析 ts）  →  ' + `status=${flowRun.status} hb=${JSON.stringify(hb)}`);
      });

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wd-kill-flow-"));
    const src = path.join(FIXTURES, "heartbeat-fresh", "round-1");
    for (const f of fs.readdirSync(src)) {
      const s = path.join(src, f);
      if (fs.statSync(s).isFile()) fs.copyFileSync(s, path.join(tmp, f));
    }
    if (fs.existsSync(hbFile)) fs.copyFileSync(hbFile, path.join(tmp, "heartbeat.json"));

    if (!Number.isFinite(tWrite)) {
      await t.test('kill 后 1s：不报 flow-stalled', () => {
        assert.ok(false, 'kill 后 1s：不报 flow-stalled  →  flow 没写下可解析心跳，后续注入无法跑');
      });
      await t.test('刚好 5 分钟还不报', () => {
        assert.ok(false, '刚好 5 分钟还不报  →  跳过');
      });
      await t.test('kill 后超过 5 分钟：退出码 1', () => {
        assert.ok(false, 'kill 后超过 5 分钟：退出码 1  →  跳过');
      });
      await t.test('kill 后超过 5 分钟：输出 [flow] flow-stalled', () => {
        assert.ok(false, 'kill 后超过 5 分钟：输出 [flow] flow-stalled  →  跳过');
      });
      await t.test('报警写得出停了几分钟（5 分钟）', () => {
        assert.ok(false, '报警写得出停了几分钟（5 分钟）  →  跳过');
      });
    } else {
      const alive = runWatchdog(tmp, ["--once", "--now", String(tWrite + 1000)]);
      await t.test('kill 后 1s（心跳仍新鲜）：不报 flow-stalled', () => {
        assert.ok(!/flow-stalled:/.test(alive.out), 'kill 后 1s（心跳仍新鲜）：不报 flow-stalled  →  ' + alive.out.trim());
      });

      const atThreshold = runWatchdog(tmp, ["--once", "--now", String(tWrite + STALE_MS)]);
      await t.test('刚好 5 分钟（now-ts == 阈值）：还不报（判据是 > 不是 >=）', () => {
        assert.ok(!/flow-stalled:/.test(atThreshold.out), '刚好 5 分钟（now-ts == 阈值）：还不报（判据是 > 不是 >=）  →  ' + atThreshold.out.trim());
      });

      const killed = runWatchdog(tmp, ["--once", "--now", String(tWrite + STALE_MS + 1)]);
      await t.test('kill 后超过 5 分钟：退出码 1', () => {
        assert.ok(killed.status === 1, 'kill 后超过 5 分钟：退出码 1  →  ' + `status=${killed.status}`);
      });
      await t.test('kill 后超过 5 分钟：输出 [flow] flow-stalled', () => {
        assert.ok(/\[flow\] flow-stalled:/.test(killed.out), 'kill 后超过 5 分钟：输出 [flow] flow-stalled  →  ' + killed.out.trim());
      });
      await t.test('报警写得出停了几分钟（5 分钟）', () => {
        assert.ok(/flow-stalled:.*5 分钟未更新/.test(killed.out), '报警写得出停了几分钟（5 分钟）  →  ' + killed.out.trim());
      });
    }
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(tmpFlow, { recursive: true, force: true });
  });

  it('⑳b 处置矩阵连败：同指纹连续命中超阈值 → 报帅（#471，非 capacityRetry 指纹）', async (t) => {
    const r = runWatchdog(path.join(FIXTURES, "fp-loss"));
    await t.test('退出码 1（有报警）', () => {
      assert.ok(r.status === 1, '退出码 1（有报警）  →  ' + `status=${r.status}`);
    });
    await t.test('第 2 轮 fingerprint + 动作行', () => {
      assert.ok(/round 2\/5[\s\S]*fingerprint:.*no serving account/.test(r.out) && /动作: 注入续命/.test(r.out), '第 2 轮 fingerprint + 动作行  →  ' + r.out.trim());
    });
    await t.test('第 5 轮报帅（连败阈值）', () => {
      assert.ok(/round 5\/5[\s\S]*报帅:.*连败/.test(r.out), '第 5 轮报帅（连败阈值）  →  ' + r.out.trim());
    });
  });

  it('⑳b2 #646 capacity 指纹续命调度：1/5/10 分钟各续命一次（共 3 次），第 4 次换人', async (t) => {
    // 夹具 capacity-keepalive：round 1-5 同屏 at capacity，git-evidence capturedAt 分别
    // 落在 T0 / T0 / T0+1min / T0+6min / T0+16min——正好把 1/5/10 三个间隔走完：
    //   round 2 首警 → 续命 #1；round 3（+1min）→ 续命 #2；round 4（+6min）→ 续命 #3；
    //   round 5（+16min）→ 第 4 次只报帅、不再发续命动作。
    const r = runWatchdog(path.join(FIXTURES, "capacity-keepalive"));
    const seg = (n) => (r.out.match(new RegExp(`round ${n}\\/5([\\s\\S]*?)(?:round |$)`)) || [])[1] || "";
    await t.test('退出码 1（有报警）', () => {
      assert.ok(r.status === 1, '退出码 1（有报警）  →  ' + `status=${r.status}`);
    });
    await t.test('round 2：fingerprint 首警 + 续命 #1（动作行）', () => {
      assert.ok(/round 2\/5[\s\S]*fingerprint:.*at capacity/.test(r.out), 'round 2：fingerprint 首警  →  ' + r.out.trim());
      assert.ok(/round 2\/5[\s\S]*动作: 注入续命（#646/.test(r.out), 'round 2：续命 #1 动作行  →  ' + r.out.trim());
    });
    await t.test('round 3（+1min）：续命 #2 动作行', () => {
      assert.ok(/动作: 注入续命（#646/.test(seg(3)), 'round 3：续命 #2 动作行  →  ' + seg(3).trim());
    });
    await t.test('round 4（+6min）：续命 #3 动作行', () => {
      assert.ok(/动作: 注入续命（#646/.test(seg(4)), 'round 4：续命 #3 动作行  →  ' + seg(4).trim());
    });
    await t.test('round 5（+16min）：第 4 次不续命（卡名不是审官·模型 → 报帅）', () => {
      assert.ok(/报帅:.*capacity 指纹已按 1\/5\/10 分钟各续命一次/.test(seg(5)), 'round 5：认不出审官卡则报帅  →  ' + seg(5).trim());
      assert.ok(!/动作: 注入续命/.test(seg(5)), 'round 5：第 4 次不发续命动作  →  ' + seg(5).trim());
    });
  });

  it('⑳c 活证否决（#500 换代）：否决只看非 spinner 真实内容在动', async (t) => {
    const r = runWatchdog(path.join(FIXTURES, "veto"));
    await t.test('退出码 0（否决 = 不唤醒）', () => {
      assert.ok(r.status === 0, '退出码 0（否决 = 不唤醒）  →  ' + `status=${r.status}`);
    });
    await t.test('打印观察行（活证否决，真实内容在动）', () => {
      assert.ok(/\[#452 - 看门狗正式版\] 观察: 指纹两连同「at capacity、try a different model」但非 spinner 真实内容在动——活证否决/.test(r.out), '打印观察行（活证否决，真实内容在动）  →  ' + r.out.trim());
    });
    await t.test('不报 fingerprint（被否决）', () => {
      assert.ok(!/fingerprint:/.test(r.out), '不报 fingerprint（被否决）  →  ' + r.out.trim());
    });

    const rs = runWatchdog(path.join(FIXTURES, "veto-stall"));
    await t.test('真实内容静止 → 指纹两连同照常报警（退出码 1）', () => {
      assert.ok(rs.status === 1, '真实内容静止 → 指纹两连同照常报警（退出码 1）  →  ' + `status=${rs.status}`);
    });
    await t.test('真实内容静止 → fingerprint 事件命中 at capacity', () => {
      assert.ok(/round 2\/2[\s\S]*\[#452 - 看门狗正式版\] fingerprint:.*at capacity/.test(rs.out), '真实内容静止 → fingerprint 事件命中 at capacity  →  ' + rs.out.trim());
    });
  });

  it('⑳d 分级排除：--exclude-pane 豁免指纹/停摆判据但保留死活判据（2026-08-15 裁定书）', async (t) => {
    // veto-stall 的工位屏面有 at capacity 指纹 + 真实内容静止：不排除会报警；排除后指纹豁免 → 不报但仍在监视
    const paneKey = "e9f1fff3-f73d-4624-a619-99c0cb257267:60cb698e-d683-446b-aaab-6e475a3b0c56";
    const r = runWatchdog(path.join(FIXTURES, "veto-stall"), ["--exclude-pane", paneKey]);
    await t.test('退出码 0（指纹判据被豁免）', () => {
      assert.ok(r.status === 0, '退出码 0（指纹判据被豁免）  →  ' + `status=${r.status}`);
    });
    await t.test('不报 fingerprint', () => {
      assert.ok(!/fingerprint:/.test(r.out), '不报 fingerprint  →  ' + r.out.trim());
    });
    await t.test('工位仍被监视（保留死活判据）→ OK 扫完 1 个工位', () => {
      assert.ok(/OK 扫完 1 个工位（#452 - 看门狗正式版）/.test(r.out), '工位仍被监视（保留死活判据）→ OK 扫完 1 个工位  →  ' + r.out.trim());
    });
    await t.test('不是 NO_TARGETS（旧版整体排除的盲区没了）', () => {
      assert.ok(!/NO_TARGETS/.test(r.out), '不是 NO_TARGETS（旧版整体排除的盲区没了）  →  ' + r.out.trim());
    });
  });

  it('⑳e 分级排除保留死活判据：--exclude-pane 下 exited/waiting 仍会响（2026-08-15 裁定书）', async (t) => {
    // 豁免的是指纹/停摆判据，不是死活判据——exited/waiting 在分级排除下必须照常报警
    const paneKey = "a04a1b0a-c845-4ec2-842b-41816b364e87:d539fff1-47d1-4a97-b479-69523fc1778f";
    const re = runWatchdog(path.join(FIXTURES, "exited"), ["--exclude-pane", paneKey]);
    await t.test('exited 工位被 --exclude-pane 后仍报 exited（保留死活判据）', () => {
      assert.ok(re.status === 1 && /\[#452 - 看门狗正式版\] exited:/.test(re.out), 'exited 工位被 --exclude-pane 后仍报 exited（保留死活判据）  →  ' + `status=${re.status} ${re.out.trim()}`);
    });
    const rw = runWatchdog(path.join(FIXTURES, "waiting"), ["--exclude-pane", paneKey]);
    await t.test('waiting 工位被 --exclude-pane 后仍报 waiting（保留死活判据）', () => {
      assert.ok(rw.status === 1 && /\[#452 - 看门狗正式版\] waiting:/.test(rw.out), 'waiting 工位被 --exclude-pane 后仍报 waiting（保留死活判据）  →  ' + `status=${rw.status} ${rw.out.trim()}`);
    });
  });

  it('㉑ #569 ④ 权限确认框停摆指纹：N/M:select 持续超阈轮才报，不自动替它选', async (t) => {
    // 真阳样本形态直接抄 #568 现场（grok 审官卡在权限确认框 7 分钟）：屏面底部 1/3:select、进程活着、屏面冻结。
    const r1 = runWatchdog(path.join(FIXTURES, "selector-freeze"), ["--once"]);
    await t.test('单轮：退出码 0（持续未达阈轮，不唤醒）', () => {
      assert.ok(r1.status === 0, '单轮：退出码 0（持续未达阈轮，不唤醒）  →  ' + `status=${r1.status}`);
    });
    await t.test('单轮：不报 selector', () => {
      assert.ok(!/selector:/.test(r1.out), '单轮：不报 selector  →  ' + r1.out.trim());
    });

    const r2 = runMultiRounds(path.join(FIXTURES, "selector-freeze", "round-1"), 2);
    await t.test('两轮同屏：退出码 1（选择器持续超阈轮）', () => {
      assert.ok(r2.status === 1, '两轮同屏：退出码 1（选择器持续超阈轮）  →  ' + `status=${r2.status}`);
    });
    await t.test('两轮同屏：第 2 轮报 selector 且带选择器原文', () => {
      assert.ok(/round 2\/2[\s\S]*\[#452 - 看门狗正式版\] selector:.*「1\/3:select」/.test(r2.out), '两轮同屏：第 2 轮报 selector 且带选择器原文  →  ' + r2.out.trim());
    });
    await t.test('selector 事件不带处置动作（不自动替它选——选哪个有后果）', () => {
      assert.ok(!/动作:/.test(r2.out), 'selector 事件不带处置动作（不自动替它选——选哪个有后果）  →  ' + r2.out.trim());
    });

    const rn = runWatchdog(path.join(FIXTURES, "live"), ["--once"]);
    await t.test('健康语料（无选择器提示）：不报 selector', () => {
      assert.ok(!/selector:/.test(rn.out), '健康语料（无选择器提示）：不报 selector  →  ' + rn.out.trim());
    });
  });

  it('㉒ #569 垫片并进：编排层隐形工人 BLIND（2026-08-17 判据订正：有活终端 + 查不到 dispatch 记账才算真隐形）', async (t) => {
    // 真判据 = 有活终端（>1）+ orca orchestration worker-list 的 resource.worktreeId 里没有它
    // （从没走 worker-start/dispatch = 编排层不知道有工人在跑）。worker-list-evidence.json 里
    // 列了现存非主树（#450/#452/#449）但没列 #555 → #555 无记账 → 报。
    const r = runWatchdog(path.join(FIXTURES, "blind"), ["--once"]);
    await t.test('退出码 1（隐形工人必须显形）', () => {
      assert.ok(r.status === 1, '退出码 1（隐形工人必须显形）  →  ' + `status=${r.status}`);
    });
    await t.test('输出 blind 事件且带判据（有活终端、无 dispatch 记账）', () => {
      assert.ok(/\[#555 - 隐形工人测试\] blind: 编排层隐形工人：有 2 个活终端且查不到 dispatch 记账/.test(r.out), '输出 blind 事件且带判据（有活终端、无 dispatch 记账）  →  ' + r.out.trim());
    });
    await t.test('有记账的非主树（#452 等）不报 blind', () => {
      assert.ok(!/\[#452 - 看门狗正式版\] blind:/.test(r.out), '有记账的非主树（#452 等）不报 blind  →  ' + r.out.trim());
    });
    await t.test('隐形工人树不误报 orphan（有活终端 = 有活跃执行者）', () => {
      assert.ok(!/\[#555 - 隐形工人测试\] orphan:/.test(r.out), '隐形工人树不误报 orphan（有活终端 = 有活跃执行者）  →  ' + r.out.trim());
    });

    // 负控（2026-08-17 帅实证形态）：同一棵树出现在记账里（agents=0 的审官 worker-read 读得到、
    // token 在涨）→ 编排层看得见 → 不报。判别力：把判据改回垫片的 agents=0 → 本条断言变红。
    const rt = runWatchdog(path.join(FIXTURES, "blind-tracked"), ["--once"]);
    await t.test('blind-tracked（#555 有 dispatch 记账）：退出码 0，不报 blind（有记账的 agents=0 不算隐形）', () => {
      assert.ok(rt.status === 0 && !/blind:/.test(rt.out), 'blind-tracked（#555 有 dispatch 记账）：退出码 0，不报 blind（有记账的 agents=0 不算隐形）  →  ' + `${rt.status} ${rt.out.trim()}`);
    });

    // 没查成 ≠ 查过没事：无 worker-list-evidence.json 的快照显式 DISPATCH_BOOKKEEPING_MISSING
    const rm = runWatchdog(path.join(FIXTURES, "live"), ["--once"]);
    await t.test('缺记账证据：显式 DISPATCH_BOOKKEEPING_MISSING（不是静默放过）', () => {
      assert.ok(/DISPATCH_BOOKKEEPING_MISSING/.test(rm.out), '缺记账证据：显式 DISPATCH_BOOKKEEPING_MISSING（不是静默放过）  →  ' + rm.out.trim());
    });
  });

  it('㉓ #569 降噪命名：无 agent 且无 #N 前缀的树不参与命名校验（windsurf-dao 假阳修复）', async (t) => {
    const r = runWatchdog(path.join(FIXTURES, "naming-skip"), ["--once"]);
    await t.test('退出码 0（无报警）', () => {
      assert.ok(r.status === 0, '退出码 0（无报警）  →  ' + `status=${r.status}`);
    });
    await t.test('windsurf-dao（0 agent、无 #N）不再报 naming（#569：它不是任务卡）', () => {
      assert.ok(!/naming:.*windsurf-dao/.test(r.out), 'windsurf-dao（0 agent、无 #N）不再报 naming（#569：它不是任务卡）  →  ' + r.out.trim());
    });
    await t.test('有 agent 的误命名卡仍报（naming-bad 就是正控）', () => {
      assert.ok(/\[审官·GPT\] naming:/.test(runWatchdog(path.join(FIXTURES, "naming-bad"), ["--once"]).out), '有 agent 的误命名卡仍报（naming-bad 就是正控）  →  naming-bad 应照常报警');
    });
  });

  it('㉔ #569 ② pi 静默换 provider：model_change 事件 + 诱因（errorMessage）', async (t) => {
    const r = runWatchdog(path.join(FIXTURES, "model-change"), ["--once"]);
    await t.test('退出码 1（静默换 provider 报警）', () => {
      assert.ok(r.status === 1, '退出码 1（静默换 provider 报警）  →  ' + `status=${r.status}`);
    });
    await t.test('输出 model-change 事件且带诱因（前一条 message 的 errorMessage）', () => {
      assert.ok(/\[pi\] model-change:.*诱因：503 status code \(no body\)/.test(r.out), '输出 model-change 事件且带诱因（前一条 message 的 errorMessage）  →  ' + r.out.trim());
    });
    await t.test('切换到 deepseek 直连被点出（止血验证手段）', () => {
      assert.ok(/model_change → provider=deepseek/.test(r.out), '切换到 deepseek 直连被点出（止血验证手段）  →  ' + r.out.trim());
    });
    await t.test('会话开头的初始选型（前无 message）不报——只报中途切换', () => {
      assert.ok((r.out.match(/\[pi\] model-change:/g) || []).length === 1, '会话开头的初始选型（前无 message）不报——只报中途切换  →  ' + r.out.trim());
    });

    const rm = runWatchdog(path.join(FIXTURES, "live"), ["--once", "--sessions-dir", path.join(FIXTURES, "live", "no-sessions")]);
    await t.test('sessions 目录不存在：显式 PI_SESSIONS_MISSING（没查成≠查过没事），不误报', () => {
      assert.ok(rm.status === 0 && /PI_SESSIONS_MISSING/.test(rm.out), 'sessions 目录不存在：显式 PI_SESSIONS_MISSING（没查成≠查过没事），不误报  →  ' + `${rm.status} ${rm.out.trim()}`);
    });
  });

  it('㉕ #602：Pasted/ALL_IDLE 扩判退役（治错了病）', async (t) => {
    const r1 = runWatchdog(path.join(FIXTURES, "pasted-content"), ["--once"]);
    await t.test('Pasted Content 单轮：不再报 pasted-content', () => {
      assert.ok(!/pasted-content:/.test(r1.out), 'Pasted Content 单轮：不再报 pasted-content  →  ' + r1.out.trim());
    });

    const r2 = runMultiRounds(path.join(FIXTURES, "pasted-content", "round-1"), 2);
    await t.test('Pasted Content 两轮：仍不报 pasted-content，不补回车', () => {
      assert.ok(!/pasted-content:/.test(r2.out) && !/补一记回车/.test(r2.out), 'Pasted Content 两轮：仍不报 pasted-content，不补回车  →  ' + r2.out.trim());
    });

    const ra = runWatchdog(path.join(FIXTURES, "all-idle"), ["--once"]);
    await t.test('原 ALL_IDLE 盘面：回到 NO_TARGETS（exit 2），不打 all-idle', () => {
      assert.ok(ra.status === 2 && /NO_TARGETS/.test(ra.out) && !/all-idle:/.test(ra.out), '原 ALL_IDLE 盘面：回到 NO_TARGETS（exit 2），不打 all-idle  →  ' + ra.out.trim());
    });

    const ri1 = runWatchdog(path.join(FIXTURES, "pasted-idle"), ["--once"]);
    await t.test('idle+Pasted：不报 all-idle / pasted-content', () => {
      assert.ok(!/all-idle:/.test(ri1.out) && !/pasted-content:/.test(ri1.out), 'idle+Pasted：不报 all-idle / pasted-content  →  ' + ri1.out.trim());
    });
  });

  it('㉖ #580 追加：503/5xx 指纹 + 重试循环（内容在变也报；有产出不报；stall 不弱）', async (t) => {
    const r = runWatchdog(path.join(FIXTURES, "retry-503"), ["--now", String(NOW)]);
    await t.test('503 重试三轮（内容在变、无产出）：退出码 1', () => {
      assert.ok(r.status === 1, '503 重试三轮（内容在变、无产出）：退出码 1  →  ' + `status=${r.status} ${r.out.trim()}`);
    });
    await t.test('503 重试三轮：报 retry-loop', () => {
      assert.ok(/retry-loop:.*同一错误行连续 3 轮/.test(r.out), '503 重试三轮：报 retry-loop  →  ' + r.out.trim());
    });
    await t.test('503 重试三轮：不报 stall（真实内容在变，停摆判据没被放宽也没被误伤）', () => {
      assert.ok(!/stall:/.test(r.out), '503 重试三轮：不报 stall（真实内容在变，停摆判据没被放宽也没被误伤）  →  ' + r.out.trim());
    });

    const p = runWatchdog(path.join(FIXTURES, "retry-503-progress"), ["--now", String(NOW)]);
    await t.test('503 重试但 git 产出新鲜：不报 retry-loop', () => {
      assert.ok(!/retry-loop:/.test(p.out), '503 重试但 git 产出新鲜：不报 retry-loop  →  ' + p.out.trim());
    });

    const s = runWatchdog(path.join(FIXTURES, "hash-stable"));
    await t.test('屏面全冻三轮：stall 照旧报（不许为修重试循环把停摆判弱）', () => {
      assert.ok(s.status === 1 && /stall:/.test(s.out), '屏面全冻三轮：stall 照旧报（不许为修重试循环把停摆判弱）  →  ' + s.out.trim());
    });

    const h = runWatchdog(path.join(FIXTURES, "real-advance"));
    await t.test('正常输出且内容在动：不报 retry-loop / stall', () => {
      assert.ok(h.status === 0 && !/retry-loop:/.test(h.out) && !/stall:/.test(h.out), '正常输出且内容在动：不报 retry-loop / stall  →  ' + h.out.trim());
    });
  });

  it('㉗ #586 工人 done 但 head 比完工信号新', async (t) => {
    const stale = runWatchdog(path.join(FIXTURES, "stale-completion"), ["--once"]);
    await t.test('正样本：head 比完工 comment 新 → 退出码 1', () => {
      assert.ok(stale.status === 1, '正样本：head 比完工 comment 新 → 退出码 1  →  ' + `status=${stale.status}`);
    });
    await t.test('正样本：报 stale-completion', () => {
      assert.ok(/stale-completion:/.test(stale.out) && /#453 - dispatch 顺车修订/.test(stale.out), '正样本：报 stale-completion  →  ' + stale.out.trim());
    });

    const fresh = runWatchdog(path.join(FIXTURES, "stale-completion-fresh"), ["--once"]);
    await t.test('负样本：完工 comment 不早于 head → 不报 stale-completion', () => {
      assert.ok(!/stale-completion:/.test(fresh.out), '负样本：完工 comment 不早于 head → 不报 stale-completion  →  ' + fresh.out.trim());
    });

    const none = runWatchdog(path.join(FIXTURES, "no-targets"), ["--once"]);
    await t.test('缺 completion-evidence：不猜、不报 stale-completion（没查成 ≠ 查过有事）', () => {
      assert.ok(!/stale-completion:/.test(none.out), '缺 completion-evidence：不猜、不报 stale-completion（没查成 ≠ 查过有事）  →  ' + none.out.trim());
    });
  });
});