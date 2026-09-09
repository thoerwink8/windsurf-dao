import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createExecutionRuntime,judgeExecutionCompletion,maintenanceStatus,resolveExecutionProfile,promotedVersion,ensureGitWorkspace} from '../scripts/lib/execution-runtime.mjs';

function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'execution-runtime-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const workdir=path.join(dir,'tree');fs.mkdirSync(workdir);return {dir,workdir};}
const profile={id:'cursor-test',backend:'acp',agent:'cursor',model:'composer-test',enabled:true,availability:{status:'available'},provider:'cursor',accountPoolId:'cursor-owner',route:'local'};
function fakeRuntime(overrides={}){return {async startSession(s){return {sessionKey:'acp:00000000-0000-4000-8000-000000000001',taskId:s.taskId,startedAt:10};},async readSession(){return {phase:'running',text:'',toolCalls:[]};},async listSessions(){return {ok:true,sessions:[]};},async stopSession(){return {ok:true};},async interact(){return {ok:true};},...overrides};}
test('explicit ACP route reaches ACP, preserves context and never calls Mirasim',async t=>{
 const {dir,workdir}=fixture(t);let seen,wrong=0;
 const runtime=createExecutionRuntime({homeDir:dir,profiles:[profile],acpRuntime:fakeRuntime({async startSession(s){seen=s;return {sessionKey:'acp:00000000-0000-4000-8000-000000000001'};}}),mirasimRuntime:fakeRuntime({async startSession(){wrong++;throw Error('wrong backend')}})});
 const r=await runtime.startSession({profileId:profile.id,workdir,prompt:'read fixture',taskId:'issue:1174',issue:1174});
 assert.equal(wrong,0);assert.equal(seen.model,'composer-test');assert.equal(seen.route,'local');assert.equal(r.accountPoolId,'cursor-owner');assert.equal(runtime.metadata(r.sessionKey).issue,1174);
});
test('cloud route belongs to a session, not a shared global setting',async t=>{
 const {dir,workdir}=fixture(t);const tree2=path.join(dir,'second');fs.mkdirSync(tree2);const calls=[];
 const rt=createExecutionRuntime({homeDir:dir,profiles:[{...profile,id:'cloud',backend:'mirasim',agent:'codex',route:'cloud'},{...profile,id:'local',backend:'mirasim',agent:'grok',route:'local'}],acpRuntime:fakeRuntime(),mirasimRuntime:fakeRuntime({async startSession(s){calls.push(s);return {sessionKey:s.agent+':'+calls.length};}})});
 await Promise.all([rt.startSession({profileId:'cloud',workdir,prompt:'x'}),rt.startSession({profileId:'local',workdir:tree2,prompt:'y'})]);
 assert.deepEqual(calls.map(x=>x.route).sort(),['cloud','local']);
});
test('concurrent starts on one worktree admit only one backend call',async t=>{
 const {dir,workdir}=fixture(t);let calls=0;
 const rt=createExecutionRuntime({homeDir:dir,profiles:[profile],mirasimRuntime:fakeRuntime(),acpRuntime:fakeRuntime({async startSession(){calls++;await new Promise(r=>setTimeout(r,40));return {sessionKey:'acp:00000000-0000-4000-8000-000000000001'};}})});
 const results=await Promise.allSettled([1,2].map(()=>rt.startSession({profileId:profile.id,workdir,prompt:'x'})));
 assert.equal(calls,1);assert.equal(results.filter(x=>x.status==='fulfilled').length,1);assert.equal(results.find(x=>x.status==='rejected').reason.detail.busy,true);
});
test('unknown previous state blocks re-dispatch instead of assuming a dead worker',async t=>{
 const {dir,workdir}=fixture(t);let calls=0;
 const rt=createExecutionRuntime({homeDir:dir,profiles:[profile],mirasimRuntime:fakeRuntime(),acpRuntime:fakeRuntime({async startSession(){calls++;return {sessionKey:'acp:00000000-0000-4000-8000-000000000001'};},async readSession(){return {missing:true};}})});
 await rt.startSession({profileId:profile.id,workdir,prompt:'x'});
 await assert.rejects(rt.startSession({profileId:profile.id,workdir,prompt:'x'}),e=>e.detail?.busy===true);assert.equal(calls,1);
});
test('backend rejection releases reservation so a corrected attempt can start',async t=>{
 const {dir,workdir}=fixture(t);let calls=0;
 const rt=createExecutionRuntime({homeDir:dir,profiles:[profile],mirasimRuntime:fakeRuntime(),acpRuntime:fakeRuntime({async startSession(){if(++calls===1)throw Error('bad auth');return {sessionKey:'acp:00000000-0000-4000-8000-000000000001'};}})});
 await assert.rejects(rt.startSession({profileId:profile.id,workdir,prompt:'x'}),/bad auth/);
 const r=await rt.startSession({profileId:profile.id,workdir,prompt:'x'});assert.equal(r.backend,'acp');
});
test('partial Mirasim failure preserves ACP visibility but overall scan is incomplete',async t=>{
 const {dir}=fixture(t);const rt=createExecutionRuntime({homeDir:dir,profiles:[],mirasimRuntime:fakeRuntime({async listSessions(){throw Error('WS timeout')}}),acpRuntime:fakeRuntime({async listSessions(){return {ok:true,sessions:[{key:'acp:1',state:'running',cwd:'/tmp/tree'}]}}})});
 const r=await rt.listSessions();assert.equal(r.ok,false);assert.equal(r.partial,true);assert.equal(r.sessions.length,1);assert.equal(r.errors[0].backend,'mirasim');
});
test('missing relay usage does not erase a completed direct turn; task acceptance stays separate',()=>{
 const r=judgeExecutionCompletion({phase:'done',text:'read returned fixture',toolCalls:[{name:'read'}]});assert.equal(r.status,'done');assert.match(r.reason,/artifacts/);
 assert.equal(judgeExecutionCompletion({phase:'done',partial:true,text:'preview'}).status,'unknown');
 assert.equal(judgeExecutionCompletion({phase:'done',text:''}).status,'unknown');
 assert.equal(judgeExecutionCompletion({phase:'done',incomplete:true,text:'partial work'}).status,'failed');
});
test('waiting question is not completed or dead; unsupported interaction is explicit failure',()=>{
 assert.equal(judgeExecutionCompletion({phase:'waiting_user',text:'pick a format'}).status,'waiting_user');
 assert.equal(judgeExecutionCompletion({phase:'done',text:'question',interactions:[{promptId:'p'}]}).status,'waiting_user');
 assert.equal(judgeExecutionCompletion({phase:'unsupported_interaction'}).status,'failed');
});
test('maintenance blocks before any backend call and malformed state never silently clears',async t=>{
 const {dir,workdir}=fixture(t);const state=path.join(dir,'.dao/execution');fs.mkdirSync(state,{recursive:true});let calls=0;
 const rt=createExecutionRuntime({homeDir:dir,profiles:[profile],mirasimRuntime:fakeRuntime(),acpRuntime:fakeRuntime({async startSession(){calls++;}})});
 fs.writeFileSync(path.join(state,'maintenance.json'),JSON.stringify({active:true,expiresAt:Date.now()+60000,reason:'upgrade'}));
 await assert.rejects(rt.startSession({profileId:profile.id,workdir,prompt:'x'}),e=>e.detail?.reason==='maintenance');assert.equal(calls,0);
 fs.writeFileSync(path.join(state,'maintenance.json'),'{bad');assert.throws(()=>maintenanceStatus(path.join(state,'maintenance.json')));
});
test('disabled/unavailable/ambiguous profiles refuse without silent fallback',()=>{
 assert.throws(()=>resolveExecutionProfile({profileId:profile.id},[{...profile,enabled:false}]),/disabled/);
 assert.throws(()=>resolveExecutionProfile({profileId:profile.id},[{...profile,availability:{status:'unverified'}}]),/unverified/);
 assert.throws(()=>resolveExecutionProfile({model:'alias'},[{...profile,defaultForModels:['alias']},{...profile,id:'second',defaultForModels:['alias']}]),/ambiguous/);
});
test('promoted version is read from service-user installation and invalid manifests refuse',t=>{
 const {dir}=fixture(t);assert.equal(promotedVersion(dir,'0.0.282'),'0.0.282');const p=path.join(dir,'mirasim-server/current');fs.mkdirSync(p,{recursive:true});fs.writeFileSync(path.join(p,'VERSION'),'0.0.307\n');assert.equal(promotedVersion(dir,'0.0.282'),'0.0.307');fs.writeFileSync(path.join(p,'VERSION'),'invalid');assert.throws(()=>promotedVersion(dir,'0.0.282'),/invalid/);
});
