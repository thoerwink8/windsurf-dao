import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn,spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {createExecutionRuntime,judgeExecutionCompletion,maintenanceStatus,resolveExecutionProfile,promotedVersion} from '../scripts/lib/execution-runtime.mjs';
import {acquireExecutionFence,withExecutionFence,writeExecutionRecord} from '../scripts/lib/execution-fence.mjs';

const linuxTest=(name,fn)=>test(name,{skip:process.platform!=='linux',timeout:10000},fn);
const key=(agent='codex')=>agent+':'+crypto.randomUUID();
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const emptyScan=()=>({ok:true,procs:[]});
const profile={id:'cursor-test',backend:'acp',agent:'cursor',model:'composer-test',enabled:true,availability:{status:'available'},provider:'cursor',accountPoolId:'cursor-owner',route:'local',actualVendor:'cursor'};
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'execution-runtime-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const workdir=path.join(dir,'tree');fs.mkdirSync(workdir);return {dir,workdir,stateDir:path.join(dir,'.dao/execution')};}
function fakeRuntime(overrides={}) {
  const views=new Map(),calls={start:[],read:[],stop:[],list:0,resume:[]};
  const rt={views,calls,config:{},async startSession(spec){calls.start.push(spec);const sessionKey=spec.sessionKey||key(spec.agent);views.set(sessionKey,{phase:'running',text:'',toolCalls:[],missing:false});return {sessionKey,taskId:spec.taskId};},async readSession(k){calls.read.push(k);return views.get(k)||{missing:true,phase:null};},async listSessions(){calls.list++;return {ok:true,sessions:[]};},async stopSession(k){calls.stop.push(k);views.set(k,{phase:'stopped',text:'',missing:false});return {ok:true,verified:true};},async interact(){return {ok:true};},...overrides};
  return rt;
}
function runtime(f,opts={}){return createExecutionRuntime({homeDir:f.dir,profiles:[],mirasimRuntime:fakeRuntime(),acpRuntime:fakeRuntime(),scanProcesses:emptyScan,cleanupPollMs:1,stopVerifyTries:1,...opts});}
const spec=f=>({agent:'codex',model:'fixture-model',workdir:f.workdir,prompt:'fixture',taskId:'task-1174',issue:1174});
function lease(f){const file=path.join(f.stateDir,'leases',crypto.createHash('sha256').update(fs.realpathSync(f.workdir)).digest('hex')+'.json');return {file,value:JSON.parse(fs.readFileSync(file))};}
function records(f){return fs.readdirSync(path.join(f.stateDir,'sessions')).filter(n=>n.endsWith('.json')).map(n=>JSON.parse(fs.readFileSync(path.join(f.stateDir,'sessions',n))));}
const fenceURL=new URL('../scripts/lib/execution-fence.mjs',import.meta.url).href;
const runtimeURL=new URL('../scripts/lib/execution-runtime.mjs',import.meta.url).href;

