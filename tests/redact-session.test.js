// 会话态脱敏（scripts/lib/redact.mjs）· 回归网
//
// 验的层：①对 canonical 的委派（不重写凭据判据 ⇒ 那边少认一类，这边跟着红）
//        ②EXTRA 两类正控（绝对路径 / 43+ 高熵串）③负控（git sha / PR 号 / 相对路径必须留）
//        ④幂等 ⑤深度脱敏 ⑥**变异自证**：机械地把某条规则改坏 → 对应正控必须翻红。
// 判别力自检问句：任何把脱敏放宽或收紧的改动，是否都至少有一条断言会变红？
// ⚠ 本文件里所有「密钥」都是合成串（CANARY_* 命名），不是真实凭据。
// ⚠ 路径样本用 String.raw：反斜杠经不起二次转义（本单实咬过一次——heredoc 把 `[\\/]`
//   吃成 `[\/]`，win-path 正则于是只认正斜杠，而「写完读回自证」才发现）。

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const LIB = path.join(REPO, 'scripts', 'lib', 'redact.mjs');
const CANONICAL = path.join(REPO, 'scripts', 'lib', 'redact.js');
const SANDBOX = path.join(REPO, '_tmp', 'redact-session-sandbox');

const toUrl = p => 'file://' + p.replace(/\\/g, '/');
const LIB_LOAD = import(toUrl(LIB));

const CANARY_SK = 'sk-CANARYaaaabbbbccccddddeeeeffff1234';
const CANARY_PAT = 'ghp_CANARY0123456789abcdefghij0123456';
const CANARY_BEARER = 'CANARYbearer.abc-123_xyz';
// 43+ 字符、混大小写含数字 = 裸 token 的形状（无前缀，前缀模式抓不到它）
const CANARY_HIGH = 'CANARYaB3' + 'xY7z'.repeat(9) + 'Q9';
const WIN_PATH = String.raw`D:\frank\windsurf-dao\scripts\lib\redact.mjs`;
const SPACED_WIN = String.raw`C:\Users\Jane Doe\windsurf dao\notes.txt`;
const SPACED_UNC = String.raw`\\server\Jane Doe\share\secret.txt`;
const SPACED_POSIX = '/home/Jane Doe/windsurf dao/secret.txt';
const POSIX_HOME = '/home/orca/bin/hub-say';
const POSIX_CUSER = '/c/Users/Administrator/.claude/settings.json';
const REAL_SHA = '077f48b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7';

