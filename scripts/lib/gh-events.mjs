// scripts/lib/gh-events.mjs —— GitHub 事件桥的判据（纯函数，#956）
//
// 改这里前必须知道的四件事：
//
// 1. 事件从哪来：`gh webhook forward` 的 **stdout**，不是 HTTP 端点。
//    那条命令自己往 GitHub 建一个 hook（url = webhook-forwarder.github.com），
//    再用一条**出站** wss 把投递拉回来。本机没有任何监听端口，
//    所以 #956 原文里「HTTP 端点 + X-Hub-Signature-256 校验」那一层整个不存在——
//    签名是用来防「谁都能 POST 进来」的，而这里根本没有可以 POST 的入口。
//    要是哪天有人把它改回 `--url`（起本地监听），签名校验必须一起加回来。
//
// 2. stdout 上**只有负载**，一行一个 JSON。事件名那行（`[LOG] received event "push"`）
//    和开场白（notice: / Forwarding…）全在 **stderr**。
//    这一条是 2026-09-05 用 `1>o.log 2>e.log` 分流实测的——在那之前我用 `2>&1` 探的，
//    两股混在一起看着像「事件名 + 负载两行一组」，照那个写的解析器把每一条负载都丢了
//    （收到 4 个事件，counts.received 是 0）。**探流的时候不许合并 stderr。**
//    所以事件类型只能从负载自身认（eventTypeOf）：跨两个管道配对本来也没有顺序保证，
//    而且那行日志是给人看的，gh 换个版本就可能改写法。
//
// 3. 订阅哪些事件不是抄 issue 正文，是抄 SERVER-LANDING-CHECKLIST 那张判据表：
//    表里「靠事件」的只有三行——审官判定落地、PR 合并关单、工人交卷起审官。
//    三行全是 PR 形状，所以只订 pull_request / pull_request_review 两类。
//    `push` 订了也没有哪一行会用它，只会把 act 叫醒得更勤——不订。
//
// 4. 事件只负责**提前叫醒**已有的定时任务，不自己判断该做什么。
//    close-issues.mjs / commander.mjs act 是唯一那把尺；桥只决定「现在叫一下」。

/** 订阅的事件类型。每一类都对得上判据表里的一行，加之前先问那一行在哪。 */
export const FORWARD_EVENTS = ['pull_request', 'pull_request_review'];

export const UNIT_CLOSE_ISSUES = 'dao-close-issues.service';
export const UNIT_COMMANDER_ACT = 'commander-act.service';

/** 叫醒同一个单元的最小间隔。首发不等（前沿触发），冷却期内来的事件攒到期末补一发。 */
export const DEFAULT_COOLDOWN_MS = 60 * 1000;

/** 自证 ping 的节奏与容忍。ping 是本桥**自己造的样本**——没有它，「0 个事件」分不出死活。 */
export const PING_INTERVAL_MS = 10 * 60 * 1000;
export const HEARTBEAT_MS = 30 * 1000;

/**
 * 从负载本身认事件类型。事件名只在 stderr 上，跨管道配对没有顺序保证，所以只能这么认。
 * 认不出来的一律 'unknown'——记下来但不触发任何动作，不猜。
 */
export function eventTypeOf(payload) {
  const p = payload && typeof payload === 'object' ? payload : {};
  // ping 的签名：GitHub 每次连上和每次 /pings 都发它，负载里必有 zen + hook_id。
  if (p.zen !== undefined && p.hook_id !== undefined) return 'ping';
  // review 要排在 pull_request 前面——审官事件的负载里**也**有 pull_request。
  if (p.review && p.pull_request) return 'pull_request_review';
  // comment 存在说明是 review_comment / issue_comment 那一族，不是 PR 本身动了。
  if (p.pull_request && p.action !== undefined && !p.comment) return 'pull_request';
  return 'unknown';
}

/**
 * `gh webhook forward` 的 stdout 行解析器。不碰 IO，喂字符串就能测。
 * 返回 null = 这一行不是负载（空行，或 gh 哪天往 stdout 多打了一句人话）。
 */
export function createForwardParser() {
  return {
    push(line) {
      const text = String(line == null ? '' : line).trim();
      if (!text || text[0] !== '{') return null;
      let payload = null;
      try { payload = JSON.parse(text); } catch {
        // 收到了但读不懂：**不能当没收到**。上层要记成 malformed 并报出来。
        return { type: 'unknown', payload: null, malformed: true };
      }
      return { type: eventTypeOf(payload), payload, malformed: false };
    },
  };
}

