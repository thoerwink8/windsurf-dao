#!/usr/bin/env node
import {COMMANDER_SCAN_BUDGET_MS,createExecutionRuntime,formatIncompleteScanWhy,summarizeScanObservation} from './lib/execution-runtime.mjs';
import {EXECUTION_WAITING,sessionStateOf} from './lib/execution-states.mjs';
import {pathToFileURL} from 'node:url';
export function scanBudgetMs(env=process.env) {
  const n=Number.parseInt(env.DAO_EXECUTION_SCAN_BUDGET_MS||'',10);
  if(Number.isInteger(n)&&n>0)return n;
  return COMMANDER_SCAN_BUDGET_MS;
}
export function normalizeExecutionSession(s) {
  const interactions=s.interactions||s.snapshot?.interactions||[];
  const phase=sessionStateOf(s)||'';
  const waiting=s.awaiting===true||EXECUTION_WAITING.has(phase)||interactions.some(i=>!i.answered&&!i.answeredAt&&!i.resolvedAt&&!['answered','cancelled','resolved'].includes(i.status));
  const failed=!!s.error||['error','failed','aborted'].includes(phase);
  const issue=Number(s.issue??s.issue_number);
  const pr=Number(s.pr??s.pr_number);
  return {key:s.sessionKey??s.key??s.id??null,sessionKey:s.sessionKey??null,title:s.title??null,
    state:failed?'failed':waiting?'waiting_user':s.incomplete?'incomplete':phase||null,
    cwd:s.workdir??s.cwd??null,lastActivityAt:s.seatAt??s.updatedAt??s.lastActivityAt??null,
    cleanupVerified:s.cleanupVerified===true,
    // 模型与落地：渠道在途数要用「这棵树在跑什么模型」把它归到渠道（#1145 的分子）。
    // 登记文件里本来就有这两格，是这份名单**没往外带**——登记里 323/323 条都有 model+workdir，
    // 而名单只有 key/title/state/cwd，于是消费侧拿不到模型，只能退回「按分支名猜派工账本」，
    // 猜不到就归进 unattributed。实测渠道在途数因此恒为 0，渠道闸对在途**永远不判满**。
    model:s.model??s.requestedModel??null,
    provider:s.provider??s.actualVendor??null,
    profileId:s.profileId??null,
    backend:String(s.sessionKey??s.key??'').startsWith('acp:')?'acp':'mirasim',
    ...(Number.isInteger(issue)&&issue>0?{issue}:{}),
    ...(Number.isInteger(pr)&&pr>0?{pr}:{})};
}
export async function main() {
try {
  const budgetMs=scanBudgetMs();
  const r=await createExecutionRuntime({managedListTimeoutMs:budgetMs}).listSessions();
  const complete=r.ok===true&&r.partial!==true&&r.complete!==false;
  const sessions=Array.isArray(r.sessions)?r.sessions.map(normalizeExecutionSession):null;
  const counts=r.counts||summarizeScanObservation({sessions,errors:r.errors});
  const why=complete?null:formatIncompleteScanWhy(counts);
  console.log(JSON.stringify({
    type:'sessions',
    sessions,
    count:Array.isArray(sessions)?sessions.length:0,
    scope:r.scope||'managed',
    ok:r.ok===true,
    partial:complete?false:true,
    complete,
    stages:r.stages||null,
    errors:r.errors||[],
    counts,
    why,
  }));
  if(!complete){
    // 计数走 stdout 协议帧；stderr 只留短 why，避免再被 200 字节截成 "ma"
    console.error(why);
    process.exitCode=2;
  }
} catch(e) {console.error(e.message);process.exitCode=2;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await main();