// ── 变异自证的机械手 ────────────────────────────────────────────────────────
// 把 redact.mjs 抄一份到沙箱，按 EXTRA 模式名把那一条的正则替换成「永不命中」（/(?!)/g），
// 再 import 变异体跑同一条正控。**若正控在变异体上仍然通过 ⇒ 那条断言没有判别力，判红。**
// 抄进沙箱而不是原地改：源码树在测试期间保持干净；`./redact.js` 的相对 require 改写成绝对路径。
function mutantWithout(patternName) {
  fs.mkdirSync(SANDBOX, { recursive: true });
  const src = fs.readFileSync(LIB, 'utf8');
  // 用正则而不是字面量匹配那行 require：字面量会让 dao-check 的孤儿测试闸（㉖）把它当成
  // 本测试对 tests/redact.js 的真引用（那个文件不存在）⇒ 误报孤儿。正则同时更耐引号风格变动。
  const rewired = src.replace(/require\((['"])\.\/redact\.js\1\)/, `require(${JSON.stringify(CANONICAL)})`);
  assert.ok(rewired !== src, '变异手没能改写 canonical 的 require 路径 ⇒ 变异自证本身失效了');

  const lines = rewired.split('\n');
  const at = lines.findIndex(l => l.includes(`name: '${patternName}'`));
  assert.ok(at >= 0, `变异手找不到模式 ${patternName} ⇒ EXTRA_PATTERNS 结构变了，变异自证失效`);
  // 认 `re:` 行但不认它的**写法**：模式表里既有正则字面量（high-entropy）也有
  // `new RegExp(...)`（三条路径——段规则要复用零件，拼不出字面量）。首版这里写死了 `re: /`，
  // 改成 new RegExp 后变异手当场找不到行 ⇒ 变异自证整组失效。判据只认「有个 re: 键」。
  const reAt = lines.findIndex((l, i) => i > at && /^\s*re:\s*\S/.test(l));
  assert.ok(reAt > at && reAt < at + 12, `变异手找不到 ${patternName} 的 re: 行 ⇒ 变异自证失效`);
  lines[reAt] = '    re: /(?!)/g,'; // 永不命中 = 这条规则被删掉了
  const file = path.join(SANDBOX, `mutant-no-${patternName}.mjs`);
  fs.writeFileSync(file, lines.join('\n'), 'utf8');
  return import(toUrl(file));
}

describe('redact.mjs · 会话态脱敏', () => {
  it('① 委派 canonical，不重写凭据判据', async () => {
    const { redact, PATTERNS } = await LIB_LOAD;
    // 任务书点名的四条必须在 canonical 的表里。canonical 哪天丢一条 ⇒ 这里红（漂移报警）。
    const names = PATTERNS.map(p => p.name);
    for (const need of ['sk-key', 'bearer', 'github-token', 'env-assign']) {
      assert.ok(names.includes(need), `canonical 模式表缺 ${need} ⇒ 凭据判据漂移了`);
    }
    // 输出用的是 canonical 的标签 ⇒ 证明真走了那张表，不是这边另写了一条同名规则。
    assert.strictEqual(redact(`key=${CANARY_SK}`), 'key=[REDACTED:sk-key]');
    assert.strictEqual(redact(CANARY_PAT), '[REDACTED:github-token]');
    assert.ok(!redact(`Bearer ${CANARY_BEARER}`).includes(CANARY_BEARER));
    assert.ok(!redact(`ANTHROPIC_AUTH_TOKEN=${CANARY_HIGH}`).includes(CANARY_HIGH));
  });

  it('② EXTRA 正控 · 绝对路径与高熵串消失', async (t) => {
    const { redact, redactHits } = await LIB_LOAD;
    const positives = [
      ['Windows 反斜杠', `file at ${WIN_PATH} done`, WIN_PATH, 'win-path'],
      ['Windows 正斜杠', 'at D:/frank/wd-w2-hook/scripts here', 'D:/frank/wd-w2-hook/scripts', 'win-path'],
      ['Windows 家目录', String.raw`C:\Users\Administrator\.mirasim\keys\zhipu.key`, 'Administrator', 'win-path'],
      ['POSIX /home', `log in ${POSIX_HOME} now`, POSIX_HOME, 'posix-path'],
      ['POSIX /c/Users', `cfg ${POSIX_CUSER}`, POSIX_CUSER, 'posix-path'],
      ['POSIX /root', 'at /root/.ssh/config', '/root/.ssh/config', 'posix-path'],
      ['43+ 高熵串', `tok ${CANARY_HIGH} end`, CANARY_HIGH, 'high-entropy'],
      // ↓ 审官 P1：首版三条路径正则在空格处截断、UNC 整条漏过。这四条是那次漏的形状。
      ['Win 含空格（用户名+目录名都带空格）', SPACED_WIN, 'Jane Doe', 'win-path'],
      ['Win 含空格 · 末段也带空格但有扩展名', String.raw`C:\Users\Jane Doe\my notes.txt`, 'Jane Doe', 'win-path'],
      ['UNC 含空格', SPACED_UNC, 'Jane Doe', 'unc-path'],
      ['POSIX 含空格', SPACED_POSIX, 'Jane Doe', 'posix-path'],
    ];
    for (const [label, input, secret, wantHit] of positives) {
      await t.test(`正控 ${label}`, () => {
        const out = redact(input);
        assert.ok(!out.includes(secret), `${label} 没被脱掉 → ${JSON.stringify(out)}`);
        assert.ok(redactHits(input).includes(wantHit), `${label} 命中类型应含 ${wantHit}，实际 ${JSON.stringify(redactHits(input))}`);
      });
    }
  });

  it('③ 负控 · 复查用得上的事实必须留下', async (t) => {
    const { redact } = await LIB_LOAD;
    const negatives = [
      ['git sha（audit.bypass 的 evidence 本体）', `commit ${REAL_SHA} landed`],
      ['短 sha', 'commit 077f48b landed'],
      ['PR 号与分支名', 'PR #891 on branch feat/891-session-hook'],
      ['仓内相对路径', 'changed scripts/lib/session-audit.mjs and tests/x.test.js'],
      ['GitHub URL', 'see https://github.com/thoerwink8/windsurf-dao/pull/891'],
      ['公共布局路径（无身份信息）', 'binary at /usr/bin/node and /etc/hosts'],
      ['普通中英文叙述', '本轮有实质产出却零相关事件，判漏记'],
    ];
    for (const [label, input] of negatives) {
      await t.test(`负控 ${label} 原样保留`, () => {
        assert.strictEqual(redact(input), input, `${label} 被误脱 → ${JSON.stringify(redact(input))}`);
      });
    }
  });

  it('④ 幂等：重复跑逐字节相同（占位形状不被自己的规则再吃一次）', async () => {
    const { redact } = await LIB_LOAD;
    const samples = [
      `key=${CANARY_SK} at ${WIN_PATH}`,
      `${POSIX_HOME} ${CANARY_HIGH} ${CANARY_PAT}`,
      `commit ${REAL_SHA} clean`,
      '',
    ];
    for (const s of samples) {
      const once = redact(s);
      assert.strictEqual(redact(once), once, `不幂等：${JSON.stringify(s)}`);
    }
    assert.strictEqual(redact(null), null);
    assert.strictEqual(redact(undefined), undefined);
  });

  it('⑤ redactDeep：嵌套对象/数组里的字符串都过一遍，键名不动', async () => {
    const { redactDeep } = await LIB_LOAD;
    const out = redactDeep({
      detail: `产出 ${WIN_PATH}`,
      evidence: ['commit:077f48b', `file:${POSIX_HOME}`],
      nested: { api_key_note: CANARY_SK, n: 7, ok: true, nil: null },
    });
    assert.ok(!JSON.stringify(out).includes('frank'), '深度脱敏漏了 win 路径');
    assert.ok(!JSON.stringify(out).includes('orca'), '深度脱敏漏了 posix 路径');
    assert.ok(!JSON.stringify(out).includes(CANARY_SK), '深度脱敏漏了凭据');
    assert.strictEqual(out.evidence[0], 'commit:077f48b', 'evidence 里的 sha 被误脱 ⇒ 报警就没法复查了');
    assert.ok('api_key_note' in out.nested, '键名不该动');
    assert.strictEqual(out.nested.n, 7);
    assert.strictEqual(out.nested.ok, true);
    assert.strictEqual(out.nested.nil, null);
  });

  it('⑦ 安全边界 · 空格不是终止符，代价与仍不认的那一格都钉在这里', async (t) => {
    const { redact } = await LIB_LOAD;
    // ── 终止符是引号 / 换行 / 句读，**不是单空格**（大脑一轮红）──────────────
    // 「空格当终止符」那条路本身就是错的：用户名一旦是末段，它必漏一半。
    //   `C:\Users\Jane Doe` → `[REDACTED:win-path] Doe`（中间修法的实咬）
    // 所以下面这组的判据是**整条命中、marker 之后不留任何路径残字**。
    const noResidue = [
      ['末段就是带空格的用户名', String.raw`C:\Users\Jane Doe`, '[REDACTED:win-path]'],
      ['末段带空格且无扩展名', String.raw`C:\Users\Jane Doe\my secret folder`, '[REDACTED:win-path]'],
      ['POSIX 末段就是用户名', '/home/jane doe', '[REDACTED:posix-path]'],
      ['UNC 末段带空格无扩展名', String.raw`\\server\Jane Doe\private share`, '[REDACTED:unc-path]'],
      ['引号终止', `"${String.raw`C:\Users\Jane Doe\a b`}" 后面的话`, '"[REDACTED:win-path]" 后面的话'],
      ['分号终止', String.raw`C:\Users\Jane Doe\a b; next`, '[REDACTED:win-path]; next'],
      ['闭括号收尾终止', String.raw`(C:\Users\Jane Doe\a b)`, '([REDACTED:win-path])'],
      ['换行终止', `${String.raw`C:\Users\Jane Doe`}\n下一行`, '[REDACTED:win-path]\n下一行'],
      // 闭括号后面还接分隔符时属于路径 ⇒ 不留 `)\app\x.txt` 这种残段
      ['Program Files (x86)', String.raw`C:\Program Files (x86)\app\x.txt`, '[REDACTED:win-path]'],
      // 空格后面是新路径的开头 ⇒ 让出去，两条各自整条命中（否则留下 `:\c\d.txt` 半条）
      ['同行两条路径各自整条', String.raw`C:\a\b.txt D:\c\d.txt`, '[REDACTED:win-path] [REDACTED:win-path]'],
    ];
    for (const [label, input, want] of noResidue) {
      await t.test(`无残段 ${label}`, () => {
        const out = redact(input);
        assert.strictEqual(out, want, `${label}：marker 之后留下了路径残字 → ${JSON.stringify(out)}`);
        for (const leak of ['Doe', 'doe', 'secret', 'share', 'x86', 'd.txt']) {
          assert.ok(!out.includes(leak), `${label} 残留了 ${leak} → ${JSON.stringify(out)}`);
        }
      });
    }

    // ── 代价：路径后面没有句读隔开的字会被一起打码。刻意选的，不是漏 ──────────
    await t.test('代价 · 紧跟在路径后面的半句话会被一起吃掉（宁多勿漏那一侧）', () => {
      assert.strictEqual(
        redact(String.raw`路径 C:\Users\Jane Doe\x.txt 已改好`),
        '路径 [REDACTED:win-path]',
        '边界变了就同步更新头注 🚧 段'
      );
    });

    await t.test('正斜杠 UNC 刻意不认（与 URL 分不开）', () => {
      assert.strictEqual(redact('//server/share/x'), '//server/share/x');
      // 代价对照：认它就会把每条链接吃掉，所以负控里的 GitHub URL 必须活着
      assert.strictEqual(
        redact('see https://github.com/thoerwink8/windsurf-dao/pull/891'),
        'see https://github.com/thoerwink8/windsurf-dao/pull/891'
      );
    });
  });

  it('⑧ 变异自证：去掉一条规则 → 那条正控必须翻红', async (t) => {
    const cases = [
      ['win-path', `file at ${WIN_PATH} done`, WIN_PATH],
      ['posix-path', `log in ${POSIX_HOME} now`, POSIX_HOME],
      ['high-entropy', `tok ${CANARY_HIGH} end`, CANARY_HIGH],
      ['unc-path', `share at ${SPACED_UNC} here`, SPACED_UNC],
    ];
    for (const [name, input, secret] of cases) {
      await t.test(`删掉 ${name} → 正控失效（说明该断言有判别力）`, async () => {
        const mutant = await mutantWithout(name);
        const out = mutant.redact(input);
        assert.ok(
          out.includes(secret),
          `把 ${name} 改坏后 ${JSON.stringify(input)} 仍被脱掉 ⇒ 该正控不是靠这条规则过的，` +
          `它没有判别力（或有别的规则在兜，判据重叠）。变异体输出：${JSON.stringify(out)}`
        );
      });
    }
    // 反向自证：变异手没把别的规则连带打坏（否则「翻红」可能是变异手自己坏了）
    await t.test('变异只影响目标规则：删 win-path 后凭据仍脱得掉', async () => {
      const mutant = await mutantWithout('win-path');
      assert.ok(!mutant.redact(`key=${CANARY_SK}`).includes(CANARY_SK), '变异手打坏了不该动的规则 ⇒ 变异自证不可信');
    });
  });
});
