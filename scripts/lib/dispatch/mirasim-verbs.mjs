// scripts/lib/dispatch/mirasim-verbs.mjs —— #880 卡 F：ask / notify / send 三动词的 mirasim 分支。
//
// 改这段前必须知道：
//   mirasim 会话里**没有 orca 卡、没有 Run、没有 dispatch 身份**——ask/notify/send 这三条
//   orchestration 通道在 mirasim 侧没有落点。#880 消歧已定：
//     - 问答（ask/send）= mirasim interact（帅经客户端 / mirasim-runtime interact 注入会话）
//     - 通知（notify）= GitHub 评论 + 飞书 hub
//     - 不搬 orchestration，不造第二套信箱。
//   所以 mirasim 路径这里**明确拒绝并指路**，不新建一套信箱：把误调 orca 动词的会话当场拦下、指回原生等价物。
//
// 纯判定，不看盘面、不发消息：executor!=='mirasim' → {mirasim:false} 透传（orca 原路照跑）；
// executor==='mirasim' → {mirasim:true, refuse, error, pointTo}。调用方对 refuse 走 fail（非零 + 指路）。

export const MIRASIM_VERB_POINTERS = Object.freeze({
  ask: 'reply-in-session',
  send: 'mirasim-interact',
  notifyWorkerDone: 'pr-and-review',
  notify: 'github-comment',
});

export function mirasimVerbGuard(verb, { executor, type } = {}) {
  if (executor !== 'mirasim') return { mirasim: false };
  switch (verb) {
    case 'ask':
      return {
        mirasim: true,
        refuse: true,
        pointTo: MIRASIM_VERB_POINTERS.ask,
        error: 'mirasim 会话问帅＝直接在回复正文提问、提问即停手等答，由 interact 答。mirasim 侧没有 Run 信箱，dao.mjs ask 无落点——不要调它。',
      };
    case 'send':
      return {
        mirasim: true,
        refuse: true,
        pointTo: MIRASIM_VERB_POINTERS.send,
        error: '给 mirasim 工人下指令＝走 mirasim interact（帅经 Mirasim 客户端 / mirasim-runtime interact 注入会话），不经 orchestration send。不要造第二套信箱。',
      };
    case 'notify':
      if (type === 'worker_done') {
        return {
          mirasim: true,
          refuse: true,
          pointTo: MIRASIM_VERB_POINTERS.notifyWorkerDone,
          error: 'mirasim 完工无 orchestration 结算：完工＝PR 存在＋判据绿（收口官核）。不要发 notify --type worker_done——mirasim 会话没有 dispatch 身份可结算。',
        };
      }
      return {
        mirasim: true,
        refuse: true,
        pointTo: MIRASIM_VERB_POINTERS.notify,
        error: 'mirasim 通知走 GitHub 评论（gh-as … issue/pr comment）＋飞书 hub，不搬 orchestration。dao.mjs notify 无落点——不要调它。',
      };
    default:
      return { mirasim: true, refuse: false };
  }
}
