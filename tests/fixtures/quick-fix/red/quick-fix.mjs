// 红样本：微修脚本忘了 #679 闸、忘了异步审官、忘了回滚、身份不是 bot。
export function plan(args) {
  if (!args.issue) throw new Error('要 --issue');
  if (!args.model) throw new Error('要 --model');
  return { issue: args.issue, model: args.model };
}
