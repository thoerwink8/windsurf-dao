// 判据不得经过外壳的引号层（dao-check ㊲，2026-09-13 用户拍板「赞同」，随 #1240）
//
// 验 scripts/lib/inline-script-check.mjs：
//   内联代码解释器的**代码参数**里含 `$`/反引号（落在双引号区间）→ 红；
//   单引号区间里的 `$`、`\$` 转义、整行注释、行内代码里的 `--body` → 不报（红得没道理的闸会被关掉）；
//   `--body` 正文含命令替换 → 红；`gh issue` 写动作带 `--body` 且正文含替换 → 红（#792 同口径）；
//   引用定界符的 heredoc 正文一个字都不判；
//   扫了 N 份 0 违规 vs 一份都没扫到——后者没查成，不许当绿；
//   故意违规样本必须当场拦下（仓规：被拦住才算生效）。
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const LIB = path.join(REPO, 'scripts', 'lib', 'inline-script-check.mjs');
const FIX = path.join(__dirname, 'fixtures', 'inline-script');
const LOAD = import('file://' + LIB.replace(/\\/g, '/'));

function judge(S, line, file = 'x.sh') {
  return S.judgeInlineScriptLine(line, { file, lineNo: 1 });
}

describe('inline-script-check', () => {
  it('检查器零 import——探头全注入，不复用被检查对象', () => {
    const src = fs.readFileSync(LIB, 'utf8');
    const imports = [...src.matchAll(/^import\s+[\s\S]*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);
    assert.deepEqual(imports, [], '本检查器不许 import 任何东西（含 shell / 网关解析器）');
    assert.equal(/require\s*\(/.test(src), false, '也不许 require');
  });

  it('实咬原形：`node -e "…$/"` 当场拦下并点出 $/', async () => {
    const S = await LOAD;
    const v = judge(S, 'node -e "const m=/@e([0-9a-f]{12})$/.exec(\'x\')"');
    assert.equal(v.kind, 'inline-eval');
    assert.match(v.why, /\$\//, '要说清是哪个形状被吞  →  ' + v.why);
  });

  it('三种展开形状（$/, ${, $(）都拦', async () => {
    const S = await LOAD;
    for (const [line, shape] of [
      ['node -e "x=/a$/.test(s)"', '$/'],
      ['node -e "console.log(${HOME})"', '${'],
      ['node -e "console.log($(date))"', '$('],
    ]) {
      const v = judge(S, line);
      assert.ok(v, `该拦没拦：${line}`);
      assert.ok(v.why.includes(shape), `没点出 ${shape}  →  ${v.why}`);
    }
  });

  it('python3 -c / perl -e 同样按内联代码判', async () => {
    const S = await LOAD;
    assert.equal(judge(S, 'python3 -c "print(os.environ[\'$HOME\'])"').kind, 'inline-eval');
    assert.equal(judge(S, 'perl -e "print $x"').kind, 'inline-eval');
  });

  it('只看代码参数：同一行别处的 $ 展开不报', async () => {
    const S = await LOAD;
    const line = 'if [[ -f "$STATE" ]] && runuser -u orca -- node -e \'process.exit(0)\'';
    assert.equal(judge(S, line), null, '代码在单引号里、$STATE 是正当参数展开，不该报');
  });

  it('单引号区间里的 $ 全部放行（正当用法）', async () => {
    const S = await LOAD;
    assert.equal(judge(S, "node -e 'process.stdout.write(\"N\"+Date.now())'"), null);
    assert.equal(judge(S, "git log -1 --format='%h %s'"), null);
  });

  it('转义 \\$ 与整行注释不报', async () => {
    const S = await LOAD;
    assert.equal(judge(S, 'node -e "echo \\$HOME"'), null, '转义的 $ 外壳不展开');
    assert.equal(judge(S, '# 讨论：不要写 node -e "x$y"'), null);
    assert.equal(judge(S, '// 讨论：不要写 node -e "x$y"'), null);
  });

  it('--body 正文含命令替换 → 红；死的正文不报', async () => {
    const S = await LOAD;
    assert.equal(judge(S, 'gh pr comment 1 --repo o/r --body "结论：$(date)"').kind, 'inline-body');
    assert.equal(judge(S, 'gh pr comment 1 --repo o/r --body "纯文字结论"'), null, '没有展开就不报');
  });

  it('--body-file 是正当做法，不报', async () => {
    const S = await LOAD;
    assert.equal(judge(S, 'gh issue comment 1 --repo o/r --body-file f.md'), null);
  });

  it('散文中引用的 --body 不报（闸自己的正控样本就是这个形状）', async () => {
    const S = await LOAD;
    assert.equal(judge(S, '// 多行 `--body` 先写文件再 `--body-file`'), null, 'Markdown/注释里的旗标引用不是命令行');
    assert.equal(judge(S, "const ghCreate = decideGate('gh issue create --title t --body b');"), null,
      '闸自己的样本不能被闸刷红——一律红会把闸自己变成噪音');
  });

  it('gh issue 写动作带 --body 且含变量 → 红（#792 同口径）', async () => {
    const S = await LOAD;
    const v = judge(S, 'gh issue comment 42 --repo o/r --body "结论：$(git rev-parse --short HEAD)"');
    assert.equal(v.kind, 'gh-issue-body-arg');
    assert.match(v.fix, /issue-gateway/, '修法要指到网关  →  ' + v.fix);
  });

  it('引用定界符的 heredoc：正文一个字都不判', async () => {
    const S = await LOAD;
    const text = [
      "cat > /tmp/p.md <<'EOF'",
      '结论：$HOME 与 $(git rev-parse HEAD) 原样保留。',
      'EOF',
      'node -e "x=/a$/.test(s)"',
    ].join('\n');
    const vs = S.scanInlineScriptText(text, { file: 'x.sh' });
    assert.equal(vs.length, 1, '只该报 heredoc 之后那一行  →  ' + JSON.stringify(vs.map((v) => v.line)));
    assert.equal(vs[0].line, 4);
  });

  it('引号跨行：续写里的 $ 归外层引号管，不因行内引号误判', async () => {
    const S = await LOAD;
    const text = [
      "node -e '",
      '  const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));',
      "  console.log('$HOME');",
      "'",
    ].join('\n');
    const vs = S.scanInlineScriptText(text, { file: 'x.sh' });
    assert.deepEqual(vs, [], '外层单引号里的 $ 不展开，不该报  →  ' + JSON.stringify(vs));
  });

  it('一份都没扫到 = 没查成，不许当绿', async () => {
    const S = await LOAD;
    const r = S.inspectInlineScripts({ files: [] });
    assert.equal(r.ok, false);
    assert.equal(r.unscanned, true);
    assert.match(r.error, /没查成/);
  });

  it('扫了 N 份 0 违规 = 绿，并且带上份数', async () => {
    const S = await LOAD;
    const r = S.inspectInlineScripts({ files: [{ path: 'a.sh', text: 'echo hi\n' }, { path: 'b.sh', text: 'node /tmp/x.mjs\n' }] });
    assert.equal(r.ok, true);
    assert.equal(r.scanned, 2);
  });

  it('node_modules 底下不扫', async () => {
    const S = await LOAD;
    const r = S.inspectInlineScripts({
      files: [{ path: 'host/machine/x/node_modules/p/package.json', text: 'node -e "x=${a}"' }],
    });
    assert.equal(r.ok, true, '第三方历史文本不是本仓的动手路径');
  });

  it('故意违规样本当场拦下（仓规：被拦住才算生效）', async () => {
    const S = await LOAD;
    const evil = { path: 'tmp/evil.sh', text: 'head=$(git rev-parse HEAD)\nnode -e "const m=/@e([0-9a-f]{12})$/.exec(\'$head\')"\n' };
    const r = S.inspectInlineScripts({ files: [evil] });
    assert.equal(r.ok, false, '故意违规必须拦下');
    assert.equal(r.violations[0].line, 2);
    assert.equal(r.violations[0].kind, 'inline-eval');
  });

  it('夹具三态齐全且都有判别力', async () => {
    const S = await LOAD;
    const readdir = (rel) => fs.readdirSync(path.join(REPO, rel));
    const r = S.inspectInlineScriptsFixtures({
      exists: (rel) => fs.existsSync(path.join(REPO, rel)),
      readdir,
      readFile: (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8'),
    });
    assert.equal(r.ok, true, r.error || (r.problems || []).join('；'));
    assert.deepEqual(r.kinds, { red: 1, ok: 1, empty: 1 });
  });

  it('夹具目录真在仓里（不是现场拼出来的）', () => {
    for (const k of ['red', 'ok', 'empty']) {
      assert.ok(fs.existsSync(path.join(FIX, k)), `缺 ${k}/`);
    }
    assert.ok(fs.readdirSync(path.join(FIX, 'red')).length >= 2, '红样本要覆盖两种形状');
  });
});
