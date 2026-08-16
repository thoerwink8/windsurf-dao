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
if (args[0] === 'issue' && args[1] === 'view' && args[3] === '--json' && args[4] === 'labels') {
  const n = args[2];
  if (n === '999') {
    process.stderr.write('fake-gh: 模拟 gh 失败（CI 无 GH_TOKEN）');
    process.exit(1);
  }
  const labels = n === '565' ? [{ name: '已消歧' }, { name: '任务' }] : [];
  process.stdout.write(JSON.stringify({ labels }));
  process.exit(0);
}
process.stderr.write(`fake-gh: 未预期的调用 ${args.join(' ')}`);
process.exit(1);
