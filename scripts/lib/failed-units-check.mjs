// 本仓的常驻单元挂进 `systemctl --failed` 了没有（#1172 / #1173 的第三格）。
//
// 为什么要有这一格：另一道闸守的是「单元文件写对没写对」——它 11/11 绿的时候，
// miraquota-contabo 正因为被写死的那一行每 10 分钟红一次，红了五天没人看见。
// 单元文件对了不等于单元活了；「装了」和「跑成了」是两件事。
//
// 归属判定不看单元名（手打的名字早晚漏），看**这个单元的 ExecStart 指不指向本仓**：
// 指得进来就是本仓的活，红了就该本仓修。这样别的仓的单元、系统自带单元不会误报。
//
// 「没查成」必须跟「查完 0 条」分开（本仓硬规矩）：探不到 systemctl / 输出不认识
// 一律返回 unknown，不做成绿。

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** 从 unit 文件文本里取 ExecStart 指到的本仓路径（不在本仓返回 null）。 */
export function repoScriptOf(unitText, repoRoot) {
  const es = (String(unitText).match(/^ExecStart=(.*)$/m) || [])[1] || '';
  if (!es) return null;
  const root = resolve(repoRoot || '');
  for (const tok of es.split(/\s+/)) {
    if (!/\.(mjs|js|cjs|sh)$/.test(tok)) continue;
    const abs = resolve(tok.startsWith('/') ? tok : join(root, tok));
    if (abs === root || abs.startsWith(root + '/')) return abs;
  }
  return null;
}

/** 本仓 systemd 目录里定义的单元名（带 .service）。0 个 = 没查成，不是「没有」。 */
export function repoUnitNames({ root } = {}) {
  const dir = join(root || '', 'host', 'machine', 'systemd');
  if (!existsSync(dir)) return { ok: false, error: `单元目录不在：${dir}` };
  const names = readdirSync(dir).filter((n) => n.endsWith('.service'));
  if (!names.length) return { ok: false, error: `${dir} 里没有 .service——0 个样本 = 没查成` };
  return { ok: true, names };
}

/**
 * 这个服务单元「跑成过」吗——判它是不是那种常亮红灯。
 *
 * 判据：同名的 timer 有没有 LastTriggerUSecRealtime（有过触发），
 * 或有配对的 timer 单元存在且 enable。取不到 → **不是 false 就是 true**，
 * 而是「判不了」，返回 null；调用方把 null 当「没跑成过」处理（保守判红）。
 *
 * @param {{serviceName:string, timerProps?:string, hasTimerFile?:boolean}} args
 * @returns {boolean|null}
 */
export function hasEverRun({ serviceName, timerProps = '', hasTimerFile = false } = {}) {
  const base = String(serviceName || '').replace(/\.service$/, '');
  if (!base) return null;
  if (!hasTimerFile) return false; // 没配对的 timer：oneshot 靠人拉，没「跑成过」这回事
  // 这个 systemd（255）上 `LastTriggerUSecRealtime` 是**空的**，有值的是 `LastTriggerUSec`
  // （它打出来是人读的时间串，不是单调计数）。两个都取，**只要有一个非空非零就算跑成过**——
  // 只认其中一个会在另一版 systemd 上把「跑成过」读成「从没跑过」，凭空造红灯。
  const vals = [...String(timerProps).matchAll(/^LastTriggerUSec(?:Realtime)?=(.*)$/gm)].map((m) => m[1].trim());
  if (!vals.length) return null; // 两项都没打出来 = 判不了
  return vals.some((v) => v && v !== '0' && v !== 'n/a');
}

