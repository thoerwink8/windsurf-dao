#!/usr/bin/env node
import {createExecutionRuntime} from './lib/execution-runtime.mjs';
import {pathToFileURL} from 'node:url';
export function normalizeExecutionSession(s) {
  const interactions=s.interactions||s.snapshot?.interactions||[];
  const waiting=s.awaiting===true||['waiting','waiting_user','waiting_permission'].includes(s.phase)||interactions.some(i=>!i.answered&&!i.answeredAt&&!i.resolvedAt&&!['answered','cancelled','resolved'].includes(i.status));
  const failed=!!s.error||['error','failed','aborted'].includes(s.phase);
  const issue=Number(s.issue??s.issue_number);
  const pr=Number(s.pr??s.pr_number);
  return {key:s.sessionKey??s.key??s.id??null,title:s.title??null,
    state:failed?'failed':waiting?'waiting_user':s.incomplete?'incomplete':s.phase??s.runState??s.state??null,
    cwd:s.workdir??s.cwd??null,lastActivityAt:s.seatAt??s.updatedAt??s.lastActivityAt??null,
    // 模型与落地：渠道在途数要用「这棵树在跑什么模型」把它归到渠道（#1145 的分子）。
    // 登记文件里本来就有这两格，是这份名单**没往外带**——登记里 323/323 条都有 model+workdir，
    // 而名单只有 key/title/state/cwd，于是消费侧拿不到模型，只能退回「按分支名猜派工账本」，
    // 猜不到就归进 unattributed。实测渠道在途数因此恒为 0，渠道闸对在途**永远不判满**。
    model:s.model??s.requestedModel??null,
    provider:s.provider??s.actualVendor??null,
    profileId:s.profileId??null,
    cleanupVerified:s.cleanupVerified??null,
    backend:String(s.sessionKey??s.key??'').startsWith('acp:')?'acp':'mirasim',
    ...(Number.isInteger(issue)&&issue>0?{issue}:{}),
    ...(Number.isInteger(pr)&&pr>0?{pr}:{})};
}
export async function main() {
try {
  const r=await createExecutionRuntime().listSessions();
  if(!r.ok)throw new Error('execution session scan incomplete: '+JSON.stringify(r.errors));
  const sessions=r.sessions.map(normalizeExecutionSession);
  console.log(JSON.stringify({type:'sessions',sessions,count:sessions.length,scope:r.scope||'global'}));
} catch(e) {console.error(e.message);process.exitCode=2;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await main();
