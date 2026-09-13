#!/usr/bin/env node
import {createExecutionRuntime} from './lib/execution-runtime.mjs';
import {pathToFileURL} from 'node:url';
export function normalizeExecutionSession(s) {
  const interactions=s.interactions||s.snapshot?.interactions||[];
  const waiting=s.awaiting===true||['waiting','waiting_user','waiting_permission'].includes(s.phase)||interactions.some(i=>!i.answered&&!i.answeredAt&&!i.resolvedAt&&!['answered','cancelled','resolved'].includes(i.status));
  const failed=!!s.error||['error','failed','aborted'].includes(s.phase);
  return {key:s.sessionKey??s.key??s.id??null,title:s.title??null,
    state:failed?'failed':waiting?'waiting_user':s.incomplete?'incomplete':s.phase??s.runState??s.state??null,
    cwd:s.workdir??s.cwd??null,lastActivityAt:s.seatAt??s.updatedAt??s.lastActivityAt??null,
    backend:String(s.sessionKey??s.key??'').startsWith('acp:')?'acp':'mirasim'};
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
