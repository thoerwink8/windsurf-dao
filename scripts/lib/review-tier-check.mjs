// dao-check 项：红项分级是否真的接线（2026-09-16 用户拍板走甲）
//
// 为什么单列：这一条本身就是当天挖出的病——规矩写了、模板指了，但没有任何东西核它，
// 于是「机制装了但没生效」（#1051 同一形状，收件箱 26 条里 18 条是它）。
// 分级制度若只写在 markdown 里，第一步就会退化成「谁也不知道该标 P1 还是 P2」。
//
// 本库只做**可机械判定**的两件事：
//   ① 标准页真的有分级节（P1/P2/P3 三档齐全）、审官书/士兵书真的指到它；
//   ② release-policy 的 review_rounds_max 真的有**生产代码**读它
//     （检查器自身 / 注释 / 字符串自命中不算；否则熔断永远不会触发）。
// 「审官标得对不对」是判断题，归审官与帅侧抽查，本库不碰——**不装作能判它**。
//
// 判据不许复用被检查对象自己的解析逻辑（自己查自己查不出错）：本库只做字符串在场性
// 与正则扫描，不 import 那几个文档的任何解析器。

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

/** 标准页必须同时出现这三档的档位名；缺一 = 分级没落地。 */
const TIERS = ['P1', 'P2', 'P3'];

/** 熔断说法：这几条同时在场才算「到轮数必须二选一」写进去了。 */
const CAP_MARKERS = ['review_rounds_max', '拆单', '改判'];

/** 接线闸自己。它读阈值是为了核别人，不能把自己算成熔断已接线。 */
const CHECKER_NAMES = new Set(['review-tier-check.mjs', 'review-tier-check.js']);

/**
 * 生产代码读阈值的语法：属性访问 `.budget.per_issue.review_rounds_max`（含可选链）。
 * 裸字符串、注释、检查器自命中都不是消费者——那正是本闸曾经静默放行的形状。
 */
const CONSUMER_ACCESS = /(?:\?\.|\.)budget(?:\?\.|\.)per_issue(?:\?\.|\.)review_rounds_max\b/;

