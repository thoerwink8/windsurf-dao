// 跨机账本汇聚（按需拉取）：合并 / 去重 / 排序 / 冲突判定的判别力，issue #891 期二。
// 纯函数层不碰网不碰真账本；落盘层用假 ssh 执行器 + 临时目录，断言幂等与「同名不覆盖」。
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 这两条字面量引用是给 dao-check ㉖（孤儿测试闸）当报警器的：
// ledger-home.mjs 头注与 host/machine/INDEX.md 都指着它们，落点被挪走/删掉这里当场红。
const LIB_PATH = path.join(__dirname, '..', 'scripts', 'lib', 'ledger-sync.mjs');
const CLI_PATH = path.join(__dirname, '..', 'scripts', 'ledger-sync.mjs');

const url = p => 'file://' + path.join(__dirname, '..', 'scripts', 'lib', p).replace(/\\/g, '/');
const SYNC = import(url('ledger-sync.mjs'));
const WRITER = import(url('event-writer.mjs'));
const SCHEMA = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'schemas', 'events.schema.json'), 'utf8'));

const NAME_A = '01M00DA3KG6KVJBXVSYEE1T5XR-alpha.json';
const NAME_B = '01M00FCCPGKT99Z4BGFQ9ZC2EE-beta.json';

function ev(over = {}) {
  return {
    type: 'incident',
    schema_version: 1,
    ts: '2026-09-04T10:00:00+08:00',
    machine: 'alpha',
    seq: 3,
    event_id: 'e-alpha-3',
    summary: '样本',
    ...over,
  };
}
const pretty = e => JSON.stringify(e, null, 2) + '\n';

/** 假 ssh：按远端脚本里的哨兵判断问的是列表还是内容，用一份 name→text 的假远端账本作答。
 *  故意不复用被测的解析函数——自己 base64、自己拼哨兵头尾行。 */
function fakeSsh(remote, { noDir = false, truncate = false, noSentinel = false, noRead = false, listCode = 0, listTruncate = false, bundleCode = 0, dropMiss = false } = {}) {
  const calls = [];
  const run = (cmd, args, opts = {}) => {
    calls.push({ cmd, args, input: opts.input });
    const script = args[args.length - 1];
    if (noDir) return { probed: true, code: 3, stdout: 'DAO_LEDGER_NODIR\n', stderr: '' };
    if (noRead) return { probed: true, code: 5, stdout: 'DAO_LEDGER_NOREAD\n', stderr: '' };
    if (noSentinel) return { probed: true, code: 255, stdout: '', stderr: 'ssh: connect timed out' };
    if (script.includes('DAO_LEDGER_LIST')) {
      const names = [...remote.keys()];
      if (listTruncate) return { probed: true, code: listCode, stdout: 'DAO_LEDGER_LIST v1\n', stderr: 'client_loop: send disconnect' };
      return {
        probed: true,
        code: listCode,
        stdout: 'DAO_LEDGER_LIST v1\n' + names.map(n => n + '\n').join('') + `DAO_LEDGER_LIST_END ${names.length}\n`,
        stderr: listCode ? 'ls: I/O error on one entry' : '',
      };
    }
    const want = String(opts.input || '').split('\n').filter(Boolean);
    let body = '';
    let n = 0;
    for (const f of want) {
      if (!remote.has(f)) {
        if (!dropMiss) body += `MISS ${f}\n`; // dropMiss：既不回内容也不回 MISS，模拟名单没送到
        continue;
      }
      body += `${f} ${Buffer.from(remote.get(f), 'utf8').toString('base64')}\n`;
      n += 1;
    }
    const tail = truncate ? `DAO_LEDGER_BUNDLE_END ${n + 1}\n` : `DAO_LEDGER_BUNDLE_END ${n}\n`;
    return { probed: true, code: bundleCode, stdout: 'DAO_LEDGER_BUNDLE v1\n' + body + tail, stderr: bundleCode ? 'base64: write error' : '' };
  };
  return { run, calls };
}

