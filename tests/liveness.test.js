// 会话活性统一接口（issue #940，用户 2026-09-05 拍板：删指纹层只判静默 + 三驱动统一接口）。
// 每条都对着一个实咬：6 个审官掉回裸 shell 停 10 小时零报警；reclaude 终端因为没有 agentIdentity 被整个跳过。
const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

const LIB = 'file://' + path.join(__dirname, '..', 'scripts', 'lib', 'liveness.mjs').replace(/\\/g, '/');
const LOAD = import(LIB);

const NOW = Date.parse('2026-09-05T12:00:00Z');
const min = (n) => new Date(NOW - n * 60000).toISOString();

describe('活性：orca / reclaude 采样面', () => {
  it('reclaude 终端（没有 agentIdentity）也进采样面——旧代码这里 continue 掉了', async () => {
    const S = await LOAD;
    const s = S.sessionFromOrcaTerminal({ handle: 't1', title: '帅位', lastOutputAt: min(5) });
    assert.ok(s, 'reclaude 终端不许被跳过');
    assert.equal(s.driver, 'reclaude');
    assert.equal(S.assessLiveness(s, { now: NOW }).state, 'active');
  });

  it('有 agentIdentity 的仍标 orca 驱动', async () => {
    const S = await LOAD;
    const s = S.sessionFromOrcaTerminal({ handle: 't2', agentIdentity: 'codex', lastOutputAt: min(1) });
    assert.equal(s.driver, 'orca');
  });

  it('停在裸 shell 十小时 → silent（今天真发生的那件事）', async () => {
    const S = await LOAD;
    const s = S.sessionFromOrcaTerminal({
      handle: 't3', title: 'PR-#894 审官·gpt-5.6-luna',
      lastOutputAt: min(611), preview: 'orca@vmi:~/...$',
    });
    const a = S.assessLiveness(s, { now: NOW });
    assert.equal(a.state, 'silent', '屏上没有任何错误字样，但它已经死了 10 小时');
    assert.equal(S.routeSilent(s).action, 'restart-reviewer', '审官静默要判死重起');
  });

  it('没有 lastOutputAt → unscanned，绝不当 active', async () => {
    const S = await LOAD;
    const s = S.sessionFromOrcaTerminal({ handle: 't4', title: 'x' });
    assert.equal(s.unscanned, true);
    assert.equal(S.assessLiveness(s, { now: NOW }).state, 'unscanned');
  });
});

describe('活性：mirasim 驱动', () => {
  it('自报 completed → done，不算静默也不算活着', async () => {
    const S = await LOAD;
    const s = S.sessionFromMirasimSession({ key: 'codex:1', title: '审 PR #893', state: 'completed' });
    assert.equal(S.assessLiveness(s, { now: NOW }).state, 'done');
  });

  it('incomplete 且没有活动时间戳 → unscanned（明说缺时间戳，不猜还活着）', async () => {
    const S = await LOAD;
    const s = S.sessionFromMirasimSession({ key: 'codex:2', title: 'x', state: 'incomplete' });
    const a = S.assessLiveness(s, { now: NOW });
    assert.equal(a.state, 'unscanned');
    assert.match(a.why, /没有活动时间戳|没查成/);
  });

  it('有活动时间戳就按时间判', async () => {
    const S = await LOAD;
    const fresh = S.sessionFromMirasimSession({ key: 'k', state: 'incomplete', lastActivityAt: min(3) });
    const stale = S.sessionFromMirasimSession({ key: 'k', state: 'incomplete', lastActivityAt: min(500) });
    assert.equal(S.assessLiveness(fresh, { now: NOW }).state, 'active');
    assert.equal(S.assessLiveness(stale, { now: NOW }).state, 'silent');
  });
});

describe('活性：扫一轮的三态可辨', () => {
  it('「扫完都健康」与「压根没采到样本」必须分得开', async () => {
    const S = await LOAD;
    const empty = S.scanLiveness({ sessions: [], now: NOW });
    assert.equal(empty.sampledNothing, true, '空采样面要显形，不许看起来像全绿');
    const healthy = S.scanLiveness({
      sessions: [S.sessionFromOrcaTerminal({ handle: 'a', lastOutputAt: min(1) })], now: NOW,
    });
    assert.equal(healthy.sampledNothing, false);
    assert.equal(healthy.counts.active, 1);
  });

  it('不是数组 → 没查成（第三态）', async () => {
    const S = await LOAD;
    assert.equal(S.scanLiveness({ sessions: null }).ok, false);
  });

  it('四态各自计数，silent 与 unscanned 各自成清单', async () => {
    const S = await LOAD;
    const r = S.scanLiveness({
      now: NOW,
      sessions: [
        S.sessionFromOrcaTerminal({ handle: 'a', lastOutputAt: min(1) }),
        S.sessionFromOrcaTerminal({ handle: 'b', title: '审官', lastOutputAt: min(600) }),
        S.sessionFromOrcaTerminal({ handle: 'c' }),
        S.sessionFromMirasimSession({ key: 'd', state: 'completed' }),
      ],
    });
    assert.deepEqual(r.counts, { active: 1, silent: 1, done: 1, unscanned: 1 });
    assert.equal(r.silent.length, 1);
    assert.equal(r.unscanned.length, 1);
  });

  it('阈值判别力：把阈值调大，同一批就不该再判静默（反证判据真的在用时间）', async () => {
    const S = await LOAD;
    const sessions = [S.sessionFromOrcaTerminal({ handle: 'b', lastOutputAt: min(600) })];
    assert.equal(S.scanLiveness({ sessions, now: NOW }).counts.silent, 1);
    assert.equal(S.scanLiveness({ sessions, now: NOW, thresholdMs: 24 * 3600 * 1000 }).counts.silent, 0);
  });
});

