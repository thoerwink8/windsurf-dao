// systemd OnCalendar 语义展开（本仓实际在用的子集）。
//
// 病：仓内闸只对 OnCalendar **字符串**去重，于是 `*:06/5` 和 `*:1/5` 被当成两个点位。
// systemd 对 `*:N/I` 会从 N 起按 I 步进并在字段上限处回绕，6 ≡ 1 (mod 5)，
// 两者展开成同一串分钟（systemd-analyze calendar 给出同一个 Next elapse）。
//
// 本文件不调 systemd、不复用单元文件自己的注释——检查器自己展开。
// 认不出的写法、以及 systemd 会拒的超范围字段（*:60/5、*:99、24 点、99 分）
// 都返回 ok:false（没查成），不许当成有效展开、更不许按模数折回装绿。

/** 从 start 起按 interval 步进，在 modulus 处回绕，收到重复值停。 */
export function repeatingField(start, interval, modulus) {
  const s = Number(start);
  const i = Number(interval);
  const m = Number(modulus);
  if (!Number.isInteger(s) || !Number.isInteger(i) || !Number.isInteger(m)) return null;
  if (i <= 0 || m <= 0) return null;
  const out = new Set();
  let v = ((s % m) + m) % m;
  while (!out.has(v)) {
    out.add(v);
    v = (v + i) % m;
  }
  return out;
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function slotsFor(hours, minutes) {
  const slots = new Set();
  for (const h of hours) {
    for (const min of minutes) slots.add(`${pad(h)}:${pad(min)}`);
  }
  return slots;
}

const ALL_HOURS = repeatingField(0, 1, 24);

function inRange(n, min, max) {
  return Number.isInteger(n) && n >= min && n <= max;
}

/**
 * 展开一条 OnCalendar 为 24h 内所有 `HH:MM` 触发点。
 * 小时 0–23、分钟/秒 0–59；超范围跟 systemd-analyze calendar 一样当非法
 * （`*:60/5` 不得按模数折回成有效点）。认不出的写法也返回 ok:false。
 * @returns {{ok:true, slots:Set<string>} | {ok:false, reason:string}}
 */
export function expandOnCalendar(raw) {
  const cal = String(raw || '').trim();
  if (!cal) return { ok: false, reason: 'OnCalendar 空' };

  let m = cal.match(/^\*:(\d+)\/(\d+)$/);
  if (m) {
    const start = Number(m[1]);
    if (!inRange(start, 0, 59)) return { ok: false, reason: `分钟起点超范围：${cal}` };
    const minutes = repeatingField(start, Number(m[2]), 60);
    if (!minutes) return { ok: false, reason: `分钟步进展开失败：${cal}` };
    return { ok: true, slots: slotsFor(ALL_HOURS, minutes) };
  }

  m = cal.match(/^\*:(\d+)(?::(\d{2}))?$/);
  if (m) {
    const min = Number(m[1]);
    const sec = m[2] == null ? 0 : Number(m[2]);
    if (!inRange(min, 0, 59) || !inRange(sec, 0, 59)) {
      return { ok: false, reason: `分钟/秒超范围：${cal}` };
    }
    return { ok: true, slots: slotsFor(ALL_HOURS, new Set([min])) };
  }

  m = cal.match(/^\*-\*-\* (\d{1,2})\/(\d+):(\d{2}):(\d{2})$/);
  if (m) {
    const start = Number(m[1]);
    const min = Number(m[3]);
    const sec = Number(m[4]);
    if (!inRange(start, 0, 23) || !inRange(min, 0, 59) || !inRange(sec, 0, 59)) {
      return { ok: false, reason: `小时/分钟/秒超范围：${cal}` };
    }
    const hours = repeatingField(start, Number(m[2]), 24);
    if (!hours) return { ok: false, reason: `小时步进展开失败：${cal}` };
    return { ok: true, slots: slotsFor(hours, new Set([min])) };
  }

  m = cal.match(/^\*-\*-\* ([\d,]+):(\d{2}):(\d{2})$/);
  if (m) {
    const hours = new Set(m[1].split(',').map((x) => Number(x)));
    const min = Number(m[2]);
    const sec = Number(m[3]);
    if ([...hours].some((h) => !inRange(h, 0, 23)) || !inRange(min, 0, 59) || !inRange(sec, 0, 59)) {
      return { ok: false, reason: `小时列表/分钟/秒不合法：${cal}` };
    }
    return { ok: true, slots: slotsFor(hours, new Set([min])) };
  }

  return { ok: false, reason: `不认识的 OnCalendar：${cal}` };
}

/** 两条日历 24h 触发点的交集。任一条没查成 → ok:false。 */
export function calendarOverlap(a, b) {
  const ea = expandOnCalendar(a);
  const eb = expandOnCalendar(b);
  if (!ea.ok) return { ok: false, reason: ea.reason };
  if (!eb.ok) return { ok: false, reason: eb.reason };
  const hits = [...ea.slots].filter((s) => eb.slots.has(s));
  return { ok: true, hits };
}