/** 剥掉注释和字符串，剩下的才拿去对属性访问。 */
function stripJsNoise(src) {
  return String(src)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/`(?:\\.|[^`\\])*`/g, '""')
    .replace(/'(?:\\.|[^'\\])*'/g, '""')
    .replace(/"(?:\\.|[^"\\])*"/g, '""');
}

function isCapConsumerSource(src) {
  return CONSUMER_ACCESS.test(stripJsNoise(src));
}

function isCheckerFile(abs) {
  return CHECKER_NAMES.has(basename(abs));
}

/** 读一个文件；读不到返回 null（调用方据此判「没查成」，不是「没问题」）。 */
function readOrNull(abs) {
  try {
    return existsSync(abs) ? readFileSync(abs, 'utf8') : null;
  } catch {
    return null;
  }
}

/**
 * ① 分级制度接线检查（静态，不出网）。
 *
 * @param {{ root: string, paths?: object }} input
 *   paths 可覆盖（夹具用）：不给就按仓内标准落点取。
 * @returns {{ kind: 'unscanned'|'red'|'ok', line: string, howToFix?: string, evidence?: string }}
 */
export function inspectReviewTiers({ root, paths: override } = {}) {
  const paths = override || {
    standard: join(root, 'host', 'skills', 'dispatch', 'review-standard.md'),
    reviewerBook: join(root, 'host', 'skills', 'dispatch', 'templates', 'reviewer-book-mirasim.md'),
    soldierBook: join(root, 'host', 'skills', 'dispatch', 'templates', 'soldier-book-mirasim.md'),
    policy: join(root, 'docs', 'release-policy.json'),
  };

  // 「文件在不在、读不读得到」与「读到了但判据不满足」必须分开：
  // 前者是没查成，后者才是红。混起来会把「没扫到」当成「扫过没事」。
  // scripts 是目录，单独处理——混进下面的读文件循环会把它判成「读不了」。
  const { scripts: scriptsPath, ...docPaths } = paths;

  const missing = Object.entries(docPaths).filter(([, p]) => !existsSync(p)).map(([k]) => k);
  if (missing.length) {
    return {
      kind: 'unscanned',
      line: `红项分级接线没查成：文件不在（${missing.join('、')}）——不是「分级没问题」`,
      howToFix: '恢复这些文件，或改本检查的落点（落点被挪走时必须同轮改，否则闸静默开门）',
    };
  }

  const docs = {};
  for (const [k, p] of Object.entries(docPaths)) {
    const t = readOrNull(p);
    if (t == null) {
      return { kind: 'unscanned', line: `红项分级接线没查成：${k} 读不了`, howToFix: '查文件权限或损坏' };
    }
    docs[k] = t;
  }

  // 上限本身要真在策略里——否则「代码读它」是读一个不存在的值，
  // 接手的人会以为阈值有人管（判据与落点必须同一轮一起核）。
  // 落点是 budget.per_issue.*（实测 2026-09-16；早期写成 per_issue.* 判过红，别改回去）。
  let capValue = null;
  try {
    capValue = JSON.parse(docs.policy)?.budget?.per_issue?.review_rounds_max ?? null;
  } catch {
    return {
      kind: 'unscanned',
      line: '红项分级接线没查成：release-policy.json 不是合法 JSON——不是「阈值没问题」',
      howToFix: '修 JSON，或核本检查的落点是否已挪走',
    };
  }
  if (!Number.isFinite(capValue) || capValue <= 0) {
    return {
      kind: 'red',
      line: '红项分级没接线：release-policy 的 budget.per_issue.review_rounds_max 不是正数',
      howToFix: '熔断要有个能数出来的轮数上限，写回正整数',
      evidence: `budget.per_issue.review_rounds_max = ${JSON.stringify(capValue)}`,
    };
  }

  const bad = [];

  // ①-a 标准页三档齐全 + 熔断说法在场。
  const lackTiers = TIERS.filter((t) => !new RegExp(`\\b${t}\\b`).test(docs.standard));
  if (lackTiers.length) bad.push(`review-standard 缺档位 ${lackTiers.join('/')}`);
  const lackCap = CAP_MARKERS.filter((m) => !docs.standard.includes(m));
  if (lackCap.length) bad.push(`review-standard 缺熔断说法 ${lackCap.join('/')}`);

  // ①-b 两份任务书必须指到标准页——审官/士兵读的是它们，不指就等于没接线。
  // 认**文件名**而不是整条路径：模板里带不带 `host/skills/dispatch/` 前缀都算指到，
  // 否则本闸会把「换了写法但指向同一份文件」误判成红。
  for (const [k, label] of [['reviewerBook', '审官书'], ['soldierBook', '士兵书']]) {
    if (!docs[k].includes('review-standard.md')) bad.push(`${label}没有指到 review-standard.md`);
    else if (!TIERS.every((t) => new RegExp(`\\b${t}\\b`).test(docs[k]))) bad.push(`${label}指了标准页但正文没提档位`);
  }

  // ①-c 熔断的轮数上限必须真的被生产代码读到。
  //
  // 判据：scripts/ 下有人用属性访问读 budget.per_issue.review_rounds_max。
  // 检查器自身、注释、字符串字面量都不算——那是本闸曾经把「只有自己命中」判绿的洞。
  // 注意两种「没扫到」的意思完全不同，必须分开报（CLAUDE.md 自动检查节）：
  //   · 扫不到任何 .mjs 样本 → 没查成（unscanned），不是「没有硬编码」；
  //   · 扫到 N 个样本但 0 个生产消费者 → 红（阈值没人读，熔断永不触发，#1227）。
  const scriptsDir = override ? scriptsPath : join(root, 'scripts');
  let sawInCode = false;
  let scannedFiles = 0;
  if (existsSync(scriptsDir)) {
    const walk = (dir) => {
      let entries = [];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const abs = join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
          walk(abs);
        } else if (e.isFile() && /\.mjs$|\.js$/.test(e.name)) {
          const t = readOrNull(abs);
          if (t == null) continue;
          scannedFiles += 1;
          if (isCheckerFile(abs)) continue;
          if (isCapConsumerSource(t)) sawInCode = true;
        }
      }
    };
    walk(scriptsDir);
  }
  if (scannedFiles === 0) {
    return {
      kind: 'unscanned',
      line: '红项分级接线没查成：scripts/ 下没扫到任何 .mjs 样本——不是「没有硬编码」',
      howToFix: '核 scripts/ 是否还在，或本检查的扫描面是否失效',
    };
  }
  if (!sawInCode) {
    bad.push(`scripts/ 下 ${scannedFiles} 个脚本里没有生产代码读 budget.per_issue.review_rounds_max（检查器自身/注释/字符串自命中不算）——熔断永远不触发（#1227）`);
  }

  if (bad.length) {
    return {
      kind: 'red',
      line: `红项分级没接线 ${bad.length} 处`,
      howToFix: '分级只是文档、没人执行时，53 轮 0 绿的死循环会原样继续：把缺的那一层接上',
      evidence: bad.join('；'),
    };
  }

  return {
    kind: 'ok',
    line: `红项分级已接线：标准页三档齐全 + 审官书/士兵书都指到 + 熔断上限被生产代码读到`,
  };
}
