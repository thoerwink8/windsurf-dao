import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeExecutionSession} from '../scripts/execution-sessions.mjs';
import {readSessionView} from '../scripts/lib/mirasim-runtime.mjs';
test('an explicit pending interaction outranks legacy completed metadata',()=>{
 assert.equal(normalizeExecutionSession({runState:'completed',phase:'waiting_user',awaiting:true}).state,'waiting_user');
 assert.equal(normalizeExecutionSession({phase:'done',snapshot:{interactions:[{promptId:'q'}]}}).state,'waiting_user');
 assert.equal(normalizeExecutionSession({phase:'waiting'}).state,'waiting_user');
 assert.equal(normalizeExecutionSession({phase:'waiting_permission'}).state,'waiting_user');
});
test('normalize keeps explicit pr/issue so unsigned fast-path sessions still match',()=>{
 assert.deepEqual(normalizeExecutionSession({sessionKey:'grok:1',phase:'running',workdir:'/x/dao-queue-selfheal',pr:1271,issue:42}).pr,1271);
 assert.equal(normalizeExecutionSession({sessionKey:'grok:1',phase:'running',workdir:'/x/dao-queue-selfheal',pr:1271,issue:42}).issue,42);
});
test('answered questions are not permanent waits, and failures remain failures',()=>{
 assert.equal(normalizeExecutionSession({phase:'done',interactions:[{status:'answered'}]}).state,'done');
 assert.equal(normalizeExecutionSession({phase:'error',error:'upstream failed',awaiting:true}).state,'failed');
});
test('state outranks conflicting phase; waiting_user is kept',()=>{
 const input={sessionKey:'acp:11111111-2222-3333-4444-555555555555',state:'waiting_user',phase:'running'};
 assert.equal(normalizeExecutionSession(input).state,'waiting_user');
 assert.equal(normalizeExecutionSession({state:'',phase:'waiting_user'}).state,'waiting_user');
 assert.equal(normalizeExecutionSession({state:'WAITING_USER',phase:'running'}).state,'waiting_user');
});
test('rejected launch with verified cleanup keeps that evidence for decide',()=>{
 const projected=normalizeExecutionSession({sessionKey:null,key:'launch:test',state:'rejected',cleanupVerified:true});
 assert.equal(projected.cleanupVerified,true);
 assert.equal(projected.state,'rejected');
 assert.equal(projected.sessionKey,null);
 assert.equal(projected.key,'launch:test');
});
test('missing cleanupVerified is not synthesized as a successful cleanup',()=>{
 const projected=normalizeExecutionSession({sessionKey:null,key:'launch:pending',state:'uncertain'});
 assert.notEqual(projected.cleanupVerified,true);
});
test('Mirasim snapshot interactions survive public read view normalization',()=>{
 const interactions=[{promptId:'q',questions:[{id:'format'}]}];
 assert.deepEqual(readSessionView({phase:'done',text:'question',interactions}).interactions,interactions);
});
