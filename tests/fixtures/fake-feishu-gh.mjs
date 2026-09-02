// tests/fixtures/fake-feishu-gh.mjs —— 飞书适配器（#801 块A）测试的假 gh
//
// 只实现块A deps 用到的三个调用面（search issues / issue create / issue comment）；
// 其它 gh 调用一律报错退出（fail-loud：测试里出现未预期的调用 = 直接红）。
// 固定判定：
//   search issues "FAIL" → 模拟 gh 失败（验证 deps 抛错）；
//   issue create --repo thoerwink8/fail-repo → 模拟建单失败；
//   其余 → 固定返回（1 条搜索命中 / issue 9001）。
const args = process.argv.slice(2);

if (args[0] === 'search' && args[1] === 'issues') {
  const query = args[2];
  const repo = args[args.indexOf('--repo') + 1];
  if (query === 'FAIL') {
    process.stderr.write('fake-feishu-gh: 模拟 gh search 失败');
    process.exit(1);
  }
  process.stdout.write(JSON.stringify([
    { number: 1436, title: '会话支持', url: `https://github.com/${repo}/issues/1436` },
    { number: 2760, title: '已修复', url: `https://github.com/${repo}/issues/2760` },
  ]));
  process.exit(0);
}

if (args[0] === 'issue' && args[1] === 'create') {
  const repo = args[args.indexOf('--repo') + 1];
  if (repo === 'thoerwink8/fail-repo') {
    process.stderr.write('fake-feishu-gh: 模拟 issue create 失败');
    process.exit(1);
  }
  process.stdout.write(JSON.stringify({ number: 9001, url: `https://github.com/${repo}/issues/9001` }));
  process.exit(0);
}

if (args[0] === 'issue' && args[1] === 'comment') {
  process.stdout.write('{}');
  process.exit(0);
}

process.stderr.write(`fake-feishu-gh: 未预期调用 ${args.join(' ')}`);
process.exit(2);