linuxTest('real flock belongs to the parent FD after helper exit and shares the same inode',async t=>{
  const f=fixture(t),held=acquireExecutionFence({stateDir:f.stateDir});assert.ok(held.ok);t.after(()=>held.release());
  const childCode='import {acquireExecutionFence} from '+JSON.stringify(fenceURL)+';const h=acquireExecutionFence({stateDir:process.argv[1]});console.log(JSON.stringify({ok:h.ok}));h.release?.();';
  const probe=()=>{const r=spawnSync(process.execPath,['--input-type=module','-e',childCode,f.stateDir],{encoding:'utf8',timeout:3000});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);};
  const inode=fs.statSync(held.path).ino;assert.equal(probe().ok,false);held.release();assert.equal(probe().ok,true);assert.equal(fs.statSync(held.path).ino,inode);
});
linuxTest('flock automatically releases on holder death without unlink or PID stale-lock heuristics',async t=>{
  const f=fixture(t);const script='import {acquireExecutionFence} from '+JSON.stringify(fenceURL)+';const h=acquireExecutionFence({stateDir:process.argv[1]});console.log(h.ok?"ready":"busy");setInterval(()=>{},1000);';
  const child=spawn(process.execPath,['--input-type=module','-e',script,f.stateDir],{stdio:['ignore','pipe','pipe']});t.after(()=>{if(child.exitCode===null)child.kill('SIGKILL');});
  assert.match(String((await once(child.stdout,'data'))[0]),/ready/);
  assert.equal(acquireExecutionFence({stateDir:f.stateDir}).ok,false);
  const exited=once(child,'exit');child.kill('SIGKILL');await exited;
  const h=acquireExecutionFence({stateDir:f.stateDir});assert.ok(h.ok);h.release();assert.ok(fs.existsSync(h.path));
});
linuxTest('root-compatible fence mode does not inherit restrictive umask',t=>{
  const f=fixture(t),old=process.umask(0o077);let h;
  try{h=acquireExecutionFence({stateDir:f.stateDir});assert.equal(fs.statSync(h.path).mode&0o777,0o644);}finally{h?.release();process.umask(old);}
});
linuxTest('fence refuses symlink replacement and makes contention explicit',async t=>{
  const f=fixture(t);fs.mkdirSync(f.stateDir,{recursive:true});fs.symlinkSync('/nonexistent-fixture',path.join(f.stateDir,'admission.lock'));assert.throws(()=>acquireExecutionFence({stateDir:f.stateDir}));fs.unlinkSync(path.join(f.stateDir,'admission.lock'));
  const h=acquireExecutionFence({stateDir:f.stateDir});try{await assert.rejects(withExecutionFence({stateDir:f.stateDir,timeoutMs:0},()=>{}),e=>e.detail?.reason==='admission-held');}finally{h.release();}
});
linuxTest('Mirasim persists a keyless pending reservation before the first network call',async t=>{
  const f=fixture(t),m=fakeRuntime();let observed;
  const start=m.startSession;m.startSession=async s=>{observed={rows:records(f),lease:lease(f).value,spec:s};return start(s);};
  const rt=runtime(f,{mirasimRuntime:m}),r=await rt.startSession(spec(f));
  assert.equal(observed.spec.sessionKey,undefined);assert.equal(observed.rows[0].sessionKey,null);assert.equal(observed.rows[0].state,'pending');assert.match(observed.rows[0].recordKey,/^launch:/);assert.equal(observed.lease.recordKey,observed.rows[0].recordKey);assert.equal(observed.spec.clientRef,observed.rows[0].clientRef);
  assert.equal(records(f).length,1);assert.equal(records(f)[0].sessionKey,r.sessionKey);assert.equal(lease(f).value.sessionKey,r.sessionKey);assert.equal(r.taskId,'task-1174');assert.equal(r.taskCompleted,false);
});
linuxTest('updater fence observes pending launch; maintenance blocks all later admissions',async t=>{
  const f=fixture(t),entered=deferred(),release=deferred(),m=fakeRuntime();const start=m.startSession;
  m.startSession=async s=>{entered.resolve();await release.promise;return start(s);};
  const rt=runtime(f,{mirasimRuntime:m}),pending=rt.startSession(spec(f));await entered.promise;
  await withExecutionFence({stateDir:f.stateDir},()=>{writeExecutionRecord(path.join(f.stateDir,'maintenance.json'),{active:true,expiresAt:Date.now()+60000});assert.equal(records(f)[0].state,'pending');assert.equal(lease(f).value.state,'pending');});
  release.resolve();await pending;
  assert.equal(records(f)[0].state,'running');await assert.rejects(rt.startSession(spec(f)),e=>e.detail?.reason==='maintenance');assert.equal(m.calls.start.length,1);
});
linuxTest('maintenance acquired before admission produces no pending record or backend launch',async t=>{
  const f=fixture(t),m=fakeRuntime();await withExecutionFence({stateDir:f.stateDir},()=>writeExecutionRecord(path.join(f.stateDir,'maintenance.json'),{active:true,expiresAt:Date.now()+60000}));
  await assert.rejects(runtime(f,{mirasimRuntime:m}).startSession(spec(f)),e=>e.detail?.reason==='maintenance');assert.equal(m.calls.start.length,0);assert.equal(fs.existsSync(path.join(f.stateDir,'sessions')),false);
});
linuxTest('different processes cannot launch on one worktree, including after launcher death',async t=>{
  const f=fixture(t),ready=path.join(f.dir,'ready');
  const code='import fs from "node:fs";import {createExecutionRuntime} from '+JSON.stringify(runtimeURL)+';const fake={startSession:async s=>{fs.writeFileSync(process.argv[2],"ready");await new Promise(()=>{});},readSession:async()=>({missing:true}),listSessions:async()=>({ok:true,sessions:[]})};const rt=createExecutionRuntime({homeDir:process.argv[1],profiles:[],mirasimRuntime:fake,acpRuntime:fake,scanProcesses:()=>({ok:true,procs:[]})});rt.startSession({agent:"codex",model:"fixture",workdir:process.argv[3],prompt:"fixture"});setInterval(()=>{},1000);';
  const child=spawn(process.execPath,['--input-type=module','-e',code,f.dir,ready,f.workdir],{stdio:'ignore'});t.after(()=>{if(child.exitCode===null)child.kill('SIGKILL');});
  for(let i=0;i<200&&!fs.existsSync(ready);i++)await new Promise(r=>setTimeout(r,10));assert.ok(fs.existsSync(ready));
  const m=fakeRuntime(),rt=runtime(f,{mirasimRuntime:m});await assert.rejects(rt.startSession(spec(f)),e=>e.detail?.busy===true);
  const exited=once(child,'exit');child.kill('SIGKILL');await exited;
  await assert.rejects(rt.startSession(spec(f)),e=>e.detail?.busy===true);assert.equal(m.calls.start.length,0);assert.equal(records(f)[0].state,'pending');
});
linuxTest('ACP preallocates its durable key and preserves profile/account/model context',async t=>{
  const f=fixture(t),a=fakeRuntime(),rt=runtime(f,{profiles:[profile],acpRuntime:a});const r=await rt.startSession({...spec(f),agent:'cursor',model:profile.id,profileId:profile.id,provider:profile.provider,accountPoolId:profile.accountPoolId,route:'local'});
  assert.equal(a.calls.start[0].sessionKey,r.sessionKey);assert.match(r.sessionKey,/^acp:/);assert.equal(r.model,profile.model);assert.equal(r.actualVendor,'cursor');assert.equal(r.issue,1174);assert.equal(rt.profileForModel(profile.id).id,profile.id);
});
linuxTest('profile route/account/backend/model overrides fail before launch',async t=>{
  const f=fixture(t),a=fakeRuntime(),rt=runtime(f,{profiles:[profile],acpRuntime:a});
  for(const patch of [{route:'cloud'},{accountPoolId:'different'},{provider:'different'},{agent:'devin'},{backend:'mirasim'},{model:'other'}])await assert.rejects(rt.startSession({profileId:profile.id,workdir:f.workdir,prompt:'fixture',...patch}));
  assert.equal(a.calls.start.length,0);
});
linuxTest('unqualified Mirasim preallocated key is never sent',async t=>{const f=fixture(t),m=fakeRuntime();await assert.rejects(runtime(f,{mirasimRuntime:m}).startSession({...spec(f),sessionKey:key()}),/not qualified/);assert.equal(m.calls.start.length,0);});
linuxTest('lost acknowledgement without identity proof retains uncertainty and forbids resend',async t=>{
  const f=fixture(t);let calls=0;const m=fakeRuntime({async startSession(){calls++;throw Object.assign(new Error('lost ack'),{detail:{launchUncertain:true}});},resolveStart(){return {ok:false,missing:true};}}),rt=runtime(f,{mirasimRuntime:m});let detail;
  await assert.rejects(rt.startSession(spec(f)),e=>{detail=e.detail;return e.detail.launchUncertain;});
  assert.equal(lease(f).value.state,'uncertain');assert.equal(records(f)[0].state,'uncertain');assert.equal(records(f)[0].sessionKey,null);
  const row=records(f)[0];writeExecutionRecord(path.join(f.stateDir,'sessions',encodeURIComponent(row.recordKey)+'.json'),{...row,owner:null,createdAt:1});
  await assert.rejects(rt.startSession(spec(f)),e=>e.detail?.busy===true);assert.equal(calls,1);assert.equal((await rt.stopSession(detail.recordKey)).ok,false);assert.equal(m.calls.stop.length,0);
});
for(const ambiguous of [false,true])linuxTest('identity recovery remains uncertain for '+(ambiguous?'multiple matches':'zero matches'),async t=>{
  const f=fixture(t),m=fakeRuntime({async startSession(){throw Object.assign(new Error('lost ack'),{detail:{launchUncertain:true}});},resolveStart(){return {ok:false,ambiguous,missing:!ambiguous};}}),rt=runtime(f,{mirasimRuntime:m});
  await assert.rejects(rt.startSession(spec(f)));const row=records(f)[0];const r=await rt.resolveStart(row.recordKey);assert.equal(r.ok,false);assert.equal(r.ambiguous,ambiguous);assert.equal(records(f)[0].state,'uncertain');
});
linuxTest('exact unique Mirasim resolveStart reattaches once without resending or claiming completion',async t=>{
  const f=fixture(t),sessionKey=key();let sent=0,seen;
  const m=fakeRuntime({async startSession(){sent++;throw Object.assign(new Error('lost ack'),{detail:{launchUncertain:true}});},resolveStart(s){seen=s;return {ok:true,sessionKey,startedAt:s.startedAt,confirmedBy:['creation-window']};}}),rt=runtime(f,{mirasimRuntime:m});
  const r=await rt.startSession(spec(f));assert.equal(r.sessionKey,sessionKey);assert.equal(r.recovered,true);assert.equal(r.state,'running');assert.equal(sent,1);assert.equal(seen.agent,'codex');assert.equal(seen.workdir,f.workdir);assert.equal(records(f).length,1);assert.equal(lease(f).value.sessionKey,sessionKey);
});
linuxTest('explicitly proven rejection releases occupancy; untyped exceptions never do',async t=>{
  const f=fixture(t),m=fakeRuntime();const start=m.startSession;let first=true;
  m.startSession=async s=>{if(first){first=false;throw Object.assign(new Error('refused'),{detail:{launchUncertain:false}});}return start(s);};
  const rt=runtime(f,{mirasimRuntime:m});await assert.rejects(rt.startSession(spec(f)));assert.equal(records(f)[0].state,'rejected');assert.equal(lease(f).value.cleanupVerified,true);await rt.startSession(spec(f));assert.equal(m.calls.start.length,1);
});
linuxTest('key mismatch after ACP acceptance remains uncertain',async t=>{
  const f=fixture(t),a=fakeRuntime({async startSession(){return {sessionKey:key('acp')};}}),rt=runtime(f,{profiles:[profile],acpRuntime:a});await assert.rejects(rt.startSession({profileId:profile.id,workdir:f.workdir,prompt:'fixture'}),/inconsistent/);assert.equal(records(f)[0].state,'uncertain');assert.equal(lease(f).value.cleanupVerified,false);
});
linuxTest('new ACP launch checks legacy Mirasim process occupancy before backend invocation',async t=>{
  const f=fixture(t),a=fakeRuntime();let scans=0;const rt=runtime(f,{profiles:[profile],acpRuntime:a,scanProcesses:()=>{scans++;return {ok:true,procs:[{pid:99999,cwd:f.workdir}]};}});
  await assert.rejects(rt.startSession({profileId:profile.id,workdir:f.workdir,prompt:'fixture'}),e=>e.detail?.busy===true);assert.equal(scans,1);assert.equal(a.calls.start.length,0);
});
linuxTest('cross-backend admission refuses an incomplete process scan',async t=>{const f=fixture(t),a=fakeRuntime();await assert.rejects(runtime(f,{profiles:[profile],acpRuntime:a,scanProcesses:()=>({ok:false})}).startSession({profileId:profile.id,workdir:f.workdir,prompt:'fixture'}),e=>e.detail?.reason==='lease-unscanned');assert.equal(a.calls.start.length,0);});
linuxTest('losing reclaimer cannot stop or reap a newly started replacement',async t=>{
  const f=fixture(t),m=fakeRuntime(),rt=runtime(f,{mirasimRuntime:m});const first=await rt.startSession(spec(f));m.views.set(first.sessionKey,{phase:'done',text:'finished'});
  const enteredA=deferred(),enteredB=deferred(),releaseA=deferred(),releaseB=deferred(),read=m.readSession;let reads=0;
  m.readSession=async k=>{if(k===first.sessionKey){reads++;if(reads===1){enteredA.resolve();await releaseA.promise;return {phase:'done',text:'terminal'};}if(reads===2){enteredB.resolve();await releaseB.promise;return {phase:'done',text:'stale terminal'};}}return read(k);};
  const a=rt.startSession(spec(f));await enteredA.promise;
  const b=rt.startSession(spec(f)).then(value=>({value}),error=>({error}));await enteredB.promise;releaseA.resolve();
  const second=await a;releaseB.resolve();const loser=await b;
  assert.equal(loser.error?.detail?.busy,true);assert.deepEqual(m.calls.stop,[first.sessionKey]);assert.equal(lease(f).value.sessionKey,second.sessionKey);assert.equal(m.views.get(second.sessionKey).phase,'running');
  await assert.rejects(rt.stopSession(first.sessionKey),e=>e.detail?.busy===true);assert.deepEqual(m.calls.stop,[first.sessionKey]);
});
linuxTest('exclusive stopping reservation covers backend stop and process cleanup',async t=>{
  const f=fixture(t),m=fakeRuntime(),rt=runtime(f,{mirasimRuntime:m});const s=await rt.startSession(spec(f)),entered=deferred(),release=deferred(),stop=m.stopSession;
  m.stopSession=async k=>{assert.equal(lease(f).value.state,'stopping');assert.ok(lease(f).value.cleanupToken);entered.resolve();await release.promise;return stop(k);};
  const stopping=rt.stopSession(s.sessionKey);await entered.promise;
  await assert.rejects(rt.stopSession(s.sessionKey),e=>e.detail?.busy===true);await assert.rejects(rt.startSession(spec(f)),e=>e.detail?.busy===true);release.resolve();assert.equal((await stopping).ok,true);assert.equal(lease(f).value.cleanupVerified,true);
});
linuxTest('empty processes plus weak stop acknowledgement cannot clear a queued vendor session',async t=>{
  const f=fixture(t),m=fakeRuntime({async stopSession(){return {ok:true};}}),rt=runtime(f,{mirasimRuntime:m});const s=await rt.startSession(spec(f));m.views.set(s.sessionKey,{phase:'queued',text:''});const r=await rt.stopSession(s.sessionKey);assert.equal(r.ok,false);assert.equal(lease(f).value.state,'stopping');await assert.rejects(rt.startSession(spec(f)),e=>e.detail?.busy===true);
});
linuxTest('managed list never calls global history; terminal observations persist',async t=>{
  const f=fixture(t),m=fakeRuntime({async listSessions(){throw Error('global history must not be called');}}),rt=runtime(f,{mirasimRuntime:m});const s=await rt.startSession(spec(f));m.views.set(s.sessionKey,{phase:'done',text:'finished'});
  const r=await rt.listSessions();assert.equal(r.ok,true);assert.equal(r.scope,'managed');assert.equal(r.includesExternal,false);assert.equal(r.sessions[0].state,'done');assert.equal(r.sessions[0].title,'ISSUE-#1174');const count=m.calls.read.length;await rt.listSessions();assert.equal(m.calls.read.length,count);
});
linuxTest('managed pending inventory is explicit and does not imply absent external sessions',async t=>{
  const f=fixture(t),entered=deferred(),release=deferred(),m=fakeRuntime(),start=m.startSession;m.startSession=async s=>{entered.resolve();await release.promise;return start(s);};const rt=runtime(f,{mirasimRuntime:m}),pending=rt.startSession(spec(f));await entered.promise;
  const list=await rt.listSessions();assert.equal(list.scope,'managed');assert.equal(list.sessions[0].state,'pending');assert.match(list.sessions[0].key,/^launch:/);assert.equal(m.calls.read.length,0);assert.equal(m.calls.list,0);release.resolve();await pending;
});
linuxTest('unreadable managed registry is unknown, never successful empty inventory',async t=>{
  const f=fixture(t);fs.mkdirSync(path.join(f.stateDir,'sessions'),{recursive:true});fs.writeFileSync(path.join(f.stateDir,'sessions','bad.json'),'{bad');const r=await runtime(f).listSessions();assert.equal(r.ok,false);assert.equal(r.partial,true);assert.equal(r.scope,'managed');
});
linuxTest('managed active reads have a shared deadline and report omissions as unknown',async t=>{
  const f=fixture(t),m=fakeRuntime(),rt=runtime(f,{mirasimRuntime:m,managedListTimeoutMs:30,managedReadTimeoutMs:15,managedReadConcurrency:2});for(let i=0;i<4;i++){const workdir=path.join(f.dir,'tree-'+i);fs.mkdirSync(workdir);await rt.startSession({...spec(f),workdir});}m.readSession=async()=>new Promise(()=>{});const started=Date.now(),r=await rt.listSessions();assert.ok(Date.now()-started<1000);assert.equal(r.ok,false);assert.equal(r.sessions.length,4);assert.ok(r.sessions.every(s=>s.state==='unknown'));
});
linuxTest('external/debug inventory refuses truncated responses and keeps explicit scope',async t=>{
  const f=fixture(t),m=fakeRuntime({async listSessions(){return {ok:true,hasMore:true,sessions:[{key:key(),state:'running'}]};}}),r=await runtime(f,{mirasimRuntime:m}).listSessions({includeExternal:true});assert.equal(r.ok,false);assert.equal(r.scope,'managed+external');assert.equal(r.includesExternal,true);
});
linuxTest('resume uses new ACP key through the same fence and preserves task/account lineage',async t=>{
  const f=fixture(t),a=fakeRuntime(),rt=runtime(f,{profiles:[profile],acpRuntime:a});const s=await rt.startSession({profileId:profile.id,workdir:f.workdir,prompt:'fixture',taskId:'same-task',issue:1174});a.views.set(s.sessionKey,{phase:'done',text:'turn ended'});
  a.resumeSession=async(old,prompt,options)=>{a.calls.resume.push({old,prompt,options});const row=records(f).find(r=>r.sessionKey===options.sessionKey);assert.equal(row.state,'pending');return {sessionKey:options.sessionKey};};
  const r=await rt.resumeSession(s.sessionKey,'continue');assert.notEqual(r.sessionKey,s.sessionKey);assert.equal(r.taskId,'same-task');assert.equal(r.resumeFrom,s.sessionKey);assert.equal(r.accountPoolId,profile.accountPoolId);assert.equal(a.calls.resume[0].options.sessionKey,r.sessionKey);
});
linuxTest('completion timeout is unknown rather than successful running',async t=>{const f=fixture(t),m=fakeRuntime(),rt=runtime(f,{mirasimRuntime:m});const s=await rt.startSession(spec(f));assert.equal((await rt.waitForCompletion(s.sessionKey,{timeoutMs:0})).status,'unknown');});
linuxTest('test mutation guard prevents unisolated runtime operations',async t=>{const f=fixture(t),rt=createExecutionRuntime({homeDir:f.dir,profiles:[]});await assert.rejects(rt.startSession(spec(f)),/live execution mutations/);await assert.rejects(rt.stopSession(key()),/live execution mutations/);await assert.rejects(rt.resumeSession(key(),'continue'),/live execution mutations/);});