describe('ledger-sync 纯函数：名字与判等', () => {
  it('文件名只认 <ulid>-<machine>.json；索引/临时件不当事件', async () => {
    const S = await SYNC;
    assert.deepStrictEqual(S.parseEventName(NAME_A), { ulid: '01M00DA3KG6KVJBXVSYEE1T5XR', machine: 'alpha' });
    assert.strictEqual(S.parseEventName('.dispatch-index'), null, '.dispatch-index 不是事件');
    assert.strictEqual(S.parseEventName('01M00DA3KG6KVJBXVSYEE1T5XR-alpha.json.tmp-9-ab'), null, '临时件不是事件');
    assert.strictEqual(S.parseEventName('short-alpha.json'), null, 'ULID 位数不够不是事件');
    assert.strictEqual(S.parseEventName('01I00DA3KG6KVJBXVSYEE1T5XR-alpha.json'), null, 'Crockford 不含 I');
    assert.strictEqual(S.parseEventName('01M00DA3KG6KVJBXVSYEE1T5XR-../../outside.json'), null, '含 ../ 不是事件（路径逃逸）');
    assert.strictEqual(S.parseEventName('01M00DA3KG6KVJBXVSYEE1T5XR-..\\outside.json'), null, '含 ..\\ 不是事件');
  });

  it('判等按规范化 JSON，不按字节：CRLF/LF、键序、缩进都不算不同', async () => {
    const S = await SYNC;
    const lf = pretty(ev());
    const crlf = lf.replace(/\n/g, '\r\n');
    const r1 = S.sameEvent(crlf, lf);
    assert.ok(r1.decided && r1.same, 'CRLF 与 LF 是同一事件（种子是 git 检出的 CRLF，服务器是 LF）');
    const reordered = JSON.stringify({ event_id: 'e-alpha-3', seq: 3, machine: 'alpha', ts: '2026-09-04T10:00:00+08:00', schema_version: 1, type: 'incident', summary: '样本' });
    const r2 = S.sameEvent(reordered, lf);
    assert.ok(r2.decided && r2.same, '键序不同仍是同一事件');
    const r3 = S.sameEvent(pretty(ev({ summary: '改过了' })), lf);
    assert.ok(r3.decided && r3.same === false, '内容真不同要判成不同');
  });

  it('拿不到身份就不许判等（坏 JSON / 缺骨架字段 / 不是对象）', async () => {
    const S = await SYNC;
    assert.strictEqual(S.eventIdentity('{坏 JSON').ok, false, '坏 JSON 没身份');
    assert.strictEqual(S.eventIdentity('[1,2]').ok, false, '数组不是事件对象');
    const noSeq = S.eventIdentity(JSON.stringify({ type: 'incident', ts: '2026-09-04T10:00:00+08:00', machine: 'a', event_id: 'x' }));
    assert.strictEqual(noSeq.ok, false, '缺 seq（全序键的一维）没身份');
    assert.match(noSeq.why, /seq/, '说清缺哪个字段');
    const undecided = S.sameEvent('{坏', pretty(ev()));
    assert.strictEqual(undecided.decided, false, '判不了 ≠ 相同');
  });

  it('内容决定名：event-writer 真写一个事件，反推名字对得上；改一个字段名字就变', async () => {
    const S = await SYNC;
    const W = await WRITER;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ls-name-'));
    const { path: p, event } = W.writeEvent({
      dir, type: 'incident', ts: '2026-09-04T10:00:00+08:00', machine: 'alpha', seq: 0,
      payload: { fingerprint: 'ls-name-fixture', disposition: '记账', why: '名字由内容决定' }, schema: SCHEMA,
    });
    assert.strictEqual(S.expectedEventName(event), path.basename(p), '反推名字 == 真文件名');
    assert.notStrictEqual(S.expectedEventName({ ...event, seq: 1 }), path.basename(p), '改一个字段名字必须变');
    assert.strictEqual(S.expectedEventName({ ...event, ts: '不是时间' }), null, '时间解不开就不硬猜名字');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('ledger-sync 纯函数：计划 / 合并 / 冲突 / 排序', () => {
  it('拉取计划 = 远端 ∖ 本机；非事件名不拉；--verify 连同名的也拉', async () => {
    const S = await SYNC;
    const plan = S.planFetch({ localNames: [NAME_A], remoteNames: [NAME_A, NAME_B, '.dispatch-index'] });
    assert.deepStrictEqual(plan.fetch, [NAME_B], '只拉本机没有的');
    assert.deepStrictEqual(plan.skip, [NAME_A], '同名进跳过');
    assert.deepStrictEqual(plan.ignored, ['.dispatch-index'], '非事件名点名但不拉');
    const v = S.planFetch({ localNames: [NAME_A], remoteNames: [NAME_A, NAME_B], verify: true });
    assert.deepStrictEqual(v.fetch, [NAME_A, NAME_B].sort(), '--verify 全拉回来比内容');
    assert.deepStrictEqual(v.skip, [], '--verify 下没有「不取内容就跳过」');
  });

  it('同名不同内容 = 冲突（必须报出来，不能当同一事件跳过）', async () => {
    const S = await SYNC;
    const mine = pretty(ev({ summary: '本机版' }));
    const theirs = pretty(ev({ summary: '远端版' }));
    const r = S.classifyIncoming({ name: NAME_A, text: theirs, localText: mine });
    assert.strictEqual(r.action, 'conflict', '同名不同内容判冲突');
    assert.match(r.why, /改过历史/, '说清冲突意味着什么');
    assert.notStrictEqual(r.fingerprint, r.localFingerprint, '两边指纹都算出来，便于人核');
    const same = S.classifyIncoming({ name: NAME_A, text: pretty(ev()).replace(/\n/g, '\r\n'), localText: pretty(ev()) });
    assert.strictEqual(same.action, 'skip', '同名同内容（换行不同）跳过，不算冲突');
    const fresh = S.classifyIncoming({ name: NAME_B, text: pretty(ev({ machine: 'beta', event_id: 'e-beta' })) });
    assert.strictEqual(fresh.action, 'add', '本机没有就新增');
  });

  it('进不了账的一律 reject，不写盘：名字非法 / 坏 JSON / 同名文件本机已损坏', async () => {
    const S = await SYNC;
    assert.strictEqual(S.classifyIncoming({ name: 'weird.json', text: pretty(ev()) }).action, 'reject', '名字非法不进账');
    assert.strictEqual(S.classifyIncoming({ name: NAME_A, text: '{坏' }).action, 'reject', '坏 JSON 不进账');
    const r = S.classifyIncoming({ name: NAME_A, text: pretty(ev()), localText: '{本机这个文件坏了' });
    assert.strictEqual(r.action, 'reject', '比不了就不许当相同、也不许当冲突');
    assert.match(r.why, /比不了/, '说清是没查成');
  });

  it('合并一批：四类计数分开；同批重复同名只新增一次', async () => {
    const S = await SYNC;
    const localTexts = new Map([[NAME_A, pretty(ev({ summary: '本机版' }))]]);
    const incoming = [
      { name: NAME_A, text: pretty(ev({ summary: '远端版' })) },
      { name: NAME_B, text: pretty(ev({ machine: 'beta', event_id: 'e-beta' })) },
      { name: NAME_B, text: pretty(ev({ machine: 'beta', event_id: 'e-beta' })) },
      { name: 'nope', text: pretty(ev()) },
    ];
    const m = S.mergeIncoming({ localTexts, incoming });
    assert.strictEqual(m.counts.added, 1, '只新增一个（同批第二次同名不再加）');
    assert.strictEqual(m.counts.skipped, 1, '同批重复的第二件按跳过算');
    assert.strictEqual(m.counts.conflicts, 1, '一件冲突');
    assert.strictEqual(m.counts.rejected, 1, '一件进不了账');
    assert.strictEqual(m.added[0].name, NAME_B, '新增的是本机没有的那个');
  });

  it('名字与内容对不上只报 suspect，不拦（就地脱敏过的老事件本机实测有 1 个）', async () => {
    const S = await SYNC;
    const m = S.mergeIncoming({ incoming: [{ name: NAME_A, text: pretty(ev()) }] });
    assert.strictEqual(m.counts.added, 1, '照样进账');
    assert.strictEqual(m.suspects.length, 1, '但要点名');
    assert.match(m.suspects[0].why, /内容应叫/, '给出内容反推的名字');
  });

  it('全序排序键 (ts, machine, seq, event_id) 四级都要真起作用', async () => {
    const S = await SYNC;
    const mk = (ts, machine, seq, event_id) => ({ ts, machine, seq, event_id });
    const src = [
      mk('2026-09-04T10:00:00+08:00', 'beta', 1, 'b'),
      mk('2026-09-04T10:00:00+08:00', 'alpha', 2, 'x'),
      mk('2026-09-03T10:00:00+08:00', 'zeta', 9, 'z'),
      mk('2026-09-04T10:00:00+08:00', 'alpha', 2, 'a'),
      mk('2026-09-04T10:00:00+08:00', 'alpha', 10, 'c'),
    ];
    const got = S.sortEvents(src).map(e => `${e.ts}|${e.machine}|${e.seq}|${e.event_id}`);
    assert.deepStrictEqual(got, [
      '2026-09-03T10:00:00+08:00|zeta|9|z',
      '2026-09-04T10:00:00+08:00|alpha|2|a',
      '2026-09-04T10:00:00+08:00|alpha|2|x',
      '2026-09-04T10:00:00+08:00|alpha|10|c',
      '2026-09-04T10:00:00+08:00|beta|1|b',
    ], 'ts 先、machine 次、seq 再（数值不是字符串）、event_id 兜底');
    assert.notStrictEqual(S.sortEvents(src), src, '排序不改入参数组');
  });
});

describe('ledger-sync 远端命令与解析', () => {
  it('远端目录：~ 交给远端 $HOME 展开；字面量单引号包住；注入字符当场拒', async () => {
    const S = await SYNC;
    assert.strictEqual(S.remoteDirExpr(), '"$HOME/.dao/ledger/events"', '默认走远端 $HOME');
    assert.strictEqual(S.remoteDirExpr('/srv/ledger'), "'/srv/ledger'", '绝对路径单引号包住');
    assert.strictEqual(S.shQuote("a'b"), "'a'\\''b'", '单引号自身要转义');
    assert.throws(() => S.remoteDirExpr('~/$(rm -rf /)'), /不许出现的字符/, '注入面当场拒');
  });

  it('列表解析：0 条与没查成分得开；头行、尾行、尾行条数三道都得过', async () => {
    const S = await SYNC;
    const empty = S.parseRemoteList('DAO_LEDGER_LIST v1\nDAO_LEDGER_LIST_END 0\n');
    assert.ok(!empty.unscanned && empty.names.length === 0, '头尾哨兵都在、0 条 = 查过是空的');
    const gone = S.parseRemoteList('DAO_LEDGER_NODIR\n');
    assert.ok(gone.unscanned && /目录不在/.test(gone.error), '目录不在 = 没查成');
    const noRead = S.parseRemoteList('DAO_LEDGER_NOREAD\n');
    assert.ok(noRead.unscanned && /读不了/.test(noRead.error), '目录没权限 = 没查成，不是 0 条');
    const dead = S.parseRemoteList('');
    assert.ok(dead.unscanned && /没吐哨兵/.test(dead.error), '空输出 = 没查成，不是 0 条');
    // 审官 P1①：吐了头行就断线——旧协议这里会当成「远端 0 条」，静默漏事件
    const headOnly = S.parseRemoteList('DAO_LEDGER_LIST v1\n');
    assert.ok(headOnly.unscanned && /没尾行哨兵/.test(headOnly.error), '只有头行 = 流被截断，不是 0 条');
    const short = S.parseRemoteList(`DAO_LEDGER_LIST v1\n${NAME_A}\nDAO_LEDGER_LIST_END 2\n`);
    assert.ok(short.unscanned && /尾行说 2 个、实收 1 个/.test(short.error), '尾行条数对不上 = 列表不完整');
    const after = S.parseRemoteList(`DAO_LEDGER_LIST v1\nDAO_LEDGER_LIST_END 0\n${NAME_A}\n`);
    assert.ok(after.unscanned && /尾行之后还有内容/.test(after.error), '尾行之后还有行 = 协议乱了');
    const two = S.parseRemoteList(`Warning: something\nDAO_LEDGER_LIST v1\n${NAME_A}\n${NAME_B}\nDAO_LEDGER_LIST_END 2\n`);
    assert.deepStrictEqual(two.names, [NAME_A, NAME_B], '哨兵之前的噪声行不算名字');
  });

  it('列表脚本不用 `ls | grep || true`（那个写法把列举错误吞成空列表）', async () => {
    const S = await SYNC;
    const script = S.remoteListScript();
    assert.ok(!/\|\|\s*true/.test(script), '脚本里不许有 `|| true` 这种吞错误的尾巴');
    assert.match(script, /DAO_LEDGER_NOREAD/, '先验目录可读可进（不可读时 glob 会退化成字面量，像空目录）');
    assert.match(script, /DAO_LEDGER_LIST_END/, '列表要有尾行条数哨兵');
  });

  it('内容流解析：解码、MISS、截断（尾行条数对不上）都判得出', async () => {
    const S = await SYNC;
    const text = pretty(ev());
    const b64 = Buffer.from(text, 'utf8').toString('base64');
    const good = S.parseRemoteBundle(`DAO_LEDGER_BUNDLE v1\n${NAME_A} ${b64}\nMISS ${NAME_B}\nDAO_LEDGER_BUNDLE_END 1\n`);
    assert.ok(!good.unscanned, '正常流查得成');
    assert.strictEqual(good.files[0].text, text, '解码后与原文逐字节一致');
    assert.deepStrictEqual(good.missing, [NAME_B], '列了却取不到的点名');
    const cut = S.parseRemoteBundle(`DAO_LEDGER_BUNDLE v1\n${NAME_A} ${b64}\nDAO_LEDGER_BUNDLE_END 2\n`);
    assert.ok(cut.unscanned && /截断/.test(cut.error), '尾行说 2 实收 1 = 流被截断');
    const noTail = S.parseRemoteBundle(`DAO_LEDGER_BUNDLE v1\n${NAME_A} ${b64}\n`);
    assert.ok(noTail.unscanned && /没尾行/.test(noTail.error), '没尾行 = 没查成');
  });

  it('分批：名单走 stdin，不进 argv', async () => {
    const S = await SYNC;
    assert.deepStrictEqual(S.chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]], '按批切');
    assert.deepStrictEqual(S.chunk([], 2), [], '空名单不发请求');
    assert.deepStrictEqual(S.chunk([1, 2], 0), [[1], [2]], '批量 0 不许死循环');
  });
});

describe('ledger-sync 落盘：真写、幂等、不覆盖', () => {
  it('写一件读回自证；已存在一律不覆盖', async () => {
    const S = await SYNC;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ls-write-'));
    const text = pretty(ev());
    const w = S.writeIncoming({ dir, name: NAME_A, text });
    assert.ok(w.ok && w.event_id === 'e-alpha-3', '写完从盘上读回来核 event_id');
    assert.strictEqual(fs.readFileSync(path.join(dir, NAME_A), 'utf8'), text, '落盘内容逐字节等于来件');
    const again = S.writeIncoming({ dir, name: NAME_A, text });
    assert.ok(!again.ok && /不覆盖/.test(again.why), '已存在不覆盖（不可变律）');
    assert.strictEqual(fs.readdirSync(dir).filter(f => f.endsWith('.tmp')).length, 0, '不留临时残件');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('按需拉取：首拉新增 N、复跑新增 0（幂等）、冲突不动本机文件', async () => {
    const S = await SYNC;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ls-pull-'));
    const remote = new Map([
      [NAME_A, pretty(ev())],
      [NAME_B, pretty(ev({ machine: 'beta', event_id: 'e-beta', seq: 1 }))],
      ['.dispatch-index', '{"v":1}'],
    ]);
    const first = S.pullFromHost({ host: 'fake', localDir: dir, run: fakeSsh(remote).run });
    assert.strictEqual(first.counts.added, 2, '首拉新增 2');
    assert.strictEqual(first.counts.skipped, 0, '首拉没有可跳的');
    assert.deepStrictEqual(first.ignored, ['.dispatch-index'], '索引文件不拉');
    assert.ok(first.added.every(a => fs.existsSync(a.path)), '新增的文件真在盘上');

    const second = S.pullFromHost({ host: 'fake', localDir: dir, run: fakeSsh(remote).run });
    assert.strictEqual(second.counts.added, 0, '复跑新增 0（幂等）');
    assert.strictEqual(second.counts.skipped, 2, '复跑跳过 2');
    assert.strictEqual(S.verdict([second]).code, 0, '幂等复跑是绿');

    const fake = fakeSsh(remote);
    const dry = S.pullFromHost({ host: 'fake', localDir: dir, run: fake.run, verify: true });
    assert.strictEqual(dry.counts.conflicts, 0, '--verify 下内容一致，无冲突');
    assert.strictEqual(dry.counts.skipped, 2, '--verify 下逐个比过内容才算跳过');
    assert.ok(fake.calls.some(c => String(c.input || '').includes(NAME_A)), '--verify 真把同名的也取回来了');

    // 远端改了同名事件的内容 = 有一边改过历史：必须报冲突，且不许动本机那份
    const tampered = new Map(remote);
    tampered.set(NAME_A, pretty(ev({ summary: '远端被改过' })));
    const before = fs.readFileSync(path.join(dir, NAME_A), 'utf8');
    const clash = S.pullFromHost({ host: 'fake', localDir: dir, run: fakeSsh(tampered).run, verify: true });
    assert.strictEqual(clash.counts.conflicts, 1, '同名不同内容报冲突');
    assert.strictEqual(fs.readFileSync(path.join(dir, NAME_A), 'utf8'), before, '本机那份一个字节都没动');
    assert.strictEqual(S.verdict([clash]).code, 1, '冲突是真红 exit 1');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('探不到的三种形态都判「没查成」，不判绿也不判红', async () => {
    const S = await SYNC;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ls-un-'));
    const remote = new Map([[NAME_A, pretty(ev())]]);
    const noDir = S.pullFromHost({ host: 'fake', localDir: dir, run: fakeSsh(remote, { noDir: true }).run });
    assert.ok(noDir.unscanned.length === 1 && /目录不在/.test(noDir.unscanned[0]), '远端目录不在 = 没查成');
    const dead = S.pullFromHost({ host: 'fake', localDir: dir, run: fakeSsh(remote, { noSentinel: true }).run });
    assert.ok(dead.unscanned.length === 1 && /没吐哨兵/.test(dead.unscanned[0]), 'ssh 连不上 = 没查成');
    const cut = S.pullFromHost({ host: 'fake', localDir: dir, run: fakeSsh(remote, { truncate: true }).run });
    assert.ok(cut.unscanned.length === 1 && /截断/.test(cut.unscanned[0]), '流截断 = 没查成');
    assert.strictEqual(fs.readdirSync(dir).length, 0, '没查成时一个字节都别落盘');
    assert.strictEqual(S.verdict([cut]).code, 2, '没查成 exit 2');
    const spawnFail = S.pullFromHost({ host: 'fake', localDir: dir, run: () => ({ probed: false, reason: 'ENOENT' }) });
    assert.ok(/没跑成/.test(spawnFail.unscanned[0]), '连 ssh 都没起来也是没查成');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('命令入口在、参数缺了报用法（不静默当成功）', () => {
    assert.ok(fs.existsSync(LIB_PATH), '判据落点在：scripts/lib/ledger-sync.mjs');
    assert.ok(fs.existsSync(CLI_PATH), '命令入口在：scripts/ledger-sync.mjs');
    const bare = spawnSync(process.execPath, [CLI_PATH], { encoding: 'utf8' });
    assert.strictEqual(bare.status, 3, '不给参数 = 用法错 exit 3（不是 0，也不是「拉过了」）');
    assert.match(bare.stdout, /--from/, '用法里点名 --from');
    const noFrom = spawnSync(process.execPath, [CLI_PATH, '--verify'], { encoding: 'utf8' });
    assert.strictEqual(noFrom.status, 3, '有别的参数但没 --from 也是用法错');
    assert.match(noFrom.stderr, /--from/, '错在哪说清楚');
  });

  it('三态判决：真红优先于没查成（红必须处置）', async () => {
    const S = await SYNC;
    const base = S.emptyResult({ host: 'x' });
    assert.strictEqual(S.verdict([base]).code, 0, '什么都没有 = 绿');
    assert.strictEqual(S.verdict([{ ...base, rejected: [{}] }]).code, 2, '有进不了账的 = 没查成');
    assert.strictEqual(S.verdict([{ ...base, conflicts: [{}], unscanned: ['x'] }]).code, 1, '红与没查成同时在 → 报红');
    assert.strictEqual(S.verdict([{ ...base, writeFailures: [{}] }]).code, 1, '写不进 = 真红');
  });
});

// ── 审官 #899 三条：同一种病的三个位置——「没查成」被当成「没有/成功」 ────────
describe('ledger-sync：不完整一律 fail-closed（审官 #899）', () => {
  const remoteWith = () => new Map([[NAME_A, pretty(ev())]]);

  it('P1① 列表不完整/命令非零/目录没权限，一律 unscanned + exit 2，不当远端 0 条', async () => {
    const S = await SYNC;
    // ① ssh 吐了哨兵头就断线（审官实验 1：旧代码 remoteTotal=0 / unscanned=[] / exit 0）
    let dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ls-p1a-'));
    const cut = S.pullFromHost({ host: 'fake', localDir: dir, run: fakeSsh(remoteWith(), { listTruncate: true, listCode: 1 }).run });
    assert.strictEqual(cut.counts.added, 0, '没拉到东西');
    assert.ok(cut.unscanned.length === 1 && /没尾行哨兵/.test(cut.unscanned[0]), '判成没查成，理由是流被截断');
    assert.strictEqual(S.verdict([cut]).code, 2, 'exit 2，不是 0');
    assert.notStrictEqual(cut.remoteTotal, 0, 'remoteTotal 不许写成 0（那等于宣称远端是空的）');
    fs.rmSync(dir, { recursive: true, force: true });

    // ② 协议完整但命令非零退出 ⇒ 列举过程出过事，这份名单不许当全集
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ls-p1b-'));
    const nonZero = S.pullFromHost({ host: 'fake', localDir: dir, run: fakeSsh(new Map(), { listCode: 1 }).run });
    assert.ok(nonZero.unscanned.length === 1 && /非零退出 exit 1/.test(nonZero.unscanned[0]), '非零退出必须点名');
    assert.strictEqual(S.verdict([nonZero]).code, 2, '非零退出 = 没查成');
    fs.rmSync(dir, { recursive: true, force: true });

    // ③ 远端目录没权限（不加 NOREAD 哨兵时，glob 退化成字面量，看着就像空目录）
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ls-p1c-'));
    const noRead = S.pullFromHost({ host: 'fake', localDir: dir, run: fakeSsh(remoteWith(), { noRead: true }).run });
    assert.ok(noRead.unscanned.length === 1 && /读不了/.test(noRead.unscanned[0]), '没权限 = 没查成');
    assert.strictEqual(S.verdict([noRead]).code, 2, 'exit 2');
    fs.rmSync(dir, { recursive: true, force: true });

    // ④ 取内容那条命令非零退出，同样不许把这批当齐了
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ls-p1d-'));
    const bundleBad = S.pullFromHost({ host: 'fake', localDir: dir, run: fakeSsh(remoteWith(), { bundleCode: 4 }).run });
    assert.ok(bundleBad.unscanned.some(u => /取内容命令非零退出 exit 4/.test(u)), '取内容非零退出要点名');
    assert.strictEqual(S.verdict([bundleBad]).code, 2, 'exit 2');
    assert.strictEqual(fs.readdirSync(dir).length, 0, '没查成时一个字节都别落盘');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('P1② 列表与取值对不上账（MISS / 请了没回）算没查成，不许报同步成功', async () => {
    const S = await SYNC;
    // 审官实验 2：列表列了 A，取值时 A 已被删——旧代码 missing.length=1 却 exit 0
    let dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ls-p2a-'));
    const listOnly = new Map([[NAME_A, pretty(ev())]]);
    const runner = fakeSsh(listOnly).run;
    const wrapped = (cmd, args, opts) => {
      if (String(args[args.length - 1]).includes('DAO_LEDGER_BUNDLE')) listOnly.delete(NAME_A); // 取值前远端删掉
      return runner(cmd, args, opts);
    };
    const gone = S.pullFromHost({ host: 'fake', localDir: dir, run: wrapped });
    assert.strictEqual(gone.counts.missing, 1, '远端列了却取不到，进 missing');
    assert.strictEqual(gone.missing[0].name, NAME_A, 'missing 要带文件名');
    assert.strictEqual(gone.counts.added, 0, '什么也没落盘');
    assert.strictEqual(S.verdict([gone]).code, 2, 'missing 是唯一异常时也必须 exit 2（旧代码这里 exit 0）');
    fs.rmSync(dir, { recursive: true, force: true });

    // 请过的名字既没回内容也没回 MISS ⇒ 名单没送到 / 流丢行
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ls-p2b-'));
    const listOnly2 = new Map([[NAME_A, pretty(ev())]]);
    const runner2 = fakeSsh(listOnly2, { dropMiss: true }).run;
    const wrapped2 = (cmd, args, opts) => {
      if (String(args[args.length - 1]).includes('DAO_LEDGER_BUNDLE')) listOnly2.delete(NAME_A);
      return runner2(cmd, args, opts);
    };
    const lost = S.pullFromHost({ host: 'fake', localDir: dir, run: wrapped2 });
    assert.strictEqual(lost.counts.lost, 1, '请过却没回音，进 lost');
    assert.strictEqual(S.verdict([lost]).code, 2, 'exit 2');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('P2③ 写盘/读回抛异常收成 writeFailures（带文件名与原因），不往外抛', async () => {
    const S = await SYNC;
    // ① 落点建不出来（父路径是个文件）：旧代码在 pullFromHost 里直接抛 ENOTDIR，--json 拿不到结果
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ls-p3-'));
    const blocker = path.join(base, 'blocker');
    fs.writeFileSync(blocker, 'not a dir', 'utf8');
    let r;
    assert.doesNotThrow(() => {
      r = S.pullFromHost({ host: 'fake', localDir: path.join(blocker, 'events'), run: fakeSsh(remoteWith()).run });
    }, '不许把异常抛给调用方');
    assert.strictEqual(r.counts.writeFailures, 1, '收成一条 writeFailures');
    assert.match(r.writeFailures[0].why, /ENOTDIR|EEXIST|ENOENT/, '原因要带上系统错误码');
    assert.ok(r.writeFailures[0].name, '要带落点名字');
    assert.strictEqual(S.verdict([r]).code, 1, '写不进是真红 exit 1');

    // ② writeIncoming 自己也不许抛：非法文件名（含 NUL）会让 writeFileSync 抛
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ls-p3b-'));
    let w;
    assert.doesNotThrow(() => {
      w = S.writeIncoming({ dir, name: 'x .json', text: pretty(ev()) });
    }, 'writeIncoming 不许抛');
    assert.ok(!w.ok && /安全|basename|抛了/.test(w.why), '非法名先拦或不抛，收成 ok:false');
    fs.rmSync(base, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('回归：远端真是空目录（头 + 尾 END 0）仍判绿——fail-closed 不是「一律报红」', async () => {
    const S = await SYNC;
    // 上面三条把「不完整」全堵成非零；这条是反向判别力：协议齐、命令 0、真的 0 条，
    // 必须还是 exit 0 且 remoteTotal 写 0（此时 0 是查过的结论，不是没查成的缺省值）。
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ls-empty-'));
    const r = S.pullFromHost({ host: 'fake', localDir: dir, run: fakeSsh(new Map()).run });
    assert.strictEqual(r.remoteTotal, 0, '查过是空的 ⇒ remoteTotal 是 0，不是 null');
    assert.strictEqual(r.unscanned.length, 0, '没有任何「没查成」');
    assert.strictEqual(S.verdict([r]).code, 0, '空远端是绿，不许被 fail-closed 顺手带红');
    assert.strictEqual(fs.readdirSync(dir).length, 0, '没有东西可拉，也别留临时件');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('判决口径只有一处：桶就是 SIGNAL_CLASS 的键，忘了归类 → fail-closed 判红', async () => {
    const S = await SYNC;
    const fresh = S.emptyResult({ host: 'x' });
    const buckets = Object.keys(fresh).filter(k => Array.isArray(fresh[k])).sort();
    assert.deepStrictEqual(buckets, Object.keys(S.SIGNAL_CLASS).sort(), '结果桶与判决表逐个对齐（加桶必须先归类）');
    for (const [k, v] of Object.entries(S.SIGNAL_CLASS)) {
      assert.ok(['ok', 'unscanned', 'red'].includes(v), `${k} 的归类必须是 ok/unscanned/red 之一，实际 ${v}`);
    }
    const sneaky = { ...S.emptyResult({ host: 'x' }), brandNewBucket: [{ name: 'z' }] };
    const v = S.verdict([sneaky]);
    assert.strictEqual(v.code, 1, '没归类的桶 → 判红，不是默认落进 ok');
    assert.deepStrictEqual(v.unclassified, ['brandNewBucket'], '点名是哪个桶漏登记');
    const typo = { ...S.emptyResult({ host: 'x' }) };
    typo.counts = {};
    assert.strictEqual(S.verdict([{ ...typo, added: [{ name: 'a' }] }]).code, 0, '正常的 ok 桶照样是绿（判别力在，不是一律报红）');
    assert.strictEqual(S.verdict([]).code, 0, '零台机器 = 没有异常');
  });
});

// ── 审官 #899 返工：远端文件名路径逃逸不许写出 localDir ────────
describe('ledger-sync：来件名路径边界（审官 #899 返工）', () => {
  const ULID = '01M00DA3KG6KVJBXVSYEE1T5XR';
  const ESCAPE = ULID + '-../../outside.json';

  it('含 ../ 的列表+bundle 判别：不写出 localDir，也不当 add', async () => {
    const S = await SYNC;
    const text = pretty(ev());

    assert.strictEqual(S.isSafeEventName(ESCAPE), false, '逃逸名不是安全 basename');
    assert.strictEqual(S.classifyIncoming({ name: ESCAPE, text }).action, 'reject', 'classify 拒，不当 add');
    const located = S.eventPathInDir('/tmp/ledger-events', ESCAPE);
    assert.ok(!located.ok, 'eventPathInDir 拒逃逸');
    assert.ok(!located.path, '拒的时候不拼 path');

    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'ls-esc-'));
    const dir = path.join(parent, 'events');
    fs.mkdirSync(dir);
    const outside = path.join(parent, 'outside.json');

    let w;
    assert.doesNotThrow(() => {
      w = S.writeIncoming({ dir, name: ESCAPE, text });
    }, 'writeIncoming 对逃逸名不许抛');
    assert.ok(!w.ok, '逃逸名不写盘');
    assert.ok(!fs.existsSync(outside), 'writeIncoming 不写出 localDir');
    assert.deepStrictEqual(fs.readdirSync(dir), [], '账本目录也没落下逃逸名');

    // 列表带 ../：整份名单 fail-closed，added=0（审官复现是 added=1 且 path 逃出）
    const listed = S.pullFromHost({
      host: 'fake',
      localDir: dir,
      run: fakeSsh(new Map([[ESCAPE, text]])).run,
    });
    assert.ok(listed.unscanned.some(u => /路径逃逸|非法文件名/.test(u)), '列表含 ../ 判没查成');
    assert.strictEqual(listed.counts.added, 0, 'added 必须是 0');
    assert.ok(!fs.existsSync(outside), '列表逃逸不写出 localDir');
    assert.strictEqual(S.verdict([listed]).code, 2, 'exit 2');

    // bundle 拆名：列表是合法名，打包流回逃逸名——校验放在写盘前，不靠列表端
    const runner = fakeSsh(new Map([[NAME_A, text]])).run;
    const wrapped = (cmd, args, opts) => {
      const r = runner(cmd, args, opts);
      if (String(args[args.length - 1]).includes('DAO_LEDGER_BUNDLE') && r.stdout) {
        const b64 = Buffer.from(text, 'utf8').toString('base64');
        r.stdout = 'DAO_LEDGER_BUNDLE v1\n' + ESCAPE + ' ' + b64 + '\nDAO_LEDGER_BUNDLE_END 1\n';
      }
      return r;
    };
    const bundled = S.pullFromHost({ host: 'fake', localDir: dir, run: wrapped });
    assert.ok(
      bundled.unscanned.some(u => /路径逃逸|非法文件名|没请过/.test(u)),
      'bundle 逃逸名 / 非请求名判没查成'
    );
    assert.strictEqual(bundled.counts.added, 0, 'bundle 逃逸不当 add');
    assert.ok(!fs.existsSync(outside), 'bundle 逃逸不写出 localDir');
    assert.strictEqual(S.verdict([bundled]).code, 2, 'exit 2');

    // 请求名单校验：打包流回了合法但没请过的名字，同样没查成（不靠列表端）
    const extra = S.parseRemoteBundle(
      'DAO_LEDGER_BUNDLE v1\n' + NAME_B + ' ' + Buffer.from(text, 'utf8').toString('base64') + '\nDAO_LEDGER_BUNDLE_END 1\n',
      { requested: [NAME_A] }
    );
    assert.ok(extra.unscanned && /没请过/.test(extra.error), '传输中的 name 必须在请求名单里');

    // 反向判别：合法名照样进账，不是一律拒写
    const ok = S.pullFromHost({
      host: 'fake',
      localDir: dir,
      run: fakeSsh(new Map([[NAME_A, text]])).run,
    });
    assert.strictEqual(ok.counts.added, 1, '合法名照样进账');
    assert.ok(fs.existsSync(path.join(dir, NAME_A)), '落在 localDir 内');
    assert.ok(!fs.existsSync(outside), '合法拉取也不碰目录外');
    assert.ok(String(ok.added[0].path).startsWith(dir), '返回 path 在 localDir 下');

    fs.rmSync(parent, { recursive: true, force: true });
  });

  it('纯函数：含 ../ 或反斜杠 parseEventName 为 null；合法 hostname / FQDN 仍过', async () => {
    const S = await SYNC;
    const ULID = '01M00DA3KG6KVJBXVSYEE1T5XR';
    const BAD_INSIDE = ULID + '-../../outside.json';
    const BAD_OUTSIDE = ULID + '-../../../outside.json';
    const BAD_WIN = ULID + '-..\\..\\outside.json';
    assert.strictEqual(S.parseEventName(BAD_INSIDE), null, '斜杠路径组件不是事件名');
    assert.strictEqual(S.parseEventName(BAD_OUTSIDE), null, '会写出父目录的名字也不是事件名');
    assert.strictEqual(S.parseEventName(BAD_WIN), null, 'Windows 反斜杠写法同样 null（Linux 上 \\ 不是分隔符，要双边 basename）');
    assert.strictEqual(S.parseEventName(ULID + '-..json'), null, 'machine 整段是 . 不行');
    assert.strictEqual(S.parseEventName(ULID + '-...json'), null, 'machine 整段是 .. 不行');
    assert.deepStrictEqual(S.parseEventName(NAME_A), { ulid: ULID, machine: 'alpha' }, '合法 NAME_A 仍解析出 machine:alpha');
    assert.deepStrictEqual(S.parseEventName(ULID + '-vmi3551059.json'), { ulid: ULID, machine: 'vmi3551059' }, '真实 hostname 仍过');
    assert.deepStrictEqual(S.parseEventName(ULID + '-host.example.com.json'), { ulid: ULID, machine: 'host.example.com' }, '带点的 FQDN 仍过（不要禁 .）');
    const plan = S.planFetch({ remoteNames: [BAD_OUTSIDE, '.dispatch-index', NAME_A] });
    assert.deepStrictEqual(plan.fetch, [NAME_A], '不安全名字不拉');
    assert.ok(plan.rejected.includes(BAD_OUTSIDE), '形态像 .json 但不安全 → rejected，不是 ignored');
    assert.deepStrictEqual(plan.ignored, ['.dispatch-index'], '.dispatch-index 仍走 ignored');
    assert.strictEqual(S.classifyIncoming({ name: BAD_OUTSIDE, text: pretty(ev()) }).action, 'reject', 'classify 走 reject 不走 add');
  });
});
