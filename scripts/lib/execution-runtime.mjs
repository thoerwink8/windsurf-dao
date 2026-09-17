// One task lifecycle over Mirasim and ACP. Backends never choose dispatch policy.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createRuntime as createMirasimRuntime,judgeTestExecutorIsolation,MirasimRejectedError} from './mirasim-runtime.mjs';
import {createAcpRuntime} from './acp-runtime.mjs';
import {withExecutionFence,writeExecutionRecord} from './execution-fence.mjs';
import {cwdBelongsToTree,scanSessionProcs} from './dispatch/lease.mjs';
import {EXECUTION_FINISHED,EXECUTION_RESERVED,EXECUTION_VERDICT_FINISHED,EXECUTION_WAITING,isWaitingState,sessionStateOf,confirmedSessionState} from './execution-states.mjs';
import {acpProcessIdentity,acpProcessAlive} from './acp-runtime.mjs';
import {preparePiDirectLaunch} from './execution-pi-provider.mjs';
import {attachControlPlaneHooksOrThrow} from './control-plane-write.mjs';
import {resolveStartInteractionPolicy} from './acp-interaction-policy.mjs';

// 终态读正典（execution-states.mjs）。这里原来手打一份，**漏了 rejected / incomplete / gone**，
// 于是 judgeExecutionCompletion 把「已经死了」的会话判成 running（实测 rejected/gone → running）。
// 本晚第 3 处手打副本；现在全仓只留正典一处。
const TERMINAL = EXECUTION_FINISHED;
const wait = ms => new Promise(r=>setTimeout(r,ms));
const defaultProfilesFile = new URL('../../docs/execution-profiles.json',import.meta.url);
export function loadExecutionProfiles(file=process.env.DAO_EXECUTION_PROFILES || defaultProfilesFile) {
  const doc=JSON.parse(fs.readFileSync(file,'utf8'));
  if(!Array.isArray(doc.profiles))throw new Error('execution profiles must contain profiles[]');
  return doc.profiles;
}
const atomic=writeExecutionRecord;
function readJson(file){try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}}
export function maintenanceStatus(file,now=Date.now()) {
  const state=readJson(file);if(!state||state.active===false)return {blocked:false};
  const until=typeof state.expiresAt==='number'?state.expiresAt:Date.parse(state.expiresAt);
  if(!Number.isFinite(until))throw new Error('execution maintenance has no valid expiry');
  return {blocked:state.active===true&&until>now,reason:state.reason||'Mirasim upgrade',expiresAt:until};
}
export function resolveExecutionProfile(spec,profiles) {
  const requested=spec.profileId||spec.profile||(profiles.some(p=>p.id===spec.model)?spec.model:null);
  const matches=requested?profiles.filter(p=>p.id===requested):profiles.filter(p=>Array.isArray(p.defaultForModels)&&p.defaultForModels.includes(spec.model));
  if(matches.length>1)throw new Error('ambiguous execution profile: '+(requested||spec.model));
  const p=matches[0];
  if(requested&&!p)throw new Error('unknown execution profile '+requested);
  if(!p)return null;
  if(p.enabled!==true)throw new Error('execution profile disabled: '+p.id);
  if(!['mirasim','acp'].includes(p.backend)||!p.agent||!p.model)throw new Error('invalid execution profile '+p.id);
  const availability=typeof p.availability==='string'?p.availability:p.availability?.status;
  if(availability&&availability!=='available')throw new Error('execution profile '+availability+': '+p.id);
  return p;
}
export function promotedVersion(homeDir,fallback) {
  try {const v=fs.readFileSync(path.join(homeDir,'mirasim-server/current/VERSION'),'utf8').trim();if(!/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(v))throw new Error('invalid promoted Mirasim version');return v;}
  catch(e){if(e.code==='ENOENT')return fallback;throw e;}
}
export function ensureGitWorkspace(repo,branch,{homeDir=os.homedir(),base='origin/master',exec=execFileSync}={}) {
  const root=fs.realpathSync(repo);const git=args=>String(exec('git',['-C',root,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']})).trim();
  git(['check-ref-format','--branch',branch]);
  const blocks=git(['worktree','list','--porcelain']).split(/\n\n/);
  for(const b of blocks){const lines=b.split('\n');if(lines.includes('branch refs/heads/'+branch)){const dir=lines.find(l=>l.startsWith('worktree '))?.slice(9);if(dir&&fs.existsSync(dir)){attachControlPlaneHooksOrThrow(dir);return {path:dir,branch,created:false,verified:true};}}}
  const target=path.join(homeDir,'mirasim-worktrees',path.basename(root),branch.replace(/[^\w.-]/g,'-'));
  if(fs.existsSync(target))throw new Error('unregistered worktree path already exists: '+target);
  fs.mkdirSync(path.dirname(target),{recursive:true});let exists=false;try{git(['show-ref','--verify','--quiet','refs/heads/'+branch]);exists=true;}catch{}
  if(exists)git(['worktree','add',target,branch]);else git(['worktree','add','-b',branch,target,base]);
  const head=String(exec('git',['-C',target,'symbolic-ref','--short','HEAD'],{encoding:'utf8'})).trim();
  if(head!==branch)throw new Error('created worktree has wrong branch');
  attachControlPlaneHooksOrThrow(target);
  return {path:target,branch,created:true,verified:true};
}
export function judgeExecutionCompletion(view) {
  // 快照没回帧（partial）时不许一律回 unknown：会话清单已经报了终态就采信它。
  // 判据在正典（execution-states.confirmedSessionState），与 listSessions 那条路同一句。
  // 2026-09-12 实咬：不认这句话 → 收尾永远验不过 → 租约永久 stopping 占住审官树。
  const confirmed=confirmedSessionState(view);
  if(confirmed)return {status:'failed',reason:'session already finished per inventory (snapshot stale)',confirmedBy:['session']};
  if(!view||view.missing||view.partial)return {status:'unknown',reason:'complete session view unavailable',confirmedBy:[]};
  const snapshot=view.snapshot||{},phase=view.phase||snapshot.phase||snapshot.runState;
  const cancelled=['aborted','cancelled','canceled','stopped'].includes(phase);
  if(cancelled)return {status:'failed',reason:'session cancelled',confirmedBy:['session']};
  const pending=x=>x&&x.answered!==true&&!x.done&&!x.answeredAt&&!x.resolvedAt&&!['answered','cancelled','canceled','resolved','done'].includes(x.status);
  if(view.awaiting===true||snapshot.awaiting===true||[view.interactions,snapshot.interactions].some(xs=>Array.isArray(xs)&&xs.some(pending))||EXECUTION_WAITING.has(String(phase||'').toLowerCase()))return {status:'waiting_user',reason:'pending interaction',confirmedBy:['interaction']};
  if(!phase)return {status:'unknown',reason:'session phase unavailable',confirmedBy:[]};
  if(view.error||snapshot.error||view.incomplete===true||snapshot.incomplete===true||['failed','error','incomplete','auth_required','unsupported_interaction'].includes(phase))return {status:'failed',reason:'session did not complete',confirmedBy:['session']};
  if(!TERMINAL.has(phase))return {status:'running',reason:'session active',confirmedBy:['session']};
  if(!String(view.text??snapshot.text??'').trim()&&!(view.toolCalls||snapshot.toolCalls)?.length)return {status:'unknown',reason:'terminal session has no observable output',confirmedBy:['session']};
  return {status:'done',reason:'agent turn ended with observable output; task artifacts still require acceptance',confirmedBy:['session','output']};
}
function busy(message,reason='lease-held'){const e=new Error(message);e.code='busy';e.detail={busy:true,reason};return e;}
// 终态/预留态的正典在 lib/execution-states.mjs——回收侧（board-gc）读同一份，
// 免得「挡人的说它没死、回收的说它死了」（2026-09-11 #1150 实咬）。
const RESERVED=EXECUTION_RESERVED;
const FINISHED=EXECUTION_FINISHED;
/** 指挥官 spawn 墙钟（commander.mjs scanSessions timeout）。#1397 不许加大这个数来掩盖组合预算缝隙。 */
export const COMMANDER_SCAN_SPAWN_MS = 40_000;
/** 子进程端到端预算：必须小于 spawn 墙钟，留给 JSON 打印和进程退出。 */
export const COMMANDER_SCAN_BUDGET_MS = 38_000;
export const SCAN_WRAP_UP_MS = 500;

export function recordNeedsManagedFallback(m) {
  if (!m || !m.sessionKey) return false;
  if (m.cleanupVerified) return false;
  if (RESERVED.has(m.state)) return false;
  return !FINISHED.has(m.state) || m.state === 'incomplete';
}

/** 把总预算切成名单 / 快照回退 / 收尾。回退是预留，不是名单用剩才给。 */
export function allocateManagedScanBudget({
  now,
  deadline,
  wrapUpMs = SCAN_WRAP_UP_MS,
  needSnapshotFallback = false,
  snapshotReserveMs = 8000,
} = {}) {
  const remainingMs = Math.max(0, Number(deadline) - Number(now));
  const wrap = Number.isFinite(Number(wrapUpMs)) && Number(wrapUpMs) >= 0 ? Number(wrapUpMs) : SCAN_WRAP_UP_MS;
  const usable = Math.max(0, remainingMs - wrap);
  const want = needSnapshotFallback
    ? Math.max(0, Number.isFinite(Number(snapshotReserveMs)) ? Number(snapshotReserveMs) : 0)
    : 0;
  const fallbackMs = Math.min(want, usable);
  const listMs = Math.max(0, usable - fallbackMs);
  return { remainingMs, wrapUpMs: wrap, fallbackMs, listMs, exhausted: usable <= 0 };
}
// 已经停在 stopping 时，宽限时钟不许被重试或失败回写刷新。
// 看门狗每轮对 stopping 再 stop-session；失败路径若写 updatedAt=now()，
// 重置它的正是等它的那个循环，宽限窗永远到不了（#1174 缺陷二，2026-09-12 实咬）。
function reservedClock(record, fallback) {
  if (record && String(record.state || '') === 'stopping') {
    const at = Number(record.updatedAt) || Number(record.acceptedAt) || Number(record.startedAt);
    if (Number.isFinite(at) && at > 0) return at;
  }
  return fallback;
}
// `judgeExecutionCompletion` 的 status 值域只有两个词，且由它自己从正典映射而来。
// 谁要判「这次收尾验过了没」，读这句话，别去卡 view 的原始状态词——
// 手打 ['done','failed'] 去卡 view 的那版漏了 `incomplete`，把树永久锁死（2026-09-12 实咬）。
const TERMINAL_STATUS=EXECUTION_VERDICT_FINISHED;
const SESSION_KEY=/^[a-z][a-z0-9-]*:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const sameLease=(a,b)=>a&&b&&a.token===b.token&&(a.recordKey||a.sessionKey)===(b.recordKey||b.sessionKey)&&a.cleanupToken===b.cleanupToken;

export function createExecutionRuntime(opts={}) {
  const homeDir=opts.homeDir||os.homedir(),stateDir=path.resolve(opts.stateDir||path.join(homeDir,'.dao/execution'));
  const profiles=opts.profiles||loadExecutionProfiles(opts.profilesFile);
  // 显式钉的版本优先于本机自动发现：promotedVersion 读的是 mirasim-server/current，
  // 无条件跟随会把策略里的「钉版本」永久盖掉（#884 P1#5 那条契约就是这么断的）。
  // 只有没人钉的时候才跟随本机升级结果。
  const mirasim=opts.mirasimRuntime||createMirasimRuntime({...opts,homeDir,
    pinnedVersion:opts.pinnedVersion||promotedVersion(homeDir,opts.pinnedVersion)});
  const acp=opts.acpRuntime||createAcpRuntime({...opts,homeDir,stateDir:path.join(stateDir,'acp'),profiles});
  const sessionsDir=path.join(stateDir,'sessions'),metaFile=key=>path.join(sessionsDir,encodeURIComponent(key)+'.json');
  const leaseFile=workdir=>path.join(stateDir,'leases',crypto.createHash('sha256').update(workdir).digest('hex')+'.json');
  const now=opts.now||Date.now,scan=opts.scanProcesses||scanSessionProcs;
  const identity=opts.processIdentity||acpProcessIdentity,alive=opts.processAlive||acpProcessAlive,kill=opts.killProcess||process.kill.bind(process);
  const fence=fn=>withExecutionFence({stateDir,timeoutMs:opts.fenceTimeoutMs??5000},fn);
  const isolatedBackends=Boolean(opts.mirasimRuntime&&opts.acpRuntime);
  const assertMutationAllowed=()=>{if(process.env.NODE_TEST_CONTEXT&&!isolatedBackends)throw new Error('live execution mutations are disabled in test processes; inject isolated backends');};
  const assertExecutorIsolation=()=>{
    if(isolatedBackends)return;
    const isolation=judgeTestExecutorIsolation(opts.env||process.env);
    if(!isolation.ok)throw new MirasimRejectedError(isolation.error,{isolation});
  };
  function metadata(key){return readJson(metaFile(key));}
  const backend=(key,m)=>((m?.backend||(String(key).startsWith('acp:')?'acp':'mirasim'))==='acp'?acp:mirasim);
  const keyOf=m=>m.recordKey||m.sessionKey;
  function registry() {
    let names;try{names=fs.readdirSync(sessionsDir).filter(n=>n.endsWith('.json')).sort();}catch(e){if(e.code==='ENOENT')return [];throw e;}
    if(names.length>(opts.registryLimit??10000))throw new Error('managed registry limit reached');
    return names.map(name=>{
      const file=path.join(sessionsDir,name);
      if(!fs.lstatSync(file).isFile())throw new Error('invalid managed registry entry');
      const m=readJson(file);
      if(!m||typeof m!=='object'||keyOf(m)!==decodeURIComponent(name.slice(0,-5))||!m.workdir||!m.state)throw new Error('invalid managed registry entry');
      return m;
    });
  }
  function processCheck(workdir) {
    const s=scan();
    if(s?.ok!==true||!Array.isArray(s.procs))throw busy('worktree process scan incomplete','lease-unscanned');
    return s.procs.filter(p=>p&&cwdBelongsToTree(p.cwd,workdir));
  }
  function assertAdmission() {
    const maintenance=maintenanceStatus(path.join(stateDir,'maintenance.json'),now());
    if(maintenance.blocked)throw busy(maintenance.reason,'maintenance');
  }
  function prepare(spec) {
    if(!spec||!spec.workdir||!path.isAbsolute(spec.workdir)||!fs.statSync(spec.workdir).isDirectory())throw new Error('execution requires an existing absolute workdir');
    if(typeof spec.prompt!=='string'||!spec.prompt.trim())throw new Error('execution requires a prompt');
    if(spec.profileId&&spec.profile&&spec.profileId!==spec.profile)throw new Error('conflicting execution profiles');
    const p=resolveExecutionProfile(spec,profiles);
    if(p) {
      for(const name of ['agent','provider','accountPoolId','route','backend','nativeProviderId'])if(spec[name]!=null&&spec[name]!==p[name])throw new Error(name+' override would change the profile account path; select an explicit profile');
      const models=[p.id,p.model,p.agentModel,...(p.defaultForModels||[])];
      if(spec.model!=null&&!models.includes(spec.model))throw new Error('model conflicts with execution profile');
    }
    let actual={...spec,...(p?{profileId:p.id,agent:p.agent,model:p.model,route:p.route,provider:p.provider,accountPoolId:p.accountPoolId,actualVendor:p.actualVendor??p.vendor??spec.actualVendor}:{}),workdir:fs.realpathSync(spec.workdir)};
    if(p?.nativeProviderId){const prepared=preparePiDirectLaunch(p,actual,{homeDir});if(!prepared.ok)throw new Error('Pi direct provider: '+prepared.reason);actual={...actual,...prepared.launchSpec};}
    const selected=p?.backend||spec.backend||(['cursor','devin'].includes(actual.agent)?'acp':'mirasim');
    if(!['acp','mirasim'].includes(selected)||!/^[a-z][a-z0-9-]*$/.test(actual.agent||''))throw new Error('invalid execution backend or agent');
    actual.route??=selected==='acp'?'local':'auto';
    if(!(['local','native','direct'].includes(actual.route)&&selected==='acp')&&!(['local','cloud','auto'].includes(actual.route)&&selected==='mirasim'))throw new Error('invalid execution route');
    // #1174 T8b：ACP 热路默认挂 worktree 已知权限。显式策略不合并。闸装在 prepare，四个调用点绕不开。
    if(selected==='acp') actual.interactionPolicy=resolveStartInteractionPolicy({backend:selected,workdir:actual.workdir,interactionPolicy:spec.interactionPolicy});
    if(spec.resumeFrom) {
      const prior=metadata(spec.resumeFrom);if(!prior)throw new Error('resume requires persistent execution metadata');
      for(const [name,value] of Object.entries({backend:selected,agent:actual.agent,provider:actual.provider??null,accountPoolId:actual.accountPoolId??null,route:actual.route,actualModel:p?.model||actual.model,workdir:actual.workdir})) {
        const previous=prior[name]??(name==='actualModel'?prior.model:null);
        if(value!==previous)throw new Error('resume would change recorded '+name);
      }
      if(actual.taskId!==prior.taskId)throw new Error('resume must preserve task lineage');
    }
    const launchId=crypto.randomUUID();
    // A Mirasim sessionKey may mean resume, not create. Until that contract is
    // qualified, persist a LOCAL launch key and bind the vendor key after acceptance.
    if(selected==='mirasim'&&spec.sessionKey)throw new Error('Mirasim preallocated session keys are not qualified');
    const sessionKey=selected==='acp'?(spec.sessionKey||'acp:'+launchId):null;
    if(sessionKey&&(!SESSION_KEY.test(sessionKey)||!sessionKey.startsWith('acp:')))throw new Error('invalid preallocated sessionKey');
    const recordKey=sessionKey||'launch:'+launchId;
    actual={...actual,...(sessionKey?{sessionKey}:{}),taskId:spec.taskId||spec.clientRef||crypto.randomUUID(),clientRef:spec.clientRef||'dao-launch:'+launchId};
    const meta={schemaVersion:1,recordKey,sessionKey,launchId,attemptId:launchId,backend:selected,agent:actual.agent,model:actual.model,requestedModel:spec.model||p?.model||null,actualModel:p?.model||actual.model,profileId:p?.id||null,provider:actual.provider??null,accountPoolId:actual.accountPoolId??null,actualVendor:actual.actualVendor??null,route:actual.route,taskId:actual.taskId,clientRef:actual.clientRef,issue:spec.issue??null,pr:spec.pr??null,title:(typeof spec.title==='string'&&spec.title.trim())?spec.title.trim():null,workdir:actual.workdir,createdAt:now(),startedAt:now(),updatedAt:now(),state:'pending',launchState:'pending',taskCompleted:false,completionScope:'agent-turn',owner:identity(process.pid),...(spec.resumeFrom?{resumeFrom:spec.resumeFrom}:{})};
    return {actual,meta,token:crypto.randomUUID()};
  }
  async function reapMirasim(workdir) {
    if(process.platform!=='linux')return {ok:false,why:'process cleanup verification requires Linux'};
    for(let round=0;round<4;round++) {
      let procs;try{procs=processCheck(workdir);}catch{return {ok:false,why:'process cleanup scan incomplete'};}
      if(!procs.length)return {ok:true,verified:true};
      const targets=procs.map(p=>identity(p.pid));
      if(targets.some(p=>!p))return {ok:false,why:'process identity unavailable'};
      for(const p of targets)if(alive(p))try{kill(p.pid,round?'SIGKILL':'SIGTERM');}catch(e){if(e.code!=='ESRCH')return {ok:false,why:'cannot stop owned session process'};}
      await wait(opts.cleanupPollMs??(round?150:300));
    }
    try{return processCheck(workdir).length?{ok:false,why:'session processes survived cancellation'}:{ok:true,verified:true};}catch{return {ok:false,why:'process cleanup scan incomplete'};}
  }
  function attachAccepted(meta,token,started,recovered=false) {
    if(!started?.sessionKey||!SESSION_KEY.test(started.sessionKey)||!started.sessionKey.startsWith((meta.backend==='acp'?'acp':meta.agent)+':')||(meta.sessionKey&&started.sessionKey!==meta.sessionKey))throw new Error('backend returned an inconsistent sessionKey');
    const file=leaseFile(meta.workdir),held=readJson(file);
    if(!held||held.token!==token||!['pending','uncertain','running'].includes(held.state))throw new Error('launch reservation ownership changed');
    const existing=metadata(started.sessionKey);
    if(existing&&existing.launchId!==meta.launchId)throw new Error('backend sessionKey already registered');
    if(held.state==='running'&&held.sessionKey===started.sessionKey&&existing)return {...started,...existing,recovered};
    const accepted={...meta,recordKey:started.sessionKey,sessionKey:started.sessionKey,state:'running',launchState:'accepted',acceptedAt:now(),updatedAt:now(),startedAt:started.startedAt??meta.startedAt,vendorTaskId:started.taskId??null,recovered};
    atomic(metaFile(accepted.recordKey),accepted);
    atomic(file,{...held,recordKey:accepted.recordKey,sessionKey:accepted.sessionKey,state:'running',acceptedAt:accepted.acceptedAt});
    if(meta.recordKey!==accepted.recordKey&&fs.existsSync(metaFile(meta.recordKey)))fs.unlinkSync(metaFile(meta.recordKey));
    return {...started,...accepted};
  }
  async function resolveStart(recordKey) {
    const initial=await fence(()=>{
      const m=metadata(recordKey);
      if(!m)return null;
      const held=readJson(leaseFile(m.workdir));
      if(!held||held.recordKey!==keyOf(m)||held.state==='stopping')return null;
      // PID absence permits identity reconciliation, never deletion or a resend.
      if(m.state==='pending'&&m.owner&&alive(m.owner))return null;
      if(!['pending','uncertain'].includes(m.state))return null;
      return {meta:m,token:held.token};
    });
    if(!initial)return {ok:false,uncertain:true,recordKey};
    const {meta,token}=initial,rt=backend(recordKey,meta);
    let found;
    try {
      if(meta.backend==='mirasim') {
        if(typeof rt.resolveStart!=='function')return {ok:false,uncertain:true,recordKey};
        found=await rt.resolveStart({agent:meta.agent,workdir:meta.workdir,startedAt:meta.createdAt,clientRef:meta.clientRef});
      } else {
        const view=await rt.readSession(meta.sessionKey);
        found={ok:!!view&&!view.missing&&!view.partial&&!!view.phase,sessionKey:meta.sessionKey};
      }
      if(found?.ok!==true)return {ok:false,uncertain:true,recordKey,ambiguous:found?.ambiguous===true};
      return await fence(()=>({ok:true,...attachAccepted(meta,token,found,true)}));
    }catch{return {ok:false,uncertain:true,recordKey};}
  }
  async function startSession(spec) {
    assertExecutorIsolation();
    assertMutationAllowed();
    const launch=prepare(spec),{actual,meta,token}=launch,file=leaseFile(meta.workdir);
    for(;;) {
      const previous=await fence(()=>{
        assertAdmission();
        if(metadata(meta.recordKey))throw busy('execution key already exists','session-key-used');
        const held=readJson(file);
        if(held&&!held.cleanupVerified) {
          if(!held.sessionKey||RESERVED.has(held.state))throw busy('worktree has an unresolved launch or cleanup',held.state==='uncertain'?'launch-uncertain':'lease-held');
          return held;
        }
        // A crash between the two durable writes must not hide a reservation.
        const orphan=registry().find(m=>m.workdir===meta.workdir&&keyOf(m)!==(held?.recordKey||held?.sessionKey)&&(!FINISHED.has(m.state)||RESERVED.has(m.state)));
        if(orphan)throw busy('worktree has an unresolved registry reservation','launch-uncertain');
        if(processCheck(meta.workdir).length)throw busy('worktree already has an execution process');
        atomic(metaFile(meta.recordKey),meta);
        atomic(file,{schemaVersion:1,token,recordKey:meta.recordKey,sessionKey:meta.sessionKey,backend:meta.backend,workdir:meta.workdir,state:'pending',createdAt:now(),owner:meta.owner});
        return null;
      });
      if(!previous)break;
      const view=await backend(previous.sessionKey,previous).readSession(previous.sessionKey);
      if(!TERMINAL_STATUS.has(judgeExecutionCompletion(view).status))throw busy('worktree already has an active or unknown session');
      const cleaned=await stopSession(previous.sessionKey,{workdir:meta.workdir,expectedLease:previous,automatic:true});
      if(!cleaned?.ok)throw busy('previous worktree session cleanup is unverified');
    }
    let started;
    try {
      const rt=backend(meta.recordKey,meta);
      started=spec.resumeFrom
        ? (typeof rt.resumeSession==='function'?await rt.resumeSession(spec.resumeFrom,actual.prompt,{sessionKey:meta.sessionKey}):(()=>{throw Object.assign(new Error('backend does not expose resume'),{detail:{requestSent:false}});})())
        : await rt.startSession(actual);
      return await fence(()=>attachAccepted(meta,token,started));
    } catch(error) {
      const definite=started==null&&(error?.detail?.launchUncertain===false||error?.detail?.requestSent===false||error?.detail?.definiteRejection===true);
      await fence(()=>{
        const held=readJson(file);
        if(held?.token!==token)return;
        const current=metadata(held.recordKey||meta.recordKey)||meta;
        const next={...current,state:definite?'rejected':'uncertain',launchState:definite?'rejected':'uncertain',updatedAt:now(),...(started?.sessionKey?{observedSessionKey:started.sessionKey}:{}),launchError:'backend_launch_unconfirmed',cleanupVerified:definite,taskCompleted:false};
        atomic(metaFile(keyOf(next)),next);
        atomic(file,{...held,state:next.state,cleanupVerified:definite});
      });
      if(!definite&&started==null) {
        const resolved=await resolveStart(meta.recordKey);
        if(resolved.ok)return resolved;
      }
      error.detail={...(error.detail||{}),recordKey:meta.recordKey,sessionKey:meta.sessionKey,launchId:meta.launchId,launchUncertain:!definite};
      throw error;
    }
  }
  async function readSession(key) {
    let initial=metadata(key);
    if(initial&&['pending','uncertain'].includes(initial.state)) {
      const resolved=await resolveStart(key);
      if(resolved.ok){key=resolved.sessionKey;initial=metadata(key);}
    }
    if(initial&&!initial.sessionKey)return {phase:initial.state,text:'',toolCalls:[],missing:false,partial:false,via:'managed-registry',execution:initial,launchUncertain:initial.state==='uncertain'};
    const view=await backend(key,initial).readSession(initial?.sessionKey||key);
    let result=initial;
    if(initial)result=await fence(()=>{
      const current=metadata(key);if(!current)return null;
      const verdict=judgeExecutionCompletion(view);
      let state=RESERVED.has(current.state)||current.cleanupVerified?current.state:verdict.status;
      // 快照读不成（unknown）不许把已经落盘的终态改回 unknown，否则死人登记永久占树。
      // #1176 返工实咬：peek 一次就把 completed 写成 unknown，下一跳 startSession 被挡。
      if(verdict.status==='unknown'&&FINISHED.has(String(current.state||'')))state=current.state;
      const next={...current,state,observedState:verdict.status,updatedAt:now(),taskCompleted:false};
      atomic(metaFile(key),next);return next;
    });
    return {...view,execution:result};
  }
  /**
   * 树已回收 + 租约归别人：只结自己的记录。判据与主路一致——零进程、供应商侧终态或查无此会话；
   * 任一不满足就原样留着（下轮再看），不许凭「树没了」一个证据就判清退。
   */
  async function settleOrphanRecord(key,meta,target) {
    if(meta.backend==='acp')return {ok:false,why:'ACP record on a reaped worktree needs backend cleanup'};
    const rt=backend(key,meta);
    let procs;try{procs=processCheck(target);}catch{return {ok:false,why:'process cleanup scan incomplete'};}
    if(procs.length)return {ok:false,why:'processes still run inside the reaped worktree'};
    const stopped=await rt.stopSession(key).catch(e=>({ok:false,why:String(e?.message||e)}));
    const view=await rt.readSession(key);
    const terminal=view?.missing===true||TERMINAL_STATUS.has(judgeExecutionCompletion(view).status);
    if(!terminal)return {ok:false,uncertain:true,why:'vendor session on a reaped worktree is not terminal'};
    await fence(()=>{
      const current=metadata(key);if(!current)return null;
      atomic(metaFile(key),{...current,state:'stopped',cleanupVerified:true,cleanupToken:null,cleanupOwner:null,updatedAt:now(),taskCompleted:false});
      return current;
    });
    return {ok:true,verified:true,treeGone:true,foreignLease:true,stopAcknowledged:stopped?.ok===true};
  }
  async function stopSession(key,{workdir,expectedLease,automatic=false}={}) {
    assertMutationAllowed();
    let meta=metadata(key),target=meta?.workdir||workdir;
    if(meta&&!meta.sessionKey)return {ok:false,uncertain:true,why:'launch has no confirmed vendor session key'};
    if(!target) {
      const view=await backend(key,meta).readSession(key);target=view?.workdir||view?.snapshot?.cwd||view?.snapshot?.workdir;
      if(!target) {
        const listed=await backend(key,meta).listSessions({scope:'global'});
        const hit=listed?.ok&&listed.sessions?.find(s=>(s.sessionKey||s.key||s.id)===key);target=hit?.workdir||hit?.cwd;
      }
    }
    if(!target||!path.isAbsolute(target))return {ok:false,unscanned:true,why:'session workdir unavailable'};
    // 树已经被回收（reap-tree 跑在 stop 之前，或会话早就过期）：realpath 会 ENOENT 直接抛，
    // 一个字都没落盘 → 下一轮同一条再来。2026-09-18 实咬（#1350）：117 条终态会话每轮全部
    // 在这一行抛掉，stop-session 100% 空转。树没了不是「没查成」，是「残留进程已无处可占」：
    // 照走清退，让 cleanupVerified 落下去，指挥官下一轮就不再点它。
    let treeGone=false;
    try{target=fs.realpathSync(target);}catch(e){if(e?.code!=='ENOENT')throw e;treeGone=true;target=path.resolve(target);}
    const file=leaseFile(target),cleanupToken=crypto.randomUUID();
    const claimed=await fence(()=>{
      const held=readJson(file);meta=metadata(key)||meta;
      if(held&&held.sessionKey!==key) {
        // 树没了、租约也早归了后来者（同一路径被复用，实咬 26 条）：这条记录什么都握不住，
        // 「session no longer owns this worktree」对它不是拦路而是判词。租约一个字不碰，
        // 只按同样的判据（零进程 + 终态/missing）清自己的记录；树在时照旧拦。
        if(treeGone&&meta)return {foreignLease:true,meta};
        throw busy('session no longer owns this worktree');
      }
      if(expectedLease&&!sameLease(held,expectedLease))throw busy('worktree lease changed before cleanup');
      if(held?.state==='pending')throw busy('launch is still awaiting acceptance','launch-pending');
      if(held?.state==='stopping'&&(automatic||held.cleanupOwner&&alive(held.cleanupOwner)))throw busy('session cleanup already owned');
      if(held?.cleanupVerified&&meta?.cleanupVerified)return {alreadyStopped:true};
      if(automatic&&isWaitingState(meta))throw busy('session is waiting for user');
      const m=meta||{schemaVersion:1,recordKey:key,sessionKey:key,workdir:target,backend:String(key).startsWith('acp:')?'acp':'mirasim',state:'unknown',launchState:'accepted',taskCompleted:false,adopted:true};
      const clock=reservedClock(m,now());
      const next={...m,state:'stopping',cleanupVerified:false,cleanupToken,cleanupOwner:identity(process.pid),updatedAt:clock};
      atomic(metaFile(key),next);
      const lease={...held,token:held?.token||crypto.randomUUID(),recordKey:key,sessionKey:key,backend:m.backend,workdir:target,state:'stopping',cleanupToken,cleanupOwner:next.cleanupOwner,cleanupVerified:false,updatedAt:clock};
      atomic(file,lease);return {lease,meta:next,wasUncertain:m.state==='uncertain'||m.launchState==='uncertain'};
    });
    if(claimed.alreadyStopped)return {ok:true,verified:true,alreadyStopped:true};
    if(claimed.foreignLease)return settleOrphanRecord(key,claimed.meta,target);
    let result={ok:false,why:'session cleanup failed'};
    try {
      const rt=backend(key,claimed.meta);
      // Unknown vendor queues cannot be disproved by an empty process scan.
      if(claimed.wasUncertain) {
        const before=await rt.readSession(key);
        if(!before||before.missing||before.partial||!before.phase)return {ok:false,uncertain:true,why:'vendor acceptance remains unconfirmed'};
      }
      const stopped=await rt.stopSession(key);
      // 树没了时 stop 回执不是判据（服务端可能早已归档这条会话、回「查无此会话」）；
      // 下面的进程扫描 + 终态核实才是。stop 失败又树在，仍照旧返回。
      if(!stopped?.ok&&!(treeGone&&claimed.meta.backend!=='acp'))return stopped||result;
      if(claimed.meta.backend==='acp')result=stopped.verified===true||stopped.cleanup?.verified===true?{...stopped,ok:true}:{ok:false,why:'ACP cleanup unverified'};
      else {
        result=await reapMirasim(target);
        if(result.ok) {
          let terminal=false;
          for(let i=0;i<(opts.stopVerifyTries??3);i++) {
            const view=await rt.readSession(key);
            // 「收尾验过了」的判据：`judgeExecutionCompletion` 的 status 是**归一后**的两个词
            // （done/failed），它内部已经把正典的整张终态表映射进来了，所以这里不是手打状态表。
            // 原来的写法是拿 `['done','failed']` 去卡 **view**，而上游断流打死的常态（`incomplete`）
            // 在正典里是终态、却不在那个手打清单 → 验不过 → 会话与租约双双回写 stopping
            // → 这棵树永久起不了新会话（2026-09-12 实咬）。
            if(TERMINAL_STATUS.has(judgeExecutionCompletion(view).status)){terminal=true;break;}
            // 树没了 + 服务端查无此会话 + 零进程 = 没有任何东西可清。listSessions 那条路对同一形状
            // 的判词就是 gone（「明确的 missing 记成 gone」），这里不另起一套。树在时 missing 仍是 unknown。
            if(treeGone&&view?.missing===true){terminal=true;break;}
            if(i+1<(opts.stopVerifyTries??3))await wait(opts.cleanupPollMs??100);
          }
          if(!terminal)result={ok:false,uncertain:true,why:'vendor stop is not terminal; lease retained'};
          else if(treeGone)result={...result,treeGone:true,stopAcknowledged:stopped?.ok===true};
        }
      }
      return result;
    } finally {
      await fence(()=>{
        const held=readJson(file);if(held?.cleanupToken!==cleanupToken||held.sessionKey!==key)throw busy('cleanup ownership changed');
        const current=metadata(key)||claimed.meta;
        const complete=result?.ok===true;
        const clock=complete?now():reservedClock(current,Number(current.updatedAt)||now());
        atomic(metaFile(key),{...current,state:complete?'stopped':'stopping',cleanupVerified:complete,cleanupToken:null,cleanupOwner:null,updatedAt:clock,taskCompleted:false});
        atomic(file,{...held,state:complete?'stopped':'stopping',cleanupVerified:complete,cleanupToken:null,cleanupOwner:null,updatedAt:clock});
      });
    }
  }
  async function listSessions({includeExternal=false,readTimeoutMs=opts.managedReadTimeoutMs??8000,maxActive=opts.maxActiveReads??64,timeoutMs}={}) {
    let records;
    try{records=await fence(registry);}catch{return {ok:false,scope:'managed',includesExternal:false,sessions:[],errors:[{backend:'registry',error:'managed registry unreadable'}],partial:true,complete:false,stages:{list:'error',listCalls:0,snapshots:{attempted:0,completed:0}}};}
    const sessions=new Array(records.length),errors=[];
    const given=Number(timeoutMs);
    const budget=Number.isFinite(given)&&given>0?given:(opts.managedListTimeoutMs??15000);
    const wrapUpMs=opts.scanWrapUpMs??SCAN_WRAP_UP_MS;
    const started=now();
    const deadline=started+budget;
    const remaining=()=>Math.max(0,deadline-now()-wrapUpMs);
    const needFb=records.some(recordNeedsManagedFallback);
    const alloc=allocateManagedScanBudget({now:started,deadline,wrapUpMs,needSnapshotFallback:needFb,snapshotReserveMs:Math.max(1,readTimeoutMs)});
    const stages={startedAt:started,alloc,list:alloc.listMs<=0?'skipped':null,listCalls:0,listMs:null,snapshots:{attempted:0,completed:0}};
    let cursor=0,active=0;
    // 服务端的会话名单**按需查一次、全 worker 复用**：它带每条会话的 runState/open（服务端
    // 对自己会话的权威定性），是「这条已经终结了吗」最便宜的答案——比逐个读快照快一个数量级
    // （快照读实测 12s/条且过期会话必然超时）。
    //
    // 「按需」不能省：一条要判的会话都没有时（全是 pending/终态）不该白打一趟名单——
    // 既有用例盯着这个（managed pending inventory… 断言 m.calls.list===0）。所以用惰性
    // promise：第一个真需要的 worker 触发，其余等同一个结果，全程最多一次。
    // 查不成就是 null，退回「读快照判进度」的老路（fail-open 到旧行为，不假装终结）。
    // #1397：名单必须吃剩余预算，不能自己再开一轮；慢/失败时预留快照回退，不许把所有项变 unknown。
    let listedIndexPromise = null;
    const listedIndexOnce = () => {
      if (!listedIndexPromise) {
        listedIndexPromise = (async () => {
          if (alloc.listMs <= 0) return null;
          const tList=now();
          stages.listCalls+=1;
          try {
            const listed = await mirasim.listSessions({ scope: 'global', timeoutMs: alloc.listMs });
            stages.listMs = now()-tList;
            if (listed && listed.ok === true && Array.isArray(listed.sessions)) {
              stages.list = listed.complete === true && listed.partial !== true && listed.hasMore !== true ? 'ok' : 'partial';
              const idx = new Map();
              for (const x of listed.sessions) {
                const k = x.sessionKey || x.id || x.key;
                if (k) idx.set(String(k), x);
              }
              idx.complete = listed.complete === true && listed.partial !== true && listed.hasMore !== true;
              return idx;
            }
            const why=String(listed?.why||'');
            stages.list = listed?.stage==='connect' ? 'connect'
              : /超时|预算|deadline|建连/.test(why) ? 'timeout'
              : listed?.partial ? 'partial'
              : 'error';
          } catch { stages.list = 'error'; stages.listMs = now()-tList; }
          return null;
        })();
      }
      return listedIndexPromise;
    };
    const persistObservation=(m,state)=>{
      if(now()>=deadline)return Promise.resolve(null);
      return fence(()=>{ const cur = metadata(keyOf(m)); if (!cur) return null; const next = { ...cur, state: RESERVED.has(cur.state) || cur.cleanupVerified ? cur.state : state, observedState: state, observedAt: now(), taskCompleted: false }; atomic(metaFile(keyOf(m)), next); return next; });
    };
    const worker=async()=>{
      for(;;) {
        const index=cursor++;if(index>=records.length)return;
        let m=records[index],state=m.state;
        // **先问名单**：服务端自己的会话名单里就带 runState/open，那是它对自己每条会话的
        // 权威定性。名单说已经终结（incomplete/failed/…）、或 open=false 的，不必再去读快照
        // ——快照会随会话过期消失，为它等一趟读超时（实测 12s > 8s 预算）只会把整张名单判成
        // 没查成（2026-09-10 实咬：三条过期会话让观测集恒 incomplete，指挥官冻结差集重派）。
        // 名单没这条 / 没给状态，才退回「读快照判进度」那条老路。
        let listedState = null;
        const needList = recordNeedsManagedFallback(m);
        const listedIndex = needList ? await listedIndexOnce() : null;
        const hit = listedIndex ? listedIndex.get(String(m.sessionKey)) : null;
        if (hit) {
          // `open` describes an open UI session, not whether its agent ended.
          // A headless running Grok may have open:false. Never manufacture a
          // terminal state from that bit: doing so lets commander kill its own
          // workers on the next scan. Re-read unverified incomplete cache rows
          // so a previous misclassification does not become permanent truth.
          const raw = sessionStateOf(hit);
          if (raw) listedState = raw;
        }
        // Absence from a proven complete server inventory plus no executing
        // process is positive evidence of a removed session. Without both
        // observations retain the snapshot fallback; absence is not a timeout.
        if (!hit && listedIndex?.complete && m.backend === 'mirasim') {
          try { if (processCheck(m.workdir).length === 0) listedState = 'gone'; }
          catch { /* Cannot verify processes: do not infer disappearance. */ }
        }
        if (listedState) {
          state = listedState;
          try { await persistObservation(m, listedState); } catch { /* 落不下不改判 */ }
        } else if(needList) {
          const rem=remaining();
          if(++active>maxActive){state='unknown';errors.push({backend:m.backend,recordKey:keyOf(m),error:'managed active scan limit'});}
          else if(rem<=0){state='unknown';errors.push({backend:m.backend,recordKey:keyOf(m),error:'scan-budget-exhausted'});}
          else {
            let timer;
            stages.snapshots.attempted+=1;
            try {
              const view=await Promise.race([backend(m.sessionKey,m).readSession(m.sessionKey),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('timeout')),Math.max(1,Math.min(readTimeoutMs,rem)));})]);
              // 「服务端查无此会话」与「这次没读成」不是一回事：前者是**已经消失**（会话档案被
              // 归档/清掉、服务端重启丢了内存里的会话），后者是慢或抖。旧代码把两者都算成
              // 「没查成」并让整张名单 ok:false——2026-09-10 实咬：一条 review-1175 的死会话记录
              // 让观测集整轮没查成，指挥官据此把差集重派全冻结（#1146/#1152 该补的没补）。
              // 明确的 missing 记成 gone：不进 errors（不影响整张名单），当 FINISHED 处理，
              // 让「账上有、盘上没了」走到它该走的对账分支。
              if(view&&view.missing===true){state='gone';}
              else{
              state=judgeExecutionCompletion(view).status;
              // 「服务端名单里已经报了终态、只是快照没回帧」（partial）不算「这次没读成」：
              // 终态会话的快照本来就会过期消失，为它把整张名单判成没查成，代价是调度器整轮不动
              // （2026-09-10 实咬：一条 runState=incomplete 的死会话让观测集恒 incomplete，
              // 指挥官每轮只打一行 escalate）。名单给的终态就是判据，直接采信。
              // 真·读不成（超时/抛错）仍走下面那条 catch，照旧进 errors。
              if(state==='unknown'&&!(view&&view.partial===true&&FINISHED.has(String(view.phase||'')))){
                errors.push({backend:m.backend,recordKey:keyOf(m),error:'session state unknown'});
              }
              if(state==='unknown'&&view&&view.partial===true&&FINISHED.has(String(view.phase||'')))state=String(view.phase);
              }
              stages.snapshots.completed+=1;
              const written=await persistObservation(m,state);
              if(written){m=written;state=m.state;}
            }catch{
              // 读快照失败（超时/抛错）：**别把 unknown 写回记录**。写回之后这一条就永远
              // 进不了上面的 FINISHED 短路，每轮都白等一整趟超时，而且每轮都给整张名单
              // 记一条 errors —— 2026-09-10 实咬：三条过期会话让观测集恒「没查成」，
              // 指挥官据此冻结差集重派。状态留原样（下次仍会尝试读，会话真回来了还能救），
              // 但本轮按 unknown 上报，不写盘。
              state='unknown';
              errors.push({backend:m.backend,recordKey:keyOf(m),error:'session read incomplete'});
            }finally{clearTimeout(timer);}
          }
        }
        sessions[index]={...m,key:m.sessionKey||keyOf(m),state,phase:state,cwd:m.workdir,title:m.title||(m.issue?'ISSUE-#'+m.issue:m.pr?'PR-#'+m.pr:null),scope:'managed',taskCompleted:false};
        // 记账自愈：这一轮真读到过终态就落盘，免得下一轮又按 `unknown` 去读一趟必然超时的快照。
        // （旧实咬：上一次读失败写回 unknown，此后再也不进 FINISHED 段，每轮白等 8 秒。）
        if (FINISHED.has(state) && m.state !== state && now()<deadline) {
          try { await fence(() => { const cur = metadata(keyOf(m)); if (!cur) return null; const next = { ...cur, observedState: state, observedAt: now() }; atomic(metaFile(keyOf(m)), next); return next; }); }
          catch { /* 落不下不改判，下一轮再说 */ }
        }
      }
    };
    const workers=Math.max(1,Math.min(records.length||1,opts.managedReadConcurrency??4));
    await Promise.all(Array.from({length:workers},worker));
    if(includeExternal) {
      if(remaining()<=0) {
        errors.push({backend:'mirasim',error:'external scan incomplete'});
        errors.push({backend:'acp',error:'external scan incomplete'});
      } else {
        const rem=remaining();
        const results=await Promise.allSettled([mirasim.listSessions({scope:'global',timeoutMs:rem}),acp.listSessions()]);
        for(let i=0;i<results.length;i++) {
          const r=results[i];
          if(r.status!=='fulfilled'||r.value?.ok!==true||r.value.partial||r.value.hasMore===true||!Array.isArray(r.value.sessions))errors.push({backend:i?'acp':'mirasim',error:'external scan incomplete'});
          else for(const s of r.value.sessions)if(!sessions.some(m=>(m.sessionKey||m.key)===(s.sessionKey||s.key||s.id)))sessions.push({...s,scope:'external'});
        }
      }
    }
    const partial=errors.length>0;
    return {ok:!partial,scope:includeExternal?'managed+external':'managed',includesExternal:includeExternal,sessions,errors,partial,complete:!partial,stages};
  }
  async function waitForCompletion(key,{timeoutMs=600000,pollMs=1500}={}) {
    const deadline=now()+timeoutMs;
    for(;;){const view=await readSession(key),verdict=judgeExecutionCompletion(view);if(!['running','unknown'].includes(verdict.status))return {...verdict,view};if(now()>=deadline)return {status:'unknown',reason:'completion wait timed out',confirmedBy:[],view};await wait(pollMs);}
  }
  async function resumeSession(key,prompt) {
    assertMutationAllowed();const m=metadata(key);if(!m||!m.sessionKey)throw new Error('resume requires confirmed persistent execution metadata');
    if(typeof backend(key,m).resumeSession!=='function')throw new Error('backend does not expose resume; use a recorded task handoff');
    const view=await readSession(key);
    if(view.missing||(!TERMINAL.has(view.phase)&&view.phase!=='interrupted'))throw busy('only a stopped or interrupted session can be resumed');
    const stopped=await stopSession(key);if(!stopped?.ok)throw new Error('resume cleanup is unverified');
    return startSession({profileId:m.profileId,agent:m.agent,model:m.requestedModel||m.model,provider:m.provider,accountPoolId:m.accountPoolId,route:m.route,backend:m.backend,workdir:m.workdir,prompt,taskId:m.taskId,issue:m.issue,pr:m.pr,title:m.title,resumeFrom:key});
  }
  return {startSession,readSession,listSessions,stopSession,waitForCompletion,config:mirasim.config,
    profileForModel:model=>{const matches=profiles.filter(p=>p.id===model||p.defaultForModels?.includes(model));if(matches.length>1)throw new Error('ambiguous model profile');return matches[0]||null;},
    ensureWorkspace:async(repo,branch)=>{
      assertExecutorIsolation();
      assertMutationAllowed();
      const tree=await (opts.ensureWorkspace?opts.ensureWorkspace(repo,branch):ensureGitWorkspace(repo,branch,{homeDir,base:opts.base}));
      if(tree&&tree.path) attachControlPlaneHooksOrThrow(tree.path);
      return tree;
    },
    interact:async(key,answer)=>{assertMutationAllowed();await fence(assertAdmission);const m=metadata(key);if(m&&!m.sessionKey)throw busy('launch remains unconfirmed','launch-uncertain');return backend(key,m).interact(key,answer);},
    resumeSession,resolveStart,crossCheck:key=>String(key).startsWith('acp:')?{ledger:{readable:false,why:'ACP usage is independently collected'},journal:{readable:false}}:mirasim.crossCheck(key),metadata,
  };
}
