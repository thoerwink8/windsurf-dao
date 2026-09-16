// #1236：重试账的判据版本。
//
// 2026-09-13 实咬：重试次数按 `<动词>:<pr>@<head>` 记，**键只跟 head 走、不跟代码版本走**。
// 于是修法落到 master 之后，旧账里那 3 次失败还挂在同一个 head 上——修好了，可没人给它
// 第四次机会。实测 PR #1118 被认输 32 次（#1127 18 次、#1129 15 次），一周里
// 「认输→推送→摘标→再认输」转磨盘；人的处置「摘标重推」也无效，因为重推仍读那份旧账。
//
// 本套要证的是**三态分得开**（这是 #1236 最容易做错的地方）：
//   · 指纹算得出 + 代码没变  → 键稳定，重试计数照常累加（不许每轮凭空重置）
//   · 指纹算得出 + 代码变了  → 键变，旧账不匹配 ⇒ tries 从 0 起（修好的局面重获机会）
//   · 指纹算不出（文件没了）→ 退回**旧形态的键**并报 unscanned，不许退化成「空版本」
//     让所有 PR 共用一本账（那会把「没查成」伪装成「版本一致」，比不做事更糟）

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const M = import('file://' + path.join(REPO, 'scripts', 'lib', 'retry-epoch.mjs').replace(/\\/g, '/'));

describe('#1236 判据版本 retryEpoch', () => {
  it('算得出：12 位 hex，且覆盖声明的每一个文件', async () => {
    const { retryEpoch, EPOCH_FILES } = await M;
    const r = retryEpoch();
    assert.equal(r.ok, true, '本仓的文件都在，必须算得出  →  ' + JSON.stringify(r));
    assert.match(r.epoch, /^[0-9a-f]{12}$/, '版本号是 12 位 hex  →  ' + r.epoch);
    assert.equal(r.files, EPOCH_FILES.length, 'read 的数要等于文件数（少读一个也算「没查成」）');
  });

  it('内容相同 ⇒ 版本相同（同一份代码不许两次算出两个版本）', async () => {
    const { retryEpoch } = await M;
    assert.equal(retryEpoch().epoch, retryEpoch().epoch);
  });

  it('任一个判据文件变了 ⇒ 版本变（这是整件事的开关）', async () => {
    const { retryEpoch, EPOCH_FILES } = await M;
    const before = retryEpoch().epoch;
    // 注入假 readFile：只让第一个文件的内容不同，其余照真实文件读
    const fs = require('node:fs');
    const target = EPOCH_FILES[0];
    const after = retryEpoch({
      readFile: (p) => (p.endsWith(target) ? Buffer.from('// 改过了\n') : fs.readFileSync(p)),
    });
    assert.equal(after.ok, true);
    assert.notEqual(after.epoch, before, '判据文件变了版本必须变，否则旧账永远作废不了');
  });

  it('把两个文件的内容对调也变（文件名参与哈希，不是只哈希内容串）', async () => {
    const { retryEpoch, EPOCH_FILES } = await M;
    const fs = require('node:fs');
    const a = EPOCH_FILES[0];
    const b = EPOCH_FILES[1];
    // 第 0 个读成第 1 个的内容，第 1 个读成第 0 个的内容：**内容集合完全不变**，
    // 变的只是「哪份内容挂在哪个名字下」。若哈希只喂内容不喂文件名，这个改动静悄悄不发生。
    const r = retryEpoch({
      readFile: (p) => {
        if (p.endsWith(a)) return fs.readFileSync(path.join(REPO, b));
        if (p.endsWith(b)) return fs.readFileSync(path.join(REPO, a));
        return fs.readFileSync(p);
      },
    });
    assert.equal(r.ok, true);
    assert.notEqual(r.epoch, retryEpoch().epoch,
      '对调内容必须变版本——否则「把 A 的实现搬到 B」这类改动静默作废不了旧账');
  });

  it('读不到任何一个文件 ⇒ ok:false + epoch:null，且说得出是哪个文件', async () => {
    const { retryEpoch, EPOCH_FILES } = await M;
    const r = retryEpoch({ readFile: () => { const e = new Error('nope'); e.code = 'ENOENT'; throw e; } });
    assert.equal(r.ok, false);
    assert.equal(r.epoch, null, '算不出时必须是 null，不是空串——空串会让所有键长得一样');
    assert.ok(r.why.includes(EPOCH_FILES[0]), '要说得出是哪个文件读不到  →  ' + r.why);
  });
});

