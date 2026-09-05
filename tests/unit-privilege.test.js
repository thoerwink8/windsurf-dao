// systemd 单元不许以 root 解释仓里的脚本（2026-09-05 实咬）。
//
// dao-sync.service 原来没写 User=，systemd 默认 root，而它 ExecStart 的
// /home/orca/windsurf-dao/scripts/server-sync.sh 躺在 orca 可写的 checkout 里
// （实测 -rw-rw-r-- orca orca）。每一个工人 agent 都能写那个仓，改一行脚本，
// 等 5 分钟定时器一响就是 root。当时另外 6 个单元全都写了 User=orca，只有这一个漏了——
// 「大家都写了」正是它一直没被发现的原因。
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const DIR = path.join(__dirname, '..', 'host', 'machine', 'systemd');
// 仓的部署落点。ExecStart 指进这里 = 那个文件是 orca（以及每个 agent）可写的。
const CHECKOUT = '/home/orca/windsurf-dao';

function units() {
  return fs.readdirSync(DIR).filter((f) => f.endsWith('.service'))
    .map((f) => ({ name: f, text: fs.readFileSync(path.join(DIR, f), 'utf8') }));
}

describe('systemd 单元的权限边界', () => {
  it('扫得到单元——扫出 0 个就是判据失效，不是通过', () => {
    assert.ok(units().length > 0, '一个 .service 都没扫到，本闸已经不在查任何东西');
  });

  it('以 root 跑的单元，不许 ExecStart 仓里的文件', () => {
    const bad = [];
    for (const u of units()) {
      const user = (u.text.match(/^User=(.+)$/m) || [])[1];
      const execs = [...u.text.matchAll(/^ExecStart=(.+)$/gm)].map((m) => m[1]);
      const isRoot = !user || user.trim() === 'root';
      if (!isRoot) continue;
      if (execs.some((e) => e.includes(CHECKOUT))) bad.push(u.name);
    }
    assert.deepEqual(bad, [],
      `这些单元以 root 解释仓内脚本，能写仓的 agent 借定时器就能提权：${bad.join('、')}\n`
      + '修法：给单元加 User=orca，真正要 root 的那一条命令走 /etc/sudoers.d 白名单');
  });

  it('每个单元都显式写了 User=——不写就是 root，而「忘了写」和「故意 root」长得一样', () => {
    const missing = units().filter((u) => !/^User=/m.test(u.text)).map((u) => u.name);
    assert.deepEqual(missing, [], `缺 User= 的单元：${missing.join('、')}`);
  });

  it('sudoers 白名单必须写死命令，不带通配——通配等于没收窄', () => {
    const f = path.join(__dirname, '..', 'host', 'machine', 'sudoers.d', 'dao-sync');
    assert.ok(fs.existsSync(f), 'sudoers 白名单文件不在——dao-sync 重启机器人那一步会静默失败');
    const rules = fs.readFileSync(f, 'utf8').split(/\r?\n/)
      .filter((l) => l.trim() && !l.trim().startsWith('#'));
    assert.ok(rules.length > 0, '白名单里一条规则都没有——扫出 0 条不算通过');
    for (const r of rules) {
      assert.ok(!/[*?]/.test(r), `规则里有通配符，等于没收窄：${r}`);
      assert.match(r, /NOPASSWD:\s*\/[^\s]+/, `规则要给绝对路径的命令：${r}`);
      assert.ok(!/\/home\//.test(r),
        `白名单不许指向家目录里的东西——那正是可写的地方，收窄就白收了：${r}`);
    }
  });
});
