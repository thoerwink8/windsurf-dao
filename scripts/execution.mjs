#!/usr/bin/env node
import fs from 'node:fs';
import {parseArgs} from 'node:util';
import {pathToFileURL} from 'node:url';
import {createExecutionRuntime,loadExecutionProfiles} from './lib/execution-runtime.mjs';

export async function executionCommand(argv,{runtime,output=console.log}={}) {
  const {values:a,positionals}=parseArgs({args:argv,allowPositionals:true,options:{
    profile:{type:'string'},agent:{type:'string'},model:{type:'string'},route:{type:'string'},
    workdir:{type:'string'},'prompt-file':{type:'string'},prompt:{type:'string'},
    session:{type:'string'},task:{type:'string'},issue:{type:'string'},pr:{type:'string'},
    'answer-file':{type:'string'},answer:{type:'string'},'interaction-policy':{type:'string'},
    'timeout-ms':{type:'string'},json:{type:'boolean'},'dry-run':{type:'boolean'},help:{type:'boolean'},
  }});
  const cmd=positionals[0];
  if(a.help||!cmd){output('execution start|read|list|answer|stop|wait|resume|profiles --profile ID --workdir PATH --prompt-file FILE --task ID');return {ok:true};}
  if(cmd==='profiles'){const r={ok:true,profiles:loadExecutionProfiles()};output(JSON.stringify(r));return r;}
  const rt=runtime||createExecutionRuntime();let r;
  if(cmd==='start'){
    const prompt=a['prompt-file']?fs.readFileSync(a['prompt-file'],'utf8'):a.prompt;
    if(!prompt||!a.workdir||(!a.profile&&(!a.agent||!a.model)))throw new Error('start requires prompt, workdir and profile (or agent+model)');
    const spec={profileId:a.profile,agent:a.agent,model:a.model,route:a.route,workdir:a.workdir,prompt,taskId:a.task,issue:a.issue,pr:a.pr,
      ...(a['interaction-policy']?{interactionPolicy:JSON.parse(fs.readFileSync(a['interaction-policy'],'utf8'))}:{})};
    r=a['dry-run']?{ok:true,dryRun:true,spec:{...spec,prompt:undefined,promptBytes:Buffer.byteLength(prompt)}}:{ok:true,...await rt.startSession(spec)};
  }else if(cmd==='list')r=await rt.listSessions();
  else {
    if(!a.session)throw new Error(cmd+' requires --session');
    if(cmd==='read')r={ok:true,...await rt.readSession(a.session)};
    else if(cmd==='stop')r=await rt.stopSession(a.session);
    else if(cmd==='wait')r=await rt.waitForCompletion(a.session,{timeoutMs:Number(a['timeout-ms']||600000)});
    else if(cmd==='resume'){const prompt=a['prompt-file']?fs.readFileSync(a['prompt-file'],'utf8'):a.prompt;if(!prompt)throw new Error('resume requires a continuation prompt');r={ok:true,...await rt.resumeSession(a.session,prompt)};}
    else if(cmd==='answer'){const answer=a['answer-file']?fs.readFileSync(a['answer-file'],'utf8'):a.answer;if(answer===undefined)throw new Error('answer requires --answer or --answer-file');let value;try{value=JSON.parse(answer);}catch{value=answer;}r=await rt.interact(a.session,value);}
    else throw new Error('unknown execution command '+cmd);
  }
  output(JSON.stringify(r));return r;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  executionCommand(process.argv.slice(2)).then(r=>{if(r.ok===false||r.status==='failed'||r.status==='unknown')process.exitCode=1;}).catch(e=>{console.error(JSON.stringify({ok:false,error:e.message,...(e.detail||{})}));process.exitCode=1;});
}
