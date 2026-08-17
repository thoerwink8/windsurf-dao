// #595 ① 守卫版本闸：落后 / 最新 / 查不成 三态。故意违规必须当场拦住。
const {
  recordStartupRevision, checkGuardRevision, formatRevisionAlarm, attachRevision,
} = require('../scripts/lib/guard-revision.mjs');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? '  →  ' + detail : ''}`); }
}

function fakeGit(script) {
  return (args) => {
    const key = args.join(' ');
    if (Object.prototype.hasOwnProperty.call(script, key)) return script[key];
    return { ok: false, error: `unexpected git ${key}` };
  };
}

const OLD = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const NEW = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

console.log('\n=== #595 ① 落后 1 个 commit → 报警 ===');
{
  const git = fakeGit({
    'fetch --quiet origin master': { ok: true, out: '' },
    'rev-parse origin/master': { ok: true, out: NEW },
    'rev-list --count aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa..origin/master': { ok: true, out: '1' },
  });
  const rev = checkGuardRevision({ startup: { sha: OLD }, git });
  check('state=behind', rev.state === 'behind' && rev.behind === 1 && rev.alarm === true, JSON.stringify(rev));
  const text = formatRevisionAlarm(rev);
  check('日志含落后 1 个', /落后 origin\/master 1 个 commit/.test(text), text);
  const hb = attachRevision({ ts: 't', prs: [] }, rev);
  check('heartbeat.revision.state=behind', hb.revision && hb.revision.state === 'behind' && hb.revision.behind === 1, JSON.stringify(hb.revision));
}

console.log('\n=== #595 ① 已是最新 → 不报 ===');
{
  const git = fakeGit({
    'fetch --quiet origin master': { ok: true, out: '' },
    'rev-parse origin/master': { ok: true, out: OLD },
  });
  const rev = checkGuardRevision({ startup: { sha: OLD }, git });
  check('state=current 不报警', rev.state === 'current' && rev.alarm === false && rev.behind === 0, JSON.stringify(rev));
  check('报警文本为空（不报）', formatRevisionAlarm(rev) === '', formatRevisionAlarm(rev));
}

console.log('\n=== #595 ① git fetch 失败 → 查不成，不含「已是最新」 ===');
{
  const git = fakeGit({
    'fetch --quiet origin master': { ok: false, error: 'Could not resolve host' },
  });
  const rev = checkGuardRevision({ startup: { sha: OLD }, git });
  check('state=unknown', rev.state === 'unknown' && rev.alarm === true && rev.current === false, JSON.stringify(rev));
  const text = formatRevisionAlarm(rev);
  check('含查不成', /查不成/.test(text), text);
  check('不含「已是最新」', !/已是最新/.test(text), text);
}

console.log('\n=== #595 ① 非 git 仓 → 查不成，不含「已是最新」 ===');
{
  const git = fakeGit({
    'fetch --quiet origin master': { ok: true, out: '' },
    'rev-parse origin/master': { ok: false, error: 'not a git repository' },
  });
  const rev = checkGuardRevision({ startup: { sha: OLD }, git });
  const text = formatRevisionAlarm(rev);
  check('非 git 仓 unknown', rev.state === 'unknown' && rev.alarm === true, JSON.stringify(rev));
  check('非 git 仓含查不成', /查不成/.test(text), text);
  check('非 git 仓不含「已是最新」', !/已是最新/.test(text), text);
}

console.log('\n=== 启动没记下 HEAD ===');
{
  const rec = recordStartupRevision({ git: () => ({ ok: false, error: 'not a git repository' }) });
  check('启动失败 ok=false', rec.ok === false && !rec.sha, JSON.stringify(rec));
  const rev = checkGuardRevision({ startup: rec, git: fakeGit({}) });
  check('启动失败后每轮都是查不成', rev.state === 'unknown' && !/已是最新/.test(formatRevisionAlarm(rev)), formatRevisionAlarm(rev));
}

console.log(`\n${fail === 0 ? 'OK' : 'FAIL'}  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
