// tests/fixtures/fake-feishu-gh.mjs —— 飞书适配器（#801 块A）测试的假 gh
//
// 只实现块A deps 用到的三个调用面（search issues / issue create / issue comment）；
// 其它 gh 调用一律报错退出（fail-loud：测试里出现未预期的调用 = 直接红）。
// **未知参数一律失败**（审官红①：真 gh issue create 没有 --json，假 gh 必须拦住）：
//   - issue create 收到 --json → exit 2（真 CLI unknown flag）
//   - 其余未预期参数形态 → exit 2
// 固定判定：
//   search issues "FAIL" → 模拟 gh 失败（验证 deps 抛错）；
//   issue create --repo thoerwink8/fail-repo → 模拟建单失败；
//   其余 → 固定返回：search 2 条命中；issue create stdout 输出 issue URL（真 gh 契约）。
const args = process.argv.slice(2);

if (args[0] === 'search' && args[1] === 'issues') {
  // 真 gh search issues 支持 --json；只认这套参数形态（位置参数 query 除外）
  const allowed = new Set(['--repo', '--limit', '--json']);
  for (let i = 2; i < args.length; i++) {
    if (args[i].startsWith('-') && !allowed.has(args[i])) {
      process.stderr.write(`fake-feishu-gh: search 未知参数 ${args[i]}`);
      process.exit(2);
    }
  }
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
  // 真 gh issue create 没有 --json（审官红①实测 unknown flag）——假 gh 必须拦住
  const allowed = new Set(['--repo', '--title', '--body', '--label']);
  for (let i = 2; i < args.length; i++) {
    if (args[i] === '--json') {
      process.stderr.write('fake-feishu-gh: issue create 收到 --json（真 gh 不支持，unknown flag）');
      process.exit(2);
    }
    if (args[i].startsWith('-')) {
      if (!allowed.has(args[i])) {
        process.stderr.write(`fake-feishu-gh: issue create 未知参数 ${args[i]}`);
        process.exit(2);
      }
      i += 1; // 跳过该 flag 的值
    }
  }
  const repo = args[args.indexOf('--repo') + 1];
  if (repo === 'thoerwink8/fail-repo') {
    process.stderr.write('fake-feishu-gh: 模拟 issue create 失败');
    process.exit(1);
  }
  // 真 gh issue create 契约：成功时 stdout 输出 issue URL（最后一行）
  process.stdout.write(`https://github.com/${repo}/issues/9001\n`);
  process.exit(0);
}

if (args[0] === 'issue' && args[1] === 'comment') {
  const allowed = new Set(['--repo', '--body']);
  for (let i = 2; i < args.length; i++) {
    if (args[i].startsWith('-')) {
      if (!allowed.has(args[i])) {
        process.stderr.write(`fake-feishu-gh: issue comment 未知参数 ${args[i]}`);
        process.exit(2);
      }
      i += 1; // 跳过该 flag 的值
    }
  }
  process.stdout.write('\n');
  process.exit(0);
}

process.stderr.write(`fake-feishu-gh: 未预期调用 ${args.join(' ')}`);
process.exit(2);
