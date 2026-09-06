// 消歧官（#1006）：给「已消歧」这道只有读没有写的闸补上执行者。
//
// 验收 1–7 都是判别性的。把 2 或 5 判反，等于这个消歧官会自己给自己发派工许可。
// 纯函数测 refine-core；驱动层测注入假 gh，不出网。
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const CORE = import('file://' + path.join(ROOT, 'scripts', 'lib', 'refine-core.mjs').replace(/\\/g, '/'));
const CLI = import('file://' + path.join(ROOT, 'scripts', 'refiner.mjs').replace(/\\/g, '/'));
const PLAIN = import('file://' + path.join(ROOT, 'scripts', 'lib', 'plain-words.mjs').replace(/\\/g, '/'));

const UNIT_DIR = path.join(ROOT, 'host', 'machine', 'systemd');
const SERVICE = path.join(UNIT_DIR, 'dao-refiner.service');
const TIMER = path.join(UNIT_DIR, 'dao-refiner.timer');
const INSTALL = path.join(ROOT, 'scripts', 'install-dao-refiner.sh');
const ROUTING = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'model-routing.json'), 'utf8'));

const CLEAR_TITLE = '把 formatError 函数的错误信息换成人话';
const CLEAR_BODY = '只改这一处提示文案，不改行为。验收：报错字符串不再含内部代号。';
const FORK_TITLE = '合并闸推广到全部仓：先缩面再造分发器（体系类三问已答）';
const FORK_BODY = [
  '用户拍板推广到所有项目。',
  '',
  '## 要你拍的三件',
  '',
  '1. **私有仓怎么办**：① 升 GitHub Pro ② 转公开 ③ 私有仓不开平台闸',
  '2. **两个公开仓**：要不要我提 PR 给它们的 CI 加 pull_request 触发',
  '3. **弃用仓**：归档还是删除',
  '',
  '推荐：不造分发器，造检查器。',
].join('\n');

function labels(...names) {
  return names.map((name) => ({ name }));
}

function issue(number, over = {}) {
  return {
    number,
    title: CLEAR_TITLE,
    body: CLEAR_BODY,
    labels: [],
    ...over,
  };
}

function fakeGh(map) {
  const calls = [];
  const runGh = (args) => {
    calls.push(args.slice());
    const key = args.join(' ');
    if (typeof map === 'function') return map(args, key);
    if (Object.prototype.hasOwnProperty.call(map, key)) return map[key];
    const prefix = Object.keys(map).find((k) => key.startsWith(k));
    if (prefix) return map[prefix];
    return { ok: false, error: `假 gh 没准备这条：${key}` };
  };
  return { runGh, calls };
}

describe('验收 1：边界清楚 → 无岔路，打齐三标', () => {
  it('classify 判 clear', async () => {
    const { classifyIssue, VERDICT } = await CORE;
    const r = classifyIssue(issue(1));
    assert.equal(r.verdict, VERDICT.clear);
    assert.equal(r.number, 1);
    assert.equal(r.forks.length, 0);
  });

  it('plan 打 已消歧 + model/ + reviewer/，评论带钉', async () => {
    const { planIssue, VERDICT, DISAMBIGUATED_LABEL, REFINER_MARKER } = await CORE;
    const r = planIssue({ issue: issue(1), comments: [], routingDoc: ROUTING });
    assert.equal(r.verdict, VERDICT.clear);
    assert.equal(r.labelsToAdd.includes(DISAMBIGUATED_LABEL), true);
    assert.equal(r.labelsToAdd.some((n) => n.startsWith('model/')), true);
    assert.equal(r.labelsToAdd.some((n) => n.startsWith('reviewer/')), true);
    assert.equal(r.labelsToAdd.includes('待拍板'), false);
    assert.equal(String(r.comment).includes(REFINER_MARKER), true);
    assert.equal(r.hub, false);
  });

  it('工人 grok、审官跨厂（luna，不是 grok）', async () => {
    const { pickDispatchLabels } = await CORE;
    const r = pickDispatchLabels({ labels: [], routingDoc: ROUTING });
    assert.equal(r.ok, true);
    assert.equal(r.model, 'grok-4.6');
    assert.notEqual(r.reviewer, 'grok-4.6');
    assert.equal(r.reviewer.startsWith('gpt-'), true);
  });
});

