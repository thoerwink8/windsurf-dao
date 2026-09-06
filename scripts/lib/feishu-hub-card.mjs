// scripts/lib/feishu-hub-card.mjs —— 待拍板卡片 + card.action.trigger 回传（#875）
//
// 布局沿用原 buildHubCard（Card 1.0 header/elements），只加上下文四行和回传按钮。
// 按钮 value + behaviors.callback 都带 {issue, choice, repo}，兼容 1.0 / 2.0 回传。
// 点击处理是纯函数：先算出 toast + 更新后的卡片（3 秒内能回包），再由调用方落 gh 评论。

import { ensurePlain } from './plain-words.mjs';

export const CARD_CHOICES = ['recommend', 'wait', 'alternative'];

export const CHOICE_LABELS = {
  recommend: '按推荐执行',
  wait: '等我回来拍',
  alternative: '换个方案',
};

export const CARD_CHOICE_PRIMARY = 'recommend';

function str(v) {
  return v == null ? '' : String(v).trim();
}

function issueNum(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

export function choiceLabel(choice) {
  return CHOICE_LABELS[choice] || '';
}

/** 卡片正文：出事 / 影响 / 推荐+为什么 / 期限；GitHub 链接最后一行兜底。 */
export function hubCardBodyText({
  title, from, repo, url, what, impact, recommend, why, deadline,
} = {}) {
  const lines = [];
  const head = str(what) || str(title);
  if (head) lines.push(`出了什么事：${head}`);
  if (str(impact)) lines.push(`影响：${impact}`);
  const rec = str(recommend);
  const reason = str(why);
  if (rec && reason) lines.push(`推荐：${rec}（${reason}）`);
  else if (rec) lines.push(`推荐：${rec}`);
  else if (reason) lines.push(`推荐理由：${reason}`);
  if (str(deadline)) lines.push(`期限：${deadline}`);
  if (str(from)) lines.push(`来自：${from}`);
  if (str(repo)) lines.push(`仓库：${repo}`);
  if (str(url)) lines.push(`[打开单子看](${url})`);
  return ensurePlain(lines.join('\n'), 'feishu-hub-card');
}

function callbackButton({ label, choice, repo, number, type }) {
  const value = { issue: String(number ?? ''), choice, repo: str(repo) };
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: label },
    type,
    value,
    behaviors: [{ type: 'callback', value }],
  };
}

export function buildHubCard({
  repo, number, url, title, from,
  what, impact, recommend, why, deadline,
  decided = null,
} = {}) {
  if (decided && decided.choice) return buildDecidedHubCard({
    repo, number, url, title, from, what, impact, recommend, why, deadline, decided,
  });
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: `待拍板：${repo || ''}#${number ?? ''}` },
      template: 'orange',
    },
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: hubCardBodyText({ title, from, repo, url, what, impact, recommend, why, deadline }),
        },
      },
      {
        tag: 'action',
        actions: [
          callbackButton({
            label: CHOICE_LABELS.recommend, choice: 'recommend', repo, number, type: 'primary',
          }),
          callbackButton({
            label: CHOICE_LABELS.wait, choice: 'wait', repo, number, type: 'default',
          }),
          callbackButton({
            label: CHOICE_LABELS.alternative, choice: 'alternative', repo, number, type: 'default',
          }),
        ],
      },
    ],
  };
}

export function buildDecidedHubCard({
  repo, number, url, title, from,
  what, impact, recommend, why, deadline,
  decided = {},
} = {}) {
  const who = str(decided.who) || '有人';
  const when = str(decided.when) || '';
  const picked = choiceLabel(decided.choice) || str(decided.choice) || '未知选项';
  const stamp = [`已拍：${picked}`, who, when].filter(Boolean).join(' · ');
  const body = [hubCardBodyText({ title, from, repo, url, what, impact, recommend, why, deadline }), stamp]
    .filter(Boolean)
    .join('\n');
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: `已拍：${repo || ''}#${number ?? ''}` },
      template: 'green',
    },
    elements: [
      {
        tag: 'div',
        text: { tag: 'lark_md', content: ensurePlain(body, 'feishu-hub-card/decided') },
      },
    ],
  };
}

function parseValue(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
  if (typeof raw === 'string' && raw.trim()) {
    try { return JSON.parse(raw); } catch { return { choice: raw.trim() }; }
  }
  return {};
}

function eventTypeOf(event) {
  if (!event || typeof event !== 'object') return '';
  return str(event.event_type || event.type || event.header?.event_type);
}

