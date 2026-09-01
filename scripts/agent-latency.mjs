#!/usr/bin/env node
// scripts/agent-latency.mjs —— 给 Claude Code 的一次回复分段计时：本地占几秒、上游占几秒。
//
// 为什么要它（2026-09-01 实咬，两台机各栽一次）：用户报「模型好慢」，两台机都先去查
// 网关、查 Clash、查节点，查了半天才发现请求根本还没发出去——慢在本地 harness 冷启动。
// 网关侧计时里看不到那一段，Mirasim 的 turn timing 也只给一个笼统的 prep。
// 没有分段数字，就只能靠猜，而猜的方向一错就是几个小时。
//
// 分四段（都从进程 spawn 起算，单位 ms）：
//   init      会话就绪 —— CLI 启动 + MCP 握手 + skills/CLAUDE.md/settings 加载
//   msgStart  上游开始回包 —— 请求发出到 message_start，含链路 RTT + 提示词处理
//   firstTok  真·首字 —— 第一个 content_block_delta（thinking 或 text）
//   done      收尾 —— result 事件
//
// 用法：
//   node scripts/agent-latency.mjs                      默认 opus，跑 4 次取中位
//   node scripts/agent-latency.mjs --model sonnet -n 6
//   node scripts/agent-latency.mjs --cwd D:/frank/xxx   在指定项目下测（吃它的 CLAUDE.md/MCP）
//   node scripts/agent-latency.mjs --ab                 额外跑一组「不带 MCP」做对照
//   node scripts/agent-latency.mjs --json               一行 JSON
//
// 三个测量纪律（都是踩出来的，别绕过）：
//  · **stdin 必须关掉**。`claude -p` 没有 TTY 时会等管道输入，干等 3 秒才继续——
//    不关就会凭空多出 3s 并被误判成「本地慢」。本脚本 spawn 时 stdio[0]='ignore'。
//  · **别用 `Measure-Command { <server> --help }` 量单个 MCP**。flag 不识别时 server 会起来
//    等 stdin，量出来是假大数。要量 MCP 就量 `claude mcp list` 的握手耗时。
//  · **报中位不报均值**，且把每次原值一并打出来——上游抖动能到 ±1.5s，均值会把一次
//    离群点糊进结论里，看不出「这条链稳不稳」。
//
// 读数怎么用：init 大 → 本机的事（MCP 没钉本地？见 NEW-MACHINE §13）。
// msgStart+firstTok 大 → 上游的事（模型 / effort / 链路），本机这侧压不动。

import { spawn } from 'node:child_process';

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const arg = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };

if (has('--help') || has('-h')) {
  console.log(`用法: node scripts/agent-latency.mjs [选项]

  --model <名>   传给 claude --model（默认 opus）
  -n <次数>      跑几次取中位（默认 4）
  --cwd <路径>   在哪个目录下测，会吃该项目的 CLAUDE.md / 项目级 MCP（默认当前目录）
  --prompt <字>  测试提示词（默认 "say hi"，要短——这里量的是延迟不是生成）
  --ab           额外跑一组 --strict-mcp-config 空配置做对照，算出 MCP 占了多少
  --json         输出一行 JSON
  --help         本页

分段：init(会话就绪) → msgStart(上游开始回包) → firstTok(真首字) → done(收尾)`);
  process.exit(0);
}

const MODEL = arg('--model', 'opus');
const N = Number(arg('-n', '4'));
const CWD = arg('--cwd', process.cwd());
const PROMPT = arg('--prompt', 'say hi');
const JSON_OUT = has('--json');

/** 跑一次，回收四个时间点 + 这次的 token 账。extra 用来做 A/B。 */
function once(extra = []) {
  return new Promise((res) => {
    const t0 = Date.now();
    const m = {};
    const p = spawn('claude', [
      '-p', PROMPT, '--model', MODEL,
      '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
      ...extra,
    ], {
      cwd: CWD, shell: true,
      // stdin 必须 ignore——见文件头「测量纪律」第一条
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let buf = '', err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let j; try { j = JSON.parse(line); } catch { continue; }
        const dt = Date.now() - t0;
        const ev = j.event?.type || j.type;
        if (j.type === 'system' && j.subtype === 'init' && m.init == null) {
          m.init = dt; m.tools = (j.tools || []).length; m.mcp = (j.mcp_servers || []).length;
        }
        if (ev === 'message_start' && m.msgStart == null) m.msgStart = dt;
        if (ev === 'content_block_delta' && m.firstTok == null) m.firstTok = dt;
        if (j.type === 'result') {
          m.done = dt; m.api = j.duration_api_ms;
          const u = j.usage || {};
          m.ctx = (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
          m.out = u.output_tokens;
        }
      }
    });
    p.on('close', (code) => { m.code = code; m.err = err.trim().slice(0, 200); res(m); });
  });
}