test('nested Mirasim interactions and awaiting override apparent completion/incomplete',()=>{
  const snapshot={phase:'done',text:'Please choose',awaiting:true,interactions:[{promptId:'p'}]};assert.equal(judgeExecutionCompletion({phase:'done',text:snapshot.text,snapshot}).status,'waiting_user');assert.equal(judgeExecutionCompletion({phase:'done',incomplete:true,snapshot}).status,'waiting_user');assert.equal(judgeExecutionCompletion({phase:'waiting_permission'}).status,'waiting_user');assert.equal(judgeExecutionCompletion({phase:'done',text:'finished',snapshot:{interactions:[{promptId:'p',done:true}]}}).status,'done');
});
test('completion rejects partial/empty observations; task acceptance is separate',()=>{
  assert.equal(judgeExecutionCompletion({phase:'done',text:'preview',partial:true}).status,'unknown');assert.equal(judgeExecutionCompletion({phase:'done',text:''}).status,'unknown');assert.equal(judgeExecutionCompletion({phase:null,error:'unreadable'}).status,'unknown');assert.equal(judgeExecutionCompletion({phase:'done',text:'unfinished',incomplete:true}).status,'failed');assert.match(judgeExecutionCompletion({phase:'done',text:'turn ended'}).reason,/artifacts/);
});
test('profiles reject disabled/unavailable/ambiguous choices and support registered IDs',()=>{assert.equal(resolveExecutionProfile({model:profile.id},[profile]).id,profile.id);assert.throws(()=>resolveExecutionProfile({profileId:profile.id},[{...profile,enabled:false}]),/disabled/);assert.throws(()=>resolveExecutionProfile({profileId:profile.id},[{...profile,availability:{status:'unverified'}}]),/unverified/);assert.throws(()=>resolveExecutionProfile({model:'alias'},[{...profile,defaultForModels:['alias']},{...profile,id:'second',defaultForModels:['alias']}]),/ambiguous/);});
test('maintenance corruption fails closed and promoted version respects service home',t=>{const f=fixture(t),file=path.join(f.dir,'maintenance.json');fs.writeFileSync(file,'{bad');assert.throws(()=>maintenanceStatus(file));assert.equal(promotedVersion(f.dir,'0.0.282'),'0.0.282');const current=path.join(f.dir,'mirasim-server/current');fs.mkdirSync(current,{recursive:true});fs.writeFileSync(path.join(current,'VERSION'),'0.0.307\n');assert.equal(promotedVersion(f.dir,'0.0.282'),'0.0.307');});
