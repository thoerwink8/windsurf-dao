// 绿样本：微修脚本该有的都在。
import { planQuickFixGate } from './lib/quick-fix.mjs';
import { ROLE_META } from './gh.mjs';

export function plan(args) {
  if (!args.issue) throw new Error('要 --issue');
  if (!args.model) throw new Error('要 --model');
  const gate = planQuickFixGate({ workerModel: args.model, reviewerId: args.reviewer, models: args.models });
  if (!gate.ok) throw new Error(gate.error);
  const attach = ['node', 'scripts/dao.mjs', 'reviewer-attach', '--skip-wait'];
  const commit = ['-c', `user.name=${ROLE_META.worker.name}`, 'commit'];
  return { attach, commit, rollback: true };
}