describe('验收 2：真有岔路（#999 形）→ 要人拍，不许打 已消歧', () => {
  it('classify 判 forks，抽出三条', async () => {
    const { classifyIssue, VERDICT } = await CORE;
    const r = classifyIssue(issue(999, { title: FORK_TITLE, body: FORK_BODY }));
    assert.equal(r.verdict, VERDICT.forks);
    assert.equal(r.forks.length, 3);
    assert.equal(/私有仓/.test(r.forks[0].fork), true);
  });

  it('plan 只打 待拍板，评论列岔路，不含 已消歧', async () => {
    const { planIssue, VERDICT, DISAMBIGUATED_LABEL, AWAITING_CALL_LABEL } = await CORE;
    const r = planIssue({
      issue: issue(999, { title: FORK_TITLE, body: FORK_BODY }),
      comments: [],
      routingDoc: ROUTING,
    });
    assert.equal(r.verdict, VERDICT.forks);
    assert.deepEqual(r.labelsToAdd, [AWAITING_CALL_LABEL]);
    assert.equal(r.labelsToAdd.includes(DISAMBIGUATED_LABEL), false);
    assert.equal(String(r.comment).includes('已消歧'), true); // 正文声明「未打」
    assert.equal(/未打/.test(r.comment), true);
    assert.equal(/私有仓/.test(r.comment), true);
    assert.equal(r.hub, true);
  });

  it('拿不准（空正文、标题含糊）也归 forks，不归 clear', async () => {
    const { classifyIssue, VERDICT } = await CORE;
    const r = classifyIssue({ number: 8, title: '优化一下派单', body: '', labels: [] });
    assert.equal(r.verdict, VERDICT.forks);
    assert.notEqual(r.verdict, VERDICT.clear);
  });
});

describe('验收 3：type/体系 不打任何标', () => {
  it('classify skip', async () => {
    const { classifyIssue, VERDICT } = await CORE;
    const r = classifyIssue(issue(3, {
      title: CLEAR_TITLE,
      labels: labels('type/体系'),
    }));
    assert.equal(r.verdict, VERDICT.skip);
  });

  it('plan 空 labelsToAdd、无评论、不进 hub', async () => {
    const { planIssue, VERDICT } = await CORE;
    const r = planIssue({
      issue: issue(3, { labels: labels('type/体系') }),
      comments: [],
      routingDoc: ROUTING,
    });
    assert.equal(r.verdict, VERDICT.skip);
    assert.deepEqual(r.labelsToAdd, []);
    assert.equal(r.comment, null);
    assert.equal(r.hub, false);
  });
});

describe('验收 4：已有 待消歧 标 → 跳过，不打标', () => {
  it('selectCandidates 把它放进 skipped', async () => {
    const { selectCandidates } = await CORE;
    const r = selectCandidates([
      issue(4, { labels: labels('待消歧') }),
      issue(5),
    ]);
    assert.equal(r.scanned, true);
    assert.deepEqual(r.skipped, [{ number: 4, reason: '待消歧' }]);
    assert.equal(r.items.length, 1);
    assert.equal(r.items[0].number, 5);
  });

  it('已消歧也跳过', async () => {
    const { selectCandidates } = await CORE;
    const r = selectCandidates([issue(6, { labels: labels('已消歧') })]);
    assert.equal(r.scanned, true);
    assert.deepEqual(r.items, []);
    assert.equal(r.skipped[0].reason, '已消歧');
  });
});

