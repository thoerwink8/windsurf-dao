// scripts/lib/mirasim-ws-probe.mjs —— mirasim-server ws 探活的纯判官（#1151）。
//
// 病（2026-09-08 实咬）：HTTP / 还是 200，进程还在，但 ws 起会话面发不出 state 帧。
// 指挥官整晚「会话名单读不到」——不报警、不自愈。判活必须看「该发生的事有没有发生」
// （state 帧 + sessions 帧），不是进程在不在、口开没开。同形状判例 #940。
//
// 分层：本文件全是纯函数，只吃入参不碰 IO / 网络 / systemd。连线、扫 /proc、
// systemctl、hub-say 在 scripts/mirasim-ws-probe.mjs。自己查自己查不出错。
//
// 三态必须分得开：
//   green     —— 收到 state 帧且 sessions 帧回来了（契约是否钉死版本是另一格，探活不拿它当死）
//   red       —— 连上了但没收到 state / 没收到 sessions / 连不上 ws（该发生的事没发生）
//   unscanned —— 令牌不在、握手抛的不是「连不上」类、在途扫不成
// 「没查成」不许当红累计 strikes，也不许当绿放行自愈。
// 2026-09-09 帅位实证：listSessions 单口退化时 state 仍在、startSession 仍通——
// 只 ping state 会整晚当活。空名单 [] 算活；没回帧才算死。

export const DEFAULT_STRIKES_TO_ALERT = 2;
export const DEFAULT_STRIKES_TO_HEAL = 2;

/**
 * 把一次握手结果收成三态。只吃判官出口 / 抛错形状，不碰网络。
 *
 * handshake 成功时入参是 {ok, unscanned, version, errors, sessionsOk?}。
 * sessionsOk=false：state 在但 listSessions 不回（2026-09-09 单口退化）。
 * 失败时入参是 {error}（MirasimUnavailableError / 其它）。
 */
export function classifyHandshake(result) {
  if (!result || typeof result !== 'object') {
    return { state: 'unscanned', why: '握手结果不是对象（没查成）' };
  }
  if (result.error) {
    const err = result.error;
    const name = err && err.name ? String(err.name) : '';
    const code = err && err.code ? String(err.code) : '';
    const msg = String((err && err.message) || err || '').slice(0, 160);
    // 令牌不在 / 空令牌：服务多半没在跑，跟「ws 挂起」不是一类——没查成，不算连红。
    if (/读不到回环会话令牌|回环会话令牌是空的/.test(msg)) {
      return { state: 'unscanned', why: msg };
    }
    // 连不上 / 连上没 state / 没 sessions 帧：正是本探针要抓的病。HTTP 200 探不出这个。
    if (name === 'MirasimUnavailableError' || code === 'unavailable'
        || /连不上回环 ws|没收到 state 帧|没收到 sessions 帧|会话清单没回|没等到 sessions 帧/.test(msg)) {
      return { state: 'red', why: msg || '连不上回环 ws' };
    }
    return { state: 'unscanned', why: msg || '握手抛了不认识的错（没查成）' };
  }
  // 2026-09-09：state 在但 listSessions 不回。显式 sessionsOk=false 优先于「有 version 就算绿」。
  if (result.sessionsOk === false) {
    return { state: 'red', why: (Array.isArray(result.errors) && result.errors[0]) || '没收到 sessions 帧' };
  }
  if (result.unscanned === true) {
    return { state: 'red', why: (Array.isArray(result.errors) && result.errors[0]) || '没收到 state 帧' };
  }
  // 收到 state 且 sessions 回来了才算探活通。版本不符是契约另一格（拒派），不是「ws 面瘫了」——
  // 探活把版本钉死当红，升级那天会整晚误报、把还活着的服务杀了。
  // 注入夹具可以不带 sessionsOk（视为没测这一格）；真 handshake() 会带。
  if (result.ok === true || (result.unscanned === false && result.version)) {
    const extra = result.sessionsOk === true ? '且 sessions 帧回来了' : '';
    return { state: 'green', why: `收到 state 帧${extra}（version=${result.version || '?'}）` };
  }
  return { state: 'unscanned', why: '握手结果形状不认识（没查成）' };
}

/**
 * 扫 /proc 的结果 → 在途会话三态。
 * 没扫成必须显形：当成 0 就会在看不见会话时把活人杀掉。
 */
