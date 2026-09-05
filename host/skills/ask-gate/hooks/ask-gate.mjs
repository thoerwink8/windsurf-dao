#!/usr/bin/env node
// host/skills/ask-gate/hooks/ask-gate.mjs —— PreToolUse 钩子：正要问用户的那一刻，把判据推到眼前。
//
// 改这个文件前必须知道的六条：
//
// 1. 它**永不拦**。走的是 hookSpecificOutput.additionalContext（宿主明写「非报错反馈通道」），
//    不是 exit 2 也不是 permissionDecision:deny。拦错了 AI 就问不了用户，而用户可能正等着被问——
//    那个方向不可逆。判错顶多多一段字，判对省一次打扰。
//
// 2. 所以退出码必须永远 0，任何异常都得吞掉。对本闸来说「崩了」= 不注入 = 退回今天的样子，
//    这是安全侧；但也意味着**崩了没人知道**（宿主眼里 exit 0 和放行同形）。别在这里加会抛的逻辑。
//
// 3. PreToolUse 的裸 stdout 会被宿主丢掉。宿主只在 UserPromptSubmit / UserPromptExpansion 上
//    把 exit 0 的 stdout 自动当 additionalContext；PreToolUse 必须自己吐 JSON。
//    （实证：claude.exe 2.1.261 里 `t==="UserPromptSubmit"||t==="UserPromptExpansion"` 那一支。）
//    所以本文件只用 JSON 输出——改成 print 一行人话，等于把闸关了，而且看起来一切正常。
//
// 4. additionalContext 是随工具结果一起到模型的：它纠的是**下一次**，不是当场撤回这一次。
//    当场那一层靠 systemMessage（宿主明写「Warning message shown to the user」）——
//    用户在被问的同一屏看见「这条不在四条红线里」，可以当场说「这个不用问我」。
//
// 5. 语义判断不在这里，也不该在这里。机器只验「依据在不在四条里」，
//    「这件事算不算花钱」由 AI 自己写一句「依据：花钱」交代。想让 hook 自动判类型 = 假阳假阴，
//    比没有更糟（同 dao-mode 的 `selfie --basis`，那套已经跑通，本文件照抄思路不另造）。
//
// 6. 判据住在被观测的那个仓里。本机全局装载面点到的是 windsurf-dao 的副本，但当前工作的
//    可能是别的仓——所以优先用**当前仓**自己的 lib 与策略文件，没有才回落到本 skill 随附的那份。

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(import.meta.url);
// 从 hooks/ 往上四层就是仓根（host/skills/ask-gate/hooks/x.mjs）。
// Node 默认解析 symlink，装成 Junction 后 import.meta.url 拿到的仍是仓内真实路径。
const OWN_REPO = resolve(dirname(HERE), '..', '..', '..', '..');

function findRepoRoot(start) {
  let dir = resolve(start);
  for (let i = 0; i < 40; i += 1) {
    if (existsSync(join(dir, '.git'))) return dir;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
  return null;
}

/** 当前仓有就用当前仓的，没有回落本 skill 随附的那份。两处都没有 → null。 */
function pick(root, rel) {
  const parts = rel.split('/');
  if (root) {
    const local = join(root, ...parts);
    if (existsSync(local)) return local;
  }
  const own = join(OWN_REPO, ...parts);
  return existsSync(own) ? own : null;
}

function readStdin() {
  try {
    if (process.stdin.isTTY) return '';
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

/** 只吐 JSON。systemMessage 给用户看，additionalContext 给模型看，两条都不拦动作。 */
function emit({ context, warning }) {
  const out = { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: context } };
  if (warning) out.systemMessage = warning;
  process.stdout.write(JSON.stringify(out));
}

async function main() {
  const event = (() => {
    try { return JSON.parse(readStdin()) || {}; } catch { return {}; }
  })();

  const tool = String(event.tool_name || event.toolName || '');
  const root = findRepoRoot(event.cwd || process.cwd());

  const libPath = pick(root, 'scripts/lib/ask-gate.mjs');
  // lib 都找不到就彻底闭嘴：这时连「提问工具有哪几个」都无从判起，
  // 对着别的工具吐字是纯噪音。这条静默是本闸唯一的盲区，见文件头第 2 条。
  if (!libPath) return;
  const S = await import('file://' + libPath.replace(/\\/g, '/'));

  // hooks.json 的 matcher 已经筛过一道，这里再筛一道：matcher 写错、或宿主换了 matcher 语义时，
  // 不至于对每个工具都注入。两道筛子的名单来自同一个导出，不会各自漂移。
  if (!S.ASK_TOOLS.includes(tool)) return;

  const policyFile = pick(root, S.POLICY_REL);
  const policy = policyFile
    ? S.loadPolicy({ file: policyFile })
    : { unscanned: `${S.POLICY_REL} 在当前仓和 ${OWN_REPO} 都找不到` };

  const text = S.askToolText(event.tool_input || event.toolInput || {});
  const verdict = S.classifyAsk({ text, policy });
  const context = S.renderAskGate(verdict, { policy, tool });

  if (verdict.verdict === 'ask') {
    // 放行不啰嗦：命中红线就一行，说明凭哪条命中的，好让 AI 知道自己被算过一次。
    emit({ context });
    return;
  }
  emit({
    context,
    warning: verdict.verdict === 'unscanned'
      ? `[问人闸] 该不该问你，这次没查成：${verdict.why}`
      : `[问人闸] 这次提问不在「永远问人」的四条里（${verdict.why}）`,
  });
}

// 任何异常都不许非零退出、不许写 stderr——stderr + 非零在别的 hook 语义里会变成拦截。
main().catch(() => { /* 崩了就不注入，退回没有本闸时的样子 */ });