describe('验收 5：GitHub 读失败 → 没查成，非 0，不许当 0 张', () => {
  it('issue 列表不是数组 → scanned:false', async () => {
    const { selectCandidates, planRound } = await CORE;
    const a = selectCandidates(null);
    assert.equal(a.scanned, false);
    assert.match(a.error, /没查成/);
    const b = planRound({ issues: null, commentsByNumber: {}, routingDoc: ROUTING });
    assert.equal(b.scanned, false);
    assert.match(b.error, /没查成/);
  });

  it('驱动层 list 失败 → exit 2，零写入', async () => {
    const { runRefiner } = await CLI;
    const { runGh, calls } = fakeGh(() => ({ ok: false, error: 'network down' }));
    const writes = [];
    const wrapped = (args) => {
      if (args[0] === 'issue' && (args[1] === 'edit' || args[1] === 'comment')) writes.push(args);
      return runGh(args);
    };
    const r = runRefiner({
      args: {},
      runGh: wrapped,
      say: () => { throw new Error('不该推'); },
      routingDoc: ROUTING,
    });
    assert.equal(r.scanned, false);
    assert.equal(r.exit, 2);
    assert.match(r.error, /没查成/);
    assert.match(r.error, /不是 0 张/);
    assert.deepEqual(writes, []);
    assert.equal(calls.length > 0, true);
  });

  it('评论读失败 → 整轮不作数，零写入', async () => {
    const { runRefiner } = await CLI;
    const writes = [];
    const runGh = (args) => {
      if (args[0] === 'issue' && args[1] === 'list') {
        return {
          ok: true,
          out: JSON.stringify([issue(7, { title: FORK_TITLE, body: FORK_BODY })]),
        };
      }
      if (args[0] === 'issue' && args[1] === 'view') {
        return { ok: false, error: 'timeout' };
      }
      if (args[1] === 'edit' || args[1] === 'comment') writes.push(args);
      return { ok: false, error: 'unexpected' };
    };
    const r = runRefiner({ args: {}, runGh, say: () => ({ ok: true }), routingDoc: ROUTING });
    assert.equal(r.scanned, false);
    assert.equal(r.exit, 2);
    assert.match(r.error, /没查成/);
    assert.deepEqual(writes, []);
  });

  it('labels 不是列表 → 没查成，不是「没有标」', async () => {
    const { classifyIssue, VERDICT, selectCandidates } = await CORE;
    const r = classifyIssue({ number: 9, title: CLEAR_TITLE, body: CLEAR_BODY, labels: '已消歧' });
    assert.equal(r.verdict, VERDICT.unscanned);
    const s = selectCandidates([{ number: 9, title: 'x', labels: { name: '已消歧' } }]);
    assert.equal(s.scanned, false);
  });

  it('labels 缺席 → 没查成（不许当空数组）', async () => {
    const { selectCandidates } = await CORE;
    const s = selectCandidates([{ number: 9, title: 'x' }]);
    assert.equal(s.scanned, false);
    assert.match(s.error, /没查成/);
  });

  it('对照：真的 0 张开放单 → scanned 且 exit 0，与没查成分得开', async () => {
    const { runRefiner } = await CLI;
    const r = runRefiner({
      args: {},
      runGh: (args) => {
        if (args[0] === 'issue' && args[1] === 'list') return { ok: true, out: '[]' };
        return { ok: false, error: 'unexpected ' + args.join(' ') };
      },
      say: () => { throw new Error('0 张不该推'); },
      routingDoc: ROUTING,
    });
    assert.equal(r.scanned, true);
    assert.equal(r.exit, 0);
    assert.equal(r.plans.length, 0);
  });
});

describe('验收 6：同一张单判过一次后不重复评论（幂等）', () => {
  it('已有钉 → comment null、hub false，标仍可补', async () => {
    const { planIssue, VERDICT, REFINER_MARKER, AWAITING_CALL_LABEL } = await CORE;
    const r = planIssue({
      issue: issue(999, { title: FORK_TITLE, body: FORK_BODY }),
      comments: [{ body: `旧评论\n${REFINER_MARKER}` }],
      routingDoc: ROUTING,
    });
    assert.equal(r.verdict, VERDICT.forks);
    assert.equal(r.comment, null);
    assert.equal(r.hub, false);
    assert.equal(r.idempotent, true);
    assert.deepEqual(r.labelsToAdd, [AWAITING_CALL_LABEL]);
  });

  it('标已在、钉也在 → 零动作', async () => {
    const { planIssue, AWAITING_CALL_LABEL, REFINER_MARKER } = await CORE;
    const r = planIssue({
      issue: issue(999, {
        title: FORK_TITLE,
        body: FORK_BODY,
        labels: labels(AWAITING_CALL_LABEL),
      }),
      comments: [{ body: REFINER_MARKER }],
      routingDoc: ROUTING,
    });
    assert.deepEqual(r.labelsToAdd, []);
    assert.equal(r.comment, null);
    assert.equal(r.idempotent, true);
  });
});