const PR_WAKE_ACTIONS = new Set(['opened', 'reopened', 'ready_for_review', 'synchronize']);

/**
 * 事件 → 要叫醒哪些单元。
 * 返回 { kind, units, why, hookId? }；units 为空 = 这条不触发任何动作（但仍然是「收到了」）。
 */
export function routeEvent(ev) {
  if (!ev || !ev.type) return { kind: 'invalid', units: [], why: '空事件' };
  if (ev.malformed) return { kind: 'malformed', units: [], why: `${ev.type} 负载解析不了——收到了但读不懂` };
  const p = ev.payload || {};

  if (ev.type === 'ping') {
    // ping 不触发动作，但它是活性证据：hook_id 也只有这条能给（省一次 API）。
    return { kind: 'ping', units: [], hookId: p.hook_id != null ? Number(p.hook_id) : null, why: '自证 ping' };
  }

  if (ev.type === 'pull_request') {
    const n = p.number ?? p.pull_request?.number ?? '?';
    if (p.action === 'closed' && p.pull_request?.merged === true) {
      return {
        kind: 'pr-merged',
        units: [UNIT_CLOSE_ISSUES, UNIT_COMMANDER_ACT],
        why: `PR #${n} 合进来了——关它署名的单，并让指挥官处置`,
      };
    }
    if (p.action === 'closed') {
      // 关了但没合：单不该关（关单判据只认 MERGED），指挥官仍要重算盘面。
      return { kind: 'pr-closed', units: [UNIT_COMMANDER_ACT], why: `PR #${n} 关了但没合` };
    }
    if (PR_WAKE_ACTIONS.has(p.action)) {
      return { kind: 'pr-moved', units: [UNIT_COMMANDER_ACT], why: `PR #${n} ${p.action}——工人交卷/改动，指挥官重算` };
    }
    return { kind: 'ignored', units: [], why: `pull_request ${p.action || '(无 action)'} 不在判据表里` };
  }

  if (ev.type === 'pull_request_review') {
    const n = p.pull_request?.number ?? '?';
    if (p.action === 'submitted') {
      return { kind: 'review', units: [UNIT_COMMANDER_ACT], why: `PR #${n} 审官判定落地（${p.review?.state || '?'}）` };
    }
    return { kind: 'ignored', units: [], why: `pull_request_review ${p.action || '(无 action)'} 不在判据表里` };
  }

  return { kind: 'ignored', units: [], why: `没订阅的事件类型 ${ev.type}` };
}

/**
 * 叫醒节流：前沿触发 + 期末补一发。
 * lastFiredAt=null（从没叫过）→ 立刻叫。冷却中 → 给出补发时刻，不丢事件。
 */
export function planTrigger({ lastFiredAt = null, now = Date.now(), cooldownMs = DEFAULT_COOLDOWN_MS } = {}) {
  const last = Number(lastFiredAt);
  if (!Number.isFinite(last) || last <= 0) return { fire: true, scheduleAt: null };
  const ready = last + cooldownMs;
  if (now >= ready) return { fire: true, scheduleAt: null };
  return { fire: false, scheduleAt: ready };
}

// —— 健康判据：ok / red / unknown ——
//
// 这一节存在的唯一理由：**「桥悄悄停了」和「这段时间没有事发生」必须分得开**。
// 只数事件数分不开——安静的一小时和断线的一小时，事件数都是 0。
// 所以桥每 10 分钟朝自己的 hook 打一次 ping：那是一个**自己造出来的样本**，
// 通道通的时候它一定回得来。判绿的前提是「最近收到过 ping」，不是「没出错」。
export const OK = 'ok';
export const RED = 'red';
export const UNKNOWN = 'unknown';

/** 刚起步时还没来得及收第一个 ping，别报红。 */
export const STARTUP_GRACE_MS = 3 * 60 * 1000;

/**
 * 一小时内重连几次算「在抽风」。
 * 这一格补的是自证 ping 盖不住的那种坏法：子进程反复断开重连，
 * 每次能连上几分钟——ping 照样偶尔回得来，判据看着是绿的，
 * 而每次断开的窗口里发生的事件是**真丢了**（GitHub 不会补投）。
 * 6 次/小时 = 平均 10 分钟断一次，已经和 ping 周期同量级，再高就盖不住了。
 */
export const RESTART_CHURN_PER_HOUR = 6;

const ageMin = (ms) => Math.round(ms / 60000);

