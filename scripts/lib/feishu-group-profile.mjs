// scripts/lib/feishu-group-profile.mjs —— 飞书群人格（#875 ⑥⑦）
//
// 每群一份 profile：persona 拼进意图层 system；intents 白名单；refuse 超范围一口拒。
// 缺 profile = 用 DEFAULT_PROFILE（老映射表不炸）；写了但字段不合法 = 抛（故意违规样本被拦）。

export const PROFILE_INTENTS = ['greeting', 'situation', 'decision', 'new_request', 'other'];

export const DEFAULT_PROFILE = {
  persona: '友好、简短、给人话。问候闲聊只打招呼不甩盘点；明确问现状才给盘面。查不到就说没查到，不编。',
  intents: ['greeting', 'situation', 'decision', 'new_request'],
  refuse: '这事不归我，去项目群开个单。',
};

/** 问候被 LLM 误塞进盘点时的兜底（#875 判别：违规样本被拦）。 */
export const GREETING_FALLBACK = '在的，有事直接说。';

const INVENTORY_LEAK_RE = /待拍板|开放 issues|【项目|供应商健康|【熔断|态势 @/i;

/** 问候回复里出现盘点段落 = 漏了。 */
export function inventoryLeak(text) {
  return INVENTORY_LEAK_RE.test(String(text ?? ''));
}

/**
 * 解析一群的 profile。raw 缺省 → 默认；不合法 → throw（loadGroups fail-closed）。
 * 返回新对象，不回写入参。
 */
export function parseProfile(raw, { chatId = '' } = {}) {
  if (raw == null) return { ...DEFAULT_PROFILE, intents: [...DEFAULT_PROFILE.intents] };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`群 ${chatId} 的 profile 不是对象`);
  }
  const persona = raw.persona == null ? DEFAULT_PROFILE.persona : raw.persona;
  if (typeof persona !== 'string' || !persona.trim()) {
    throw new Error(`群 ${chatId} 的 profile.persona 必须是非空字符串`);
  }
  const refuse = raw.refuse == null ? DEFAULT_PROFILE.refuse : raw.refuse;
  if (typeof refuse !== 'string' || !refuse.trim()) {
    throw new Error(`群 ${chatId} 的 profile.refuse 必须是非空字符串`);
  }
  let intents;
  if (raw.intents == null) {
    intents = [...DEFAULT_PROFILE.intents];
  } else if (!Array.isArray(raw.intents) || raw.intents.length === 0) {
    throw new Error(`群 ${chatId} 的 profile.intents 必须是非空数组`);
  } else {
    intents = [];
    for (const a of raw.intents) {
      if (!PROFILE_INTENTS.includes(a)) {
        throw new Error(`群 ${chatId} 的 profile.intents 不认识：${a}（只认 ${PROFILE_INTENTS.join('/')}）`);
      }
      if (!intents.includes(a)) intents.push(a);
    }
  }
  return { persona: persona.trim(), intents, refuse: refuse.trim() };
}

export function profileAllows(profile, intent) {
  const p = profile && typeof profile === 'object' ? profile : DEFAULT_PROFILE;
  return Array.isArray(p.intents) && p.intents.includes(intent);
}

/** 短问候（你好/在吗/hi）不走盘点。超长或问现状不命中。 */
export function looksLikeGreeting(text) {
  const t = String(text ?? '').trim();
  if (!t || t.length > 20) return false;
  const wave = String.fromCharCode(0x301c, 0x7e); // 全角/半角波浪，不写进源码字面量（路径闸会当成 ~/）
  return new RegExp(
    '^(你好|您好|在吗|在么|在不在|嗨|哈喽|嘿|早|早上好|晚上好|午安|hello|hi|hey)([呀啊吗么！!?。. \t' + wave + ']*)$',
    'i',
  ).test(t);
}

/** 问候出口：LLM 回了盘点或空话就换成兜底，不把盘点漏出去。 */
export function safeGreetingReply(text) {
  const t = typeof text === 'string' ? text.trim() : '';
  if (!t || inventoryLeak(t) || t.length > 80) return GREETING_FALLBACK;
  return t;
}