describe('验收 7：不出网，单测毫秒级；CLI 注入假 gh', () => {
  it('dry-run 不打标不评论，但仍产出计划', async () => {
    const { runRefiner } = await CLI;
    const writes = [];
    const runGh = (args) => {
      if (args[1] === 'edit' || args[1] === 'comment') writes.push(args);
      if (args[0] === 'issue' && args[1] === 'list') {
        return {
          ok: true,
          out: JSON.stringify([
            issue(1),
            issue(999, { title: FORK_TITLE, body: FORK_BODY }),
            issue(3, { labels: labels('type/体系') }),
            issue(4, { labels: labels('待消歧') }),
          ]),
        };
      }
      if (args[0] === 'issue' && args[1] === 'view') {
        return { ok: true, out: JSON.stringify({ comments: [] }) };
      }
      return { ok: false, error: args.join(' ') };
    };
    const r = runRefiner({
      args: { dryRun: true },
      runGh,
      say: () => { throw new Error('dry-run 不该推群'); },
      routingDoc: ROUTING,
    });
    assert.equal(r.scanned, true);
    assert.equal(r.exit, 0);
    assert.equal(r.dryRun, true);
    assert.deepEqual(writes, []);
    const byN = Object.fromEntries(r.plans.map((p) => [p.number, p]));
    assert.equal(byN[1].verdict, 'clear');
    assert.equal(byN[999].verdict, 'forks');
    assert.equal(byN[3].verdict, 'skip');
    assert.equal(r.skipped.some((s) => s.number === 4), true);
  });

  it('实跑：clear 打三标；forks 打待拍板+评论；体系零写入', async () => {
    const { runRefiner } = await CLI;
    const { DISAMBIGUATED_LABEL, AWAITING_CALL_LABEL, REFINER_MARKER } = await CORE;
    const edits = [];
    const comments = [];
    const existing = new Set();
    const runGh = (args) => {
      if (args[0] === 'issue' && args[1] === 'list') {
        return {
          ok: true,
          out: JSON.stringify([
            issue(1),
            issue(999, { title: FORK_TITLE, body: FORK_BODY }),
            issue(3, { labels: labels('type/体系'), title: CLEAR_TITLE }),
          ]),
        };
      }
      if (args[0] === 'issue' && args[1] === 'view') {
        return { ok: true, out: JSON.stringify({ comments: [] }) };
      }
      if (args[0] === 'label' && args[1] === 'list') {
        return { ok: true, out: JSON.stringify([...existing].map((name) => ({ name }))) };
      }
      if (args[0] === 'label' && args[1] === 'create') {
        existing.add(args[2]);
        return { ok: true, out: '' };
      }
      if (args[0] === 'issue' && args[1] === 'edit') {
        edits.push(args);
        return { ok: true, out: '' };
      }
      if (args[0] === 'issue' && args[1] === 'comment') {
        comments.push(args);
        return { ok: true, out: '' };
      }
      return { ok: false, error: args.join(' ') };
    };
    const said = [];
    const r = runRefiner({
      args: {},
      runGh,
      say: (t) => { said.push(t); return { ok: true }; },
      routingDoc: ROUTING,
    });
    assert.equal(r.scanned, true);
    assert.equal(r.exit, 0);
    const edit1 = edits.find((a) => a[2] === '1');
    assert.equal(edit1.includes(DISAMBIGUATED_LABEL), true);
    assert.equal(edit1.some((x) => String(x).startsWith('model/')), true);
    assert.equal(edit1.some((x) => String(x).startsWith('reviewer/')), true);
    const edit999 = edits.find((a) => a[2] === '999');
    assert.equal(edit999.includes(AWAITING_CALL_LABEL), true);
    assert.equal(edit999.includes(DISAMBIGUATED_LABEL), false);
    assert.equal(edits.some((a) => a[2] === '3'), false);
    assert.equal(comments.length, 2);
    assert.equal(comments.every((a) => a.includes('--body-file')), true);
    assert.equal(said.length, 1);
    assert.match(said[0], /要你拍/);
    assert.equal(said[0].includes(REFINER_MARKER), false);
  });

  it('hub 文案说人话', async () => {
    const { buildHubText, VERDICT } = await CORE;
    const { plainViolations } = await PLAIN;
    const text = buildHubText([{
      verdict: VERDICT.forks,
      number: 999,
      title: FORK_TITLE,
      comment: 'x',
      recommend: '不造分发器，造检查器',
    }]);
    assert.equal(plainViolations(text).length, 0);
    assert.match(text, /#999/);
  });

  it('--help 退出 0', () => {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'refiner.mjs'), '--help'], {
      encoding: 'utf8', timeout: 5000, windowsHide: true,
    });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /消歧官/);
  });

  it('--as 非法身份 → exit 2，零写入', async () => {
    const { runRefiner } = await CLI;
    const writes = [];
    const r = runRefiner({
      args: { as: 'dao-refiner' },
      runGh: (args) => { writes.push(args); return { ok: true, out: '[]' }; },
      say: () => ({ ok: true }),
      routingDoc: ROUTING,
    });
    assert.equal(r.scanned, false);
    assert.equal(r.exit, 2);
    assert.match(r.error, /不是已装身份/);
    assert.deepEqual(writes, []);
  });
});

