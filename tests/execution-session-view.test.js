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
test('Mirasim snapshot interactions survive public read view normalization',()=>{
 const interactions=[{promptId:'q',questions:[{id:'format'}]}];
 assert.deepEqual(readSessionView({phase:'done',text:'question',interactions}).interactions,interactions);
});