/**
 * 纯函数：`systemctl --failed` 的输出 + 每个失败单元的文件文本 → 三态。
 *
 * 归属判据用 **ExecStart 指不指向本仓**，不用单元名——名字是手打的，早晚漏
 * （本仓判例 hand-typed-constant-will-be-wrong）。这样别的仓的单元、系统自带
 * 单元不会误报，而「仓里的单元被装成别的名字」也不会漏。
 *
 * **已经被放弃的那一档**：本仓有个单元（`dao-execution-usage.service`）按设计
 * 用 exit 2 表示「采集不完整，要人看得见」，而它**每 5 分钟必然重进一次
 * `--failed`**——因为 charge 这类字段结构上就报不全。那种常亮红灯跟
 * miraquota 那五天一样，最后一定没人看。所以判据把两件事分开：
 *
 *   - 单元**从没成功过**（timer 的 LastTrigger 空 / 从未 active）→ red，这是真故障
 *   - 单元**跑成过、只是最近一次非零** → 不红，但列进 `flaky` 如实报出来
 *
 * 分开的代价是「跑成过之后又开始每次失败」会被降级成不红。用 `flaky` 明着写出来
 * 抵这一点——不红不等于不说，跟「没查成不当绿」是同一条规矩的两面。
 */
export function classifyFailedUnits({ output, repoRoot, unitTexts = {}, arming = {} } = {}) {
  if (typeof output !== 'string') {
    return { state: 'unknown', detail: 'systemctl --failed 没输出（探不到？）——没查成，不当绿' };
  }
  if (/0 loaded units listed/i.test(output)) {
    return { state: 'green', detail: '本仓单元无一在 systemctl --failed 里', failed: [] };
  }
  const lines = output.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (!lines.length) {
    return { state: 'unknown', detail: 'systemctl --failed 输出空——没扫到任何样本，不当绿' };
  }
  const root = resolve(repoRoot || '');
  const mine = [];
  const foreign = [];
  const unjudged = [];
  for (const l of lines) {
    const m = l.match(/^(\S+\.service)\s/);
    if (!m) continue; // 表头 / 分隔线 / 不属于本层的话
    const name = m[1];
    const text = unitTexts[name];
    if (typeof text !== 'string') { unjudged.push(name); continue; }
    if (repoScriptOf(text, root)) mine.push(name);
    else foreign.push(name);
  }
  // 已放弃的一档：这个单元跑成过（同前缀的 timer 有过触发），只是最近一次非零。
  const armed = (name) => {
    const v = arming[name];
    return v === true;
  };
  const flaky = mine.filter((n) => armed(n));
  const hard = mine.filter((n) => !armed(n));
  if (hard.length) {
    return {
      state: 'red',
      detail: `本仓 ${hard.length} 个单元挂在 systemctl --failed 里（从没成功过）：${hard.join('、')}`,
      failed: hard,
      flaky,
      foreign,
      unjudged,
      plain: {
        what: `本仓有 ${hard.length} 个常驻单元起不来：${hard.join('、')}`,
        impact: '那条腿其实没在跑，但它该干的活看起来像「一直没事」',
        plan: 'journalctl -u <单元> -n 50 看最后一次为什么失败；修完 systemctl reset-failed',
      },
    };
  }
  if (unjudged.length) {
    // 有失败单元但读不到它的 unit 文件（要 root / 目录不在）——不能当绿。
    return {
      state: 'unknown',
      detail: `${unjudged.length} 个失败单元读不到 unit 文件，判不了归属：${unjudged.join('、')}`,
      failed: [], flaky, foreign, unjudged,
    };
  }
  if (flaky.length) {
    // 不红，但必须说出来：这些单元跑成过、最近一次非零，可能是真故障，也可能
    // 是它按设计用非零码报「不完整」。不替人判，只把名单摆出来。
    return {
      state: 'green',
      detail: `本仓单元无一起不来（${flaky.length} 个跑成过、最近一次非零，已在 --failed 里：${flaky.join('、')}；${foreign.length} 个别的单元在失败列表里，不归本仓）`,
      failed: [], flaky, foreign,
    };
  }
  return {
    state: 'green',
    detail: `本仓单元无一失败（${foreign.length} 个别的单元在失败列表里，不归本仓）`,
    failed: [],
    foreign,
  };
}
