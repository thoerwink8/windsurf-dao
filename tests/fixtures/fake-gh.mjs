// tests/fixtures/fake-gh.mjs —— 消歧门 CLI 测试的假 gh（#565）
//
// 背景：CLI 级消歧门测试（dispatch/worker-start --issue）曾直接调真 gh，
// CI（check.yml）无 GH_TOKEN，gh issue view 全线失败 → 门按「没查成」拒派 → 测试红。
// 测试改走环境变量注入：dao.mjs 的消歧门 gh 执行器读到 DAO_GH_FAKE 就用它替真 gh
// （生产不设；同仓先例：grill-ai-pointers.tests.js 的 GRILL_MEM_DIR 覆盖）。
//
// 判定固定：issue 565 → 有「已消歧」label（本单所在 issue）；issue 999 → 模拟 gh 失败
// （CI 无 GH_TOKEN 的场景：必须报「没查成」拒派，不许放行）；其余号 → 无 label。
// 造违规样本（无 label 拒派）用 559，造通过样本用 565，CI 无网络也确定。
//
// 只实现消歧门用到的调用面（issue view <N> --json labels）；其它 gh 调用一律报错退出
// （fail-loud：测试里出现未预期的调用 = 直接红，不许静默返回假数据）。

const args = process.argv.slice(2);
// #564：label 自动打 / pr-sync-labels 的 CLI 测试也要走假 gh（CI 无 GH_TOKEN）。
// #586：reviewer/* 自读选型 + worker-done 骨架也走假 gh。
// 固定判定：
//   issue 565 → 已消歧 + model/grok-4.6 + type/写码 + reviewer/gpt-5.6-sol（查到一个）；
//   issue 568 → 无 reviewer/*（扫完 0 条）；
//   issue 569 → reviewer/gpt-5.6-sol + reviewer/claude-opus（有多个）；
//   issue 999 → 模拟 gh 失败（CI 无 GH_TOKEN 场景：必须报「没查成」拒派）；
//   其余号 → 无 label。
//   PR 42 正文 Closes #565；PR 43 Closes #568；PR 44 Closes #569；PR 46 Closes #565 且已有 review。
// 只实现测试用到的调用面；其它 gh 调用一律报错退出（fail-loud，不许静默返回假数据）。
const ISSUE_LABELS = {
  '565': [{ name: '已消歧' }, { name: '任务' }, { name: 'model/grok-4.6' }, { name: 'type/写码' }, { name: 'reviewer/gpt-5.6-sol' }],
  '568': [{ name: '已消歧' }, { name: 'model/grok-4.6' }, { name: 'type/写码' }],
  '569': [{ name: '已消歧' }, { name: 'model/grok-4.6' }, { name: 'type/写码' }, { name: 'reviewer/gpt-5.6-sol' }, { name: 'reviewer/claude-opus' }],
};
const REPO_LABELS = ['已消歧', '任务', 'model/grok-4.6', 'type/写码', 'reviewer/gpt-5.6-sol'];
const PR_HEAD = {
  headRefName: 'thoerwink8/fake-head',
  headRefOid: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  mergeable: 'MERGEABLE',
};

if (args[0] === 'issue' && args[1] === 'view' && args[3] === '--json' && args[4] === 'labels') {
  const n = args[2];
  if (n === '999') {
    process.stderr.write('fake-gh: 模拟 gh 失败（CI 无 GH_TOKEN）');
    process.exit(1);
  }
  const labels = ISSUE_LABELS[n] || [];
  process.stdout.write(JSON.stringify({ labels }));
  process.exit(0);
}
if (args[0] === 'issue' && args[1] === 'edit') {
  const n = args[2];
  if (n === '999') {
    process.stderr.write('fake-gh: 模拟 issue edit 失败');
    process.exit(1);
  }
  const addLabels = [];
  for (let i = 3; i < args.length; i++) {
    if (args[i] === '--add-label' && args[i + 1]) addLabels.push(args[i + 1]);
  }
  process.stdout.write(JSON.stringify({ number: Number(n), labels: addLabels.map(name => ({ name })) }));
  process.exit(0);
}
if (args[0] === 'label' && args[1] === 'list') {
  process.stdout.write(JSON.stringify(REPO_LABELS.map(name => ({ name }))));
  process.exit(0);
}
if (args[0] === 'label' && args[1] === 'create') {
  process.stdout.write(JSON.stringify({ name: args[2] }));
  process.exit(0);
}
if (args[0] === 'pr' && args[1] === 'view') {
  const n = args[2];
  if (n === '42') {
    process.stdout.write(JSON.stringify({
      title: '修注入轮询回归',
      body: 'Closes #565\n验收：测试 306 过',
      reviews: [],
      ...PR_HEAD,
    }));
    process.exit(0);
  }
  if (n === '41') {
    process.stdout.write(JSON.stringify({ title: '无署名', body: '改动：修复登录', reviews: [], ...PR_HEAD }));
    process.exit(0);
  }
  if (n === '43') {
    process.stdout.write(JSON.stringify({
      title: '无审官 label',
      body: 'Closes #568',
      reviews: [],
      ...PR_HEAD,
    }));
    process.exit(0);
  }
  if (n === '44') {
    process.stdout.write(JSON.stringify({
      title: '两个审官 label',
      body: 'Closes #569',
      reviews: [],
      ...PR_HEAD,
    }));
    process.exit(0);
  }
  if (n === '46') {
    process.stdout.write(JSON.stringify({
      title: '返工轮',
      body: 'Closes #565',
      reviews: [{ id: 1, body: '判定：红 1 项' }],
      ...PR_HEAD,
    }));
    process.exit(0);
  }
  process.stderr.write(`fake-gh: 未预期的 PR ${n}`);
  process.exit(1);
}
if (args[0] === 'pr' && args[1] === 'edit') {
  process.stdout.write(JSON.stringify({ number: Number(args[2]) }));
  process.exit(0);
}
if (args[0] === 'pr' && args[1] === 'comment') {
  process.stdout.write(JSON.stringify({ id: 1, pr: Number(args[2]) }));
  process.exit(0);
}
if (args[0] === 'api' && /\/pulls\/\d+\/files$/.test(String(args[1] || ''))) {
  process.stdout.write(JSON.stringify([{ filename: 'scripts/dao.mjs', status: 'modified' }]));
  process.exit(0);
}
if (args[0] === 'issue' && args[1] === 'comment') {
  const n = args[2];
  if (n === '999') {
    process.stderr.write('fake-gh: 模拟 issue comment 失败');
    process.exit(1);
  }
  process.stdout.write(JSON.stringify({ id: 1, issue: Number(n) }));
  process.exit(0);
}
process.stderr.write(`fake-gh: 未预期的调用 ${args.join(' ')}`);
process.exit(1);