describe('选型 JSON 加了消歧角色，通道是 gw/grok-4.6', () => {
  it('工人.消歧 顺位 1 是 grok-4.6 / gw', () => {
    const slot = ROUTING.工人 && ROUTING.工人.消歧 && ROUTING.工人.消歧.模型;
    assert.equal(Array.isArray(slot), true);
    const first = slot.find((m) => m && m.禁用 !== true && m.顺位 === 1);
    assert.equal(first.id, 'grok-4.6');
    assert.equal(first.provider, 'gw');
    assert.equal(first.cli_model, 'gw/grok-4.6');
  });
});

describe('systemd 单元：存在、非 root、有挂钟、装机脚本不 chmod 仓内', () => {
  it('service / timer 在', () => {
    assert.equal(fs.existsSync(SERVICE), true);
    assert.equal(fs.existsSync(TIMER), true);
    assert.equal(fs.existsSync(INSTALL), true);
  });

  it('User=orca，ExecStart 指向 refiner.mjs', () => {
    const s = fs.readFileSync(SERVICE, 'utf8');
    assert.match(s, /^User=orca$/m);
    assert.match(s, /scripts\/refiner\.mjs/);
    assert.equal(/^User=root$/m.test(s), false);
  });

  it('timer 有 OnCalendar 和 Persistent', () => {
    const t = fs.readFileSync(TIMER, 'utf8');
    assert.match(t, /^OnCalendar=/m);
    assert.match(t, /^Persistent=true$/m);
  });

  it('装机脚本不 chmod 仓内、有 dry-run 预演', () => {
    const text = fs.readFileSync(INSTALL, 'utf8');
    const bad = text.split(/\r?\n/).filter((l) => /^\s*chmod\b/.test(l) && /\$(ROOT|\{ROOT\})/.test(l));
    assert.deepEqual(bad, []);
    assert.match(text, /--dry-run/);
    assert.match(text, /OnCalendar/);
  });
});

describe('硬边界：本单不改指挥官三件套、不放宽消歧闸', () => {
  it('commander-core / commander / board-gc 不在本单 diff 里被改（文件仍在）', () => {
    // 本单只新增 + 改 routing JSON。这三条必须仍能被 require/import——
    // 更硬的「git diff 不含它们」在交卷前用 git 核。这里钉文件还在、闸字面量没被放宽。
    const card = fs.readFileSync(path.join(ROOT, 'scripts', 'lib', 'dispatch', 'card.mjs'), 'utf8');
    assert.match(card, /export const DISAMBIGUATED_LABEL = '已消歧'/);
    assert.match(card, /fail-close/);
    assert.equal(fs.existsSync(path.join(ROOT, 'scripts', 'lib', 'commander-core.mjs')), true);
    assert.equal(fs.existsSync(path.join(ROOT, 'scripts', 'commander.mjs')), true);
    assert.equal(fs.existsSync(path.join(ROOT, 'scripts', 'board-gc.mjs')), true);
  });
});
