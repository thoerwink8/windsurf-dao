// land 接 orca automations 的安装规格（#829）。
// 名字/prompt/precheck 只在这里定一份；安装命令与 server-check 都读这里，避免两个生产者。
// prompt 只写「跑这条命令」，不写业务逻辑（8-24 决策）。

export const LAND_AUTOMATION_NAME = 'land';
export const LAND_AUTOMATION_PROVIDER = 'pi';
export const LAND_AUTOMATION_TRIGGER = 'hourly';

export function quoteCmd(s) {
  return JSON.stringify(String(s));
}

export function landPrecheckCommand(landJs, repoPath) {
  return `node ${quoteCmd(landJs)} --has-work ${quoteCmd(repoPath)}`;
}

/** 给 agent 的整段 prompt：只下令跑 land、原样贴回。 */
export function landPrompt(landJs, repoPath) {
  return `跑 node ${quoteCmd(landJs)} ${quoteCmd(repoPath)}，把输出原样贴回，不要自行修仓。`;
}

/** 幂等：同名 0 条 → create；1 条 → edit；多于 1 条 → error（不许再造）。 */
export function planLandAutomationInstall(automations, name = LAND_AUTOMATION_NAME) {
  const hits = (Array.isArray(automations) ? automations : []).filter((a) => a && a.name === name);
  if (hits.length > 1) {
    return { action: 'error', reason: `同名 automation ${hits.length} 条，重跑会再造——先手工删到只剩一条`, hits };
  }
  if (hits.length === 1) return { action: 'edit', id: hits[0].id, existing: hits[0] };
  return { action: 'create' };
}