describe('#1236 键加版本 stampRetryKey', () => {
  it('带版本时拼在尾部 @e<12hex>', async () => {
    const { stampRetryKey } = await M;
    assert.equal(
      stampRetryKey('rereview:12@abc', '1bf5b3aaaab2'),
      'rereview:12@abc@e1bf5b3aaaab2');
  });

  it('版本算不出（null/空/形态不对）⇒ 原样返回，退回旧行为', async () => {
    const { stampRetryKey } = await M;
    const base = 'rereview:12@abc';
    assert.equal(stampRetryKey(base, null), base);
    assert.equal(stampRetryKey(base, ''), base);
    assert.equal(stampRetryKey(base, undefined), base);
    assert.equal(stampRetryKey(base, '未算成'), base, '非法形态一律退回旧键，不许拼出半截键');
  });

  it('空 base 不拼出版本尾巴（不然会造出一个属于所有人的键）', async () => {
    const { stampRetryKey } = await M;
    assert.equal(stampRetryKey('', '1bf5b3aaaab2'), '');
    assert.equal(stampRetryKey(null, '1bf5b3aaaab2'), '');
  });
});

describe('#1236 四个重试键都带上同一个版本', () => {
  const CORE = import('file://' + path.join(REPO, 'scripts', 'lib', 'commander-core.mjs').replace(/\\/g, '/'));
  const VERBS = import('file://' + path.join(REPO, 'scripts', 'lib', 'commander-verbs.mjs').replace(/\\/g, '/'));

  it('reworkKey / rereviewKey / pumpDraftKey / drainLedgerKey 尾部版本一致', async () => {
    const core = await CORE;
    const verbs = await VERBS;
    const epoch = verbs.epochOf().epoch;
    assert.match(epoch, /^[0-9a-f]{12}$/, '先要有版本  →  ' + epoch);
    const keys = {
      rework: core.reworkKey(1234, 'a'.repeat(40)),
      rereview: core.rereviewKey(1234, 'a'.repeat(40)),
      pump: core.pumpDraftKey(1234),
      drain: verbs.drainLedgerKey(1234, 'a'.repeat(40)),
    };
    for (const [name, k] of Object.entries(keys)) {
      assert.ok(k.endsWith('@e' + epoch), `${name} 必须带本进程的版本  →  ${k}`);
    }
  });

  it('同进程内取两次版本是同一个值（一轮里不许出现两套键）', async () => {
    const verbs = await VERBS;
    assert.equal(verbs.epochOf().epoch, verbs.epochOf().epoch);
  });

  it('键里仍看得出 pr 与 head（带版本不许把原信息挤掉）', async () => {
    const core = await CORE;
    const head = 'deadbeef' + '0'.repeat(32);
    const k = core.rereviewKey(4321, head);
    assert.ok(k.startsWith('rereview:4321@'), '还是老前缀  →  ' + k);
    assert.ok(k.includes(head), 'head 还在，没被版本挤掉  →  ' + k);
  });

  // 2026-09-15 实咬：#1279 改的是渠道上限（1→5）与拉取预算（3→8）——正是「这张 PR 现在
  // 推不推得动」的判据——却一个 EPOCH 文件都没碰。旧账没作废，19 张 PR 的认输标继续焊着，
  // 指挥官连续 9 轮零动作。把这两个文件钉死在这里：谁要删它，得先解释怎么让并发修法作废旧账。
  it('渠道上限与拉取预算在判据集里（#1279 漏的就是这两个）', async () => {
    const { EPOCH_FILES } = await M;
    assert.ok(
      EPOCH_FILES.includes('scripts/lib/channel-concurrency.mjs'),
      '「渠道已满员，拒起会话」是重试失败的一大类，改了它旧账必须作废  →  ' + JSON.stringify(EPOCH_FILES),
    );
    assert.ok(
      EPOCH_FILES.includes('scripts/lib/dispatch/review-pending.mjs'),
      '拉取预算与票→reviewer-create 的换人计划同理  →  ' + JSON.stringify(EPOCH_FILES),
    );
  });
});
