// ACP 起会话时「任务内已知答案」的默认策略（#1174 T8b）。
//
// 已知 = T1 实测放过的那一类：受管 worktree 内的读/改，以及白名单里的 git 前缀。
// 未知（MCP 提问、白名单外的命令、树外路径）不猜，留给 waiting_user。
// 调用方显式给了 interactionPolicy 就用那份，不和默认合并——合并会造出两条同 method 规则，policyAnswer 直接判歧义。

import path from 'node:path';

/** T1 Cursor/Devin 工作树闭环实际放过的 execute 前缀。不在这里的命令要等人。
 *
 * 2026-09-18 补只读巡检一条：fleet 首跑实咬——会话要读代码就得跑 `ls`/`grep`/`cat` 一类命令，
 * 全在白名单外 → 停在 `waiting_user` 等人回答，无人值守链路上等于卡死。
 * 补的原则不变：**只放行树内的只读巡检**；碰网络/凭据/装包的（gh、curl、npm install、git push）
 * 与树外路径一律仍留给人。 */
export const WORKTREE_EXECUTE_PREFIXES = Object.freeze([
  Object.freeze(['git', 'status']),
  Object.freeze(['git', 'log']),
  Object.freeze(['git', 'add']),
  Object.freeze(['git', 'commit']),
  Object.freeze(['git', 'rev-parse']),
  Object.freeze(['git', 'diff']),
  Object.freeze(['git', 'show']),
  Object.freeze(['git', 'branch']),
  Object.freeze(['echo']),
  Object.freeze(['ls']),
  Object.freeze(['cat']),
  Object.freeze(['head']),
  Object.freeze(['tail']),
  Object.freeze(['wc']),
  Object.freeze(['grep']),
  Object.freeze(['rg']),
  Object.freeze(['find']),
  Object.freeze(['sed']),
  Object.freeze(['diff']),
  Object.freeze(['stat']),
  Object.freeze(['file']),
  Object.freeze(['tree']),
  // `test -f/-d <路径>`：交卷前判断文件在不在是最常见的自查（g2 实咬：工人写完了
  // README 却卡在 `test -f` 的权限提问上）。参数路径同样受树内约束，见 acp-session-runner。
  Object.freeze(['test']),
  Object.freeze(['node', '--test']),
  // 跑仓库自己的测试（改 CI 接线的任务要看测试计数）。**不放 npm ci / npm install**：
  // 那要联网、有供应链面；装依赖由系统在 prepare 阶段按 lock 做好。
  Object.freeze(['npm', 'test']),
  Object.freeze(['npm', 'run']),
]);

export const WORKTREE_TOOL_KINDS = Object.freeze(['read', 'edit', 'execute']);

export function defaultWorktreeInteractionPolicy(workdir) {
  if (typeof workdir !== 'string' || !path.isAbsolute(workdir)) {
    throw new Error('default worktree policy requires an absolute workdir');
  }
  return {
    rules: [{
      method: 'session/request_permission',
      worktreeScope: true,
      workdir,
      toolKinds: [...WORKTREE_TOOL_KINDS],
      commandPrefixes: WORKTREE_EXECUTE_PREFIXES.map((p) => [...p]),
      answer: { grant: 'once' },
    }],
  };
}

/** ACP 没给策略 → 默认 worktree 放行；显式策略（含 {rules:[]}）原样用。非 ACP 不塞。 */
export function resolveStartInteractionPolicy({ backend, workdir, interactionPolicy } = {}) {
  if (backend !== 'acp') return interactionPolicy;
  if (interactionPolicy != null) return interactionPolicy;
  return defaultWorktreeInteractionPolicy(workdir);
}
