// 指挥官装机模板（#848）。2026-09-03 实咬：install 写出的 systemd 单元没有 PATH，
// oneshot 拿到的 PATH 只有 /usr/bin:/bin —— commander act 调 orca、hub-say 全 ENOENT
// （派单被 fail-closed 拦下、群通知整轮静默），靠手糊 drop-in 垫片才跑起来。
//
// 判别力：同一把尺（pathVerdict）同时量三份——新模板必须过、实咬那份老模板必须被拦、
// 「写了 PATH 但漏了 ~/.local/bin」也必须被拦（否则这把尺只是在数「有没有 PATH 这个词」）。
const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

const INV = import('file://' + path.join(__dirname, '..', 'scripts', 'lib', 'commander-inventory.mjs').replace(/\\/g, '/'));
const PREFIX = 'Environment=PATH=';

/** 这份 unit 文本跑起来找不找得到 orca / hub-say。回 {ok, why}——不合格时 why 要说清缺什么。 */
function pathVerdict(text, toolDirs) {
  const line = String(text).split(/\r?\n/).find((l) => l.startsWith(PREFIX));
  if (!line) return { ok: false, why: `没有 ${PREFIX} 那一行` };
  const dirs = line.slice(PREFIX.length).split(':').filter(Boolean);
  const missing = Object.entries(toolDirs).filter(([, d]) => !dirs.includes(d)).map(([t, d]) => `${t}(${d})`);
  return missing.length ? { ok: false, why: 'PATH 里缺：' + missing.join('、') } : { ok: true, why: `PATH 带齐 ${dirs.length} 段` };
}

describe('指挥官 systemd 单元模板（#848）', () => {
  it('两个 service 都带 PATH，且 orca / hub-say 的目录都在里面', async () => {
    const { INSTALL_FILES, UNIT_TOOL_DIRS } = await INV;
    const services = Object.entries(INSTALL_FILES()).filter(([p]) => p.endsWith('.service'));
    assert.equal(services.length, 2, '应生成 act + inventory 两个 service：' + services.map(([p]) => p).join(','));
    for (const [p, text] of services) {
      const v = pathVerdict(text, UNIT_TOOL_DIRS);
      assert.ok(v.ok, `${p} 不合格：${v.why}`);
      assert.match(text, /\nExecStart=\/usr\/bin\/node /, 'node 走绝对路径（它不在 ~/.local/bin 里，PATH 管不着）');
      assert.match(text, /\nUser=orca\n/, '仍以 orca 跑——PATH 里那两段是 orca 的家目录');
    }
  });

  it('违规样本：实咬那份没 PATH 的模板，以及漏了 ~/.local/bin 的半吊子，都必须被拦', async () => {
    const { UNIT_TOOL_DIRS } = await INV;
    // 2026-09-03 服务器上真跑的那份（#848 现场原样）
    const before = ['[Unit]', 'Description=指挥官 act', '', '[Service]', 'Type=oneshot', 'User=orca',
      'WorkingDirectory=/srv/projects/windsurf-dao',
      'ExecStart=/usr/bin/node /srv/projects/windsurf-dao/scripts/commander.mjs act', ''].join('\n');
    const v = pathVerdict(before, UNIT_TOOL_DIRS);
    assert.equal(v.ok, false, '没 PATH 的老模板本该被拦——拦不住说明这把尺恒真');
    assert.match(v.why, /没有 Environment=PATH=/);

    const half = before.replace('ExecStart=', `${PREFIX}/usr/local/bin:/usr/bin:/bin\nExecStart=`);
    const hv = pathVerdict(half, UNIT_TOOL_DIRS);
    assert.equal(hv.ok, false, '有 PATH 不等于找得到 orca');
    assert.match(hv.why, /orca/);
  });

  it('UNIT_PATH 与手写单元同一份值（换机改一处不许漏另一处）', async () => {
    const { UNIT_PATH } = await INV;
    // 指针配报警：手写单元的 PATH 行被挪走/删掉，这条当场红，不会指向空气。
    const hand = fs.readFileSync(path.join(__dirname, '..', 'host', 'machine', 'systemd', 'dao-board-gc.service'), 'utf8');
    const line = hand.split(/\r?\n/).find((l) => l.startsWith(PREFIX));
    assert.ok(line, 'host/machine/systemd/dao-board-gc.service 本该有 PATH 行——它没了这条判据就在量空气');
    assert.equal(UNIT_PATH, line.slice(PREFIX.length), '模板与手写单元的 PATH 值不一致，换机会踩同一个坑');
  });

  it('findPathShims：垫片在就报出来，不在就静默（不许恒真也不许恒假）', async () => {
    const { findPathShims } = await INV;
    assert.deepEqual(findPathShims(() => false), [], '没垫片时不许瞎报');
    const all = findPathShims(() => true);
    assert.equal(all.length, 2, '两个单元各一份 drop-in');
    for (const p of all) assert.match(p, /\.service\.d[\\/]path\.conf$/);
    assert.deepEqual(findPathShims((p) => p.includes('commander-act')),
      ['/etc/systemd/system/commander-act.service.d/path.conf'], '在几份报几份');
  });
});
