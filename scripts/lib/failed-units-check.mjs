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
 * 纯函数：`systemctl --failed` 的输出 + 每个失败单元的文件文本 → 三态。
 *
 * 归属判据用 **ExecStart 指不指向本仓**，不用单元名——名字是手打的，早晚漏
 * （本仓判例 hand-typed-constant-will-be-wrong）。这样别的仓的单元、系统自带
 * 单元不会误报，而「仓里的单元被装成别的名字」也不会漏。
 */
export function classifyFailedUnits({ output, repoRoot, unitTexts = {} } = {}) {
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
  if (mine.length) {
    return {
      state: 'red',
      detail: `本仓 ${mine.length} 个单元挂在 systemctl --failed 里：${mine.join('、')}`,
      failed: mine,
      foreign,
      unjudged,
      plain: {
        what: `本仓有 ${mine.length} 个常驻单元起不来：${mine.join('、')}`,
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
      failed: [], foreign, unjudged,
    };
  }
  return {
    state: 'green',
    detail: `本仓单元无一失败（${foreign.length} 个别的单元在失败列表里，不归本仓）`,
    failed: [],
    foreign,
  };
}