export function classifyGhEventBridge({
  probed = false, reason = '', state = null, now = Date.now(),
  heartbeatMs = HEARTBEAT_MS, pingIntervalMs = PING_INTERVAL_MS, graceMs = STARTUP_GRACE_MS,
} = {}) {
  if (!probed) return { state: UNKNOWN, detail: reason || '没探到事件桥状态文件（这台机器装了吗？）' };
  if (!state || typeof state !== 'object') {
    return { state: UNKNOWN, detail: reason || '事件桥状态文件读不出对象——没查成，不算「没有事发生」' };
  }

  const at = (v) => { const t = Date.parse(String(v || '')); return Number.isFinite(t) ? t : null; };
  const started = at(state.startedAt);
  const beat = at(state.heartbeatAt);
  if (!beat) return { state: UNKNOWN, detail: '状态文件里没有心跳时刻——判不了死活，不当成活着' };

  // 心跳停了：进程没了 / 卡死。这一条要在 ping 之前判——进程都不在，ping 当然也不会更新。
  const beatAge = now - beat;
  if (beatAge > heartbeatMs * 6) {
    return {
      state: RED,
      detail: `事件桥心跳停在 ${ageMin(beatAge)} 分钟前——它已经不在守着了，`
        + '现在只剩定时器兜底（延迟回到小时级）；journalctl -u dao-gh-events -n 50',
    };
  }

  const uptime = started ? now - started : Infinity;
  const pingRecv = at(state.ping?.recvAt);

  // 一个 ping 都没回来过：连上了但投递通道没通（多半 forward 子进程起不来 / 建不了 hook）。
  if (!pingRecv) {
    if (uptime < graceMs) {
      return { state: UNKNOWN, detail: `事件桥刚起 ${Math.max(0, Math.round(uptime / 1000))} 秒，第一个自证 ping 还没到——先别判` };
    }
    return {
      state: RED,
      detail: `事件桥起了 ${ageMin(uptime)} 分钟，一个自证 ping 都没收到——`
        + 'GitHub 的投递根本没进来，「没有事发生」这个解释不成立',
    };
  }

  // 进程活着，但 ping 迟到：通道断了而进程没察觉。
  const pingAge = now - pingRecv;
  const pingLimit = pingIntervalMs * 2 + 5 * 60 * 1000;
  if (pingAge > pingLimit) {
    return {
      state: RED,
      detail: `事件桥进程活着，但最近一次自证 ping 已经是 ${ageMin(pingAge)} 分钟前（该 ${ageMin(pingIntervalMs)} 分钟一次）`
        + '——事件送不进来了，别把它当「这段时间没事」',
    };
  }

  // 长连接在抽风：ping 偶尔回得来所以上面几条都放行，但每次断开窗口里的事件是真丢了。
  const exits = Array.isArray(state.forward?.recentExits) ? state.forward.recentExits : [];
  const churn = exits.map(at).filter((t) => t != null && now - t <= 60 * 60 * 1000).length;
  if (churn >= RESTART_CHURN_PER_HOUR) {
    return {
      state: RED,
      detail: `事件桥的长连接一小时内断了 ${churn} 次——ping 还偶尔回得来，所以别的判据都放行，`
        + '但每次断开窗口里的事件 GitHub 不会补投，等于在丢事；journalctl -u dao-gh-events -n 100',
    };
  }

  // 收到事件却叫不动单元：多半 sudoers 没装。这是「事件到了但没用」，比不通更容易被忽略。
  const broken = Object.entries(state.triggers || {})
    .filter(([, t]) => t && Number(t.fails) > 0)
    .map(([u, t]) => `${u}(连续失败 ${t.fails} 次：${t.lastError || '没记原因'})`);
  if (broken.length) {
    return {
      state: RED,
      detail: `事件收到了但叫不动单元：${broken.join('、')}——`
        + '先验 sudo -n /usr/bin/systemctl start --no-block dao-close-issues.service',
    };
  }

  const c = state.counts || {};
  const lastEvt = at(state.lastEvent?.at);
  return {
    state: OK,
    detail: `事件桥在守着（自证 ping ${ageMin(pingAge)} 分钟前刚回来）；`
      + `收到 ${Number(c.received) || 0} 条、触发 ${Number(c.routed) || 0} 次`
      + (churn ? `，近一小时重连 ${churn} 次` : '')
      + (lastEvt
        ? `，最近一条 ${ageMin(now - lastEvt)} 分钟前（${state.lastEvent?.type}/${state.lastEvent?.action || '-'}）`
        : '，至今没有真事件——ping 通就说明是真的没事，不是断了'),
  };
}
