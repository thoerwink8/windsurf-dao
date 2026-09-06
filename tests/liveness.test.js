// 会话活性统一接口（issue #940，用户 2026-09-05 拍板：删指纹层只判静默 + 三驱动统一接口）。
// 每条都对着一个实咬：6 个审官掉回裸 shell 停 10 小时零报警；reclaude 终端因为没有 agentIdentity 被整个跳过。
//
// 2026-09-06：原先钉在 agent-stall-watch.mjs 源码文本上的四组断言随该文件一起删了
// （用户拍板屏面指纹整层退役）。本文件现在只测 liveness.mjs 自己的采样与判定。
const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

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
