// 起 agent 的命令必须来自路由表，不许手拼（2026-09-05 实咬：手拼 4 次错 3 次，两臂 503 空转，
// 我还据此误判成「网关故障」差点开假单）。真值都在 docs/model-routing.json，现成入口是
// `node scripts/dao.mjs start --model <id> --dry-run`。
//
// 这道闸守两件事：
// ① design-exam skill 里那条指针**真能跑**——文档指向一个改了名或删了的命令，比没写更糟；
// ② 仓内不出现手写的 `pi --model <前缀>/<模型>` 字面量（当前 0 处，本条防的是未来被固化进来）。
//
// 边界（诚实说明）：它拦不住临时敲在终端里的手拼——那个只能靠 skill 里有现成命令可抄来改变路径。
// 本闸拦的是「把错误写法固化进仓/文档」，那是更持久的危害。
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..');
const SKILL = path.join(REPO, 'host/skills/design-exam/SKILL.md');

describe('起 agent 的命令来自路由表，不手拼', () => {
  it('① design-exam 的指针真能跑，且给出的通道与路由表一致', () => {
    const md = fs.readFileSync(SKILL, 'utf8');
    assert.match(md, /dao\.mjs start --model .* --dry-run/, 'skill 必须给出现成入口，否则下一个人还得自己构造');

    const r = spawnSync(process.execPath, [
      path.join(REPO, 'scripts/dao.mjs'), 'start', '--model', 'grok-4.6', '--dry-run',
    ], { encoding: 'utf8', cwd: REPO, timeout: 60000, windowsHide: true });

    assert.equal(r.status, 0, `指针命令跑不通（exit ${r.status}）——文档指向空气比没写更糟：${r.stderr || ''}`);
    const last = String(r.stdout || '').trim().split(/\r?\n/).pop();
    let out;
    try { out = JSON.parse(last); }
    catch { assert.fail(`指针命令没返回 JSON：${last.slice(0, 200)}`); }
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.ok(out.command, '必须给出 command 字段（skill 让人照抄的就是它）');

    // 与路由表交叉核：命令里的 cli 模型必须等于表里登记的那个，不是别处归纳出来的
    const routing = JSON.parse(fs.readFileSync(path.join(REPO, 'docs/model-routing.json'), 'utf8'));
    const found = [];
    (function walk(o) {
      if (Array.isArray(o)) return o.forEach(walk);
      if (o && typeof o === 'object') {
        if (o.id === 'grok-4.6' && o.cli_model) found.push(o.cli_model);
        Object.values(o).forEach(walk);
      }
    })(routing);
    assert.ok(found.length > 0, 'grok-4.6 在路由表里没有 cli_model——这是没查成，不是「查过没有」');
    assert.ok(out.command.includes(found[0]),
      `命令里的通道与路由表对不上：命令=${out.command} / 表=${found[0]}`);
  });

  it('② 判别力：不在路由表的模型必须当场报错，不许猜一个前缀', () => {
    const r = spawnSync(process.execPath, [
      path.join(REPO, 'scripts/dao.mjs'), 'start', '--model', 'no-such-model-xyz', '--dry-run',
    ], { encoding: 'utf8', cwd: REPO, timeout: 60000, windowsHide: true });
    assert.notEqual(r.status, 0, '不存在的模型必须失败退出');
    assert.match(String(r.stdout) + String(r.stderr), /不在路由表/, '要点名说清是「不在路由表」');
  });

  it('③ 仓内不出现手写的 pi --model <前缀>/<模型> 字面量', () => {
    const dirs = ['host', 'scripts', 'docs'];
    const bad = [];
    let scanned = 0;
    const walk = (dir) => {
      for (const name of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, name.name);
        if (name.isDirectory()) { walk(p); continue; }
        if (!/\.(md|mjs|js)$/.test(name.name)) continue;
        const rel = path.relative(REPO, p).replace(/\\/g, '/');
        if (rel.includes('model-routing')) continue;      // 路由表自己就是真相源
        if (rel.startsWith('tests/')) continue;            // 夹具与本文件
        scanned += 1;
        const src = fs.readFileSync(p, 'utf8');
        src.split('\n').forEach((line, i) => {
          if (line.trim().startsWith('//') || line.trim().startsWith('#')) return;
          const m = line.match(/pi --model [a-z0-9-]+\/[a-z0-9.-]+/i);
          if (m) bad.push(`${rel}:${i + 1}  ${m[0]}`);
        });
      }
    };
    dirs.forEach((d) => walk(path.join(REPO, d)));
    assert.ok(scanned >= 50, `只扫到 ${scanned} 个文件——扫描面可能挪了，这是「没查成」不是「查过没事」`);
    assert.deepEqual(bad, [],
      `发现手写的启动命令，应改用 dao.mjs start --model <id> --dry-run 取：\n  ${bad.join('\n  ')}`);
  });
});