/** 飞书 card.action.trigger → {messageId, chatId, openId, name, token, repo, number, choice}；认不出返回 null。
 *  webhook 带 header.event_type；WSClient EventDispatcher 回调是扁平 action/operator/context，没有 type。 */
export function parseCardAction(event) {
  if (!event || typeof event !== 'object') return null;
  const type = eventTypeOf(event);
  if (type === 'im.message.receive_v1') return null;
  const nested = event.event && typeof event.event === 'object' ? event.event : null;
  const ev = nested && (nested.action || nested.operator || nested.context) ? nested : event;
  const looksLike = !!(ev && (ev.action || ev.action_value || ((ev.token || event.token) && (ev.operator || ev.context))));
  if (type && type !== 'card.action.trigger') return null;
  if (type !== 'card.action.trigger' && !looksLike) return null;
  if (ev.message && ev.sender && !looksLike) return null;
  const ctx = ev.context && typeof ev.context === 'object' ? ev.context : {};
  const operator = ev.operator && typeof ev.operator === 'object' ? ev.operator : {};
  const action = ev.action && typeof ev.action === 'object' ? ev.action : {};
  const messageId = str(
    ev.message_id || ctx.open_message_id || ctx.message_id || event.message_id,
  );
  const chatId = str(ev.chat_id || ctx.open_chat_id || ctx.chat_id || event.chat_id);
  const openId = str(
    operator.open_id
    || operator.user_id
    || ev.operator_id
    || event.operator_id
    || operator.operator_id,
  );
  const name = str(operator.user_name || operator.name || ev.operator_name);
  const token = str(ev.token || event.token || event.header?.token);
  const value = parseValue(action.value ?? ev.action_value ?? event.action_value);
  const choice = str(value.choice || value.action);
  const number = issueNum(value.issue ?? value.number);
  const repo = str(value.repo);
  return {
    messageId,
    chatId,
    openId,
    name,
    token,
    repo,
    number,
    choice,
    rawValue: value,
  };
}

export function formatCardWhen(ts = Date.now()) {
  const d = ts instanceof Date ? ts : new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 点击后立刻能回的 toast + 卡片。不打网。
 * kind: ok | duplicate | bad_choice | missing_issue
 */
export function cardCallbackResponse(parsed, {
  pending = null, now = Date.now(), who = '',
} = {}) {
  const repo = str(parsed?.repo) || str(pending?.repo);
  const number = issueNum(parsed?.number) || issueNum(pending?.number);
  const base = {
    repo,
    number,
    url: pending?.url || '',
    title: pending?.title || '',
    from: pending?.from || '',
    what: pending?.what,
    impact: pending?.impact,
    recommend: pending?.recommend,
    why: pending?.why,
    deadline: pending?.deadline,
  };
  if (pending?.decided?.choice) {
    const prev = choiceLabel(pending.decided.choice) || pending.decided.choice;
    return {
      kind: 'duplicate',
      toast: { type: 'info', content: `已经拍过了：${prev}` },
      card: buildDecidedHubCard({ ...base, decided: pending.decided }),
      decided: pending.decided,
    };
  }
  if (!CARD_CHOICES.includes(parsed?.choice)) {
    return {
      kind: 'bad_choice',
      toast: { type: 'error', content: '这个按钮我没认出来' },
      card: buildHubCard(base),
      decided: null,
    };
  }
  if (!repo || !number) {
    return {
      kind: 'missing_issue',
      toast: { type: 'error', content: '对不上哪张单，没记下' },
      card: buildHubCard(base),
      decided: null,
    };
  }
  const decided = {
    choice: parsed.choice,
    who: str(who) || str(parsed?.name) || parsed?.openId || '有人',
    when: formatCardWhen(now),
    openId: str(parsed?.openId),
  };
  const label = choiceLabel(parsed.choice);
  return {
    kind: 'ok',
    toast: { type: 'success', content: `已记下：${label}` },
    card: buildDecidedHubCard({ ...base, decided }),
    decided,
  };
}

export function cardDecisionComment({ who, choice, chatId, messageId, text } = {}) {
  const label = choiceLabel(choice) || str(choice) || '未知选项';
  const extra = str(text);
  return [
    `【飞书拍板】${str(who) || '有人'} 点了「${label}」${extra ? `：${extra}` : ''}`,
    `<!-- feishu chat_id ${str(chatId)} / message_id ${str(messageId)} / choice ${str(choice)} -->`,
  ].join('\n');
}

export function alternativeFollowup() {
  return '想换成哪条？直接回我一句就行。';
}
