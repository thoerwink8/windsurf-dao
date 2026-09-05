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
    const before = src.slice(Math.max(0, i - 1400), i);
    // 去重条件在 2026-09-05 从「见过就跳」改成「办成了或试满了才跳」——
    // 因为原来失败和成功记同一条账，一次换人失败就永远不再试。
    assert.match(before, /if \(prev && \(settled \|\| tries >= MAX_SWITCH_RETRY\)\) \{[\s\S]{0,140}continue;/,
      '收集前必须先过去重，且去重条件要看「办成没办成」不是「见没见过」');
  });
  it('换人判据仍走 decideHitAction，不在本文件另写一套', () => {
    assert.match(src, /decideHitAction\(\{/);
    const uses = (src.match(/planCapacitySwitch/g) || []).length;
    assert.equal(uses, 0, '换人顺序/同厂禁令归 agent-stall-detect，本文件不许直接调');
  });
});

describe('会话名：卡名压过终端标题（实咬：9 个静默审官一个都没换成人）', () => {
  it('有卡名时用卡名，不用被 CLI 盖成 shell 提示符的标题', async () => {
    const S = await LOAD;
    const s = S.sessionFromOrcaTerminal({
      handle: 't', lastOutputAt: min(600),
      // 这一串就是 CLI 盖上去的 shell 提示符（路径分段拼出来，避免仓外路径闸把测试样本当真指针）
      title: ['orca@vmi:', '~', 'orca', 'workspaces', 'windsurf-dao', 'PR-894-审官-gpt-5.6-luna$'].join('/'),
      displayName: 'PR-#894 审官·gpt-5.6-luna',
    });
    assert.equal(s.label, 'PR-#894 审官·gpt-5.6-luna',
      '拿终端标题当名字，换人判据 parseReviewerCardName 就认不出审官卡，静默审官永远换不了人');
  });
  it('没有卡名才回落标题', async () => {
    const S = await LOAD;
    assert.equal(S.sessionFromOrcaTerminal({ handle: 't', title: '帅位', lastOutputAt: min(1) }).label, '帅位');
  });
});

// #833 第三层闸（2026-09-05 实咬）：审官位闸修通之后换人**仍然**是零——
// reviewer-create 返回 oneReviewerGate:reused，复用的正是那张死了 12 小时的审官卡。
// 换人 = 先撤掉死的再立新的；少了前半步，前两层修了也白修。
describe('换人要先撤死卡（#833 第三层）', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'agent-stall-watch.mjs'), 'utf8');
  const i = src.indexOf('function switchReviewer(');
  const block = i > -1 ? src.slice(i, src.indexOf('\n}', src.indexOf('已换人')) + 2) : '';

  it('找得到 switchReviewer——找不到就是判据失效，不是通过', () => {
    assert.ok(i > -1 && block, 'agent-stall-watch.mjs 里没有 switchReviewer，本闸判据已失效');
  });
  it('立新审官之前先撤旧卡', () => {
    const rmAt = block.indexOf("'worktree-rm'");
    const createAt = block.indexOf("'reviewer-create'");
    assert.ok(rmAt > -1, '没有撤旧卡这一步——reviewer-create 会复用死卡，换人永远是零');
    assert.ok(createAt > -1 && rmAt < createAt, '撤旧卡必须在立新审官之前');
  });
  it('不许 --force：占用闸拦下就是判死判错了，当场停手不硬删', () => {
    assert.ok(!/'--force'/.test(block),
      'worktree-rm 不许带 --force——2026-09-04 实咬：force 删掉仍在 working 的树，底层进程没死还发了 21 条重复评论');
    assert.match(block, /没有硬删|可能还活着/, '撤不掉要说清是「它可能还活着」，不是笼统的失败');
  });
  it('撤卡失败就不往下走，不留下「删了一半」的中间态', () => {
    const rmAt = block.indexOf("'worktree-rm'");
    const guard = block.slice(rmAt, block.indexOf("'reviewer-create'"));
    assert.match(guard, /return \{ ok: false/, '撤卡失败必须直接返回，不许继续 create');
  });
  it('dry-run 一步都不许真做', () => {
    assert.match(block, /if \(dryRun\)[\s\S]{0,200}return \{ ok: true, dryRun: true/,
      'dry-run 必须在任何 spawnSync 之前返回');
    const dryAt = block.indexOf('dryRun: true');
    assert.ok(dryAt < block.indexOf('spawnSync'), 'dry-run 的返回必须排在第一次 spawnSync 之前');
  });
  it('判死的那张卡真的被传进来了——不传等于没撤', () => {
    assert.match(src, /deadWorktreeId: hit\.worktreeId/,
      '调用处要把判死的审官卡 id 传给 switchReviewer');
  });
});

// 2026-09-05 实咬：10 个审官换人全失败（exit 1），而失败和成功记的是同一条账，
// 下一轮全被去重挡掉——**一次失败就永远不再试**。盘面上看着「已处置」，实际一个都没换成。
describe('换人失败要重试，成功才封账', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'agent-stall-watch.mjs'), 'utf8');

  it('账上记了办没办成，不只是「报过了」', () => {
    assert.match(src, /tries: tries \+ 1, ok: null/, '新记一条要带尝试次数和「还不知道办没办成」');
    assert.match(src, /switchLedger\[hit\.ledgerKey\] = sw\.ok === true/, '换人结果要回填');
    assert.match(src, /nextSilent\[k\]\.ok = ok/, '回填要落到静默账上');
  });

  it('办成了才封账；没办成的下一轮还试', () => {
    assert.match(src, /prev\.ok === true[\s\S]{0,80}prev\.action !== 'restart-reviewer'/,
      '封账条件必须是「办成了」或「本来就只是报警」，不是「见过」');
  });

  it('重试有上限——不然每 15 分钟死循环一次', () => {
    assert.match(src, /const MAX_SWITCH_RETRY = \d+;/);
    assert.match(src, /tries >= MAX_SWITCH_RETRY/, '到上限要停手等人');
  });

  it('dry-run 不许写账——写了下一轮真跑时会被自己的干跑记录挡掉', () => {
    assert.match(src, /if \(!args\.dryRun && switchLedger/, '回填也要判 dryRun');
  });

  it('换人之前先落一次账：中途崩了本轮判过的静默不该丢', () => {
    const a = src.indexOf('saveState(livenessStatePath');
    const b = src.indexOf("const prev = loadState(args.state);");
    assert.ok(a > -1 && b > a, '第一次落账要在 scanRound 之前');
  });


  it('旧账本（只有 at/minutes，没有 action/ok）不许被当成「已了结」', () => {
    const src2 = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'agent-stall-watch.mjs'), 'utf8');
    assert.match(src2, /prev\.action != null && prev\.action !== 'restart-reviewer'/,
      '判 settled 要求 action 记过——老条目 action 是 undefined，'
      + "不加这一层就会 `undefined !== 'restart-reviewer'` → 判已了结，换人失败的卡永远轮不到重试");
  });
});