const median = (xs) => {
  const v = xs.filter((x) => x != null).sort((a, b) => a - b);
  return v.length ? v[Math.floor(v.length / 2)] : null;
};

async function series(extra, label) {
  const runs = [];
  for (let i = 0; i < N; i++) runs.push(await once(extra));
  const ok = runs.filter((r) => r.done != null);
  // 一次都没跑成 = 没查成，不许当成 0
  if (!ok.length) return { label, failed: true, err: runs[0]?.err || `exit ${runs[0]?.code}` };
  return {
    label, runs: ok,
    init: median(ok.map((r) => r.init)),
    msgStart: median(ok.map((r) => r.msgStart)),
    firstTok: median(ok.map((r) => r.firstTok)),
    done: median(ok.map((r) => r.done)),
    ctx: median(ok.map((r) => r.ctx)),
    tools: ok[0].tools, mcp: ok[0].mcp,
  };
}

const main = await series([], `${MODEL} · ${N} 次`);
if (main.failed) {
  console.error(`✗ 一次都没跑成（≠ 快）：${main.err}`);
  process.exit(2);
}

let ab = null;
if (has('--ab')) {
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const f = join(mkdtempSync(join(tmpdir(), 'al-')), 'nomcp.json');
  writeFileSync(f, JSON.stringify({ mcpServers: {} }));
  ab = await series(['--strict-mcp-config', '--mcp-config', f], '对照：不带 MCP');
}

if (JSON_OUT) {
  const slim = (r) => r && !r.failed && { init: r.init, msgStart: r.msgStart, firstTok: r.firstTok, done: r.done, ctx: r.ctx, tools: r.tools, mcp: r.mcp };
  console.log(JSON.stringify({ model: MODEL, n: N, cwd: CWD, main: slim(main), ab: slim(ab) }));
  process.exit(0);
}

const ms = (x) => `${String(x).padStart(5)}ms`;
console.log(`\n${MODEL} · ${N} 次 · ${CWD}`);
console.log(`MCP ${main.mcp} 个 / 工具 ${main.tools} 个 / 上下文 ${main.ctx} tok\n`);
console.log('  每次原值（中位在下面；抖动大说明链路不稳，别只看中位）：');
for (const r of main.runs) {
  console.log(`    init=${ms(r.init)} msgStart=${ms(r.msgStart)} 首字=${ms(r.firstTok)} 收尾=${ms(r.done)}  out=${r.out}tok`);
}
const seg = [
  ['本地会话就绪（CLI+MCP+skills）', main.init],
  ['发请求 → 上游首包', main.msgStart - main.init],
  ['上游首包 → 真首字（思考）', main.firstTok - main.msgStart],
  ['首字 → 收尾（生成）', main.done - main.firstTok],
];
console.log('\n  分段中位：');
for (const [k, v] of seg) console.log(`    ${k.padEnd(30)} ${ms(v)}`);
console.log(`    ${'首字'.padEnd(30)} ${ms(main.firstTok)}   全程 ${ms(main.done)}`);
const localPct = Math.round((main.init / main.firstTok) * 100);
console.log(`\n  init 占首字 ${localPct}%。` +
  (localPct >= 35 ? '本地启动就是大头，先去 NEW-MACHINE §13 把 MCP 钉本地。'
                  : '启动不是大头，但别急着判给网络：'));
console.log('  「发请求→上游首包」两边都占——它 = 链路 RTT + 上游处理提示词，而提示词多大是本机决定的。');
console.log(`  本次 ${main.tools} 个工具 / ${main.ctx} tok。想知道 MCP 在这段里占多少，加 --ab（n≥5）。`);

if (ab && !ab.failed) {
  console.log(`\n  对照（不带 MCP）：init ${ms(ab.init)} 首字 ${ms(ab.firstTok)} 上下文 ${ab.ctx} tok`);
  console.log(`    MCP 的代价：init +${main.init - ab.init}ms，上下文 +${main.ctx - ab.ctx} tok，` +
    `首字 ${main.firstTok - ab.firstTok >= 0 ? '+' : ''}${main.firstTok - ab.firstTok}ms`);
  console.log('    首字那笔比 init 大：多出来的工具定义即便全是 cache_read，上游读它照样要时间。');
  if (N < 4) console.log(`    ⚠ n=${N} 太小，上游抖动会把这个差值淹掉（本机 n=3 测出 +60ms，n=5 测出 +1614ms）——要下结论至少 n=5。`);
}