export function classifyInFlight(scan) {
  if (!scan || typeof scan !== 'object') {
    return { ok: false, unscanned: true, count: null, why: '没拿到进程观测（没查成）' };
  }
  if (scan.ok === false || scan.unscanned === true) {
    return { ok: false, unscanned: true, count: null, why: scan.error || '在途扫不成' };
  }
  const procs = Array.isArray(scan.procs) ? scan.procs : null;
  if (!procs) {
    return { ok: false, unscanned: true, count: null, why: '扫成了但没有 procs 数组（没查成）' };
  }
  return { ok: true, unscanned: false, count: procs.length, why: procs.length ? `${procs.length} 个会话进程` : '没有会话进程' };
}

/**
 * 把本轮握手折进上一份状态。三态里只有 red 累计 strikes；unscanned 不算连红。
 */
export function foldWsProbe(prev, handshake, nowIso) {
  const p = prev && typeof prev === 'object' ? prev : {};
  const classified = classifyHandshake(handshake);
  const state = classified.state;
  const strikes = state === 'red' ? (p.strikes || 0) + 1 : 0;
  const lastGreenAt = state === 'green' ? nowIso : (p.lastGreenAt || null);
  return {
    state,
    strikes,
    lastGreenAt,
    why: classified.why,
    at: nowIso,
  };
}

/**
 * 自愈闸。连续失败 N 次才考虑动刀；有在途只报警不杀；在途没查成也不杀。
 *
 * @returns {{heal:boolean, alert:boolean, reason:string}}
 */
export function decideWsHeal({
  folded,
  inflight,
  strikesToAlert = DEFAULT_STRIKES_TO_ALERT,
  strikesToHeal = DEFAULT_STRIKES_TO_HEAL,
} = {}) {
  const f = folded && typeof folded === 'object' ? folded : {};
  const state = f.state;
  const strikes = Number(f.strikes) || 0;
  if (state === 'green' || state === 'unscanned' || !state) {
    return { heal: false, alert: false, reason: state === 'green' ? 'ws 握手通' : '没查成，不动刀' };
  }
  if (state !== 'red') {
    return { heal: false, alert: false, reason: `状态 ${state} 不参与自愈` };
  }
  const alert = strikes >= strikesToAlert;
  if (strikes < strikesToHeal) {
    return { heal: false, alert, reason: `连红 ${strikes}/${strikesToHeal}，还没到自愈阈值` };
  }
  if (!inflight || inflight.unscanned === true || inflight.ok === false) {
    return { heal: false, alert: true, reason: `连红 ${strikes} 次但在途没查成，不杀（${inflight && inflight.why ? inflight.why : '没拿到观测'}）` };
  }
  const count = Number(inflight.count) || 0;
  if (count > 0) {
    return { heal: false, alert: true, reason: `连红 ${strikes} 次但有 ${count} 个在途会话，只报警不杀` };
  }
  return { heal: true, alert: true, reason: `连红 ${strikes} 次且无在途会话，重启 mirasim-server` };
}

/** 群里说人话：出了什么事 / 影响 / 我打算。 */
export function buildWsAlert({ folded, decision, plan } = {}) {
  const why = folded && folded.why ? folded.why : 'ws 握手失败';
  const strikes = folded && folded.strikes ? folded.strikes : 0;
  const n = plan && plan.strikesToAlert ? plan.strikesToAlert : DEFAULT_STRIKES_TO_ALERT;
  const intend = decision && decision.heal
    ? '无在途会话，我重启 mirasim-server 拉起。'
    : (decision && /在途/.test(decision.reason || '')
      ? '有人在干活，只报警不杀——等会话收了下一轮再看。'
      : '先继续探；还红且没人在干活我就重启。');
  return `mirasim 起会话面连续 ${strikes} 次没回 state/sessions 帧（阈值 ${n}）：${why}
影响：指挥官读不到会话名单，派工/复审会静默卡住，HTTP 探活看不出来。
我打算：${intend}`;
}

export function buildWsRecovered({ lastWhy } = {}) {
  const extra = lastWhy ? `（上一轮是：${lastWhy}）` : '';
  return `mirasim 起会话面恢复了，state/sessions 帧又回来了${extra}。不用处理。`;
}