// 2026-09-05 实咬（用户截图：总控群被同一句话无限刷屏）：静默播报三个洞——
// ①--dry-run 也真发；②每轮对同一个静默会话重发；③会话名直接播 shell 提示符里的路径。
describe('静默播报不刷屏（实咬）', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'agent-stall-watch.mjs'), 'utf8');
  const i = src.indexOf('const live = scanLiveness');
  // 窗口到活性块自己的收尾为止——放宽会扫进后面的撞限流代码，把别人的 say 算到本块头上。
  const end = src.indexOf('saveState(livenessStatePath', i);
  const block = i > -1 && end > i ? src.slice(i, end + 60) : '';

  it('找得到活性块——找不到就是判据失效，不是通过', () => {
    assert.ok(i > -1, 'agent-stall-watch.mjs 里没有活性块，本闸判据已失效');
  });
  it('dry-run 不许真发', () => {
    assert.match(block, /if \(args\.dryRun\)/, '播报前必须先判 dryRun——我自己跑 --dry-run 时也把消息发进了群');
  });
  it('同一静默不重播：有去重记账且落盘', () => {
    assert.match(block, /seenSilent\[key\]/, '要按会话记账去重');
    assert.match(block, /saveState\(livenessStatePath/, '记账要落盘，否则下一轮又是新的');
  });
  it('一轮合成一条发，活性块里只有一处 say', () => {
    assert.match(block, /liveLines\.length === 1 \? liveLines\[0\]/, '多条要合并成一段');
    const says = (block.match(/\bsay\(/g) || []).length;
    assert.ok(says <= 1, '活性块里只该有一处 say，现在有 ' + says + ' 处——每个发现各发一条就是刷屏');
  });
  it('会话名不许直接播 shell 提示符里的路径', () => {
    assert.match(block, /plainLabel\(sil\)/, '播报要走 plainLabel，别直接用终端标题');
  });
});

describe('静默播报有上限、按卡去重（实咬：一轮 66 条）', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'agent-stall-watch.mjs'), 'utf8');
  const i = src.indexOf('const live = scanLiveness');
  const end = src.indexOf('saveState(livenessStatePath', i);
  const block = i > -1 && end > i ? src.slice(i, end + 60) : '';

  it('按 worktree 去重，不按终端——一张卡好几个终端', () => {
    assert.match(block, /sil\.worktreeId \|\| sil\.id/, '去重键要先用卡 id，终端 id 只作兜底');
  });
  it('一条消息有条数上限，超出只给条数', () => {
    assert.match(block, /MAX_LISTED/, '缺上限：第一次接上观测面时几十条陈年静默会一次刷一屏');
    assert.match(block, /另有 \$\{fresh\.length - MAX_LISTED\}/, '超出部分要说清还有几条');
  });
});

// #833（用户 2026-09-05 拍板「接到今天新做的活性闸上」）：判死之后要真换人。
// 此前这条能力挂在 #807 删掉的本机 watchdog 上，删完就是零——PR #827 的审官撞 429 静默 9 小时零 review。
describe('静默审官接自动换人（#833）', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'agent-stall-watch.mjs'), 'utf8');

  it('新判静默的审官会被喂进换人路', () => {
    assert.match(src, /silentReviewers\.push\(/, '静默审官要收集起来');
    assert.match(src, /round\.reports\.push\(\{ \.\.\.s, parentWorktreeId/, '要喂进同一条 reports 路，不另造判断');
  });
  it('只喂新判的——去重在前，否则同一张卡每轮换一次人', () => {
    const i = src.indexOf('silentReviewers.push(');
    const before = src.slice(Math.max(0, i - 900), i);
    assert.match(before, /if \(seenSilent\[key\]\) continue;/, '收集前必须先过去重');
  });
  it('换人判据仍走 decideHitAction，不在本文件另写一套', () => {
    assert.match(src, /decideHitAction\(\{/);
    const uses = (src.match(/planCapacitySwitch/g) || []).length;
    assert.equal(uses, 0, '换人顺序/同厂禁令归 agent-stall-detect，本文件不许直接调');
  });
});
